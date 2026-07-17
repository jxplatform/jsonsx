import { describe, expect, test } from "bun:test";
import { EXTENSION_MANIFEST, buildExtensionRegistry } from "../src/extension-registry";
import type { FormatHostIO } from "../src/extension-registry";

const MD_CLASS = {
  $defs: {
    methods: {
      load: { identifier: "load", role: "load", scope: "static" },
      parse: { identifier: "parse", role: "parse", scope: "static" },
    },
  },
  $implementation: "./md.js",
  format: { documentKinds: ["content"], extensions: [".md"] },
  title: "Md",
};

const TABLES_CLASS = {
  $defs: {
    methods: {
      emit: { identifier: "emit", role: "emit", scope: "static", timing: ["compiler"] },
      projectData: { identifier: "projectData", role: "projectData", scope: "static" },
      resolvePaths: {
        discriminator: "table",
        identifier: "resolvePaths",
        role: "resolvePaths",
        scope: "static",
      },
    },
  },
  $implementation: "./tables.js",
  project: { key: "data", referenceable: true, title: "Tables" },
  title: "Tables",
};

const D1_CLASS = {
  $defs: {
    methods: {
      dialect: { identifier: "dialect", role: "dialect", scope: "static", timing: ["server"] },
      testConnection: { identifier: "testConnection", role: "testConnection", scope: "static" },
    },
  },
  $implementation: "./d1.js",
  connector: { kind: "sqlite", local: "sqlite", provider: "d1" },
  title: "D1",
};

const DATA_MOUNT_CLASS = {
  $defs: {
    methods: {
      mount: { identifier: "mount", role: "mount", scope: "static", timing: ["server"] },
    },
  },
  $implementation: "./mount.js",
  server: { basePath: "/_jx/data", module: "@acme/data/worker", order: 20 },
  title: "DataMount",
};

const AUTH_MOUNT_CLASS = {
  $defs: {
    methods: {
      mount: { identifier: "mount", role: "mount", scope: "static", timing: ["server"] },
    },
  },
  $implementation: "./auth.js",
  server: { basePath: "/_jx/auth", order: 10 },
  title: "AuthMount",
};

const MD_MANIFEST = {
  classes: { Md: "./src/Md.class.json" },
  name: "@acme/md",
  schemas: { project: "./schemas/project.fragment.schema.json" },
};

const DATA_MANIFEST = {
  classes: {
    D1: "./src/D1.class.json",
    DataMount: "./src/Mount.class.json",
    Tables: "./src/Tables.class.json",
  },
  name: "@acme/data",
  schemas: {
    document: "./schemas/document.fragment.schema.json",
    project: "./schemas/project.fragment.schema.json",
  },
};

const AUTH_MANIFEST = {
  classes: { AuthMount: "./src/Auth.class.json" },
  name: "@acme/auth",
};

const BASE = "/proj/project.json";

function makeIO(files: Record<string, unknown>): FormatHostIO {
  return {
    importModule: () => Promise.reject(new Error("not needed")),
    loadJson: (path) => {
      const found = files[path];
      if (found === undefined) {
        return Promise.reject(new Error(`ENOENT: ${path}`));
      }
      if (found === "not-json") {
        // oxlint-disable-next-line eslint/prefer-promise-reject-errors -- Deliberate non-Error rejection to exercise errorMessage()'s String() branch.
        return Promise.reject("bad file");
      }
      return Promise.resolve(structuredClone(found) as Record<string, unknown>);
    },
    resolvePath: (base, ref) => {
      if (ref.startsWith("./") || ref.startsWith("../")) {
        const dir = base.slice(0, base.lastIndexOf("/"));
        return `${dir}/${ref.replace(/^\.\//, "")}`;
      }
      const bare = files[`bare:${ref}`];
      if (typeof bare === "string") {
        return bare;
      }
      throw new Error(`Cannot find module '${ref}'`);
    },
  };
}

function standardFiles(): Record<string, unknown> {
  return {
    "/nm/@acme/auth/jx-extension.json": AUTH_MANIFEST,
    "/nm/@acme/auth/src/Auth.class.json": AUTH_MOUNT_CLASS,
    "/nm/@acme/data/jx-extension.json": DATA_MANIFEST,
    "/nm/@acme/data/src/D1.class.json": D1_CLASS,
    "/nm/@acme/data/src/Mount.class.json": DATA_MOUNT_CLASS,
    "/nm/@acme/data/src/Tables.class.json": TABLES_CLASS,
    "/proj/local-ext/jx-extension.json": MD_MANIFEST,
    "/proj/local-ext/schemas/project.fragment.schema.json": {},
    "/proj/local-ext/src/Md.class.json": MD_CLASS,
    [`bare:@acme/auth/${EXTENSION_MANIFEST}`]: "/nm/@acme/auth/jx-extension.json",
    [`bare:@acme/data/${EXTENSION_MANIFEST}`]: "/nm/@acme/data/jx-extension.json",
  };
}

