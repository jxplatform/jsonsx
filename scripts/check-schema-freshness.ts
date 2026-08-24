/**
 * Check-schema-freshness.ts — every committed schema build is what its generator produces.
 *
 * Two generators write JSON into this tree. `bun run generate:schema` writes the SEVEN core
 * artifacts under `packages/schema/` (the document schema, the project schema, the class schema,
 * the extension-manifest schema and the three `schemas/*.schema.json` fragments); `bun run
 * schema:generate-all` composes those into a `project.schema.json` and a `document.schema.json`
 * inside each of the 26 project roots. All 59 files are generated artifacts that happen to be
 * committed, because editors, `jx validate` and published npm packages all read them off disk.
 *
 * WHAT THIS REPLACES, AND THE HOLE IT CLOSES. `schema:verify` used to be a shell one-liner:
 *
 *     generate:schema && git diff --exit-code -- packages/schema/schema.json &&
 *     schema:generate-all && git diff --exit-code -- '**\/project.schema.json' '**\/document.schema.json'
 *
 * Both pathspecs are narrower than the generators they follow. `packages/schema/schema.json` is one
 * of seven core outputs, and neither `packages/schema/project-schema.json` (a hyphen, not a dot)
 * nor `packages/schema/schemas/project.core.schema.json` nor `class-schema.json` matches
 * `**\/project.schema.json`. So the gate regenerated all seven, looked at one, and passed — with
 * the other six freshly rewritten and unread in the working tree. Measured, not inferred: stamping
 * `"title": "STALE MARKER"` into `class-schema.json` and running `bun run schema:verify` exits 0. A
 * stale `class-schema.json` is a `.class.json` contract that says something the code does not,
 * which is the same class of six-week silence that `check-shadowed-core.ts` was written for.
 *
 * So this derives the answer instead of naming files: it snapshots every tracked `*schema.json`,
 * runs both generators, and reports whatever moved. A generator that starts writing an eighth
 * artifact is covered on the day it does.
 *
 * A 500 KB JSON diff is not a review, so drift is reported as MEANING: the JSON Pointers that
 * appeared, vanished or changed value. `+42 /$defs/CssProperties/enum/anchorName…` is a sentence;
 * `git diff` on one line of minified `enum` is not. Primitive arrays are compared as SETS on
 * purpose — order in an `enum` or a `required` is not meaning, and index pointers would report one
 * insertion as a hundred changes.
 *
 *     bun run schema:verify   # the gate: regenerate, report drift, restore the tree, exit 1
 *     bun run schema:sync     # regenerate and KEEP the result, exit 0 — the fixer
 *
 * @docs extending/contributing/monorepo
 *
 * `.github/workflows/schemas.yml` runs `--fix` and commits what it produced, so a stale schema is
 * backfilled rather than being a red X somebody has to clear by hand. `checks` still runs the bare
 * gate: the lane cannot push to a fork, and a required check is what keeps a stale build off `main`
 * when it cannot.
 */

import { rmSync } from "node:fs";

/** The generators, in the order they must run: entry documents EMBED the core. */
export const GENERATORS = [
  ["bun", "run", "generate:schema"],
  ["bun", "run", "schema:generate-all"],
] as const;

/** Which generator owns a path, for grouping in the report. */
export type SchemaKind = "core" | "entry" | "fragment";

/**
 * Classify a committed schema by the generator that writes it.
 *
 * `fragment` is the hand-authored `extensions/*\/schemas/*.fragment.schema.json` — no generator
 * writes those, so they are snapshotted like everything else and simply never drift. They are in
 * the candidate set rather than excluded from it because "no generator writes this" is a claim this
 * script should be able to be wrong about safely.
 *
 * @param {string} path - Repo-relative path
 * @returns {SchemaKind} The owning generator
 */
export function classifySchema(path: string): SchemaKind {
  if (path.startsWith("packages/schema/")) {
    return "core";
  }
  if (path.endsWith("/project.schema.json") || path.endsWith("/document.schema.json")) {
    return "entry";
  }
  return "fragment";
}

/** JSON Pointer escaping (RFC 6901): `~` becomes `~0`, `/` becomes `~1`. */
function escapeToken(token: string): string {
  return token.replaceAll("~", "~0").replaceAll("/", "~1");
}

