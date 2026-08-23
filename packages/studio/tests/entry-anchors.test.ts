/**
 * The `import.meta.url` rule — the durable half of the bundle-base fix.
 *
 * The bug it guards is not a bug in any expression; it is a bug in WHERE an expression sits. `new
 * URL("workers/…", import.meta.url)` was correct when `services/monaco-setup` was part of the
 * entry, and became wrong the moment `splitting: true` hoisted it into
 * `dist/chunks/monaco-setup-<hash>.js`. Nothing failed, nothing logged: Monaco's workers 404'd and
 * the JSON language service simply stopped existing.
 *
 * So the rule is structural rather than behavioural — only an ENTRY may consult its own url, and
 * every other module goes through `services/bundle-base`. A source assertion is the right shape
 * here: it needs no build, it survives the next refactor that moves a module between chunks, and it
 * fails in the pull request that reintroduces the hazard rather than in a browser nobody is
 * watching.
 *
 * Fails BOTH ways, in this package's idiom (`scripts/check-pane-singletons.ts`): a new
 * `import.meta.url` outside the allow-list fails, and an entry that stops anchoring fails too.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";

const SRC = join(import.meta.dir, "..", "src");

/** The two entrypoints, from scripts/build-config.ts's STUDIO_ENTRYPOINTS. */
const ENTRIES = ["studio.ts", "canvas/iframe-entry.ts"];

/**
 * Modules permitted to mention `import.meta.url`, each with the reason.
 *
 * Only ever shrinks. An entry earns its place by having a CONTRACTUAL emitted path (studio.md §11.1
 * — the two entries land flat at `dist/<name>.js` and are never hashed); nothing else does.
 */
const ALLOWED: Record<string, string> = {
  "studio.ts": "Entry. Anchors the bundle base for every other module.",
  "canvas/iframe-entry.ts": "Entry, in the canvas realm. Same anchor, its own document.",
  "services/bundle-base.ts": "Owns the base. Mentions the term only in prose.",
};

function sourceFiles(): string[] {
  return [...new Glob("**/*.ts").scanSync(SRC)].map((f) => f.replaceAll("\\", "/")).toSorted();
}

/** `import.meta.url` outside a comment — the thing that actually resolves at runtime. */
function usesImportMetaUrl(source: string): boolean {
  const withoutComments = source
    .replaceAll(/\/\*[\s\S]*?\*\//g, "")
    .replaceAll(/^[ \t]*\/\/.*$/gm, "");
  return /\bimport\.meta\.url\b/.test(withoutComments);
}

describe("entry anchors", () => {
  for (const entry of ENTRIES) {
    test(`${entry} calls setBundleBase(import.meta.url)`, () => {
      const source = readFileSync(join(SRC, entry), "utf8");
      expect(source).toContain("setBundleBase(import.meta.url)");
    });
  }

  test("no module outside the allow-list resolves against its own url", () => {
    const offenders = sourceFiles().filter(
      (file) => !(file in ALLOWED) && usesImportMetaUrl(readFileSync(join(SRC, file), "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  /* The list ratchets down. An entry that stops needing the anchor should lose its row, and a stale
     row would otherwise sit here asserting a permission nobody uses. */
  test("every allow-list entry is still a module that mentions it", () => {
    const stale = Object.keys(ALLOWED).filter((file) => {
      const source = readFileSync(join(SRC, file), "utf8");
      return !/\bimport\.meta\.url\b/.test(source);
    });
    expect(stale).toEqual([]);
  });

  test("the allow-list names files that exist", () => {
    const files = new Set(sourceFiles());
    expect(Object.keys(ALLOWED).filter((f) => !files.has(f))).toEqual([]);
  });
});
