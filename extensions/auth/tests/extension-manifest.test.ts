/**
 * Extension-package surface tests (specs/extensions.md §4–§5, mirroring
 * extensions/connector/tests/extension-manifest.test.ts): the manifest validates against the
 * generated extension-manifest schema, every class descriptor exists and carries the expected
 * admission blocks (auth mounts at order 10, BEFORE the connector's data mount at 20), and the
 * project fragment is a standalone-valid 2020-12 document contributing the `auth` section.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020";

const require = createRequire(import.meta.url);

const MANIFEST_PATH = resolve(import.meta.dir, "../jx-extension.json");

function loadJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

const manifest = loadJson(MANIFEST_PATH) as {
  name: string;
  title: string;
  classes: Record<string, string>;
  schemas: { project: string };
};

describe("jx-extension.json manifest", () => {
  test("validates against the extension-manifest schema", () => {
    const schema = loadJson(require.resolve("@jxsuite/schema/extension-manifest.schema.json"));
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const validate = ajv.compile(schema);
    expect(validate(manifest)).toBe(true);
  });

  test("carries the package name and is wired through package.json", () => {
    const pkg = loadJson(resolve(import.meta.dir, "../package.json")) as {
      name: string;
      jx: string;
      exports: Record<string, string>;
      files: string[];
      dependencies: Record<string, string>;
    };
    expect(manifest.name).toBe(pkg.name);
    expect(pkg.jx).toBe("./jx-extension.json");
    expect(pkg.exports["./jx-extension.json"]).toBe("./jx-extension.json");
    expect(pkg.exports["./worker"]).toBe("./src/worker.ts");
    expect(pkg.exports["./schemas/project.fragment.schema.json"]).toBeDefined();
    expect(pkg.files).toContain("jx-extension.json");
    expect(pkg.files).toContain("schemas/");
    // Better Auth is pinned to the exact verified version (plan Part 4b).
    expect(pkg.dependencies["better-auth"]).toBe("1.6.23");
    expect(pkg.dependencies["@jxsuite/connector"]).toBe("workspace:^");
    // Every class descriptor is addressable through the exports map.
    for (const ref of Object.values(manifest.classes)) {
      const exportKey = ref.replace("./src/", "./");
      expect(pkg.exports[exportKey]).toBe(ref);
    }
  });

  test("every classes entry points at an existing descriptor", () => {
    expect(Object.keys(manifest.classes).toSorted()).toEqual(["Auth", "AuthActions", "Session"]);
    for (const ref of Object.values(manifest.classes)) {
      const classPath = resolve(dirname(MANIFEST_PATH), ref);
      expect(existsSync(classPath)).toBe(true);
    }
  });

  test("admission blocks: the auth section owner mounts /_jx/auth at order 10", () => {
    const classDef = (name: string) =>
      loadJson(resolve(dirname(MANIFEST_PATH), manifest.classes[name]!));

    const auth = classDef("Auth") as {
      project: { key: string };
      server: { basePath: string; order: number; module: string };
      $studio: { settings: { layout: string; entry: { ui: Record<string, unknown> } } };
      $defs: { methods: Record<string, { role?: string; timing?: string[] }> };
    };
    expect(auth.project.key).toBe("auth");
    expect(auth.server).toEqual({
      basePath: "/_jx/auth",
      module: "@jxsuite/auth/worker",
      order: 10,
    });
    // Order 10 < the connector data mount's 20: ctx.auth exists before the data mount reads it.
    expect(auth.server.order).toBeLessThan(20);
    expect(auth.$studio.settings.layout).toBe("form");
    expect(auth.$studio.settings.entry.ui).toMatchObject({ secretEnv: { control: "secret" } });
    expect(auth.$defs.methods.mount!.role).toBe("mount");
    expect(auth.$defs.methods.mount!.timing).toEqual(["server"]);
    expect(auth.$defs.methods.deploySchema!.role).toBe("deploySchema");
    expect(auth.$defs.methods.projectData!.role).toBe("projectData");

    for (const stateClass of ["Session", "AuthActions"]) {
      const def = classDef(stateClass) as {
        $studio: { stateDefaults: Record<string, unknown> };
        project?: unknown;
        server?: unknown;
        connector?: unknown;
      };
      expect(def.$studio.stateDefaults).toEqual({ timing: "client" });
      // Plain state classes: no admission blocks.
      expect(def.project).toBeUndefined();
      expect(def.server).toBeUndefined();
      expect(def.connector).toBeUndefined();
    }
  });
});

describe("project fragment", () => {
  const fragment = loadJson(resolve(import.meta.dir, "../schemas/project.fragment.schema.json"));

  test("is a standalone-valid 2020-12 document contributing the auth section", () => {
    expect(fragment.$id).toBe("https://jxsuite.com/schema/ext/auth/project/v1");
    expect(fragment.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    const properties = fragment.properties as Record<string, unknown>;
    expect(Object.keys(properties)).toEqual(["auth"]);
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    expect(() => ajv.compile(fragment)).not.toThrow();
  });

  test("accepts a full auth section and carries env NAMES only", () => {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const validate = ajv.compile(fragment);
    expect(
      validate({
        auth: {
          connection: "main",
          methods: { emailPassword: true },
          providers: { github: { clientIdEnv: "GH_ID", clientSecretEnv: "GH_SECRET" } },
          redirects: { afterSignIn: "/", afterSignOut: "/" },
          roles: ["admin", "editor"],
          secretEnv: "BETTER_AUTH_SECRET",
          trustedOrigins: ["https://example.com"],
        },
      }),
    ).toBe(true);
    expect(validate({ auth: { roles: "admin" } })).toBe(false);

    // No property of the fragment is named like a secret VALUE — env names only by design.
    const source = JSON.stringify(fragment);
    expect(source).not.toMatch(/"clientSecret"|"secret"\s*:/);
  });
});
