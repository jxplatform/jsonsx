import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { handleResolve, handleServerFunction } from "../src/resolve";
import { join, resolve } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const FIXTURES = resolve(import.meta.dir, "_resolve_gaps_fixtures");

/** Build a POST request for handleResolve. */
function resolveReq(body: unknown) {
  return new Request("http://localhost/__jx_resolve__", {
    body: JSON.stringify(body),
    method: "POST",
  });
}

// Self-contained class exercising field initializer/default/null branches,
// Constructor body (array form), and method parameter mapping variants.
const ctxClass = {
  $defs: {
    constructor: {
      $prototype: "Function",
      body: ["this.ctorRan = true;"],
      role: "constructor",
    },
    fields: {
      _project: {
        access: "public",
        identifier: "_project",
        role: "field",
        scope: "instance",
      },
      a: {
        access: "public",
        identifier: "a",
        initializer: 5,
        role: "field",
        scope: "instance",
      },
      b: {
        access: "public",
        default: { x: 1 },
        identifier: "b",
        role: "field",
        scope: "instance",
      },
      c: {
        access: "public",
        identifier: "c",
        role: "field",
        scope: "instance",
      },
    },
    methods: {
      combine: {
        body: "return x + y + z + (arg ?? 0);",
        identifier: "combine",
        parameters: [{ $ref: "#/$defs/parameters/x" }, { identifier: "y" }, { name: "z" }, {}],
        role: "method",
      },
      resolve: {
        body: "return { a: this.a, b: this.b, c: this.c, combined: this.combine(1, 2, 3, 4), ctorRan: this.ctorRan === true, hasProject: Boolean(this._project) };",
        identifier: "resolve",
        role: "method",
      },
    },
    parameters: {
      x: { identifier: "x", type: { type: "number" } },
    },
  },
  $prototype: "Class",
  title: "Ctx",
};

function setup() {
  rmSync(FIXTURES, { force: true, recursive: true });

  // Project with a valid project.json (no contentTypes)
  mkdirSync(join(FIXTURES, "proj-valid"), { recursive: true });
  writeFileSync(join(FIXTURES, "proj-valid", "project.json"), JSON.stringify({ name: "p1" }));
  writeFileSync(join(FIXTURES, "proj-valid", "Ctx.class.json"), JSON.stringify(ctxClass));

  // Project with a broken project.json
  mkdirSync(join(FIXTURES, "proj-broken"), { recursive: true });
  writeFileSync(join(FIXTURES, "proj-broken", "project.json"), "{broken json!");
  writeFileSync(join(FIXTURES, "proj-broken", "Ctx.class.json"), JSON.stringify(ctxClass));
}