/**
 * Flatten a JSON document to leaf JSON Pointers.
 *
 * Objects and non-primitive arrays recurse. An array whose elements are ALL primitives is flattened
 * as a SET — one pointer per value, not per index — because a schema's `enum`, `required` and
 * `type` arrays carry no ordering meaning, and index pointers turn a single insertion into a
 * hundred reported changes. An empty container emits its own pointer so that its existence is
 * visible.
 *
 * @param {unknown} value - The parsed JSON document
 * @param {string} base - Pointer prefix for recursion
 * @param {Map<string, string>} out - Accumulator
 * @returns {Map<string, string>} Pointer to a stable rendering of the value at it
 */
export function flatten(
  value: unknown,
  base = "",
  out = new Map<string, string>(),
): Map<string, string> {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      out.set(base, "[]");
      return out;
    }
    if (value.every((v) => v === null || typeof v !== "object")) {
      for (const v of value) {
        out.set(`${base}/${escapeToken(String(v))}`, "member");
      }
      return out;
    }
    for (const [i, v] of value.entries()) {
      flatten(v, `${base}/${i}`, out);
    }
    return out;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      out.set(base, "{}");
      return out;
    }
    for (const [key, v] of entries) {
      flatten(v, `${base}/${escapeToken(key)}`, out);
    }
    return out;
  }
  out.set(base, JSON.stringify(value) ?? "undefined");
  return out;
}

export interface PointerDelta {
  added: string[];
  removed: string[];
  /** Pointers present on both sides whose value differs, rendered `pointer: before → after`. */
  changed: string[];
}

/** Total pointers moved — the one number a table column can carry. */
export function deltaSize(delta: PointerDelta): number {
  return delta.added.length + delta.removed.length + delta.changed.length;
}

/**
 * Shorten one rendered value. A schema `description` is a paragraph, and a delta line carrying two
 * of them is a line nobody finishes reading.
 *
 * @param {string} value - The rendered value
 * @param {number} limit - Characters to keep
 * @returns {string} The value, elided in the middle of nothing — only the tail is dropped
 */
function clip(value: string, limit = 90): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

/**
 * Diff two parsed JSON documents by leaf pointer.
 *
 * @param {unknown} before - The committed document
 * @param {unknown} after - What the generator produced
 * @returns {PointerDelta} Pointers added, removed and re-valued
 */
export function pointerDelta(before: unknown, after: unknown): PointerDelta {
  const a = flatten(before);
  const b = flatten(after);
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [pointer, value] of b) {
    const previous = a.get(pointer);
    if (previous === undefined) {
      added.push(pointer);
    } else if (previous !== value) {
      changed.push(`${pointer}: ${clip(previous)} → ${clip(value)}`);
    }
  }
  for (const pointer of a.keys()) {
    if (!b.has(pointer)) {
      removed.push(pointer);
    }
  }
  return { added: added.toSorted(), removed: removed.toSorted(), changed: changed.toSorted() };
}

export interface DriftEntry {
  path: string;
  kind: SchemaKind;
  /** Absent when the generator wrote a file the tree did not have. */
  committed?: string;
  generated: string;
  delta: PointerDelta;
  /** Set when a side would not parse as JSON — the delta is then empty and meaningless. */
  unparseable?: string;
}

/**
 * Build the drift entry for one file, tolerating a side that is not valid JSON.
 *
 * @param {string} path - Repo-relative path
 * @param {string | undefined} committed - Content before the generators ran
 * @param {string} generated - Content after
 * @returns {DriftEntry} The entry, with an empty delta when either side is unparseable
 */
export function driftEntry(
  path: string,
  committed: string | undefined,
  generated: string,
): DriftEntry {
  const empty: PointerDelta = { added: [], removed: [], changed: [] };
  const entry: DriftEntry = {
    committed,
    delta: empty,
    generated,
    kind: classifySchema(path),
    path,
  };
  try {
    entry.delta = pointerDelta(
      committed === undefined ? {} : JSON.parse(committed),
      JSON.parse(generated),
    );
  } catch (error) {
    entry.unparseable = error instanceof Error ? error.message : String(error);
  }
  return entry;
}

/**
 * Which input in a diff explains the drift — and, when nothing does, say THAT.
 *
 * The last case is the one worth having. Two branches can each be green alone and stale together: A
 * adds a CSS property to the core, B adds a project root whose entry documents were composed before
 * A landed. Git merges both without a conflict, no per-branch check can see it, and `main` is stale
 * from the second merge onward. A lane that says "nothing in this diff explains it" is the only
 * thing that names that event out loud.
 *
 * @param {string[]} changedInputs - Repo-relative paths in the diff being explained
 * @param {Set<SchemaKind>} kinds - Which generators' outputs drifted
 * @returns {string[]} Human-readable causes, most specific first
 */
