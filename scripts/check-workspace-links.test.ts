/**
 * The workspace-link gate (`scripts/check-workspace-links.ts`).
 *
 * Everything runs against fixture trees rather than this repo's own `node_modules`: asserting "the
 * monorepo has N stale links" would go red the moment someone installs, and the live-tree assertion
 * is `bun run links:check` anyway. What these pin down is the one judgement that decides whether a
 * delete is a fix or a breakage — a nested copy exists either because an install could not hoist it
 * (keep) or because an install layout this repo abandoned left it behind (remove).
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findStaleLinks,
  isDeadStoreLink,
  removeStaleLink,
  staleLinksIn,
  workspacesWithLinks,
} from "./check-workspace-links";

/** Write a package manifest at `dir`. */
function manifest(dir: string, body: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(body), "utf8");
}

/** A repo root with a bunfig selecting `linker`, and the given root-level installs. */
function repo(linker: "hoisted" | "isolated", rootDeps: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "jx-links-"));
  writeFileSync(join(root, "bunfig.toml"), `[install]\nlinker = "${linker}"\n`, "utf8");
  for (const [name, version] of Object.entries(rootDeps)) {
    manifest(join(root, "node_modules", ...name.split("/")), { name, version });
  }
  return root;
}

/** A workspace declaring `deps`, with `installed` materialised under its own `node_modules`. */
function workspace(
  root: string,
  name: string,
  deps: Record<string, string>,
  installed: Record<string, string> = {},
): string {
  const dir = join(root, "packages", name);
  manifest(dir, { dependencies: deps, name: `@jxsuite/${name}`, version: "1.0.0" });
  for (const [dep, version] of Object.entries(installed)) {
    manifest(join(dir, "node_modules", ...dep.split("/")), { name: dep, version });
  }
  return dir;
}

