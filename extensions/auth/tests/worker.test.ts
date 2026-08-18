/**
 * Worker.test.ts — the /_jx/auth mount contract (plan Part 4b): `Auth.mount` publishes ctx.auth,
 * Better Auth answers its routes through the returned handler, instances memoize per env identity,
 * and — the milestone matrix — the connector's real data mount, sharing the same ctx, turns its
 * fail-closed denials into session-driven grants (authenticated insert, owner-scoped update with
 * setColumns/whereOwner). Also covers the section-owner deploySchema capability the push seam
 * composes.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { Sqlite } from "@jxsuite/connector";
import { Data } from "@jxsuite/connector/worker";
import { Auth, createAuthMountState, getAuthForEnv, handleAuthRequest } from "../src/worker";
import type { JxServerContext, TableDef } from "@jxsuite/connector/types";
import type { AuthMountOptions } from "../src/worker";

const TMP = resolve(import.meta.dir, "__test-auth-worker__");

const tables: Record<string, TableDef> = {
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
};

const sections = {
  auth: {},
  connections: { main: { provider: "sqlite" } },
  data: tables,
};

const connectors = { sqlite: Sqlite };

const options: AuthMountOptions = {
  autoSync: true,
  basePath: "/_jx/auth",
  connectors,
  sections,
};

const env = { BETTER_AUTH_SECRET: "worker-test-secret-0123456789", JX_PROJECT_ROOT: TMP };

/** One shared ctx + both mounts, exactly like the generated worker / dev server. */
function mountBoth(): {
  ctx: JxServerContext;
  auth: (req: Request) => Promise<Response>;
  data: (req: Request) => Promise<Response>;
} {
  const ctx: JxServerContext = {};
  const authHandler = Auth.mount(options, ctx);
  const dataHandler = Data.mount(
    { autoSync: true, basePath: "/_jx/data", connectors, sections },
    ctx,
  );
  return {
    auth: (req) => authHandler(req, env),
    ctx,
    data: (req) => dataHandler(req, env),
  };
}

/**
 * A distinct client IP per request.
 *
 * Auth routes are rate-limited per IP and path, and every request in this file otherwise arrives
 * from the same one — so a suite that signs up two dozen users in a few milliseconds looks exactly
 * like credential stuffing and starts collecting 429s. Real callers are separate people on separate
 * addresses; the header says so. (`x-forwarded-for` is Better Auth's default IP source, and it
 * trusts a single-value header.)
 */
let clientIp = 0;
function nextClientIp(): string {
  clientIp += 1;
  // TEST-NET-3, reserved for documentation and examples (RFC 5737).
  return `203.0.113.${clientIp % 254}`;
}

function jsonRequest(method: string, url: string, body: unknown, cookie = ""): Request {
  return new Request(url, {
    body: JSON.stringify(body),
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": nextClientIp(),
      ...(cookie ? { cookie } : {}),
    },
    method,
  });
}

async function signUp(auth: (req: Request) => Promise<Response>, email: string): Promise<string> {
  const response = await auth(
    jsonRequest("POST", "http://localhost:3000/_jx/auth/sign-up/email", {
      email,
      name: "Worker",
      password: "hunter2hunter2",
    }),
  );
  expect(response.status).toBe(200);
  return (response.headers.get("set-cookie") ?? "").split(";")[0]!;
}

beforeAll(() => {
  rmSync(TMP, { force: true, recursive: true });
  mkdirSync(TMP, { recursive: true });
});

afterAll(() => {
  rmSync(TMP, { force: true, recursive: true });
});

describe("Auth.mount", () => {
  test("publishes ctx.auth and serves the Better Auth routes", async () => {
    const { ctx, auth } = mountBoth();
    expect(typeof ctx.auth?.getSession).toBe("function");
    expect(typeof ctx.auth?.authorize).toBe("function");

    const cookie = await signUp(auth, "mount@example.com");
    const session = await ctx.auth!.getSession(
      new Request("http://localhost:3000/x", { headers: { cookie } }),
      env,
    );
    expect(session).not.toBeNull();
    expect(typeof session!.userId).toBe("string");

    expect(await ctx.auth!.getSession(new Request("http://localhost:3000/x"), env)).toBeNull();
  });

  test("authorize delegates to the pure evaluator", async () => {
    const { ctx } = mountBoth();
    const decision = await ctx.auth!.authorize(
      {
        action: "insert",
        ownerField: "author_id",
        rule: "owner",
        session: { userId: "u9" },
        table: "comments",
      },
      env,
    );
    expect(decision).toEqual({ allow: true, setColumns: { author_id: "u9" } });
  });

  test("getSession fails closed (null + warning) when auth cannot be constructed", async () => {
    const ctx: JxServerContext = {};
    Auth.mount(options, ctx);
    const badEnv = { JX_PROJECT_ROOT: TMP };
    expect(await ctx.auth!.getSession(new Request("http://localhost:3000/x"), badEnv)).toBeNull();
  });

  test("handleAuthRequest surfaces construction errors as 500", async () => {
    const response = await handleAuthRequest(
      new Request("http://localhost:3000/_jx/auth/get-session"),
      { JX_PROJECT_ROOT: TMP },
      options,
    );
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("BETTER_AUTH_SECRET");
  });

  test("memoizes the Better Auth instance per env identity", async () => {
    const state = createAuthMountState();
    const first = getAuthForEnv(state, options, env);
    const second = getAuthForEnv(state, options, env);
    expect(second).toBe(first);
    const third = getAuthForEnv(state, options, { ...env });
    expect(third).not.toBe(first);
    await Promise.all([first, third]);
  });
});

