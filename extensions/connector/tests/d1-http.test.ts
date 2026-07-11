/**
 * D1-http dialect — SQL forwarding to the Cloudflare HTTP API with a mocked fetch: request shape,
 * row/meta mapping, and error surfacing.
 */

import { describe, expect, test } from "bun:test";
import { Kysely, sql } from "kysely";
import { createD1HttpDialect } from "../src/dialects/d1-http";
import type { DynamicDatabase } from "../src/query";

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: { sql: string; params: unknown[] };
}

function makeDb(responder: (captured: Captured) => Response) {
  const calls: Captured[] = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const captured: Captured = {
      body: JSON.parse(String(init?.body)) as Captured["body"],
      headers: { ...(init?.headers as Record<string, string>) },
      url: String(input),
    };
    calls.push(captured);
    return responder(captured);
  }) as typeof globalThis.fetch;
  const db = new Kysely<DynamicDatabase>({
    dialect: createD1HttpDialect({
      accountId: "acct",
      apiToken: "tok",
      databaseId: "db-uuid",
      fetch: fakeFetch,
    }),
  });
  return { calls, db };
}

function d1Ok(results: Record<string, unknown>[], meta: Record<string, unknown> = {}) {
  return Response.json({ result: [{ meta, results, success: true }], success: true });
}

describe("createD1HttpDialect", () => {
  test("POSTs sql + params to the account/database endpoint with the bearer token", async () => {
    const { calls, db } = makeDb(() => d1Ok([{ id: "a", n: 1 }]));
    const rows = await db.selectFrom("t").selectAll().where("id", "=", "a").execute();
    expect(rows).toEqual([{ id: "a", n: 1 }]);

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct/d1/database/db-uuid/query",
    );
    expect(call!.headers.Authorization).toBe("Bearer tok");
    expect(call!.body.sql).toBe('select * from "t" where "id" = ?');
    expect(call!.body.params).toEqual(["a"]);
  });

  test("maps meta.changes and meta.last_row_id to Kysely result fields", async () => {
    const { db } = makeDb(() => d1Ok([], { changes: 2, last_row_id: 7 }));
    const result = await db.deleteFrom("t").where("id", "=", "x").executeTakeFirst();
    expect(result.numDeletedRows).toBe(2n);
  });

  test("surfaces API error messages", async () => {
    const { db } = makeDb(() =>
      Response.json(
        { errors: [{ code: 7500, message: "no such table: nope" }], success: false },
        { status: 400 },
      ),
    );
    expect(sql`select 1`.execute(db)).rejects.toThrow("no such table: nope");
  });

  test("falls back to the HTTP status when the body is not JSON", async () => {
    const { db } = makeDb(() => new Response("boom", { status: 502 }));
    expect(sql`select 1`.execute(db)).rejects.toThrow("HTTP 502");
  });

  test("supports a baseUrl override and rejects transactions", async () => {
    const calls: string[] = [];
    const fakeFetch = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return d1Ok([]);
    }) as typeof globalThis.fetch;
    const db = new Kysely<DynamicDatabase>({
      dialect: createD1HttpDialect({
        accountId: "a",
        apiToken: "t",
        baseUrl: "http://localhost:8787",
        databaseId: "d",
        fetch: fakeFetch,
      }),
    });
    await sql`select 1`.execute(db);
    expect(calls[0]).toStartWith("http://localhost:8787/client/v4/accounts/a/");

    expect(
      db.transaction().execute(async (trx) => {
        await sql`select 1`.execute(trx);
        throw new Error("force rollback");
      }),
    ).rejects.toThrow();

    // Begin/commit are per-statement no-ops; a successful transaction just runs its queries.
    const committed = await db.transaction().execute(async (trx) => {
      await sql`select 1`.execute(trx);
      return "done";
    });
    expect(committed).toBe("done");
    await db.destroy();
  });
});