describe("staleLinksIn — the manifest decides", () => {
  /*
   * The defect this exists for: `packages/schema` answered `@webref/css` with 8.5.8 against a
   * declared `^8.7.1`, so the schema generator dropped every CSS property added since — silently,
   * because a build against the wrong code still succeeds.
   */
  test("a nested copy the declared range rules out is stale", () => {
    const root = repo("hoisted", { "@webref/css": "8.7.1" });
    try {
      const ws = workspace(root, "schema", { "@webref/css": "^8.7.1" }, { "@webref/css": "8.5.8" });

      const stale = staleLinksIn(ws, root);

      expect(stale).toHaveLength(1);
      expect(stale[0]).toMatchObject({
        declared: "^8.7.1",
        reason: "unsatisfied",
        root: "8.7.1",
        specifier: "@webref/css",
        version: "8.5.8",
      });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  /*
   * The case a blunter rule would delete. `packages/import` pins puppeteer-core to a major the root
   * has moved past, so its own copy is the ONLY correct answer — "differs from the root" is not
   * evidence of staleness.
   */
  test("a nested copy that satisfies the declared range survives, root or no root", () => {
    const root = repo("hoisted", { "puppeteer-core": "25.7.0" });
    try {
      const ws = workspace(
        root,
        "import",
        { "puppeteer-core": "^24.9.0" },
        { "puppeteer-core": "24.9.1" },
      );

      expect(staleLinksIn(ws, root)).toEqual([]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  // A workspace link resolves back into this repo, so it is right by construction.
  test("a workspace: range is never judged", () => {
    const root = repo("hoisted");
    try {
      const ws = workspace(
        root,
        "compiler",
        { "@jxsuite/schema": "workspace:^" },
        { "@jxsuite/schema": "0.0.1" },
      );

      expect(staleLinksIn(ws, root)).toEqual([]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  // A half-written install has no version to judge; deleting on that guess would be the worse bug.
  test("an unreadable manifest is left alone rather than guessed at", () => {
    const root = repo("hoisted", { "some-dep": "2.0.0" });
    try {
      const ws = workspace(root, "server", { "some-dep": "^2.0.0" });
      mkdirSync(join(ws, "node_modules", "some-dep"), { recursive: true });

      expect(staleLinksIn(ws, root)).toEqual([]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("a workspace with no node_modules of its own has nothing to report", () => {
    const root = repo("hoisted");
    try {
      expect(staleLinksIn(workspace(root, "markup", { dep: "^1.0.0" }), root)).toEqual([]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

describe("the dead-store rule — leftovers nothing declares", () => {
  /** Link `specifier` in `ws` at a store entry under `root`. */
  function storeLink(root: string, ws: string, specifier: string, version: string): string {
    const store = join(root, "node_modules", ".bun", `${specifier}@${version}`, "node_modules");
    manifest(join(store, specifier), { name: specifier, version });
    const link = join(ws, "node_modules", specifier);
    mkdirSync(join(ws, "node_modules"), { recursive: true });
    symlinkSync(join(store, specifier), link);
    return link;
  }

  /*
   * A transitive leftover has no declared range to judge, so it is judged by the layout it belongs
   * to: the isolated linker's store, which a hoisted repo no longer writes to or reads from.
   */
  test("a symlink into the isolated store is stale when the repo links hoisted", () => {
    const root = repo("hoisted", { glob: "13.0.6" });
    try {
      const ws = workspace(root, "compiler", {});
      const link = storeLink(root, ws, "glob", "10.0.0");

      expect(isDeadStoreLink(link, root)).toBe(true);
      expect(staleLinksIn(ws, root)).toMatchObject([
        { reason: "dead-store-link", version: "10.0.0" },
      ]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  // Switching back must make the rule stop firing, not delete the layout the switch just asked for.
  test("the same link is left alone when the repo links isolated", () => {
    const root = repo("isolated", { glob: "13.0.6" });
    try {
      const ws = workspace(root, "compiler", {});
      const link = storeLink(root, ws, "glob", "10.0.0");

      expect(isDeadStoreLink(link, root)).toBe(false);
      expect(staleLinksIn(ws, root)).toEqual([]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("a real directory nothing declares is not a store leftover", () => {
    const root = repo("hoisted", { glob: "13.0.6" });
    try {
      const ws = workspace(root, "compiler", {}, { glob: "10.0.0" });

      expect(staleLinksIn(ws, root)).toEqual([]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

describe("removeStaleLink", () => {
  /*
   * The entry, never the tree. A workspace's `node_modules` may also hold the copy that IS the
   * right answer, and resolution falls through to the root the moment the stale one is gone — so
   * no reinstall is needed, and no correct copy is taken with it.
   */
  test("removes the entry, keeps its neighbours, and tidies an emptied scope", () => {
    const root = repo("hoisted", { "@webref/css": "8.7.1" });
    try {
      const ws = workspace(
        root,
        "schema",
        { "@webref/css": "^8.7.1", "@webref/idl": "^3.0.0", keeper: "^1.0.0" },
        { "@webref/css": "8.5.8", "@webref/idl": "3.1.0", keeper: "1.0.2" },
      );
      const [stale] = staleLinksIn(ws, root);

      removeStaleLink(stale!);

      expect(existsSync(join(ws, "node_modules", "@webref", "css"))).toBe(false);
      // Its neighbour in the same scope satisfies its range, so the scope directory stays.
      expect(existsSync(join(ws, "node_modules", "@webref", "idl"))).toBe(true);
      expect(existsSync(join(ws, "node_modules", "keeper"))).toBe(true);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("a scope left empty is removed with its last entry", () => {
    const root = repo("hoisted", { "@webref/css": "8.7.1" });
    try {
      const ws = workspace(root, "schema", { "@webref/css": "^8.7.1" }, { "@webref/css": "8.5.8" });
      const [stale] = staleLinksIn(ws, root);

      removeStaleLink(stale!);

      expect(existsSync(join(ws, "node_modules", "@webref"))).toBe(false);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("an unscoped entry leaves no scope directory to tidy", () => {
    const root = repo("hoisted", { lodash: "4.17.21" });
    try {
      const ws = workspace(root, "server", { lodash: "^4.17.21" }, { lodash: "3.10.1" });
      const [stale] = staleLinksIn(ws, root);

      removeStaleLink(stale!);

      expect(existsSync(join(ws, "node_modules", "lodash"))).toBe(false);
      expect(existsSync(join(ws, "node_modules"))).toBe(true);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

describe("walking the repo", () => {
  test("finds only workspaces that have a node_modules of their own", () => {
    const root = repo("hoisted", { dep: "2.0.0" });
    try {
      const withLinks = workspace(root, "schema", { dep: "^2.0.0" }, { dep: "1.0.0" });
      workspace(root, "markup", { dep: "^2.0.0" });
      mkdirSync(join(root, "extensions"), { recursive: true });

      expect(workspacesWithLinks(root)).toEqual([withLinks]);
      expect(findStaleLinks(workspacesWithLinks(root), root)).toHaveLength(1);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("a repo with neither workspace parent reports nothing", () => {
    const root = mkdtempSync(join(tmpdir(), "jx-links-bare-"));
    try {
      expect(workspacesWithLinks(root)).toEqual([]);
      expect(findStaleLinks([], root)).toEqual([]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
