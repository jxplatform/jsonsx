/**
 * Refactor-parity.test.ts — the read half and the write half must agree, on the same project.
 *
 * `findReferences` promises a count and `applyRename` fulfils it, through one shared walker and one
 * shared resolve-and-compare gate. Nothing asserted that they agreed, and for every media file
 * under `public/` they did not: the count said zero, so the rename dialog took its silent branch,
 * so the rewrite that also did nothing was never contradicted. Issue 239.
 *
 * A count that is wrong in the same direction as the rewrite is invisible. A count that is FIXED
 * while the rewrite stays broken is worse than either — Studio's dialog would then state, in a
 * modal the user has to accept, that N references will be updated automatically, and update none.
 * So this is one assertion over both halves.
 *
 * It runs against the committed starters rather than a hand-built fixture, because the shapes that
 * were missed are exactly the ones nobody thought to author into a fixture: `$props.bg` in a
 * markdown directive, `cover:` in content frontmatter, `defaults.layout` in project.json, and a
 * rooted `/images/x.jpg` naming a file that actually lives under `public/`.
 *
 * The registry is built with `buildProjectExtensionRegistry`, which is what the dev-server route
 * uses. `refactor-find-refs.test.ts` uses `buildProjectFormatRegistry`, which reports zero document
 * extensions for a project with no installed extensions — so its `documentGlob` was JSON-only and
 * no `.md` page was ever swept. That is the other half of why this class of bug survived.
 *
 * Counterpart: `packages/studio/tests/destructive-confirmations.test.ts` asserts the PROMISE the
 * dialog makes, against a mocked index. This asserts the fulfilment. Neither is sufficient alone.
 */

import { afterAll, describe, expect, test } from "bun:test";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { buildProjectExtensionRegistry } from "@jxsuite/compiler/format-host";
import { applyRename, findReferences, invalidateReferenceCache } from "../src/refactor/index";
import type { FormatRegistry } from "@jxsuite/schema/format-registry";
import type { ProjectConfig } from "@jxsuite/schema/types";

const STARTERS = join(import.meta.dir, "../../starters/sites");
const tmpRoots: string[] = [];

afterAll(() => {
  for (const dir of tmpRoots) {
    rmSync(dir, { force: true, recursive: true });
  }
});

/** Copy a committed starter to a scratch tree, so a rename can actually happen. */
function stage(starter: string): string {
  const root = mkdtempSync(join(tmpdir(), `jx-parity-${starter}-`));
  tmpRoots.push(root);
  cpSync(join(STARTERS, starter), root, {
    filter: (src) => !src.includes("node_modules"),
    recursive: true,
  });
  return root;
}

/** Every file under `root`, project-relative and forward-slashed, `node_modules` excluded. */
function allFiles(root: string, at = root, out: string[] = []): string[] {
  for (const entry of readdirSync(at, { withFileTypes: true })) {
    if (entry.name === "node_modules") {
      continue;
    }
    const p = join(at, entry.name);
    if (entry.isDirectory()) {
      allFiles(root, p, out);
    } else {
      out.push(relative(root, p).replaceAll("\\", "/"));
    }
  }
  return out;
}

const under = (files: string[], dir: string) => files.filter((f) => f.startsWith(`${dir}/`));

/** The text of every document, so one rename can be undone before the next is measured. */
function snapshotDocs(root: string): Map<string, string> {
  const snap = new Map<string, string>();
  for (const rel of allFiles(root)) {
    if (/\.(json|md|csv)$/.test(rel)) {
      snap.set(rel, readFileSync(join(root, rel), "utf8"));
    }
  }
  return snap;
}

/** Put every document back exactly as `snapshotDocs` found it. */
function restoreDocs(root: string, snap: Map<string, string>): void {
  for (const [rel, text] of snap) {
    if (readFileSync(join(root, rel), "utf8") !== text) {
      writeFileSync(join(root, rel), text);
    }
  }
}

async function registryFor(root: string): Promise<FormatRegistry> {
  const config = JSON.parse(readFileSync(join(root, "project.json"), "utf8")) as ProjectConfig;
  const extensions = await buildProjectExtensionRegistry(root, config);
  return extensions.formats;
}

/** `name.ext` → `name-renamed.ext`, project-relative. */
function renamedPath(rel: string): string {
  const dot = rel.lastIndexOf(".");
  const slash = rel.lastIndexOf("/");
  return dot > slash ? `${rel.slice(0, dot)}-renamed${rel.slice(dot)}` : `${rel}-renamed`;
}

/** Which documents still contain `needle` as raw text. Generated schemas are build output. */
function grepDocs(root: string, needle: string): string[] {
  const hits: string[] = [];
  for (const rel of allFiles(root)) {
    if (!/\.(json|md|csv)$/.test(rel) || rel.endsWith(".schema.json")) {
      continue;
    }
    if (readFileSync(join(root, rel), "utf8").includes(needle)) {
      hits.push(rel);
    }
  }
  return hits.toSorted();
}

