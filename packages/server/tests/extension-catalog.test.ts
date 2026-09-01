/**
 * The catalogue's job is to never advertise something the registry would refuse. So the tests that
 * matter are the ones about a package that is present but unusable, and the one asserting the
 * catalogue still answers for a project whose own `extensions` array is broken.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildExtensionCatalog } from "../src/extension-catalog.ts";

interface FakeDep {
  name: string;
  /** Omit to write no exports entry for the manifest — the "declared but unresolvable" case. */
  exportsManifest?: boolean;
  jx?: boolean;
  manifest?: Record<string, unknown> | null;
  classes?: Record<string, Record<string, unknown>>;
}

/** A project root with a package.json and a hand-built node_modules. */
function project(deps: FakeDep[], projectJson: Record<string, unknown> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "jx-srv-catalog-"));
  const dependencies = Object.fromEntries(deps.map((d) => [d.name, "^1.0.0"]));
  writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies, name: "site" }));
  writeFileSync(join(root, "project.json"), JSON.stringify({ name: "site", ...projectJson }));

  for (const dep of deps) {
    const dir = join(root, "node_modules", ...dep.name.split("/"));
    mkdirSync(join(dir, "src"), { recursive: true });
    const classes: Record<string, string> = {};
    for (const [className, descriptor] of Object.entries(dep.classes ?? {})) {
      classes[className] = `./src/${className}.class.json`;
      writeFileSync(join(dir, "src", `${className}.class.json`), JSON.stringify(descriptor));
    }
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        exports:
          dep.exportsManifest === false
            ? { ".": "./src/index.js" }
            : { ".": "./src/index.js", "./jx-extension.json": "./jx-extension.json" },
        ...(dep.jx === false ? {} : { jx: "./jx-extension.json" }),
        name: dep.name,
        version: "1.0.0",
      }),
    );
    if (dep.manifest !== null) {
      writeFileSync(
        join(dir, "jx-extension.json"),
        JSON.stringify(
          dep.manifest ?? {
            classes,
            description: "A third-party thing",
            name: dep.name,
            title: "Third Party",
          },
        ),
      );
    }
  }
  return root;
}

