/**
 * The schema freshness gate, and the backfill lane that fixes what it finds.
 *
 * These assertions come in two halves, and the second is the important one. The first proves the
 * delta engine — the thing that turns a 500 KB JSON diff into "these pointers moved". The second
 * proves the WORKFLOW, because `.github/workflows/schemas.yml` pushes commits to pull request
 * branches and a workflow that is subtly wrong does not error, it just does the wrong thing quietly
 * to somebody's branch. Every assertion there is a condition under which the lane would either stop
 * fixing things or start fixing the wrong ones.
 *
 * It lives flat in `scripts/` for the same reason `dependabot-config.test.ts` does: it runs
 * unconditionally through `bun test --isolate scripts` in test.yml's `changes` job, and
 * `scripts/ci/**` is in `affected.ts`'s GLOBAL list, so putting it there would make editing CI
 * policy run the entire workspace matrix.
 */

import { describe, expect, test } from "bun:test";

import {
  candidatePaths,
  classifySchema,
  deltaSize,
  driftEntry,
  explainDrift,
  flatten,
  GENERATORS,
  pointerDelta,
  renderReport,
} from "./check-schema-freshness.ts";
import type { DriftEntry, SchemaKind } from "./check-schema-freshness.ts";

const WORKFLOW = ".github/workflows/schemas.yml";

interface Job {
  permissions?: Record<string, string>;
  steps: { name?: string; id?: string; if?: string; run?: string; uses?: string; with?: unknown }[];
  "timeout-minutes"?: number;
}
interface Workflow {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  concurrency?: { group: string; "cancel-in-progress"?: boolean };
  jobs: Record<string, Job>;
}

const workflow = Bun.YAML.parse(await Bun.file(WORKFLOW).text()) as Workflow;
const workflowText = await Bun.file(WORKFLOW).text();

describe("flatten", () => {
  test("walks objects to leaf pointers", () => {
    const map = flatten({ $defs: { A: { type: "string" } } });
    expect(map.get("/$defs/A/type")).toBe('"string"');
  });

  test("escapes ~ and / in keys, per RFC 6901", () => {
    const map = flatten({ "a/b": 1, "c~d": 2 });
    expect([...map.keys()].toSorted()).toEqual(["/a~1b", "/c~0d"]);
  });

  test("flattens a primitive array as a SET, not by index", () => {
    // The whole point: `enum` order is not meaning. Index pointers would report one insertion at
    // The front as every following member having changed.
    const before = flatten({ enum: ["a", "c"] });
    const after = flatten({ enum: ["a", "b", "c"] });
    expect([...after.keys()].toSorted()).toEqual(["/enum/a", "/enum/b", "/enum/c"]);
    const delta = pointerDelta({ enum: ["a", "c"] }, { enum: ["a", "b", "c"] });
    expect(delta.added).toEqual(["/enum/b"]);
    expect(delta.removed).toEqual([]);
    expect(delta.changed).toEqual([]);
    expect(before.size).toBe(2);
  });

  test("indexes an array of objects, where position IS structure", () => {
    const map = flatten({ oneOf: [{ type: "string" }, { type: "number" }] });
    expect(map.get("/oneOf/0/type")).toBe('"string"');
    expect(map.get("/oneOf/1/type")).toBe('"number"');
  });

  test("gives an empty container its own pointer, so its existence is visible", () => {
    expect(flatten({ a: {}, b: [] }).get("/a")).toBe("{}");
    expect(flatten({ a: {}, b: [] }).get("/b")).toBe("[]");
  });

  test('distinguishes the string "1" from the number 1', () => {
    const delta = pointerDelta({ x: 1 }, { x: "1" });
    expect(delta.changed).toEqual(['/x: 1 → "1"']);
  });
});

describe("pointerDelta", () => {
  test("reports added, removed and re-valued pointers separately", () => {
    const delta = pointerDelta(
      { keep: 1, moved: "before", gone: true },
      { keep: 1, moved: "after", fresh: 2 },
    );
    expect(delta.added).toEqual(["/fresh"]);
    expect(delta.removed).toEqual(["/gone"]);
    expect(delta.changed).toEqual(['/moved: "before" → "after"']);
    expect(deltaSize(delta)).toBe(3);
  });

  test("is empty for documents that differ only in key order", () => {
    // A re-serialisation is not a contract change, and the report says so in words instead of
    // Printing a diff of every line.
    const delta = pointerDelta({ a: 1, b: 2 }, { b: 2, a: 1 });
    expect(deltaSize(delta)).toBe(0);
  });

  test("clips a paragraph-length value rather than printing it whole", () => {
    const long = "x".repeat(400);
    const [line] = pointerDelta({ description: "short" }, { description: long }).changed;
    expect(line!.length).toBeLessThan(220);
    expect(line).toContain("…");
  });
});