describe("data mount integration (shared ctx)", () => {
  test("authenticated insert: 401 anonymous, 201 with the session cookie + owner column", async () => {
    const { auth, data } = mountBoth();

    const anonymous = await data(
      jsonRequest("POST", "http://localhost:3000/_jx/data/comments", { message: "nope" }),
    );
    expect(anonymous.status).toBe(401);

    const cookie = await signUp(auth, "author@example.com");
    const created = await data(
      jsonRequest(
        "POST",
        "http://localhost:3000/_jx/data/comments",
        { author_id: "forged-id", message: "mine" },
        cookie,
      ),
    );
    expect(created.status).toBe(201);
    const row = (await created.json()) as Record<string, unknown>;
    expect(row.message).toBe("mine");
    // The declared ownerField is authoritative: stamped from the session, forged ids overwritten.
    expect(typeof row.author_id).toBe("string");
    expect(row.author_id).not.toBe("forged-id");
  });

  test("owner update: the owner edits their row; strangers and anonymous are denied", async () => {
    const { auth, data } = mountBoth();
    const ownerCookie = await signUp(auth, "owner@example.com");
    const strangerCookie = await signUp(auth, "stranger@example.com");

    const sessionResponse = await auth(
      new Request("http://localhost:3000/_jx/auth/get-session", {
        headers: { cookie: ownerCookie },
      }),
    );
    const ownerSession = (await sessionResponse.json()) as { user: { id: string } };

    const created = await data(
      jsonRequest(
        "POST",
        "http://localhost:3000/_jx/data/comments",
        { author_id: ownerSession.user.id, message: "owner row" },
        ownerCookie,
      ),
    );
    expect(created.status).toBe(201);
    const row = (await created.json()) as { id: string };

    const edited = await data(
      jsonRequest(
        "PATCH",
        `http://localhost:3000/_jx/data/comments/${row.id}`,
        { message: "edited by owner" },
        ownerCookie,
      ),
    );
    expect(edited.status).toBe(200);

    // A different signed-in user is scoped out by whereOwner (row invisible → 404).
    const stranger = await data(
      jsonRequest(
        "PATCH",
        `http://localhost:3000/_jx/data/comments/${row.id}`,
        { message: "hijack" },
        strangerCookie,
      ),
    );
    expect(stranger.status).toBe(404);

    const anonymous = await data(
      jsonRequest("PATCH", `http://localhost:3000/_jx/data/comments/${row.id}`, {
        message: "anon",
      }),
    );
    expect(anonymous.status).toBe(401);

    // Public read still needs no session.
    const listed = await data(new Request("http://localhost:3000/_jx/data/comments"));
    expect(listed.status).toBe(200);
  });
});

describe("Auth.deploySchema (push seam)", () => {
  const pushDir = `${TMP}/push`;
  const projectConfig = {
    auth: {},
    connections: { main: { file: "./push.sqlite", provider: "sqlite" } },
  };
  const pushEnv = { JX_PROJECT_ROOT: pushDir };

  test("dry-run plans kind-auth steps without applying; a real push applies", async () => {
    mkdirSync(pushDir, { recursive: true });
    const dry = await Auth.deploySchema({}, projectConfig, { dryRun: true, env: pushEnv });
    expect(dry.applied).toBe(false);
    expect(dry.connection).toBe("main");
    expect(dry.steps.length).toBeGreaterThan(0);
    expect(dry.steps.every((step) => step.kind === "auth")).toBe(true);

    const applied = await Auth.deploySchema({}, projectConfig, { env: pushEnv });
    expect(applied.applied).toBe(true);

    // Additive: pushing again is a clean no-op.
    const again = await Auth.deploySchema({}, projectConfig, { env: pushEnv });
    expect(again.steps).toEqual([]);
    expect(again.applied).toBe(false);
  });

  test("a push filtered to another connection contributes nothing", async () => {
    const skipped = await Auth.deploySchema({}, projectConfig, {
      connection: "other",
      dryRun: true,
      env: pushEnv,
    });
    expect(skipped).toEqual({ applied: false, connection: "main", steps: [], warnings: [] });
  });
});

describe("Auth.projectData", () => {
  test("exposes the section value (copy) as _project.auth", () => {
    const section = { redirects: { afterSignIn: "/app" } };
    const data = Auth.projectData(section);
    expect(data).toEqual(section);
    expect(data).not.toBe(section);
    expect(Auth.projectData(null)).toEqual({});
  });
});
