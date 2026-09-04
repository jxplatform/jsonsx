/**
 * The expensive failure here is a catalogue that advertises something the registry cannot load. So
 * the tests that matter most are the ones asserting the generator still REFUSES: a package whose
 * exports map omits the manifest, two extensions claiming one section key, and an extension the
 * docs page never documents.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { buildCatalog, serializeCatalog } from "./check-extension-catalog.ts";

interface FakeExtension {
  dir: string;
  name: string;
  title?: string;
  description?: string;
  jx?: string | null;
  exportsManifest?: boolean;
  classes?: Record<string, Record<string, unknown>>;
  dependencies?: Record<string, string>;
  heading?: string | null;
}

/** A throwaway repo root with an extensions/ tree and the first-party docs page. */
function tree(extensions: FakeExtension[]): string {
  const root = mkdtempSync(join(tmpdir(), "jx-catalog-"));

  const headings = extensions
    .filter((e) => e.heading !== null)
    .map((e) => `## ${e.heading ?? `${e.name}: what it does`}\n\nProse.\n`)
    .join("\n");
  mkdirSync(join(root, "docs/extending/extensions"), { recursive: true });
  writeFileSync(
    join(root, "docs/extending/extensions/first-party.md"),
    `---\ntitle: "First-party extensions"\n---\n\n# First-party extensions\n\n${headings}`,
  );

  for (const ext of extensions) {
    const dir = join(root, "extensions", ext.dir);
    mkdirSync(join(dir, "src"), { recursive: true });
    const classes: Record<string, string> = {};
    for (const [className, descriptor] of Object.entries(ext.classes ?? {})) {
      classes[className] = `./src/${className}.class.json`;
      writeFileSync(join(dir, "src", `${className}.class.json`), JSON.stringify(descriptor));
    }
    writeFileSync(
      join(dir, "jx-extension.json"),
      JSON.stringify({
        classes,
        description: ext.description ?? `${ext.name} does a thing`,
        name: ext.name,
        title: ext.title ?? "Thing",
      }),
    );
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        ...(ext.dependencies ? { dependencies: ext.dependencies } : {}),
        ...(ext.jx === null ? {} : { jx: ext.jx ?? "./jx-extension.json" }),
        exports:
          ext.exportsManifest === false
            ? { ".": "./src/index.ts" }
            : { "./jx-extension.json": "./jx-extension.json" },
        name: ext.name,
      }),
    );
  }
  return root;
}