describe("classifySchema", () => {
  test.each([
    ["packages/schema/schema.json", "core"],
    ["packages/schema/class-schema.json", "core"],
    ["packages/schema/schemas/project.core.schema.json", "core"],
    ["packages/starters/sites/blog/document.schema.json", "entry"],
    ["examples/project.schema.json", "entry"],
    ["extensions/parser/schemas/project.fragment.schema.json", "fragment"],
  ] as [string, SchemaKind][])("%s is %s", (path, kind) => {
    expect(classifySchema(path)).toBe(kind);
  });
});

describe("candidatePaths", () => {
  test("finds every committed schema the two generators write", () => {
    const paths = candidatePaths();
    // The four the old shell gate could not see. `packages/schema/project-schema.json` spells the
    // Word with a HYPHEN, so `**\/project.schema.json` never matched it; the other three are not
    // Named by either pathspec at all. This is the regression that motivated the whole script.
    for (const missed of [
      "packages/schema/project-schema.json",
      "packages/schema/class-schema.json",
      "packages/schema/extension-manifest.schema.json",
      "packages/schema/schemas/project.core.schema.json",
    ]) {
      expect(paths).toContain(missed);
    }
    // And the ones it could: every project root's pair.
    expect(paths).toContain("examples/document.schema.json");
    expect(paths.filter((p) => p.endsWith("/project.schema.json")).length).toBeGreaterThan(20);
  });

  test("every candidate is a real file", async () => {
    for (const path of candidatePaths()) {
      expect(await Bun.file(path).exists()).toBe(true);
    }
  });
});

describe("driftEntry", () => {
  test("treats a file the tree did not have as wholly added", () => {
    const entry = driftEntry("examples/project.schema.json", undefined, '{"a":1}');
    expect(entry.delta.added).toEqual(["/a"]);
    expect(entry.committed).toBeUndefined();
  });

  test("survives a committed file that is not valid JSON", () => {
    // A half-written artifact must produce a report, not a stack trace: the run that finds one is
    // Exactly the run that has to explain itself.
    const entry = driftEntry("packages/schema/schema.json", "{ oops", '{"a":1}');
    expect(entry.unparseable).toBeTruthy();
    expect(deltaSize(entry.delta)).toBe(0);
  });
});

describe("explainDrift", () => {
  const core = new Set<SchemaKind>(["core"]);

  test("names a dependency bump as the cause, because it is the commonest one", () => {
    const [cause] = explainDrift(["bun.lock"], core);
    expect(cause).toContain("@webref/css");
  });

  test("names the schema definitions", () => {
    expect(explainDrift(["packages/schema/defs/tag-name.schema.ts"], core)[0]).toContain(
      "schema definitions",
    );
  });

  test("names an extension fragment", () => {
    const causes = explainDrift(["extensions/search/schemas/project.fragment.schema.json"], core);
    expect(causes.join(" ")).toContain("extension fragment");
  });

  test("says outright when nothing in the diff explains it", () => {
    // The merge-race signature, and the only reason the trunk leg of the workflow exists.
    const causes = explainDrift(["docs/start/install.md"], core);
    expect(causes).toHaveLength(1);
    expect(causes[0]).toContain("nothing in this diff explains it");
  });
});

