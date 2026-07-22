/**
 * Jx-mounts.test.ts — registry-driven /_jx/* dispatch in the dev server (plan Part 4a)
 *
 * Uses a tempdir project with the real @jxsuite/connector extension (D1 connection stood in by
 * local sqlite with auto-sync on first touch) plus a local fixture extension whose mount echoes its
 * env — proving generic dispatch, .dev.vars merging, and JX_PROJECT_ROOT injection without any
 * connector-specific code in the server.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { handleJxMounts, resetJxMounts } from "../src/jx-mounts";
import { loadDevVars, parseDevVars } from "../src/dev-vars";

const TMP = resolve(import.meta.dir, "__test-jx-mounts__");

function writeFile(relPath: string, content: string | object) {
  const abs = resolve(TMP, relPath);
  mkdirSync(resolve(abs, ".."), { recursive: true });
  writeFileSync(
    abs,
    typeof content === "string" ? content : JSON.stringify(content, null, 2),
    "utf8",
  );
}

function call(method: string, path: string, body?: unknown): Promise<Response | null> {
  const url = `http://localhost:3000${path}`;
  return handleJxMounts(
    new Request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    new URL(url),
    TMP,
  );
}

beforeAll(() => {
  rmSync(TMP, { force: true, recursive: true });
  resetJxMounts();

  // Local fixture extension: a mount that echoes selected env values.
  writeFile("mount-ext/jx-extension.json", {
    classes: { Echo: "./Echo.class.json" },
    name: "echo-ext",
  });
  writeFile("mount-ext/Echo.class.json", {
    $defs: {
      methods: {
        mount: {
          identifier: "mount",
          role: "mount",
          scope: "static",
          timing: ["server"],
        },
      },
    },
    $implementation: "./echo.js",
    server: { basePath: "/_jx/echo", order: 5 },
    title: "Echo",
  });
  writeFile(
    "mount-ext/echo.ts",
    `export const Echo = {
  mount(options: Record<string, unknown>, ctx: Record<string, unknown>) {
    ctx.echoed = true;
    return async (request: Request, env: Record<string, unknown>) =>
      Response.json({
        basePath: options.basePath,
        root: env.JX_PROJECT_ROOT,
        secret: env.MOUNT_TEST_SECRET ?? null,
        sections: Object.keys(options.sections as Record<string, unknown>),
      });
  },
};
`,
  );

  writeFile("project.json", {
    connections: { main: { binding: "DB", databaseId: "remote-uuid", provider: "d1" } },
    data: {
      comments: {
        connection: "main",
        permissions: { delete: "public", insert: "public", read: "public", update: "public" },
        schema: {
          properties: { approved: { type: "boolean" }, message: { type: "string" } },
          required: ["message"],
          type: "object",
        },
      },
    },
    extensions: ["@jxsuite/connector", "./mount-ext"],
    name: "Mounts Fixture",
  });
  writeFile(".dev.vars", "MOUNT_TEST_SECRET=shh\n");
});

afterAll(() => {
  rmSync(TMP, { force: true, recursive: true });
  resetJxMounts();
});

describe("handleJxMounts", () => {
  test("non-/_jx paths and unclaimed subtrees return null", async () => {
    const url = new URL("http://x/other");
    expect(await handleJxMounts(new Request(url), url, TMP)).toBeNull();
    expect(await call("GET", "/_jx/unclaimed/route")).toBeNull();
  });

  test("a broken project.json is warned about and dispatches nothing", async () => {
    const broken = `${TMP}-broken`;
    rmSync(broken, { force: true, recursive: true });
    const warned: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => void warned.push(args.map(String).join(" "));
    try {
      mkdirSync(broken, { recursive: true });
      writeFileSync(resolve(broken, "project.json"), "{not json", "utf8");
      const url = new URL("http://x/_jx/data/comments");
      expect(await handleJxMounts(new Request(url), url, broken)).toBeNull();
      expect(warned.some((w) => w.includes("failed to build extension mounts"))).toBe(true);
    } finally {
      console.warn = origWarn;
      rmSync(broken, { force: true, recursive: true });
    }
  });

  test("projects without extensions dispatch nothing", async () => {
    const bare = `${TMP}-bare`;
    rmSync(bare, { force: true, recursive: true });
    try {
      mkdirSync(bare, { recursive: true });
      writeFileSync(resolve(bare, "project.json"), JSON.stringify({ name: "Bare" }), "utf8");
      const url = new URL("http://x/_jx/data/comments");
      expect(await handleJxMounts(new Request(url), url, bare)).toBeNull();
      // Missing project.json is null too, not an error.
      const ghostUrl = new URL("http://x/_jx/data/comments");
      expect(await handleJxMounts(new Request(ghostUrl), ghostUrl, `${bare}/ghost`)).toBeNull();
    } finally {
      rmSync(bare, { force: true, recursive: true });
    }
  });

  test("fixture mounts get merged env (.dev.vars + JX_PROJECT_ROOT) and section manifests", async () => {
    const response = await call("GET", "/_jx/echo/anything");
    expect(response).not.toBeNull();
    const body = (await response!.json()) as Record<string, unknown>;
    expect(body.basePath).toBe("/_jx/echo");
    expect(body.root).toBe(TMP);
    expect(body.secret).toBe("shh");
    expect((body.sections as string[]).toSorted()).toEqual(["connections", "data"]);
  });

  test("D1 connections are stood in by local sqlite with auto-sync on first touch", async () => {
    const dbFile = resolve(TMP, ".jx/data/main.sqlite");
    expect(existsSync(dbFile)).toBe(false);

    const created = await call("POST", "/_jx/data/comments", {
      approved: "on",
      message: "hello dev",
    });
    expect(created!.status).toBe(201);
    const row = (await created!.json()) as Record<string, unknown>;
    expect(row.approved).toBe(true);
    expect(existsSync(dbFile)).toBe(true);

    const filter = encodeURIComponent(JSON.stringify({ approved: true }));
    const listed = await call("GET", `/_jx/data/comments?filter=${filter}`);
    const rows = (await listed!.json()) as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.message).toBe("hello dev");

    const patched = await call("PATCH", `/_jx/data/comments/${row.id}`, { message: "edited" });
    expect(patched!.status).toBe(200);

    const removed = await call("DELETE", `/_jx/data/comments/${row.id}`);
    expect(removed!.status).toBe(200);
    const after = await call("GET", "/_jx/data/comments");
    expect((await after!.json()) as unknown[]).toHaveLength(0);
  });

  test("fail-closed without an auth mount: non-public rules are denied", async () => {
    writeFile("project.json", {
      connections: { main: { provider: "sqlite" } },
      data: {
        secrets: {
          connection: "main",
          permissions: { insert: "authenticated", read: "none" },
          schema: { properties: { value: { type: "string" } }, type: "object" },
        },
      },
      extensions: ["@jxsuite/connector"],
      name: "Mounts Fixture",
    });
    resetJxMounts();
    const denied = await call("GET", "/_jx/data/secrets");
    expect(denied!.status).toBe(403);
    const insert = await call("POST", "/_jx/data/secrets", { value: "x" });
    expect(insert!.status).toBe(401);
  });
});

describe("dev-vars", () => {
  test("parseDevVars handles comments, quotes, and malformed lines", () => {
    const parsed = parseDevVars(
      `# comment\nA=1\nB="two words"\nC='sq'\nnoequals\n  \nD=  spaced  \n=novalue\n`,
    );
    expect(parsed).toEqual({ A: "1", B: "two words", C: "sq", D: "spaced" });
  });

  test("loadDevVars returns {} when the file is absent", () => {
    expect(loadDevVars(`${TMP}/nope`)).toEqual({});
    expect(loadDevVars(TMP)).toEqual({ MOUNT_TEST_SECRET: "shh" });
  });

  test("loadDevVars returns {} when the file is unreadable", () => {
    // A DIRECTORY named .dev.vars exists but readFileSync throws (EISDIR).
    const dir = `${TMP}-unreadable-vars`;
    rmSync(dir, { force: true, recursive: true });
    try {
      mkdirSync(resolve(dir, ".dev.vars"), { recursive: true });
      expect(loadDevVars(dir)).toEqual({});
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});

describe("auth mount dispatch (@jxsuite/auth)", () => {
  const AUTH_TMP = `${TMP}-auth`;

  function authCall(method: string, path: string, body?: unknown, cookie = "") {
    const url = `http://localhost:3000${path}`;
    return handleJxMounts(
      new Request(url, {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        headers: {
          "Content-Type": "application/json",
          ...(cookie ? { cookie } : {}),
        },
      }),
      new URL(url),
      AUTH_TMP,
    );
  }

  beforeAll(() => {
    rmSync(AUTH_TMP, { force: true, recursive: true });
    mkdirSync(AUTH_TMP, { recursive: true });
    writeFileSync(
      resolve(AUTH_TMP, "project.json"),
      JSON.stringify({
        auth: {},
        connections: { main: { binding: "DB", databaseId: "remote-uuid", provider: "d1" } },
        data: {
          comments: {
            connection: "main",
            ownerField: "author_id",
            permissions: { insert: "authenticated", read: "public", update: "owner" },
            schema: {
              properties: { author_id: { type: "string" }, message: { type: "string" } },
              required: ["message"],
              type: "object",
            },
          },
        },
        extensions: ["@jxsuite/connector", "@jxsuite/auth"],
        name: "Auth Mounts Fixture",
      }),
      "utf8",
    );
    writeFileSync(
      resolve(AUTH_TMP, ".dev.vars"),
      "BETTER_AUTH_SECRET=dev-mount-secret-0123456789\n",
      "utf8",
    );
  });

  afterAll(() => {
    rmSync(AUTH_TMP, { force: true, recursive: true });
  });

  test("the auth mount answers real Better Auth routes over the local sqlite stand-in", async () => {
    // Anonymous session: the route resolves (no 404 from dispatch) and reports null.
    const anonymous = await authCall("GET", "/_jx/auth/get-session");
    expect(anonymous).not.toBeNull();
    expect(anonymous!.status).toBe(200);
    expect(await anonymous!.json()).toBeNull();

    // Sign-up over the D1 connection's local sqlite stand-in (auto-synced on first touch).
    const signUp = await authCall("POST", "/_jx/auth/sign-up/email", {
      email: "mounts@example.com",
      name: "Mounts",
      password: "hunter2hunter2",
    });
    expect(signUp!.status).toBe(200);
    const cookie = (signUp!.headers.get("set-cookie") ?? "").split(";")[0]!;
    expect(cookie).toContain("better-auth");
    expect(existsSync(resolve(AUTH_TMP, ".jx/data/main.sqlite"))).toBe(true);

    // The data mount (order 20) shares ctx.auth: anonymous insert 401, cookie insert 201.
    const denied = await authCall("POST", "/_jx/data/comments", { message: "anon" });
    expect(denied!.status).toBe(401);
    const created = await authCall("POST", "/_jx/data/comments", { message: "hi" }, cookie);
    expect(created!.status).toBe(201);

    // Public read passes without a session.
    const listed = await authCall("GET", "/_jx/data/comments");
    expect(listed!.status).toBe(200);
    expect(((await listed!.json()) as unknown[]).length).toBe(1);
  });
});