function withTree<T>(extensions: FakeExtension[], fn: (root: string) => T): T {
  const root = tree(extensions);
  try {
    return fn(root);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

const CONTENT = { project: { key: "content", title: "Content Types" } };

describe("buildCatalog", () => {
  test("derives identity, sections and formats from the manifest and its classes", () => {
    withTree(
      [
        {
          classes: {
            Content: CONTENT,
            Markdown: { format: { extensions: [".md"] } },
          },
          description: "Content collections",
          dir: "parser",
          name: "@jxsuite/parser",
          title: "Content & Markdown",
        },
      ],
      (root) => {
        const [entry] = buildCatalog(root);
        expect(entry?.name).toBe("@jxsuite/parser");
        expect(entry?.title).toBe("Content & Markdown");
        expect(entry?.description).toBe("Content collections");
        expect(entry?.sections).toEqual([{ key: "content", title: "Content Types" }]);
        expect(entry?.formats).toEqual([".md"]);
        expect(entry?.docs).toBe(
          "/docs/extending/extensions/first-party#jxsuiteparser-what-it-does",
        );
      },
    );
  });

  test("a class with no project block contributes no section", () => {
    withTree(
      [{ classes: { Session: { title: "Session" } }, dir: "auth", name: "@jxsuite/auth" }],
      (root) => {
        expect(buildCatalog(root)[0]?.sections).toEqual([]);
      },
    );
  });

  test("requires picks up an extension-to-extension edge and ignores core packages", () => {
    withTree(
      [
        {
          dependencies: { "@jxsuite/connector": "workspace:^", "@jxsuite/schema": "workspace:^" },
          dir: "auth",
          name: "@jxsuite/auth",
        },
        { dir: "connector", name: "@jxsuite/connector" },
      ],
      (root) => {
        const catalog = buildCatalog(root);
        expect(catalog[0]?.requires).toEqual(["@jxsuite/connector"]);
        // Not an edge, so the key is absent rather than an empty array.
        expect(catalog[1]).not.toHaveProperty("requires");
      },
    );
  });

  test("is sorted by package name", () => {
    withTree(
      [
        { dir: "search", name: "@jxsuite/search" },
        { dir: "auth", name: "@jxsuite/auth" },
      ],
      (root) => {
        expect(buildCatalog(root).map((e) => e.name)).toEqual(["@jxsuite/auth", "@jxsuite/search"]);
      },
    );
  });
});

describe("the refusals", () => {
  test("a package whose exports map omits the manifest fails by name", () => {
    withTree([{ dir: "half", exportsManifest: false, name: "@acme/jx-half" }], (root) => {
      expect(() => buildCatalog(root)).toThrow(/exports must include "\.\/jx-extension\.json"/);
    });
  });

  test("a package with no jx field fails by name", () => {
    withTree([{ dir: "nojx", jx: null, name: "@acme/jx-nojx" }], (root) => {
      expect(() => buildCatalog(root)).toThrow(/must declare "jx"/);
    });
  });

  test("a manifest whose name disagrees with package.json fails", () => {
    const root = tree([{ dir: "drift", name: "@acme/jx-drift" }]);
    try {
      writeFileSync(
        join(root, "extensions/drift/jx-extension.json"),
        JSON.stringify({ classes: {}, description: "d", name: "@acme/other", title: "t" }),
      );
      expect(() => buildCatalog(root)).toThrow(/does not match package\.json/);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("two extensions claiming one section key fails, naming both", () => {
    withTree(
      [
        { classes: { A: CONTENT }, dir: "one", heading: "@acme/one: a", name: "@acme/one" },
        { classes: { B: CONTENT }, dir: "two", heading: "@acme/two: b", name: "@acme/two" },
      ],
      (root) => {
        expect(() => buildCatalog(root)).toThrow(/"content" is claimed by both/);
      },
    );
  });

  test("an extension the docs page never documents fails by name", () => {
    withTree([{ dir: "feed", heading: null, name: "@jxsuite/feed" }], (root) => {
      expect(() => buildCatalog(root)).toThrow(/documents no section for "@jxsuite\/feed"/);
    });
  });

  test("a manifest missing a title or description fails", () => {
    const root = tree([{ dir: "bare", name: "@acme/jx-bare" }]);
    try {
      writeFileSync(
        join(root, "extensions/bare/jx-extension.json"),
        JSON.stringify({ classes: {}, name: "@acme/jx-bare" }),
      );
      expect(() => buildCatalog(root)).toThrow(/must declare a "title" and a "description"/);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("a class descriptor the manifest names but the tree lacks fails", () => {
    const root = tree([{ dir: "gone", name: "@acme/jx-gone" }]);
    try {
      writeFileSync(
        join(root, "extensions/gone/jx-extension.json"),
        JSON.stringify({
          classes: { Missing: "./src/Missing.class.json" },
          description: "d",
          name: "@acme/jx-gone",
          title: "t",
        }),
      );
      expect(() => buildCatalog(root)).toThrow(/does not exist/);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("a tree with no extensions/ directory fails rather than writing an empty catalogue", () => {
    const root = mkdtempSync(join(tmpdir(), "jx-catalog-empty-"));
    try {
      expect(() => buildCatalog(root)).toThrow(/No extensions\/ directory/);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

describe("serializeCatalog", () => {
  test("is idempotent — the property that lets the backfill lane terminate", () => {
    withTree([{ dir: "feed", name: "@jxsuite/feed" }], (root) => {
      const once = serializeCatalog(buildCatalog(root));
      const twice = serializeCatalog(buildCatalog(root));
      expect(once).toBe(twice);
    });
  });

  test("ends with a newline, so the committed file is POSIX-clean", () => {
    withTree([{ dir: "feed", name: "@jxsuite/feed" }], (root) => {
      expect(serializeCatalog(buildCatalog(root)).endsWith("]\n")).toBe(true);
    });
  });
});

describe("the live tree", () => {
  test("the real extensions/ tree builds, and every entry is documented", () => {
    const catalog = buildCatalog(".");
    expect(catalog.length).toBeGreaterThanOrEqual(5);
    for (const entry of catalog) {
      expect(entry.docs.startsWith("/docs/extending/extensions/first-party#")).toBe(true);
    }
  });
});