describe("renderReport", () => {
  const entry = (path: string, added: string[] = ["/x"]): DriftEntry => ({
    delta: { added, changed: [], removed: [] },
    generated: "{}",
    kind: classifySchema(path),
    path,
  });

  test("says so, briefly, when nothing drifted", () => {
    const report = renderReport([], { fixed: false });
    expect(report).toStartWith("<!-- jx-schema-drift -->");
    expect(report).toContain("are current");
  });

  test("carries the marker the sticky comment is found by", () => {
    // The workflow looks its own previous comment up with `startsWith(marker)`. Change one side
    // Without the other and every run posts a NEW comment instead of updating one — which is a
    // Lane people mute rather than a lane people read.
    const report = renderReport([entry("packages/schema/schema.json")], { fixed: true });
    expect(report).toStartWith("<!-- jx-schema-drift -->");
    expect(workflowText).toContain("const marker = '<!-- jx-schema-drift -->'");
  });

  test("distinguishes a pushed fix from a gate that put the tree back", () => {
    const entries = [entry("packages/schema/schema.json")];
    expect(renderReport(entries, { fixed: true })).toContain("have been regenerated");
    expect(renderReport(entries, { fixed: false })).toContain("left as it was found");
  });

  test("puts core artifacts before entry documents, because entries embed the core", () => {
    const report = renderReport(
      [entry("examples/document.schema.json"), entry("packages/schema/schema.json")],
      { detailLimit: 1, fixed: true },
    );
    expect(report).toContain("<code>packages/schema/schema.json</code>");
    expect(report).not.toContain("<code>examples/document.schema.json</code> —");
  });

  test("names a re-serialisation as one, instead of showing an empty diff", () => {
    const report = renderReport([entry("packages/schema/schema.json", [])], { fixed: true });
    expect(report).toContain("differently serialised");
  });

  test("stays inside GitHub's comment limit however much moved", () => {
    const many = Array.from({ length: 60 }, (_unused, i) =>
      entry(
        `packages/starters/sites/s${i}/document.schema.json`,
        Array.from({ length: 500 }, (_pointer, j) => `/$defs/Thing${j}/properties/whatever`),
      ),
    );
    expect(renderReport(many, { fixed: true }).length).toBeLessThanOrEqual(65_536);
  });

  test("caps the pointers listed per file and says how many it dropped", () => {
    const report = renderReport([entry("packages/schema/schema.json", ["/a", "/b", "/c", "/d"])], {
      fixed: true,
      pointerLimit: 2,
    });
    expect(report).toContain("and 2 more");
  });
});

describe("the generators this gate runs", () => {
  test("regenerate the core BEFORE the entry documents that embed it", () => {
    // Reversed, the entry documents are composed from the previous core and the run reports drift
    // It just created. The order is the contract; the names are checked so a rename of either
    // Package script reds here rather than silently running nothing.
    expect(GENERATORS.map((g) => g.join(" "))).toEqual([
      "bun run generate:schema",
      "bun run schema:generate-all",
    ]);
  });

  test("are real package scripts", async () => {
    const manifest = (await Bun.file("package.json").json()) as {
      scripts: Record<string, string>;
    };
    for (const generator of GENERATORS) {
      expect(manifest.scripts).toHaveProperty(generator[2] as string);
    }
    expect(manifest.scripts["schema:verify"]).toBe("bun scripts/check-schema-freshness.ts");
    expect(manifest.scripts["schema:sync"]).toBe("bun scripts/check-schema-freshness.ts --fix");
  });
});