async function withProject<T>(
  deps: FakeDep[],
  fn: (root: string) => Promise<T>,
  projectJson?: Record<string, unknown>,
): Promise<T> {
  const root = project(deps, projectJson);
  try {
    return await fn(root);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

describe("the first-party half", () => {
  test("every shipped extension is offered, installed or not", async () => {
    await withProject([], async (root) => {
      const catalog = await buildExtensionCatalog(root);
      const firstParty = catalog.filter((e) => e.source === "first-party");
      expect(firstParty.length).toBeGreaterThanOrEqual(5);
      expect(firstParty.map((e) => e.name)).toContain("@jxsuite/parser");
      for (const entry of firstParty) {
        expect(entry.title).toBeTruthy();
        expect(entry.description).toBeTruthy();
        expect(entry.docs).toBeTruthy();
      }
    });
  });

  test("an extension the project has not installed still carries its sections", async () => {
    await withProject([], async (root) => {
      const catalog = await buildExtensionCatalog(root);
      const parser = catalog.find((e) => e.name === "@jxsuite/parser");
      // The field that says what enabling it would DO, available before it is installed — which is
      // The whole reason it rides the catalogue rather than being read off listExtensions.
      expect(parser?.sections).toEqual([{ key: "content", title: "Content Types" }]);
      expect(parser?.installed).toBe(false);
    });
  });

  test("auth declares the connector it requires", async () => {
    await withProject([], async (root) => {
      const catalog = await buildExtensionCatalog(root);
      const auth = catalog.find((e) => e.name === "@jxsuite/auth");
      expect(auth?.requires).toEqual(["@jxsuite/connector"]);
    });
  });
});

describe("the discovered half", () => {
  test("a dependency exporting a manifest is offered with its own sections", async () => {
    await withProject(
      [
        {
          classes: { Guestbook: { project: { key: "guestbook", title: "Guestbook" } } },
          name: "@acme/jx-guestbook",
        },
      ],
      async (root) => {
        const catalog = await buildExtensionCatalog(root);
        const entry = catalog.find((e) => e.name === "@acme/jx-guestbook");
        expect(entry?.source).toBe("project");
        expect(entry?.installed).toBe(true);
        expect(entry?.title).toBe("Third Party");
        expect(entry?.sections).toEqual([{ key: "guestbook", title: "Guestbook" }]);
        expect(entry?.problem).toBeUndefined();
      },
    );
  });

  test('a dependency declaring "jx" without the exports entry is reported, not dropped', async () => {
    await withProject([{ exportsManifest: false, name: "@acme/jx-half" }], async (root) => {
      const catalog = await buildExtensionCatalog(root);
      const entry = catalog.find((e) => e.name === "@acme/jx-half");
      // A package the reader installed on purpose must not vanish with no explanation.
      expect(entry).toBeDefined();
      expect(entry?.problem).toContain("does not export");
      expect(entry?.sections).toEqual([]);
    });
  });

  test("a dependency that is not an extension at all produces no entry", async () => {
    await withProject(
      [{ exportsManifest: false, jx: false, manifest: null, name: "lodash" }],
      async (root) => {
        const catalog = await buildExtensionCatalog(root);
        expect(catalog.find((e) => e.name === "lodash")).toBeUndefined();
      },
    );
  });

  test("a manifest the registry refuses is reported with the loader's own message", async () => {
    await withProject(
      // The manifest name disagrees with the specifier, which the registry rejects by name.
      [{ manifest: { classes: {}, name: "@acme/other" }, name: "@acme/jx-drift" }],
      async (root) => {
        const catalog = await buildExtensionCatalog(root);
        const entry = catalog.find((e) => e.name === "@acme/jx-drift");
        expect(entry?.problem).toContain("does not match the specifier");
      },
    );
  });

  test("a discovered format extension reports the file extensions it claims", async () => {
    await withProject(
      [
        {
          classes: {
            Toml: {
              format: { extensions: [".toml"], documentKinds: ["page"] },
              title: "Toml",
            },
          },
          name: "@acme/jx-toml",
        },
      ],
      async (root) => {
        const catalog = await buildExtensionCatalog(root);
        const entry = catalog.find((e) => e.name === "@acme/jx-toml");
        expect(entry?.formats).toEqual([".toml"]);
      },
    );
  });

  test("a dependency declared but never installed produces no entry", async () => {
    // Package.json names it; node_modules does not have it. Nothing can be said about it, and a
    // Row for a package that is not there would be a row whose toggle could not work.
    const root = mkdtempSync(join(tmpdir(), "jx-srv-phantom-"));
    try {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ dependencies: { "@acme/jx-ghost": "^1.0.0" }, name: "site" }),
      );
      const catalog = await buildExtensionCatalog(root);
      expect(catalog.find((e) => e.name === "@acme/jx-ghost")).toBeUndefined();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("a first-party package installed in the project is not duplicated", async () => {
    await withProject([{ classes: {}, name: "@jxsuite/feed" }], async (root) => {
      const catalog = await buildExtensionCatalog(root);
      const rows = catalog.filter((e) => e.name === "@jxsuite/feed");
      expect(rows.length).toBe(1);
      expect(rows[0]?.source).toBe("first-party");
      expect(rows[0]?.installed).toBe(true);
    });
  });
});

describe("the catalogue answers when the project cannot build", () => {
  test("a project.json naming an unresolvable extension still gets a full catalogue", async () => {
    /*
     * The assertion that encodes why this is not a field on /__studio/formats. That route builds
     * the project's registry and fails on exactly this input — which is the state a reader is in
     * when they need the catalogue to repair it.
     */
    await withProject(
      [],
      async (root) => {
        const catalog = await buildExtensionCatalog(root);
        expect(catalog.length).toBeGreaterThanOrEqual(5);
      },
      { extensions: ["@acme/does-not-exist"] },
    );
  });

  test("a project with no package.json still gets the first-party half", async () => {
    const root = mkdtempSync(join(tmpdir(), "jx-srv-bare-"));
    try {
      const catalog = await buildExtensionCatalog(root);
      expect(catalog.length).toBeGreaterThanOrEqual(5);
      expect(catalog.every((e) => e.source === "first-party")).toBe(true);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("an unparseable package.json costs the discovered half, not the response", async () => {
    const root = mkdtempSync(join(tmpdir(), "jx-srv-broken-"));
    try {
      writeFileSync(join(root, "package.json"), "{ not json");
      const catalog = await buildExtensionCatalog(root);
      expect(catalog.length).toBeGreaterThanOrEqual(5);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