export function explainDrift(changedInputs: string[], kinds: Set<SchemaKind>): string[] {
  const hit = (pattern: string) => changedInputs.some((p) => new Bun.Glob(pattern).match(p));
  const causes: string[] = [];

  if (hit("packages/schema/defs/**") || hit("packages/schema/src/**")) {
    causes.push("the schema definitions under `packages/schema/` changed.");
  }
  if (hit("bun.lock") || hit("packages/schema/package.json")) {
    causes.push(
      "a dependency moved. The core schema injects web-standards data read at generation " +
        "time (`@webref/css`, `@webref/elements`, `@webref/idl`), so bumping one of those " +
        "rewrites the committed core — this is not the bump doing something unexpected.",
    );
  }
  if (hit("extensions/*/schemas/**")) {
    causes.push(
      "an extension fragment changed, and every project that enables that extension recomposes.",
    );
  }
  if (hit("packages/compiler/src/site/**")) {
    causes.push("the composer, bundler or flattener that builds the entry documents changed.");
  }
  if (kinds.has("entry") && (hit("*/project.json") || hit("*/*/project.json"))) {
    causes.push("a project enabled or disabled an extension.");
  }

  if (causes.length === 0) {
    causes.push(
      "**nothing in this diff explains it.** The drift predates this branch — most likely two " +
        "branches that were each green alone and stale together (one moved the core, the other " +
        "added or regenerated a project root before it landed). Git merges that without a " +
        "conflict and no per-branch check can see it.",
    );
  }
  return causes;
}

export interface ReportOptions {
  /** True after `--fix`: the regenerated files are still on disk. */
  fixed: boolean;
  /** Paths in the diff this drift is being explained against, if known. */
  changedInputs?: string[];
  /** Pointers listed per file before "… and N more". */
  pointerLimit?: number;
  /** Files that get an expanded delta; the rest are table rows only. */
  detailLimit?: number;
  /** Hard cap so the report stays inside GitHub's 65536-character comment limit. */
  maxBytes?: number;
}

const MARKER = "<!-- jx-schema-drift -->";

function bullet(sign: string, items: string[], limit: number): string[] {
  const lines = items.slice(0, limit).map((item) => `${sign} ${item}`);
  if (items.length > limit) {
    lines.push(`${sign} … and ${items.length - limit} more`);
  }
  return lines;
}

/**
 * The Markdown a reviewer reads instead of the diff.
 *
 * @param {DriftEntry[]} entries - Every file that moved
 * @param {ReportOptions} options - Rendering budget and context
 * @returns {string} Markdown, marker-prefixed so a bot comment can be updated in place
 */