describe("buildExtensionRegistry", () => {
  test("builds from bare and relative specifiers, in declaration order", async () => {
    const reg = await buildExtensionRegistry(
      ["./local-ext", "@acme/data", "@acme/auth"],
      makeIO(standardFiles()),
      BASE,
    );
    expect(reg.extensions.map((e) => e.specifier)).toEqual([
      "./local-ext",
      "@acme/data",
      "@acme/auth",
    ]);
    expect(reg.classes.map((c) => c.name)).toEqual([
      "Md",
      "D1",
      "DataMount",
      "Tables",
      "AuthMount",
    ]);
    expect(reg.extensions[0]!.manifestPath).toBe("/proj/local-ext/jx-extension.json");
  });

  test("empty and undefined extension lists build empty registries", async () => {
    const io = makeIO({});
    const fromEmpty = await buildExtensionRegistry([], io, BASE);
    const fromUndefined = await buildExtensionRegistry(undefined, io, BASE);
    expect(fromEmpty.classes).toHaveLength(0);
    expect(fromUndefined.extensions).toHaveLength(0);
  });

  test("format view dispatches by extension and enforces format conflicts", async () => {
    const files = standardFiles();
    const reg = await buildExtensionRegistry(["./local-ext"], makeIO(files), BASE);
    expect(reg.formats.byExtension(".md", "parse")?.name).toBe("Md");
    expect(reg.formats.byExtension(".csv")).toBeUndefined();

    const rivalManifest = { classes: { Md2: "./src/Md2.class.json" }, name: "@acme/md2" };
    files["/nm/@acme/md2/jx-extension.json"] = rivalManifest;
    files["/nm/@acme/md2/src/Md2.class.json"] = { ...MD_CLASS, title: "Md2" };
    files[`bare:@acme/md2/${EXTENSION_MANIFEST}`] = "/nm/@acme/md2/jx-extension.json";
    // oxlint-disable-next-line typescript/await-thenable -- Bun types `.rejects.toThrow` as void, but it resolves a Promise at runtime; the await is required.
    await expect(
      buildExtensionRegistry(["./local-ext", "@acme/md2"], makeIO(files), BASE),
    ).rejects.toThrow(/Format conflict/);
  });

  test("unresolvable bare specifier names the exports requirement", async () => {
    // oxlint-disable-next-line typescript/await-thenable -- Bun types `.rejects.toThrow` as void, but it resolves a Promise at runtime; the await is required.
    await expect(buildExtensionRegistry(["@acme/missing"], makeIO({}), BASE)).rejects.toThrow(
      /must export jx-extension\.json/,
    );
  });

  test("unreadable manifest and class files are loud errors, not silent skips", async () => {
    const files = standardFiles();
    delete files["/nm/@acme/data/src/Tables.class.json"];
    // oxlint-disable-next-line typescript/await-thenable -- Bun types `.rejects.toThrow` as void, but it resolves a Promise at runtime; the await is required.
    await expect(buildExtensionRegistry(["@acme/data"], makeIO(files), BASE)).rejects.toThrow(
      /cannot read class "Tables"/,
    );

    const broken = { ...standardFiles(), "/proj/local-ext/jx-extension.json": "not-json" };
    // oxlint-disable-next-line typescript/await-thenable -- Bun types `.rejects.toThrow` as void, but it resolves a Promise at runtime; the await is required.
    await expect(buildExtensionRegistry(["./local-ext"], makeIO(broken), BASE)).rejects.toThrow(
      /cannot read manifest .*bad file/,
    );
  });

  test("manifest must declare a name matching a bare specifier", async () => {
    const files = standardFiles();
    files["/nm/@acme/data/jx-extension.json"] = { ...DATA_MANIFEST, name: "@acme/other" };
    // oxlint-disable-next-line typescript/await-thenable -- Bun types `.rejects.toThrow` as void, but it resolves a Promise at runtime; the await is required.
    await expect(buildExtensionRegistry(["@acme/data"], makeIO(files), BASE)).rejects.toThrow(
      /does not match the specifier/,
    );

    files["/nm/@acme/data/jx-extension.json"] = { classes: {} };
    // oxlint-disable-next-line typescript/await-thenable -- Bun types `.rejects.toThrow` as void, but it resolves a Promise at runtime; the await is required.
    await expect(buildExtensionRegistry(["@acme/data"], makeIO(files), BASE)).rejects.toThrow(
      /must declare a "name"/,
    );
  });

  test("duplicate class names across extensions conflict", async () => {
    const files = standardFiles();
    files["/nm/@acme/auth/jx-extension.json"] = {
      classes: { Md: "./src/Auth.class.json" },
      name: "@acme/auth",
    };
    // oxlint-disable-next-line typescript/await-thenable -- Bun types `.rejects.toThrow` as void, but it resolves a Promise at runtime; the await is required.
    await expect(
      buildExtensionRegistry(["./local-ext", "@acme/auth"], makeIO(files), BASE),
    ).rejects.toThrow(/both provide a class named "Md"/);
  });

  test("duplicate project section keys conflict", async () => {
    const files = standardFiles();
    files["/nm/@acme/auth/src/Auth.class.json"] = {
      ...TABLES_CLASS,
      server: undefined,
      title: "Tables2",
    };
    files["/nm/@acme/auth/jx-extension.json"] = {
      classes: { Tables2: "./src/Auth.class.json" },
      name: "@acme/auth",
    };
    // oxlint-disable-next-line typescript/await-thenable -- Bun types `.rejects.toThrow` as void, but it resolves a Promise at runtime; the await is required.
    await expect(
      buildExtensionRegistry(["@acme/data", "@acme/auth"], makeIO(files), BASE),
    ).rejects.toThrow(/both claim the project section "data"/);
  });

  test("server basePaths must live under /_jx/ and be unique", async () => {
    const files = standardFiles();
    files["/nm/@acme/auth/src/Auth.class.json"] = {
      ...AUTH_MOUNT_CLASS,
      server: { basePath: "/api/auth" },
    };
    // oxlint-disable-next-line typescript/await-thenable -- Bun types `.rejects.toThrow` as void, but it resolves a Promise at runtime; the await is required.
    await expect(buildExtensionRegistry(["@acme/auth"], makeIO(files), BASE)).rejects.toThrow(
      /must be under \/_jx\//,
    );

    const dupes = standardFiles();
    dupes["/nm/@acme/auth/src/Auth.class.json"] = {
      ...AUTH_MOUNT_CLASS,
      server: { basePath: "/_jx/data" },
    };
    // oxlint-disable-next-line typescript/await-thenable -- Bun types `.rejects.toThrow` as void, but it resolves a Promise at runtime; the await is required.
    await expect(
      buildExtensionRegistry(["@acme/data", "@acme/auth"], makeIO(dupes), BASE),
    ).rejects.toThrow(/both mount "\/_jx\/data"/);
  });
});