/*
 * `portfolio` carries all three spellings of a rooted media reference — a JSON `attributes.src`, a
 * markdown directive prop, and content frontmatter — plus `defaults.layout` in project.json.
 * `real-estate` is the densest: a component, a page and a dynamic route all name `agent-1.jpg`.
 */
describe.each(["portfolio", "real-estate"])("%s — the count and the rewrite agree", (starter) => {
  test("every counted reference is a reference the rename actually rewrites", async () => {
    const root = stage(starter);
    const registry = await registryFor(root);
    const snap = snapshotDocs(root);
    const files = allFiles(root);
    const targets = [
      ...under(files, "public"),
      ...under(files, "components"),
      ...under(files, "layouts"),
    ].filter((p) => !p.endsWith(".schema.json"));
    expect(targets.length).toBeGreaterThan(10);

    let everCounted = 0;
    for (const target of targets) {
      invalidateReferenceCache(root);
      const before = await findReferences({ path: target, registry, root });
      if (before.refsTotal === 0) {
        continue;
      }
      everCounted += 1;

      const to = renamedPath(target);
      renameSync(join(root, target), join(root, to));
      const report = await applyRename({
        absFrom: join(root, target),
        absTo: join(root, to),
        registry,
        root,
      });
      renameSync(join(root, to), join(root, target));
      restoreDocs(root, snap);

      /*
       * The two mechanisms are asserted apart, because the report keeps them apart and the two
       * sides define the tag half differently ON PURPOSE.
       *
       * PATH references must agree exactly, modulo an honest remainder. That remainder is not
       * slack: a content source like `content/listings.csv` has a parser and deliberately no
       * serializer (it is read to load entries, never round-tripped as a document), so a
       * reference inside one can be counted but cannot be written. The engine names the file in
       * `report.errors` rather than dropping it, which is what lets the UI tell the truth — §4's
       * whole argument is that a promise the engine cannot keep must not be made silently.
       *
       * TAG references cannot agree exactly and should not: `findReferences` excludes the
       * component's own definition ("an unused component must not report 1"), while
       * `rewriteTagName` must rewrite that declaration or the rename would not take. So the tag
       * half is asserted as a floor plus the self-declaration.
       */
      const errored = new Set(report.errors.map((e) => e.path));
      const hits = before.files.flatMap((f) => f.refs.map((r) => ({ ...r, path: f.path })));
      const sum = (rows: typeof hits) => rows.reduce((n, r) => n + r.count, 0);
      const pathHits = hits.filter((r) => r.refType !== "tagName");
      const countedPathRefs = sum(pathHits);
      const unwritablePathRefs = sum(pathHits.filter((r) => errored.has(r.path)));
      const countedTagRefs = sum(hits.filter((r) => r.refType === "tagName"));

      // Labelled with the target so a failure names the file rather than just two integers.
      expect({
        rewrittenOrReported: report.references.refsUpdated + unwritablePathRefs,
        target,
      }).toEqual({ rewrittenOrReported: countedPathRefs, target });

      expect({ tagRewrites: report.tag?.refsUpdated ?? 0, target }).toEqual({
        tagRewrites: countedTagRefs === 0 ? 0 : countedTagRefs + 1,
        target,
      });
    }
    // Guard the guard: a run that counted nothing anywhere would satisfy every assertion above.
    expect(everCounted).toBeGreaterThan(5);
  }, 180_000);

  test("renaming a public asset leaves no document naming the old URL, and none naming /public/", async () => {
    const root = stage(starter);
    const registry = await registryFor(root);
    invalidateReferenceCache(root);

    // The most-referenced file under public/ — the one with the most ways to get it wrong.
    let best = { path: "", refs: 0 };
    for (const path of under(allFiles(root), "public")) {
      const result = await findReferences({ path, registry, root });
      if (result.refsTotal > best.refs) {
        best = { path, refs: result.refsTotal };
      }
    }
    expect(best.refs).toBeGreaterThan(1);

    const oldUrl = `/${best.path.slice("public/".length)}`;
    expect(grepDocs(root, oldUrl).length).toBeGreaterThan(0);

    const to = renamedPath(best.path);
    renameSync(join(root, best.path), join(root, to));
    const report = await applyRename({
      absFrom: join(root, best.path),
      absTo: join(root, to),
      registry,
      root,
    });
    const errored = report.errors.map((e) => e.path).toSorted();

    /* The old URL survives in EXACTLY the documents the report could not write, and nowhere else.
       Both halves matter: a leftover the report did not name is the silent breakage this issue is
       about, and a report naming a file it actually did rewrite would be a false alarm. */
    expect(grepDocs(root, oldUrl)).toEqual(errored);
    expect(report.references.refsUpdated).toBe(best.refs - errored.length);

    // The replacement is the URL a BUILD publishes. `/public/...` would 404 on the deployed site.
    expect(grepDocs(root, `/${to.slice("public/".length)}`).length).toBeGreaterThan(0);
    expect(grepDocs(root, "/public/")).toEqual([]);
  }, 180_000);
});