export function renderReport(entries: DriftEntry[], options: ReportOptions): string {
  const pointerLimit = options.pointerLimit ?? 12;
  const detailLimit = options.detailLimit ?? 8;
  const maxBytes = options.maxBytes ?? 60_000;

  if (entries.length === 0) {
    return (
      `${MARKER}\n### Schema builds are current\n\n` +
      "Every committed schema is what its generator produces.\n"
    );
  }

  const kinds = new Set(entries.map((e) => e.kind));
  const lines: string[] = [
    MARKER,
    "### Schema builds regenerated",
    "",
    `${entries.length} committed schema${entries.length === 1 ? " is" : "s are"} not what ` +
      `${entries.length === 1 ? "its generator produces" : "their generators produce"}. ` +
      `${
        options.fixed
          ? "They have been regenerated."
          : "Regenerated to produce the deltas below; the working tree was then left as it was found."
      }`,
    "",
    "**These bytes are generated — review the meaning, not the diff.** Every pointer below is a " +
      "line of the contract that editors, `jx validate` and every published schema consumer read.",
    "",
  ];

  if (options.changedInputs) {
    lines.push("Why:", "");
    for (const cause of explainDrift(options.changedInputs, kinds)) {
      lines.push(`- ${cause}`);
    }
    lines.push("");
  }

  lines.push("| Schema | Generator | Added | Removed | Changed |", "|---|---|---:|---:|---:|");
  for (const entry of entries) {
    const note = entry.unparseable ? " ⚠️ unparseable" : "";
    lines.push(
      `| \`${entry.path}\`${note} | ${entry.kind} | ${entry.delta.added.length} | ` +
        `${entry.delta.removed.length} | ${entry.delta.changed.length} |`,
    );
  }
  lines.push("");

  // Core artifacts first: the entry documents EMBED them, so a core delta explains most of the
  // Rows above it and reading it first turns 52 files into one story.
  const detailed = entries
    .toSorted((a, b) => {
      if (a.kind !== b.kind) {
        return a.kind === "core" ? -1 : 1;
      }
      return deltaSize(b.delta) - deltaSize(a.delta);
    })
    .slice(0, detailLimit);

  for (const entry of detailed) {
    if (entry.unparseable) {
      lines.push(
        `<details><summary><code>${entry.path}</code> — could not be compared</summary>`,
        "",
        `\`\`\`\n${entry.unparseable}\n\`\`\``,
        "",
        "</details>",
        "",
      );
      continue;
    }
    if (deltaSize(entry.delta) === 0) {
      lines.push(
        `\`${entry.path}\` — the same contract, differently serialised (formatting or key order).`,
        "",
      );
      continue;
    }
    lines.push(
      `<details><summary><code>${entry.path}</code> — ${deltaSize(entry.delta)} pointer${
        deltaSize(entry.delta) === 1 ? "" : "s"
      } moved</summary>`,
      "",
      "```diff",
      ...bullet("+", entry.delta.added, pointerLimit),
      ...bullet("-", entry.delta.removed, pointerLimit),
      ...bullet("~", entry.delta.changed, pointerLimit),
      "```",
      "",
      "</details>",
      "",
    );
  }

  if (entries.length > detailed.length) {
    lines.push(
      `_${entries.length - detailed.length} further file(s) moved; their rows are in the table ` +
        "above. Entry documents embed the core, so a core delta accounts for most of them._",
      "",
    );
  }

  const report = lines.join("\n");
  if (report.length <= maxBytes) {
    return report;
  }
  return `${report.slice(0, maxBytes)}\n\n_… report truncated at ${maxBytes} characters. The full delta is in the job log._\n`;
}

// ─── Working-tree plumbing ────────────────────────────────────────────────────

