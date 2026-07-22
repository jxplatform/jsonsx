/**
 * Connector-mounts.test.ts — generic host plumbing for extension server mounts (plan Part 4a)
 *
 * Exercises, with the real @jxsuite/connector extension: worker generation (mount imports, order,
 * shared ctx, inlined section manifest, ASSETS fallthrough), the static-adapter build error, the
 * generic `lower` capability at the prototype-resolver timing skip, `jx db push` (dry-run,
 * --connection filter, .dev.vars env, wrangler bindings), and the `schemas.fields` manifest
 * convention flowing into the emitted project schema.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { compileSiteServer } from "../src/targets/compile-server";
import { buildProjectExtensionRegistry } from "../src/site/format-host";
import { resolvePrototypes } from "../src/site/prototype-resolver";
import { buildSite } from "../src/site/site-build";
import { dbPush, readDevVars } from "../src/site/db-push";
import { writeProjectSchemas } from "../src/site/schema-command";
import type { ExtensionRegistry } from "@jxsuite/schema/extension-registry";
import type { JxDocument } from "@jxsuite/schema/types";

const TMP = resolve(import.meta.dir, "__test-connector-mounts__");

function writeFile(relPath: string, content: string | object) {
  const abs = resolve(TMP, relPath);
  mkdirSync(resolve(abs, ".."), { recursive: true });
  writeFileSync(
    abs,
    typeof content === "string" ? content : JSON.stringify(content, null, 2),
    "utf8",
  );
}

const PROJECT = {
  build: { adapter: "cloudflare-workers", format: "directory", outDir: "./dist" },
  connections: {
    main: { binding: "DB", databaseId: "d1-uuid", provider: "d1" },
  },
  data: {
    comments: {
      connection: "main",
      permissions: { insert: "public", read: "public" },
      schema: {
        properties: { message: { type: "string" } },
        required: ["message"],
        type: "object",
      },
    },
  },
  extensions: ["@jxsuite/parser", "@jxsuite/connector"],
  name: "Connector Mounts",
};

let registry: ExtensionRegistry;

beforeAll(async () => {
  rmSync(TMP, { force: true, recursive: true });
  writeFile("project.json", PROJECT);
  writeFile("pages/index.json", {
    children: [{ tagName: "h1", textContent: "Comments" }],
    state: {
      addComment: { $prototype: "TableInsert", table: "comments", timing: "client" },
      comments: {
        $prototype: "TableQuery",
        filter: { approved: true },
        table: "comments",
        timing: "client",
      },
    },
    tagName: "main",
  });
  registry = await buildProjectExtensionRegistry(TMP, PROJECT as never);
});

afterAll(() => {
  rmSync(TMP, { force: true, recursive: true });
});

// ─── compileSiteServer mounts emission ───────────────────────────────────────

describe("compileSiteServer with mounts", () => {
  const mounts = [
    {
      basePath: "/_jx/data",
      className: "Data",
      module: "@jxsuite/connector/worker",
      options: { basePath: "/_jx/data", sections: { data: { comments: {} } } },
      order: 20,
    },
    {
      basePath: "/_jx/auth",
      className: "Auth",
      module: "@acme/auth/worker",
      options: { basePath: "/_jx/auth", sections: {} },
      order: 10,
    },
  ];
  const connectors = [{ className: "D1", module: "@jxsuite/connector/d1", provider: "d1" }];

  test("emits static imports, ordered mounts over one ctx, and app.all wrappers", () => {
    const source = compileSiteServer([], { adapter: "cloudflare-workers", connectors, mounts })!;
    expect(source).toContain("import { Data } from '@jxsuite/connector/worker'");
    expect(source).toContain("import { Auth } from '@acme/auth/worker'");
    expect(source).toContain("import { D1 } from '@jxsuite/connector/d1'");
    expect(source).toContain("const jxCtx = {}");
    expect(source).toContain(`const jxConnectors = { "d1": D1 }`);

    // Auth (order 10) mounts before Data (order 20), sharing jxCtx.
    const authAt = source.indexOf("Auth.mount(");
    const dataAt = source.indexOf("Data.mount(");
    expect(authAt).toBeGreaterThan(-1);
    expect(dataAt).toBeGreaterThan(authAt);
    expect(source).toContain("connectors: jxConnectors }, jxCtx)");

    // Wrappers registered before the ASSETS fallthrough, with the inlined JSON options.
    expect(source).toContain("app.all('/_jx/data/*', (c) => jxMount1(c.req.raw, c.env))");
    expect(source).toContain("app.all('/_jx/auth/*', (c) => jxMount0(c.req.raw, c.env))");
    expect(source).toContain(`"sections":{"data":{"comments":{}}}`);
    const mountAt = source.indexOf("app.all('/_jx/data/*'");
    const assetsAt = source.indexOf("app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw))");
    expect(assetsAt).toBeGreaterThan(mountAt);
  });

  test("mounts registered before /_jx/server routes; entries-only output unchanged", () => {
    const source = compileSiteServer([{ exportName: "doThing", src: "./components/x.js" }], {
      adapter: "cloudflare-workers",
      connectors,
      mounts,
    })!;
    const mountAt = source.indexOf("app.all('/_jx/data/*'");
    const serverFnAt = source.indexOf("app.post('/_jx/server/doThing'");
    expect(mountAt).toBeGreaterThan(-1);
    expect(serverFnAt).toBeGreaterThan(mountAt);

    // No mounts → no mount block, same as before this feature.
    const plain = compileSiteServer([{ exportName: "doThing", src: "./x.js" }], {
      adapter: "cloudflare-workers",
    })!;
    expect(plain).not.toContain("jxCtx");
    expect(compileSiteServer([], {})).toBeNull();

    // Mounts alone (no server entries, no adapter) still produce a worker.
    const mountsOnly = compileSiteServer([], { mounts })!;
    expect(mountsOnly).toContain("Data.mount(");
  });
});

// ─── buildSite integration ───────────────────────────────────────────────────

describe("buildSite with the connector extension", () => {
  test("generates a self-contained bundled dist/worker.js with the data mount", async () => {
    const result = await buildSite(TMP, { clean: true });
    expect(result.errors).toEqual([]);

    const workerPath = resolve(TMP, "dist/worker.js");
    expect(existsSync(workerPath)).toBe(true);
    const worker = readFileSync(workerPath, "utf8");
    // Behavioral surface survives bundling: mount route, inlined manifest, asset fallthrough.
    expect(worker).toContain("/_jx/data/*");
    expect(worker).toContain("d1-uuid");
    expect(worker).toContain("connections");
    expect(worker).toContain("ASSETS.fetch");
    // Self-contained (compiler.md §12): no unresolved workspace/hono imports remain — kysely,
    // The mount module, and hono are inlined, so dist deploys without node_modules.
    expect(worker).not.toMatch(/from\s*["']@jxsuite\//);
    expect(worker).not.toMatch(/from\s*["']hono["']/);
    expect(worker).not.toMatch(/from\s*["']kysely["']/);
    // Cold-bundles kysely + hono via Bun.build (~1s+ unloaded); headroom over the 5s default so a
    // Heavily parallel `bun test --isolate` run can't time it out under filesystem load.
  }, 30_000);

  test("static adapter + data tables is a clear build error", async () => {
    const staticDir = `${TMP}-static`;
    rmSync(staticDir, { force: true, recursive: true });
    try {
      mkdirSync(resolve(staticDir, "pages"), { recursive: true });
      writeFileSync(
        resolve(staticDir, "project.json"),
        JSON.stringify({ ...PROJECT, build: { format: "directory", outDir: "./dist" } }),
        "utf8",
      );
      writeFileSync(resolve(staticDir, "pages/index.json"), JSON.stringify({ tagName: "main" }));
      expect(buildSite(staticDir, {})).rejects.toThrow(/dynamic section\(s\) "data".*adapter/s);
    } finally {
      rmSync(staticDir, { force: true, recursive: true });
    }
  });
});

// ─── Generic lower capability ────────────────────────────────────────────────

describe("prototype-resolver lower", () => {
  test("TableQuery lowers to a Request def; actions lower to Function defs", async () => {
    const doc = {
      state: {
        addComment: { $prototype: "TableInsert", table: "comments", timing: "client" },
        comments: {
          $prototype: "TableQuery",
          filter: { approved: true },
          table: "comments",
          timing: "client",
        },
        entry: {
          $prototype: "TableEntry",
          id: { $ref: "#/$params/id" },
          table: "comments",
          timing: "client",
        },
      },
      tagName: "main",
    } as unknown as JxDocument;

    await resolvePrototypes(doc, { _pathParams: { id: "row-1" } }, TMP, {
      config: PROJECT as never,
      registry,
    });

    const comments = doc.state!.comments as Record<string, unknown>;
    expect(comments.$prototype).toBe("Request");
    expect(comments.timing).toBe("client");
    expect(comments.url as string).toStartWith("/_jx/data/comments?filter=");
    expect(comments.url as string).toContain("_v=${(state._v || 0)}");

    const entry = doc.state!.entry as Record<string, unknown>;
    expect(entry.url as string).toStartWith("/_jx/data/comments/row-1");

    const action = doc.state!.addComment as Record<string, unknown>;
    expect(action.$prototype).toBe("Function");
    expect(action.parameters).toEqual(["event"]);
    expect(action.body as string).toContain('fetch("/_jx/data/comments"');
    expect(action.body as string).toContain("state._v = (state._v || 0) + 1;");
  });

  test("timing: 'compiler' bakes through the normal resolve path (registry class, real sqlite)", async () => {
    const bakeDir = `${TMP}-bake`;
    rmSync(bakeDir, { force: true, recursive: true });
    try {
      mkdirSync(bakeDir, { recursive: true });
      const bakeConfig = {
        connections: { main: { provider: "sqlite" } },
        data: {
          comments: {
            connection: "main",
            permissions: { insert: "public", read: "public" },
            schema: { properties: { message: { type: "string" } }, type: "object" },
          },
        },
        extensions: ["@jxsuite/parser", "@jxsuite/connector"],
        name: "Bake",
      };
      writeFileSync(resolve(bakeDir, "project.json"), JSON.stringify(bakeConfig), "utf8");
      const bakeRegistry = await buildProjectExtensionRegistry(bakeDir, bakeConfig as never);

      // Seed a row through the connector's own deploy + data mount machinery.
      const { Sqlite } = await import("@jxsuite/connector/sqlite");
      const env = { JX_PROJECT_ROOT: bakeDir };
      await Sqlite.deploySchema(
        bakeConfig.data as never,
        { $name: "main", provider: "sqlite" },
        { env },
      );
      const { handleDataRequest } = await import("@jxsuite/connector/worker");
      const seeded = await handleDataRequest(
        new Request("http://x/_jx/data/comments", {
          body: JSON.stringify({ message: "baked" }),
          method: "POST",
        }),
        env,
        {
          connectors: { sqlite: Sqlite },
          sections: {
            connections: { main: { provider: "sqlite" } },
            data: bakeConfig.data as never,
          },
        },
        {},
      );
      expect(seeded.status).toBe(201);

      const doc = {
        state: {
          comments: { $prototype: "TableQuery", table: "comments", timing: "compiler" },
        },
        tagName: "main",
      } as unknown as JxDocument;
      await resolvePrototypes(doc, {}, bakeDir, {
        config: bakeConfig as never,
        registry: bakeRegistry,
      });
      const baked = doc.state!.comments as unknown as Record<string, unknown>[];
      expect(Array.isArray(baked)).toBe(true);
      expect(baked[0]!.message).toBe("baked");
    } finally {
      rmSync(bakeDir, { force: true, recursive: true });
    }
  });

  test("unreachable databases bake to [] with a warning, never a failed build", async () => {
    // D1 with no binding and no CLOUDFLARE_API_TOKEN: the SSG bake degrades to an empty result.
    const doc = {
      state: {
        comments: { $prototype: "TableQuery", table: "comments", timing: "compiler" },
      },
      tagName: "main",
    } as unknown as JxDocument;
    const cleanEnv = { ...process.env };
    delete process.env.CLOUDFLARE_API_TOKEN;
    try {
      await resolvePrototypes(doc, {}, TMP, { config: PROJECT as never, registry });
    } finally {
      process.env = cleanEnv as NodeJS.ProcessEnv;
    }
    expect(doc.state!.comments).toEqual([] as never);
  });

  test("defs without a registry lower capability are left for their pipelines", async () => {
    const doc = {
      state: { thing: { $prototype: "NotRegistered", timing: "client" } },
      tagName: "main",
    } as unknown as JxDocument;
    await resolvePrototypes(doc, {}, TMP, { config: PROJECT as never, registry });
    expect((doc.state!.thing as Record<string, unknown>).$prototype).toBe("NotRegistered");
  });
});

// ─── jx db push ──────────────────────────────────────────────────────────────

describe("dbPush", () => {
  test("dry-run compiles statements through the D1 HTTP dialect without applying", async () => {
    const sqls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { sql: string };
      sqls.push(body.sql);
      return Response.json({ result: [{ meta: {}, results: [], success: true }], success: true });
    }) as typeof globalThis.fetch;
    try {
      writeFile(".dev.vars", 'CLOUDFLARE_API_TOKEN="tok"\nCLOUDFLARE_ACCOUNT_ID=acct\n# comment\n');
      const { results, bindingsPatched } = await dbPush(TMP, { dryRun: true });
      expect(results).toHaveLength(1);
      const [main] = results;
      expect(main!.connection).toBe("main");
      expect(main!.provider).toBe("d1");
      expect(main!.tables).toEqual(["comments"]);
      expect(main!.applied).toBe(false);
      expect(main!.statements.some((s) => s.startsWith('create table "comments"'))).toBe(true);
      expect(bindingsPatched).toBe(false);
      expect(sqls.some((s) => s.startsWith("create table"))).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("apply patches wrangler.jsonc with the connector's binding fragments", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      Response.json({
        result: [{ meta: {}, results: [], success: true }],
        success: true,
      })) as unknown as typeof globalThis.fetch;
    try {
      writeFile(
        "wrangler.jsonc",
        JSON.stringify({ compatibility_date: "2026-01-01", name: "site" }, null, "\t"),
      );
      const { results, bindingsPatched, wranglerPath } = await dbPush(TMP, {
        connection: "main",
      });
      expect(results[0]!.applied).toBe(true);
      expect(bindingsPatched).toBe(true);
      const wrangler = JSON.parse(readFileSync(wranglerPath!, "utf8")) as Record<string, unknown>;
      expect(wrangler.name).toBe("site");
      expect(wrangler.d1_databases).toEqual([
        { binding: "DB", database_id: "d1-uuid", database_name: "main" },
      ]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("--connection validates the name and readDevVars parses the file", async () => {
    expect(dbPush(TMP, { connection: "ghost" })).rejects.toThrow('Unknown connection "ghost"');
    const vars = readDevVars(TMP);
    expect(vars).toEqual({ CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "tok" });
    expect(readDevVars(`${TMP}/nope`)).toEqual({});
  });

  test("a project without connections fails with guidance", async () => {
    const emptyDir = `${TMP}-empty`;
    rmSync(emptyDir, { force: true, recursive: true });
    try {
      mkdirSync(emptyDir, { recursive: true });
      writeFileSync(
        resolve(emptyDir, "project.json"),
        JSON.stringify({ extensions: ["@jxsuite/connector"], name: "Empty" }),
        "utf8",
      );
      expect(dbPush(emptyDir, {})).rejects.toThrow('no "connections" section');
    } finally {
      rmSync(emptyDir, { force: true, recursive: true });
    }
  });
});

// ─── schemas.fields manifest convention ──────────────────────────────────────

describe("schemas.fields plumbing", () => {
  test("a fields fragment's $defs land in the emitted field union", async () => {
    const dir = `${TMP}-fields`;
    rmSync(dir, { force: true, recursive: true });
    try {
      mkdirSync(resolve(dir, "local-ext/schemas"), { recursive: true });
      writeFileSync(
        resolve(dir, "local-ext/jx-extension.json"),
        JSON.stringify({
          name: "local-fields",
          schemas: { fields: "./schemas/fields.fragment.schema.json" },
        }),
        "utf8",
      );
      writeFileSync(
        resolve(dir, "local-ext/schemas/fields.fragment.schema.json"),
        JSON.stringify({
          $defs: {
            ColumnExtra: {
              properties: { column: { type: "string" } },
              required: ["column"],
              type: "object",
            },
          },
          $id: "https://acme.test/schema/fields/v1",
          $schema: "https://json-schema.org/draft/2020-12/schema",
        }),
        "utf8",
      );
      writeFileSync(
        resolve(dir, "project.json"),
        JSON.stringify({ extensions: ["./local-ext"], name: "Fields" }),
        "utf8",
      );

      const { projectSchemaPath } = await writeProjectSchemas(dir);
      const schema = JSON.parse(readFileSync(projectSchemaPath, "utf8")) as {
        $defs: Record<string, unknown> & { Fields: { anyOf: { $ref: string }[] } };
        allOf: { $ref: string }[];
      };
      const refs = schema.$defs.Fields.anyOf.map((r) => r.$ref);
      expect(refs).toContain("https://acme.test/schema/fields/v1#/$defs/ColumnExtra");
      // The fragment joins the allOf (by canonical $id — committed docs are bundled) and its
      // Resource embeds under $defs so the union refs resolve without file access.
      expect(schema.allOf.some((r) => r.$ref === "https://acme.test/schema/fields/v1")).toBe(true);
      expect(schema.$defs["https://acme.test/schema/fields/v1"]).toBeDefined();
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});

// ─── Real auth extension: mount order in the generated worker ────────────────

describe("buildSite with the auth extension", () => {
  test("auth (order 10) mounts before data (order 20) over one shared ctx", async () => {
    const dir = `${TMP}-auth`;
    rmSync(dir, { force: true, recursive: true });
    try {
      mkdirSync(resolve(dir, "pages"), { recursive: true });
      writeFileSync(
        resolve(dir, "project.json"),
        JSON.stringify({
          ...PROJECT,
          auth: { connection: "main" },
          extensions: [...PROJECT.extensions, "@jxsuite/auth"],
          name: "Auth Mounts",
        }),
        "utf8",
      );
      writeFileSync(resolve(dir, "pages/index.json"), JSON.stringify({ tagName: "main" }));

      const result = await buildSite(dir, { clean: true });
      expect(result.errors).toEqual([]);
      const worker = readFileSync(resolve(dir, "dist/worker.js"), "utf8");

      // Both mounts wired; better-auth and the mount modules are inlined (self-contained).
      expect(worker).toContain("/_jx/auth/*");
      expect(worker).toContain("/_jx/data/*");
      expect(worker).not.toMatch(/from\s*["']@jxsuite\//);
      expect(worker).not.toMatch(/from\s*["']better-auth/);
      // Auth (order 10) registers its route before data (order 20); statement order survives
      // Bundling of the entry module.
      expect(worker.indexOf("/_jx/auth/*")).toBeLessThan(worker.lastIndexOf("/_jx/data/*"));
      // The inlined section manifest carries the auth section — identifiers only, no secrets.
      expect(worker).toContain('"connection"');
      expect(worker).not.toContain("BETTER_AUTH_SECRET=");
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
    // Cold-bundles better-auth via Bun.build (~2s unloaded); headroom over the 5s default keeps a
    // Heavily parallel `bun test --isolate` run from timing it out under filesystem load.
  }, 30_000);
});