describe("handleResolve — gaps", () => {
  beforeAll(() => setup());
  afterAll(() => {
    rmSync(FIXTURES, { force: true, recursive: true });
  });

  test("injects _project context when project.json exists", async () => {
    const root = join(FIXTURES, "proj-valid");
    const res = await handleResolve(
      resolveReq({ $prototype: "Ctx", $src: "./Ctx.class.json" }),
      root,
    );
    expect(res.status).toBe(200);
    const value = await res.json();
    expect(value.hasProject).toBe(true);
  });

  test("constructs fields from initializer, default, and null fallback", async () => {
    const root = join(FIXTURES, "proj-valid");
    const res = await handleResolve(
      resolveReq({ $prototype: "Ctx", $src: "./Ctx.class.json" }),
      root,
    );
    const value = await res.json();
    expect(value.a).toBe(5);
    expect(value.b).toEqual({ x: 1 });
    expect(value.c).toBeNull();
  });

  test("runs constructor body given as an array of lines", async () => {
    const root = join(FIXTURES, "proj-valid");
    const res = await handleResolve(
      resolveReq({ $prototype: "Ctx", $src: "./Ctx.class.json" }),
      root,
    );
    const value = await res.json();
    expect(value.ctorRan).toBe(true);
  });

  test("maps method parameters from $ref, identifier, name, and fallback", async () => {
    const root = join(FIXTURES, "proj-valid");
    const res = await handleResolve(
      resolveReq({ $prototype: "Ctx", $src: "./Ctx.class.json" }),
      root,
    );
    const value = await res.json();
    expect(value.combined).toBe(10);
  });

  test("skips project context when project.json is invalid", async () => {
    const root = join(FIXTURES, "proj-broken");
    const res = await handleResolve(
      resolveReq({ $prototype: "Ctx", $src: "./Ctx.class.json" }),
      root,
    );
    expect(res.status).toBe(200);
    const value = await res.json();
    expect(value.hasProject).toBe(false);
  });

  test("config overrides field defaults", async () => {
    const root = join(FIXTURES, "proj-valid");
    const res = await handleResolve(
      resolveReq({ $prototype: "Ctx", $src: "./Ctx.class.json", a: 99 }),
      root,
    );
    const value = await res.json();
    expect(value.a).toBe(99);
  });

  test("resolves bare specifier via server require fallback", async () => {
    // Root outside the repo: project-level require fails, server-level resolves
    const tmpRoot = mkdtempSync(join(tmpdir(), "jx-resolve-gap-"));
    try {
      const res = await handleResolve(
        resolveReq({ $prototype: "Thing", $src: "@jxsuite/schema" }),
        tmpRoot,
      );
      // Resolved module is not a .class.json, so the handler rejects it
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("requires a .class.json");
    } finally {
      rmSync(tmpRoot, { force: true, recursive: true });
    }
  });

  test("resolves bare specifier via project require when available", async () => {
    // Repo-relative root: project require resolves workspace deps directly
    const res = await handleResolve(
      resolveReq({ $prototype: "Thing", $src: "@jxsuite/schema" }),
      resolve(import.meta.dir, ".."),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("requires a .class.json");
  });

  test("returns 400 for unresolvable bare specifier", async () => {
    const res = await handleResolve(
      resolveReq({ $prototype: "Thing", $src: "completely-bogus-pkg-xyz-404" }),
      FIXTURES,
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Cannot resolve");
  });

  test("imports a $src under the active project root but outside the server root", async () => {
    // The active project lives OUTSIDE the server root: isImportable must accept it via the
    // ActiveProjectRoot containment branch.
    const external = mkdtempSync(join(tmpdir(), "jx-resolve-active-"));
    try {
      writeFileSync(join(external, "Ctx.class.json"), JSON.stringify(ctxClass));
      const res = await handleResolve(
        resolveReq({ $prototype: "Ctx", $src: "./Ctx.class.json" }),
        join(FIXTURES, "proj-valid"),
        external,
      );
      expect(res.status).toBe(200);
      const value = (await res.json()) as { a: number };
      expect(value.a).toBe(5);
    } finally {
      rmSync(external, { force: true, recursive: true });
    }
  });

  test("server-function proxy rejects a $src that escapes the project root", async () => {
    const req = new Request("http://localhost/__jx_server__", {
      body: JSON.stringify({ $export: "run", $src: "../outside.js", arguments: {} }),
      method: "POST",
    });
    const res = await handleServerFunction(req, join(FIXTURES, "proj-valid"));
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("escapes the project root");
  });

  test("rejects a .class.json whose $implementation escapes the project root", async () => {
    const root = join(FIXTURES, "impl-escape");
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, "Esc.class.json"),
      JSON.stringify({
        $implementation: "../outside-impl.js",
        $prototype: "Class",
        title: "Esc",
      }),
    );
    writeFileSync(join(FIXTURES, "outside-impl.js"), "export class Esc {}");
    const res = await handleResolve(
      resolveReq({ $prototype: "Esc", $src: "./Esc.class.json" }),
      root,
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("$implementation escapes the project root");
  });
});