function git(args: string[]): string {
  const run = Bun.spawnSync(["git", ...args], { stderr: "pipe", stdout: "pipe" });
  if (run.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${run.stderr.toString().trim()}`);
  }
  return run.stdout.toString();
}

function nulList(text: string): string[] {
  return text.split("\0").filter(Boolean);
}

/**
 * Every tracked file this script is prepared to see a generator write.
 *
 * Derived from the tree by suffix, not listed: a new generated schema is covered the day it is
 * committed. Over-covering is free — a hand-authored fragment simply never drifts — while
 * under-covering is the exact bug this script exists to close.
 *
 * @returns {string[]} Repo-relative paths
 */
export function candidatePaths(): string[] {
  return nulList(git(["ls-files", "-z", "*schema.json"])).toSorted();
}

/** Files the working tree has already changed or does not track, before the generators run. */
function dirtySet(): Set<string> {
  return new Set([
    ...nulList(git(["diff", "--name-only", "-z"])),
    ...nulList(git(["ls-files", "--others", "--exclude-standard", "-z"])),
  ]);
}

async function readOrUndefined(path: string): Promise<string | undefined> {
  const file = Bun.file(path);
  return (await file.exists()) ? await file.text() : undefined;
}

/**
 * The paths this run's drift is being explained against: everything the branch has committed since
 * the merge base, plus everything the working tree has changed on top of it.
 *
 * The working-tree half is what makes the answer right locally — a def file edited but not yet
 * committed is exactly the thing a developer is asking about — and it is empty in CI, where the
 * checkout is clean. MUST be called BEFORE the generators run, or the schemas they rewrite appear
 * in the answer as inputs to their own drift.
 *
 * @returns {string[] | undefined} Repo-relative paths, or undefined when no base ref is known
 */
function driftInputs(): string[] | undefined {
  const working = nulList(git(["diff", "--name-only", "-z", "HEAD"]));
  const baseRef = process.env.BASE_REF;
  if (!baseRef) {
    return working.length > 0 ? working : undefined;
  }
  try {
    const base = git(["merge-base", `origin/${baseRef}`, "HEAD"]).trim();
    return [...new Set([...nulList(git(["diff", "--name-only", "-z", base, "HEAD"])), ...working])];
  } catch {
    return working.length > 0 ? working : undefined;
  }
}

async function appendTo(envVar: string, text: string): Promise<void> {
  const path = process.env[envVar];
  if (!path) {
    return;
  }
  const file = Bun.file(path);
  await Bun.write(path, ((await file.exists()) ? await file.text() : "") + text);
}

async function main(): Promise<void> {
  const fix = Bun.argv.includes("--fix");
  const reportAt = Bun.argv[Bun.argv.indexOf("--report") + 1];
  const wantsReport = Bun.argv.includes("--report") && reportAt && !reportAt.startsWith("--");

  const candidates = candidatePaths();
  // Snapshotted from the WORKING TREE rather than from HEAD, so the question is "is what is on
  // Disk fresh?" — the one a human about to commit is asking, and identical to the committed
  // Question in CI, where the tree is always clean. It also means the restore below writes back
  // Exactly what was there, so a gate run cannot destroy an uncommitted edit.
  const before = new Map<string, string | undefined>();
  await Promise.all(
    candidates.map(async (path) => {
      before.set(path, await readOrUndefined(path));
    }),
  );
  const dirtyBefore = dirtySet();
  // Before the generators run: afterwards the tree holds the schemas they rewrote, and those would
  // Read as inputs to their own drift.
  const inputs = driftInputs();

  for (const command of GENERATORS) {
    const run = Bun.spawnSync([...command], { stderr: "pipe", stdout: "pipe" });
    if (run.exitCode !== 0) {
      console.error(
        `${command.join(" ")} exited ${run.exitCode}. It failed to produce a schema:\n`,
      );
      console.error(run.stdout.toString());
      console.error(run.stderr.toString());
      console.error(
        "\nThat is a broken generator, not a stale artifact. Nothing was compared, and the working\n" +
          "tree may be half-written — check `git status` before trusting it.",
      );
      process.exit(1);
    }
  }

  const entries: DriftEntry[] = [];
  for (const path of candidates) {
    const generated = await readOrUndefined(path);
    if (generated === undefined || generated === before.get(path)) {
      continue;
    }
    entries.push(driftEntry(path, before.get(path), generated));
  }

  // A generator that wrote something the suffix rule did not anticipate. Reported rather than
  // Silently ignored, and never deleted: guessing wrong about someone else's file is worse than
  // Leaving one behind with its name printed.
  const surprises = [...dirtySet()].filter(
    (path) => !dirtyBefore.has(path) && !candidates.includes(path),
  );

  if (entries.length === 0 && surprises.length === 0) {
    console.log(
      `schema builds OK: all ${candidates.length} committed schemas match their generators.`,
    );
    if (wantsReport) {
      await Bun.write(reportAt, renderReport([], { fixed: fix }));
    }
    await appendTo("GITHUB_OUTPUT", "changed=false\ncount=0\n");
    process.exit(0);
  }

  const report = renderReport(entries, { changedInputs: inputs, fixed: fix });
  if (wantsReport) {
    await Bun.write(reportAt, report);
  }
  await appendTo("GITHUB_STEP_SUMMARY", `${report}\n`);
  await appendTo("GITHUB_OUTPUT", `changed=true\ncount=${entries.length}\n`);

  for (const entry of entries) {
    const { added, changed, removed } = entry.delta;
    console.log(
      `${fix ? "regenerated" : "STALE"} ${entry.path} ` +
        `(+${added.length} -${removed.length} ~${changed.length})`,
    );
  }
  for (const path of surprises) {
    console.log(`${fix ? "wrote" : "WROTE"} ${path} — no committed schema by that name`);
  }

  if (fix) {
    console.log(
      `\nRegenerated ${entries.length} schema(s); they are on disk. Commit them alongside whatever\n` +
        "moved them.",
    );
    process.exit(0);
  }

  // Restore, byte for byte, what the snapshot held. The gate answers a question; it does not get
  // To leave the answer lying in the tree — `bun run schema:sync` is how you ask for that.
  for (const entry of entries) {
    const { committed } = entry;
    if (committed === undefined) {
      rmSync(entry.path, { force: true });
    } else {
      await Bun.write(entry.path, committed);
    }
  }

  console.error(
    `\n${entries.length} committed schema(s) are not what their generators produce.\n` +
      "Editors, `jx validate`, `jx build` and every published `@jxsuite/schema` consumer read these\n" +
      "files off disk, so a stale one is a contract that says something the code does not.\n\n" +
      "Run `bun run schema:sync` and commit the result. On a pull request in this repository,\n" +
      ".github/workflows/schemas.yml does that for you and pushes it — see its comment for the\n" +
      "delta in pointers rather than in bytes.",
  );
  process.exit(1);
}

if (import.meta.main) {
  await main();
}