describe("the backfill lane", () => {
  const job = workflow.jobs.regenerate!;
  const { steps } = job;
  /**
   * Every `run:` body with its shell comments stripped — a prose warning about `git add -A` is not
   * the same event as a step that calls it, and a test that cannot tell them apart is one that
   * fails on its own documentation.
   */
  const runs = steps
    .map((s) => s.run ?? "")
    .join("\n")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");

  test("runs on every pull request — no `paths:` filter to fall out of date", () => {
    // A filter here would be a hand-maintained list of "what can move a schema", and the answer
    // Includes `bun.lock`. The whole job is seconds; the filter is the expensive part.
    expect(workflow.on).toHaveProperty("pull_request");
    expect(workflow.on.pull_request ?? null).toBeNull();
  });

  test("also watches the trunk, which is the only place a merge race shows up", () => {
    expect(workflow.on.push).toEqual({ branches: ["main"] });
  });

  test("does NOT exclude Dependabot", () => {
    // The opposite of screenshots.yml, deliberately. A `@webref/*` bump rewrites the core schema
    // By construction and there is no human on that branch to run the generator — so excluding
    // Dependabot would remove this lane's single most valuable case.
    const guards = [job.steps.map((s) => s.if ?? "").join(" "), JSON.stringify(workflow.jobs)];
    expect(guards.join(" ")).not.toContain("dependabot[bot]");
  });

  test("can write, comment and publish a check", () => {
    expect(workflow.permissions).toMatchObject({
      checks: "write",
      contents: "write",
      "pull-requests": "write",
    });
  });

  test("uses the pinned Bun, not a version of its own", () => {
    expect(steps.some((s) => s.uses === "./.github/actions/setup-bun")).toBe(true);
    expect(JSON.stringify(steps)).not.toContain("oven-sh/setup-bun");
  });

  test("regenerates with --fix, since every later step reads the working tree", () => {
    const sync = steps.find((s) => s.id === "sync");
    expect(sync?.run).toContain("schema:sync");
    expect(sync?.run).toContain("--report");
  });

  test("stages only schemas, never everything that happens to be dirty", () => {
    // `schema:generate-all` begins with `schema:clean-roots`, which DELETES a starter's stray
    // `node_modules/@jxsuite/*`. `git add -A` would sweep that up, and a lane that stages
    // "everything dirty" is one commit away from committing something nobody meant to.
    expect(runs).toContain("git add -- '*schema.json'");
    expect(runs).not.toContain("git add -A");
    expect(runs).not.toContain("git add .");
  });

  test("pushes to a fully qualified ref", () => {
    // `HEAD:<branch>` makes git guess the destination and fail with "not a full refname" when it
    // Cannot — how the last screenshots run on feat/standards-registry died after a clean capture.
    expect(runs).toContain('git push origin "HEAD:refs/heads/${BRANCH}"');
  });

  test("commits as a `chore`, with no angle bracket in the subject", () => {
    // `chore` so landing on a release pull request cannot change what it releases; no `<tag>`
    // Because a raw angle bracket in a subject deletes a package from its own release
    // (CLAUDE.md, and scripts/check-changelog-safety.ts).
    const subjects = [...runs.matchAll(/git commit -m "([^"]+)"/g)].map((m) => m[1]!);
    expect(subjects.length).toBeGreaterThan(0);
    for (const subject of subjects) {
      expect(subject).toStartWith("chore(schema):");
      expect(subject).not.toMatch(/<[^>]+>/);
    }
  });

  test("checks out the head SHA, not the head branch, so a fork resolves at all", () => {
    // A fork's branch does not exist in this repository: `ref: <branch>` fails with "couldn't find
    // Remote ref" on exactly the pull requests the artifact path is for. A sha resolves for both.
    const resolve = steps.find((s) => s.id === "target");
    expect(resolve?.run).toContain('echo "ref=${HEAD_SHA}"');
    const checkout = steps.find((s) => (s.uses ?? "").startsWith("actions/checkout"));
    expect(JSON.stringify(checkout?.with)).toContain("steps.target.outputs.ref");
  });

  test("a dispatch against a fork's pull request is treated as a fork", () => {
    // `git push origin` writes to THIS repository. Without asking, a dispatch against a fork's
    // Pull request would create a same-named branch here and report a push that reached nobody.
    expect(runs).toContain("isCrossRepository");
  });

  test("never pushes from a fork, where the token is read-only anyway", () => {
    for (const step of steps) {
      if ((step.run ?? "").includes('git push origin "HEAD:refs/heads/${BRANCH}')) {
        expect(step.if).toContain("fork");
      }
    }
  });

  test("turns trunk drift into a pull request on ONE reused branch", () => {
    // `main` requires a pull request, so the lane cannot push the fix. A fixed branch name is what
    // Makes the second run update the existing pull request instead of opening another.
    expect(runs).toContain("chore/schema-drift");
    expect(runs).toContain("gh pr create");
    expect(runs).toContain("gh pr edit");
  });

  test("passes every attacker-controllable ref through the environment", () => {
    // A head ref is attacker-controllable text on a public repository, and `${{ … }}` substitution
    // Happens before bash sees the line — so an inline head ref is a shell-injection hole.
    for (const step of steps) {
      const body = step.run ?? "";
      expect(body).not.toContain("github.event.pull_request.head.ref");
      expect(body).not.toContain("github.head_ref");
    }
  });

  test("disables husky, so a local authoring hook cannot abort a CI push", () => {
    expect(JSON.stringify(steps)).toContain('"HUSKY":"0"');
  });

  test("cancels a superseded run, and bounds a hung one", () => {
    expect(workflow.concurrency?.["cancel-in-progress"]).toBe(true);
    expect(job["timeout-minutes"]).toBeGreaterThan(0);
  });

  test("has no `github.actor` refusal, because termination is a fixed point", () => {
    // Screenshots.yml needs one: Chromium does not re-encode a PNG byte-for-byte, so that lane can
    // Photograph its own output forever. `JSON.stringify` does, so the run this lane's push
    // Triggers regenerates to identical bytes and pushes nothing. If the generators ever stop
    // Being deterministic, this test is where to start reading.
    expect(JSON.stringify(workflow)).not.toContain("github.actor");
  });
});

describe("the gate stays wired into CI", () => {
  test("`checks` still runs the bare gate", async () => {
    // The lane cannot push to a fork, and a required check is what keeps a stale schema off main
    // When it cannot. Deleting this step would make the backfill lane the only enforcement, and
    // A lane that merely comments enforces nothing.
    const test_yml = await Bun.file(".github/workflows/test.yml").text();
    expect(test_yml).toContain("bun run schema:verify");
  });
});
