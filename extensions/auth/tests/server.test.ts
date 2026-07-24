/**
 * Server.test.ts — real Better Auth 1.6.25 over the connector's bun:sqlite dialect (plan Part 4b
 * testing bullet: sign-up → cookie → session; migrations compiled into kind "auth" push steps and
 * applied). The database is a tempdir sqlite file resolved through the real Sqlite provider, so the
 * whole `resolveDialect` seam runs, not a mock.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { Sqlite } from "@jxsuite/connector";
import {
  classifyAuthStatement,
  createJxAuth,
  getAuthMigrations,
  getSessionContext,
  splitSqlStatements,
} from "../src/server";
import type { AuthProjectConfig, AuthSection } from "../src/config";

const TMP = resolve(import.meta.dir, "__test-auth-server__");

const projectConfig: AuthProjectConfig = {
  connections: { main: { provider: "sqlite" } },
};
const section: AuthSection = { roles: ["admin"] };
const env = { BETTER_AUTH_SECRET: "unit-test-secret-0123456789", JX_PROJECT_ROOT: TMP };

/** Sign a user up through the fetch handler, returning the session cookie. */
async function signUp(
  auth: Awaited<ReturnType<typeof createJxAuth>>,
  email: string,
): Promise<string> {
  const response = await auth.handler(
    new Request("http://localhost:3000/_jx/auth/sign-up/email", {
      body: JSON.stringify({ email, name: "Unit", password: "hunter2hunter2" }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    }),
  );
  expect(response.status).toBe(200);
  const setCookie = response.headers.get("set-cookie") ?? "";
  expect(setCookie).toContain("better-auth");
  return setCookie.split(";")[0]!;
}

beforeAll(() => {
  rmSync(TMP, { force: true, recursive: true });
  mkdirSync(TMP, { recursive: true });
});

afterAll(() => {
  rmSync(TMP, { force: true, recursive: true });
});

describe("getAuthMigrations", () => {
  test("plans the Better Auth system tables as kind-auth steps and applies them", async () => {
    const migrations = await getAuthMigrations(section, projectConfig, env);
    expect(migrations.connection).toBe("main");
    const creates = migrations.steps.filter((step) => /^create table/i.test(step.sql));
    expect(creates.map((step) => step.table)).toEqual([
      "user",
      "session",
      "account",
      "verification",
    ]);
    for (const step of creates) {
      expect(step.summary).toContain("Create auth table");
    }
    for (const step of migrations.steps) {
      expect(step.kind).toBe("auth");
      expect(step.connection).toBe("main");
      // Better Auth 1.6 also compiles secondary indexes; every step is create-table or index.
      expect(step.sql).toMatch(/^create (table|(unique )?index)/i);
    }
    // The role column rides the user table because the section declares roles.
    expect(migrations.steps[0]!.sql).toContain('"role" text');

    await migrations.apply();

    // Additive: a second plan over the migrated database is empty and apply is a no-op.
    const again = await getAuthMigrations(section, projectConfig, env);
    expect(again.steps).toEqual([]);
    await again.apply();
  });

  test("prefers host-provided connector stand-ins", async () => {
    let called = 0;
    const connectors = {
      sqlite: {
        dialect: (connection: Parameters<typeof Sqlite.dialect>[0], e: Record<string, unknown>) => {
          called += 1;
          return Sqlite.dialect(connection, e);
        },
        kind: "sqlite" as const,
      },
    };
    const migrations = await getAuthMigrations(section, projectConfig, env, { connectors });
    expect(called).toBe(1);
    expect(migrations.steps).toEqual([]);
  });

  test("unknown connections and providers are clear errors", async () => {
    expect(getAuthMigrations({ connection: "ghost" }, projectConfig, env)).rejects.toThrow(
      /unknown connection "ghost"/i,
    );
    expect(
      getAuthMigrations({}, { connections: { odd: { provider: "acme" } } }, env),
    ).rejects.toThrow(/unknown provider "acme"/);
  });
});

describe("createJxAuth + getSessionContext", () => {
  test("sign-up issues a cookie; the cookie resolves to a SessionInfo", async () => {
    const auth = await createJxAuth(section, projectConfig, env);
    const cookie = await signUp(auth, "kevin@example.com");

    const session = await getSessionContext(
      auth,
      new Request("http://localhost:3000/anything", { headers: { cookie } }),
    );
    expect(session).not.toBeNull();
    expect(typeof session!.userId).toBe("string");
    // The role column exists but is unset — assigned via the data grid, never at sign-up.
    expect(session!.role).toBeUndefined();
    expect((session!.user as { email: string }).email).toBe("kevin@example.com");

    const anonymous = await getSessionContext(auth, new Request("http://localhost:3000/x"));
    expect(anonymous).toBeNull();
  });

  test("autoSync runs the migrations before serving (fresh database)", async () => {
    const fresh: AuthProjectConfig = {
      connections: { main: { file: "./fresh.sqlite", provider: "sqlite" } },
    };
    const auth = await createJxAuth({}, fresh, env, { autoSync: true });
    await signUp(auth, "fresh@example.com");
  });

  test("a missing secret fails closed naming the env var", async () => {
    expect(createJxAuth(section, projectConfig, { JX_PROJECT_ROOT: TMP })).rejects.toThrow(
      /BETTER_AUTH_SECRET/,
    );
  });
});

describe("statement helpers", () => {
  test("splitSqlStatements splits and trims a compiled blob", () => {
    expect(splitSqlStatements('create table "a" (x);\n\ncreate table "b" (y);\n')).toEqual([
      'create table "a" (x)',
      'create table "b" (y)',
    ]);
    expect(splitSqlStatements("")).toEqual([]);
  });

  test("classifyAuthStatement summarizes creates, column adds, and passthroughs", () => {
    expect(classifyAuthStatement('create table "user" ("id" text)', "main")).toMatchObject({
      kind: "auth",
      summary: 'Create auth table "user"',
      table: "user",
    });
    expect(
      classifyAuthStatement('alter table "user" add column "role" text', "main"),
    ).toMatchObject({ kind: "auth", summary: 'Add auth column "role" to "user"', table: "user" });
    expect(
      classifyAuthStatement('create index "session_userId_idx" on "session" ("userId")', "main"),
    ).toMatchObject({
      kind: "auth",
      summary: 'Create auth index "session_userId_idx" on "session"',
      table: "session",
    });
    expect(classifyAuthStatement("pragma foo", "main")).toMatchObject({
      kind: "auth",
      summary: "pragma foo",
    });
  });
});