describe("ExtensionRegistry accessors", () => {
  async function standardRegistry() {
    return await buildExtensionRegistry(
      ["./local-ext", "@acme/data", "@acme/auth"],
      makeIO(standardFiles()),
      BASE,
    );
  }

  test("project contributions, key and discriminator lookups", async () => {
    const reg = await standardRegistry();
    expect(reg.projectContributions().map((e) => e.name)).toEqual(["Tables"]);
    expect(reg.byProjectKey("data")?.project?.referenceable).toBe(true);
    expect(reg.byProjectKey("nope")).toBeUndefined();
    expect(reg.byPathsDiscriminator("table")?.name).toBe("Tables");
    expect(reg.byPathsDiscriminator("contentType")).toBeUndefined();
    expect(reg.byName("D1")?.connector?.kind).toBe("sqlite");
    expect(reg.byName("missing")).toBeUndefined();
  });

  test("server mounts sort by order then name; connectors filter", async () => {
    const reg = await standardRegistry();
    expect(reg.serverMounts().map((e) => e.name)).toEqual(["AuthMount", "DataMount"]);
    expect(reg.connectors().map((e) => e.name)).toEqual(["D1"]);
  });

  test("emitters filters to classes with an emit capability", async () => {
    const reg = await standardRegistry();
    expect(reg.emitters().map((e) => e.name)).toEqual(["Tables"]);
    expect(reg.byName("Tables")?.capabilities.emit?.timing).toEqual(["compiler"]);
  });

  test("mounts without an order default to 100 and tie-break by name", async () => {
    const files = standardFiles();
    files["/nm/@acme/auth/src/Auth.class.json"] = {
      ...AUTH_MOUNT_CLASS,
      server: { basePath: "/_jx/auth" },
    };
    const reg = await buildExtensionRegistry(["@acme/data", "@acme/auth"], makeIO(files), BASE);
    expect(reg.serverMounts().map((e) => e.name)).toEqual(["DataMount", "AuthMount"]);
  });

  test("schema fragments resolve in extension declaration order", async () => {
    const reg = await standardRegistry();
    expect(reg.schemaFragments("project")).toEqual([
      "/proj/local-ext/schemas/project.fragment.schema.json",
      "/nm/@acme/data/schemas/project.fragment.schema.json",
    ]);
    expect(reg.schemaFragments("document")).toEqual([
      "/nm/@acme/data/schemas/document.fragment.schema.json",
    ]);
  });

  test("schemas.fields fragments resolve like the other kinds (field-union extras)", async () => {
    const files = standardFiles();
    files["/nm/@acme/data/jx-extension.json"] = {
      ...DATA_MANIFEST,
      schemas: {
        ...DATA_MANIFEST.schemas,
        fields: "./schemas/fields.fragment.schema.json",
      },
    };
    const reg = await buildExtensionRegistry(["@acme/data"], makeIO(files), BASE);
    expect(reg.schemaFragments("fields")).toEqual([
      "/nm/@acme/data/schemas/fields.fragment.schema.json",
    ]);
    expect(reg.extensions[0]!.schemas.fields).toBe(
      "/nm/@acme/data/schemas/fields.fragment.schema.json",
    );
  });
});
