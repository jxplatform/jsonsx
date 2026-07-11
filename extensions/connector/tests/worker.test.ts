/**
 * Worker — handleDataRequest over real in-memory bun:sqlite with constructed Requests: the wire
 * contract (specs/extensions.md §11), the fail-closed permission matrix, setColumns/whereOwner
 * grants, junction writes, and include expansion.
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createBunSqliteDialect } from "../src/dialects/bun-sqlite";
import { Data, createDataMountState, handleDataRequest } from "../src/worker";
import type { DataMountOptions, DataMountState } from "../src/worker";
import type { JxAuthHooks, JxServerContext, TableDef } from "../src/types";

const TABLES: Record<string, TableDef> = {
  comments: {
    connection: "main",
    ownerField: "user_id",
    permissions: { delete: "owner", insert: "public", read: "public", update: "public" },
    schema: {
      properties: {
        approved: { type: "boolean", default: false },
        author: { $ref: "#/data/users" },
        message: { type: "string" },
        views: { type: "integer" },
      },
      required: ["message"],
      type: "object",
    },
  },
  drafts: {
    connection: "main",
    permissions: { insert: "authenticated", read: "none", update: "role:editor" },
    schema: { properties: { body: { type: "string" } }, type: "object" },
  },
  posts: {
    connection: "main",
    permissions: { insert: "public", read: "public", update: "public" },
    schema: {
      properties: {
        tags: { items: { $ref: "#/data/tags" }, type: "array" },
        title: { type: "string" },
      },
      type: "object",
    },
  },
  tags: {
    connection: "main",
    permissions: { insert: "public", read: "public" },
    schema: { properties: { name: { type: "string" } }, type: "object" },
  },
  users: {
    connection: "main",
    permissions: { insert: "public", read: "public" },
    schema: { properties: { name: { type: "string" } }, type: "object" },
  },
};

type Call = (method: string, path: string, body?: unknown) => Promise<Response>;

interface Harness {
  options: DataMountOptions;
  state: DataMountState;
  ctx: JxServerContext;
  call: Call;
}

function makeHarness(
  ctx: JxServerContext = {},
  tables: Record<string, TableDef> = TABLES,
): Harness {
  const database = new Database(":memory:");
  const options: DataMountOptions = {
    autoSync: true,
    connectors: {
      test: { dialect: () => createBunSqliteDialect({ database }), kind: "sqlite" },
    },
    sections: { connections: { main: { provider: "test" } }, data: tables },
  };
  const state = createDataMountState();
  const call: Call = (method, path, body) => {
    const request = new Request(`http://site.test${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
    });
    return handleDataRequest(request, {}, options, ctx, state);
  };
  return { call, ctx, options, state };
}

async function json(promise: Promise<Response> | Response): Promise<Record<string, unknown>> {
  const response = await promise;
  return (await response.json()) as Record<string, unknown>;
}

async function rows(promise: Promise<Response>): Promise<Record<string, unknown>[]> {
  const response = await promise;
  return (await response.json()) as Record<string, unknown>[];
}

async function statusOf(promise: Promise<Response>): Promise<number> {
  const response = await promise;
  return response.status;
}

describe("wire contract", () => {
  test("full CRUD round-trip with coercion, timestamps, and uuid ids", async () => {
    const { call } = makeHarness();

    const created = await call("POST", "/_jx/data/comments", {
      approved: "on",
      message: "hello",
      views: "3",
    });
    expect(created.status).toBe(201);
    const row = await json(created);
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.approved).toBe(true);
    expect(row.views).toBe(3);
    expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(row.updated_at).toBe(row.created_at as string);

    const listed = await rows(call("GET", "/_jx/data/comments"));
    expect(listed).toHaveLength(1);
    expect(listed[0]!.message).toBe("hello");

    expect(await statusOf(call("GET", `/_jx/data/comments/${row.id}`))).toBe(200);

    const patched = await json(
      call("PATCH", `/_jx/data/comments/${row.id}`, { message: "edited" }),
    );
    expect(patched.message).toBe("edited");
    expect(patched.approved).toBe(true);

    // Delete rule is "owner" and there is no auth mount → fail-closed 401.
    expect(await statusOf(call("DELETE", `/_jx/data/comments/${row.id}`))).toBe(401);
  });

  test("filters, sort, limit, and offset flow through the query grammar", async () => {
    const { call } = makeHarness();
    for (const [message, views] of [
      ["alpha", 1],
      ["beta", 5],
      ["gamma", 9],
    ] as const) {
      await call("POST", "/_jx/data/comments", { message, views });
    }
    const filter = encodeURIComponent(JSON.stringify([{ field: "views", op: ">", value: 2 }]));
    const sort = encodeURIComponent(JSON.stringify({ field: "views", order: "desc" }));
    const filtered = await rows(call("GET", `/_jx/data/comments?filter=${filter}&sort=${sort}`));
    expect(filtered.map((r) => r.message)).toEqual(["gamma", "beta"]);

    const paged = await rows(call("GET", `/_jx/data/comments?sort=${sort}&limit=1&offset=1`));
    expect(paged.map((r) => r.message)).toEqual(["beta"]);

    const offsetOnly = await rows(call("GET", `/_jx/data/comments?sort=${sort}&offset=2`));
    expect(offsetOnly.map((r) => r.message)).toEqual(["alpha"]);

    expect(await statusOf(call("GET", "/_jx/data/comments?filter={broken"))).toBe(400);
  });

  test("route and method errors: unknown table, bad ids, wrong methods", async () => {
    const { call } = makeHarness();
    expect(await statusOf(call("GET", "/_jx/data/nope"))).toBe(404);
    expect(await statusOf(call("GET", "/_jx/data"))).toBe(404);
    expect(await statusOf(call("GET", "/_jx/data/comments/x/y"))).toBe(404);
    expect(await statusOf(call("GET", "/other/path"))).toBe(404);
    expect(await statusOf(call("PATCH", "/_jx/data/comments"))).toBe(405);
    expect(await statusOf(call("DELETE", "/_jx/data/comments"))).toBe(405);
    expect(await statusOf(call("POST", "/_jx/data/comments/some-id", {}))).toBe(405);
    expect(await statusOf(call("PUT", "/_jx/data/comments/x", {}))).toBe(405);
    expect(await statusOf(call("GET", "/_jx/data/comments/missing"))).toBe(404);
  });

  test("validation failures are 400 with issues; empty patches are rejected", async () => {
    const { call } = makeHarness();
    const invalid = await call("POST", "/_jx/data/comments", { junk: 1 });
    expect(invalid.status).toBe(400);
    const body = await json(invalid);
    expect(body.error).toBe("Validation failed");
    expect(Array.isArray(body.issues)).toBe(true);

    const created = await json(call("POST", "/_jx/data/comments", { message: "x" }));
    expect(await statusOf(call("PATCH", `/_jx/data/comments/${created.id}`, {}))).toBe(400);

    const harness = makeHarness();
    const rawBad = new Request("http://site.test/_jx/data/comments", {
      body: "{not json",
      method: "POST",
    });
    const parsed = await handleDataRequest(rawBad, {}, harness.options, {}, harness.state);
    expect(parsed.status).toBe(400);
  });

  test("integer-id tables parse path ids numerically", async () => {
    const tables: Record<string, TableDef> = {
      posts: {
        connection: "main",
        id: "integer",
        permissions: { insert: "public", read: "public" },
        schema: { properties: { title: { type: "string" } }, type: "object" },
        timestamps: false,
      },
    };
    const { call } = makeHarness({}, tables);
    const created = await json(call("POST", "/_jx/data/posts", { title: "first" }));
    expect(created.id).toBe(1);
    expect(await statusOf(call("GET", "/_jx/data/posts/1"))).toBe(200);
    expect(await statusOf(call("GET", "/_jx/data/posts/1.5"))).toBe(404);
  });

  test("junction writes replace link rows; include expands them and to-one refs", async () => {
    const { call } = makeHarness();
    const tagA = await json(call("POST", "/_jx/data/tags", { name: "a" }));
    const tagB = await json(call("POST", "/_jx/data/tags", { name: "b" }));
    const user = await json(call("POST", "/_jx/data/users", { name: "kevin" }));

    const post = await json(
      call("POST", "/_jx/data/posts", { tags: [tagA.id, tagB.id], title: "hello" }),
    );
    const included = await json(call("GET", `/_jx/data/posts/${post.id}?include=tags`));
    const tagNames = (included.tags as Record<string, unknown>[]).map((t) => t.name).toSorted();
    expect(tagNames).toEqual(["a", "b"]);

    // Replace the link set.
    await call("PATCH", `/_jx/data/posts/${post.id}`, { tags: [tagB.id] });
    const after = await json(call("GET", `/_jx/data/posts/${post.id}?include=tags`));
    expect((after.tags as Record<string, unknown>[]).map((t) => t.name)).toEqual(["b"]);

    // To-one include: comments.author → users row; unknown include fields are ignored.
    const comment = await json(
      call("POST", "/_jx/data/comments", { author: user.id as string, message: "hi" }),
    );
    expect(comment.author_id).toBe(user.id as string);
    const withAuthor = await json(
      call("GET", `/_jx/data/comments/${comment.id}?include=author,ghost`),
    );
    expect((withAuthor.author as Record<string, unknown>).name).toBe("kevin");
  });

  test("Data.mount returns a memoizing fetch-style handler and projectData echoes the section", async () => {
    const database = new Database(":memory:");
    const options: DataMountOptions = {
      autoSync: true,
      connectors: { test: { dialect: () => createBunSqliteDialect({ database }), kind: "sqlite" } },
      sections: { connections: { main: { provider: "test" } }, data: TABLES },
    };
    const handler = Data.mount(options, {});
    const created = await handler(
      new Request("http://x/_jx/data/comments", {
        body: JSON.stringify({ message: "via mount" }),
        method: "POST",
      }),
      {},
    );
    expect(created.status).toBe(201);

    expect(Data.projectData(TABLES)).toEqual(TABLES);
    expect(Data.projectData(null)).toEqual({});
  });

  test("unknown connections and providers are 500 config errors", async () => {
    const tables: Record<string, TableDef> = {
      x: { connection: "ghost", permissions: { read: "public" }, schema: { type: "object" } },
      y: { connection: "badprov", permissions: { read: "public" }, schema: { type: "object" } },
    };
    const options: DataMountOptions = {
      connectors: {},
      sections: {
        connections: { badprov: { provider: "nope" } },
        data: tables,
      },
    };
    const missingConn = await handleDataRequest(
      new Request("http://x/_jx/data/x"),
      {},
      options,
      {},
    );
    expect(missingConn.status).toBe(500);
    const missingProv = await handleDataRequest(
      new Request("http://x/_jx/data/y"),
      {},
      options,
      {},
    );
    expect(missingProv.status).toBe(500);
    const body = await json(missingProv);
    expect(body.error).toContain("provider");
  });
});

describe("fail-closed permission matrix", () => {
  test("without ctx.auth: only public rules pass; writes default closed", async () => {
    const { call } = makeHarness();
    // Drafts: read "none" → 403 even without auth; insert "authenticated" → 401 fail-closed.
    expect(await statusOf(call("GET", "/_jx/data/drafts"))).toBe(403);
    expect(await statusOf(call("POST", "/_jx/data/drafts", { body: "x" }))).toBe(401);
    expect(await statusOf(call("PATCH", "/_jx/data/drafts/1", { body: "x" }))).toBe(401);
    // Comments: update "public" passes (404 for a missing row, not 401).
    expect(await statusOf(call("PATCH", "/_jx/data/comments/nope", { message: "x" }))).toBe(404);
    // Users/tags: no rule for the action → default read public / writes none.
    expect(await statusOf(call("GET", "/_jx/data/users"))).toBe(200);
    expect(await statusOf(call("DELETE", "/_jx/data/tags/1"))).toBe(403);
    expect(await statusOf(call("PATCH", "/_jx/data/users/1", { name: "x" }))).toBe(403);
  });

  test("with ctx.auth: session and rule flow into authorize; denials carry its status", async () => {
    const seen: { rule: string; ownerField?: string }[] = [];
    const auth: JxAuthHooks = {
      authorize: async (input) => {
        seen.push({ rule: input.rule, ...(input.ownerField && { ownerField: input.ownerField }) });
        if (input.rule === "authenticated") {
          return input.session ? { allow: true } : { allow: false, status: 401 };
        }
        return { allow: false, error: "Editor role required", status: 403 };
      },
      getSession: async (request) =>
        request.headers.get("x-user") ? { role: "member", userId: "u1" } : null,
    };
    const { call, options, state } = makeHarness({ auth });

    expect(await statusOf(call("POST", "/_jx/data/drafts", { body: "x" }))).toBe(401);

    const authed = await handleDataRequest(
      new Request("http://x/_jx/data/drafts", {
        body: JSON.stringify({ body: "mine" }),
        headers: { "x-user": "u1" },
        method: "POST",
      }),
      {},
      options,
      { auth },
      state,
    );
    expect(authed.status).toBe(201);

    const roleDenied = await call("PATCH", "/_jx/data/drafts/some-id", { body: "x" });
    expect(roleDenied.status).toBe(403);
    const denial = await json(roleDenied);
    expect(denial.error).toBe("Editor role required");
    expect(seen.at(-1)!.rule).toBe("role:editor");
  });

  test("owner grants apply setColumns on insert and whereOwner scoping on reads/deletes", async () => {
    const asUser = (userId: string | null): JxAuthHooks => ({
      authorize: async (input) => {
        if (!userId) {
          return { allow: false, status: 401 };
        }
        return {
          allow: true,
          setColumns: input.action === "insert" ? { [input.ownerField!]: userId } : {},
          whereOwner: input.rule === "owner" ? { field: input.ownerField!, value: userId } : null,
        };
      },
      getSession: async () => (userId ? { userId } : null),
    });

    const tables: Record<string, TableDef> = {
      notes: {
        connection: "main",
        ownerField: "user_id",
        permissions: { delete: "owner", insert: "authenticated", read: "owner" },
        schema: { properties: { text: { type: "string" } }, type: "object" },
      },
    };
    const database = new Database(":memory:");
    const options: DataMountOptions = {
      autoSync: true,
      connectors: { test: { dialect: () => createBunSqliteDialect({ database }), kind: "sqlite" } },
      sections: { connections: { main: { provider: "test" } }, data: tables },
    };
    const state = createDataMountState();
    const callAs = (user: string | null, method: string, path: string, body?: unknown) =>
      handleDataRequest(
        new Request(`http://x${path}`, {
          method,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
        {},
        options,
        { auth: asUser(user) },
        state,
      );

    const mine = await json(callAs("alice", "POST", "/_jx/data/notes", { text: "mine" }));
    expect(mine.user_id).toBe("alice");
    await callAs("bob", "POST", "/_jx/data/notes", { text: "bobs" });

    const aliceRows = await rows(callAs("alice", "GET", "/_jx/data/notes"));
    expect(aliceRows.map((r) => r.text)).toEqual(["mine"]);

    // Bob cannot delete Alice's note: owner scoping turns it into a 404.
    expect(await statusOf(callAs("bob", "DELETE", `/_jx/data/notes/${mine.id}`))).toBe(404);
    const allowed = await callAs("alice", "DELETE", `/_jx/data/notes/${mine.id}`);
    expect(allowed.status).toBe(200);
    expect(await json(allowed)).toEqual({ ok: true });
  });
});
