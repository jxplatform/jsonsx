/**
 * Table-state — the TableQuery/TableEntry/action classes: URL building with preserved template
 * placeholders, the `_v` read-after-write convention, `lower` outputs (Request/Function defs),
 * node-side resolution over a real sqlite file, and the browser fetch path with a stubbed DOM.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDataUrl,
  encodeQueryValue,
  jsObjectSource,
  jsValueSource,
  resolveIdValue,
} from "../src/table-shared";
import { TableEntry, TableQuery } from "../src/table-state";
import { TableInsert } from "../src/table-insert";
import { TableUpdate } from "../src/table-update";
import { TableDelete } from "../src/table-delete";
import { lowerActionDef } from "../src/table-actions";
import type { TableDef } from "../src/types";

const globalRef = globalThis as Record<string, unknown>;
const realFetch = globalThis.fetch;

afterEach(() => {
  delete globalRef.document;
  globalRef.fetch = realFetch;
});

/** Stub a browser: a document global plus a fetch recorder returning the given payload. */
function stubBrowser(payload: unknown, status = 200): { urls: string[] } {
  const urls: string[] = [];
  globalRef.document = {};
  globalRef.fetch = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return Response.json(payload, { status });
  }) as typeof globalThis.fetch;
  return { urls };
}

describe("table-shared helpers", () => {
  test("encodeQueryValue percent-encodes around template spans", () => {
    expect(encodeQueryValue('{"q":"${state.q}"}')).toBe("%7B%22q%22%3A%22${state.q}%22%7D");
    expect(encodeQueryValue("plain value")).toBe("plain%20value");
  });

  test("buildDataUrl carries filter/sort/limit/offset/include and the _v param", () => {
    const url = buildDataUrl(
      {
        filter: { approved: true },
        include: ["author", "tags"],
        limit: 10,
        offset: 5,
        sort: { field: "created_at", order: "desc" },
        table: "comments",
      },
      { versionParam: true },
    );
    expect(url).toBe(
      "/_jx/data/comments?filter=%7B%22approved%22%3Atrue%7D" +
        "&sort=%7B%22field%22%3A%22created_at%22%2C%22order%22%3A%22desc%22%7D" +
        "&limit=10&offset=5&include=author%2Ctags&_v=${(state._v || 0)}",
    );
    expect(buildDataUrl({ table: "t" })).toBe("/_jx/data/t");
    expect(buildDataUrl({ table: "t" }, { id: "abc" })).toBe("/_jx/data/t/abc");
  });

  test("resolveIdValue handles literals, templates, and #/$params refs", () => {
    expect(resolveIdValue("x1", {})).toBe("x1");
    expect(resolveIdValue(7, {})).toBe("7");
    expect(resolveIdValue("${state.id}", {})).toBe("${state.id}");
    expect(resolveIdValue({ $ref: "#/$params/slug" }, { slug: "hello" })).toBe("hello");
    expect(resolveIdValue({ $ref: "#/$params/slug" }, {})).toBeUndefined();
    expect(resolveIdValue({ $ref: "#/state/x" }, {})).toBeUndefined();
    expect(resolveIdValue(null, {})).toBeUndefined();
  });

  test("jsValueSource emits template literals for ${...} strings and JSON otherwise", () => {
    expect(jsValueSource("plain")).toBe('"plain"');
    expect(jsValueSource("${state.q}")).toBe("`${state.q}`");
    expect(jsValueSource(3)).toBe("3");
    expect(jsObjectSource({ a: 1, b: "${state.x}" })).toBe('{ "a": 1, "b": `${state.x}` }');
    expect(jsObjectSource({})).toBe("{}");
  });
});

describe("lower capabilities", () => {
  test("TableQuery lowers to a Request def with preserved templates and _v", () => {
    const lowered = TableQuery.lower({
      $prototype: "TableQuery",
      filter: [{ field: "q", op: "contains", value: "${state.search}" }],
      table: "comments",
      timing: "client",
    });
    expect(lowered.$prototype).toBe("Request");
    expect(lowered.timing).toBe("client");
    expect(lowered.default).toEqual([]);
    const url = lowered.url as string;
    expect(url).toStartWith("/_jx/data/comments?filter=");
    expect(url).toContain("${state.search}");
    expect(url).toContain("_v=${(state._v || 0)}");
  });

  test("TableEntry lowers with route-param substitution", () => {
    const lowered = TableEntry.lower(
      { $prototype: "TableEntry", id: { $ref: "#/$params/slug" }, table: "posts" },
      { route: { _pathParams: { slug: "abc" } } },
    );
    expect(lowered.url).toBe("/_jx/data/posts/abc?_v=${(state._v || 0)}");
    expect(lowered.default).toBeNull();

    const unresolved = TableEntry.lower({ $prototype: "TableEntry", table: "posts" }, {});
    expect(unresolved.url).toBe("/_jx/data/posts/?_v=${(state._v || 0)}");
  });

  test("actions lower to inline Function defs with event parameter and _v bump", () => {
    const insert = TableInsert.lower({ table: "comments", values: { source: "web" } });
    expect(insert.$prototype).toBe("Function");
    expect(insert.parameters).toEqual(["event"]);
    expect(insert.timing).toBe("client");
    const insertBody = insert.body as string;
    expect(insertBody).toContain("fetch(\"/_jx/data/comments\", { method: 'POST'");
    expect(insertBody).toContain('"source": "web"');
    expect(insertBody).toContain("state._v = (state._v || 0) + 1;");
    expect(insertBody).toContain("form.reset");
    expect(insertBody).not.toContain("return");

    const update = TableUpdate.lower(
      { id: { $ref: "#/$params/id" }, table: "comments" },
      { route: { _pathParams: { id: "42" } } },
    );
    expect(update.body as string).toContain("fetch(\"/_jx/data/comments/42\", { method: 'PATCH'");
    expect(update.body as string).not.toContain("form.reset");

    const remove = TableDelete.lower({ id: "${state.selected}", table: "comments" });
    expect(remove.body as string).toContain("fetch(`/_jx/data/comments/${state.selected}`");
    expect(remove.body as string).toContain("method: 'DELETE'");
  });

  test("lowered action bodies execute: fetch fires and state._v bumps on success", async () => {
    const lowered = lowerActionDef("POST", { table: "comments", values: { message: "hi" } });
    const calls: { url: string; init: RequestInit }[] = [];
    globalRef.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ init: init ?? {}, url: String(input) });
      return Response.json({ ok: true }, { status: 201 });
    }) as typeof globalThis.fetch;

    const handler = new Function("state", "event", lowered.body as string) as (
      state: Record<string, unknown>,
      event?: unknown,
    ) => void;
    const state: Record<string, unknown> = {};
    handler(state);
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/_jx/data/comments");
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ message: "hi" });
    expect(state._v).toBe(1);
  });
});

describe("node-side resolution", () => {
  const tables: Record<string, TableDef> = {
    comments: {
      connection: "main",
      schema: {
        properties: { approved: { type: "boolean" }, message: { type: "string" } },
        type: "object",
      },
    },
  };

  test("TableQuery/TableEntry resolve against a real local sqlite database", async () => {
    const root = mkdtempSync(join(tmpdir(), "jx-table-node-"));
    try {
      const projectConfig = {
        connections: { main: { provider: "sqlite" } },
        data: tables,
      };
      const _project = { config: projectConfig, root };

      // Auto-sync creates the schema on first read; then seed through a direct insert.
      const empty = await new TableQuery({ _project, table: "comments" }).resolve();
      expect(empty).toEqual([]);

      const { queryTable, getEntry } = await import("../src/table-node");
      const { resolveDialect } = await import("../src/connectors");
      const { Kysely } = await import("kysely");
      const { dialect } = await resolveDialect("main", projectConfig, { JX_PROJECT_ROOT: root });
      const db = new Kysely<Record<string, Record<string, unknown>>>({ dialect });
      await db.insertInto("comments").values({ approved: 1, id: "c1", message: "hello" }).execute();
      await db.destroy();

      const rows = (await queryTable({
        _project,
        filter: { approved: true },
        table: "comments",
      })) as Record<string, unknown>[];
      expect(rows).toHaveLength(1);
      expect(rows[0]!.approved).toBe(true);

      const entry = await getEntry({ _project, table: "comments" }, "c1");
      expect(entry!.message).toBe("hello");
      expect(await getEntry({ _project, table: "comments" }, "ghost")).toBeNull();

      const viaClass = await new TableEntry({ _project, id: "c1", table: "comments" }).resolve();
      expect((viaClass as Record<string, unknown>).message).toBe("hello");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("unreachable databases degrade to warnings + empty results (SSG contract)", async () => {
    const _project = {
      config: {
        connections: { main: { databaseId: "x", provider: "d1" } },
        data: tables,
      },
      root: "/nowhere",
    };
    const rows = await new TableQuery({ _project, table: "comments" }).resolve();
    expect(rows).toEqual([]);
    const entry = await new TableEntry({ _project, id: "c1", table: "comments" }).resolve();
    expect(entry).toBeNull();
    const unknownTable = await new TableQuery({ _project, table: "ghost" }).resolve();
    expect(unknownTable).toEqual([]);
  });
});

describe("browser resolution", () => {
  test("TableQuery fetches the /_jx/data URL and returns rows", async () => {
    const { urls } = stubBrowser([{ id: "a" }]);
    const rows = await new TableQuery({
      filter: { approved: true },
      table: "comments",
    }).resolve();
    expect(rows).toEqual([{ id: "a" }]);
    expect(urls[0]).toStartWith("/_jx/data/comments?filter=");
  });

  test("TableEntry fetches by id and maps 404 to null", async () => {
    const { urls } = stubBrowser({ id: "c1" });
    const entry = await new TableEntry({ id: "c1", table: "comments" }).resolve();
    expect(entry).toEqual({ id: "c1" });
    expect(urls[0]).toBe("/_jx/data/comments/c1");

    stubBrowser({ error: "Not found" }, 404);
    const missing = await new TableEntry({ id: "ghost", table: "comments" }).resolve();
    expect(missing).toBeNull();

    const noId = await new TableEntry({ table: "comments" }).resolve();
    expect(noId).toBeNull();
  });

  test("action handlers post form-free payloads and bump scope._v", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    globalRef.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ init: init ?? {}, url: String(input) });
      return Response.json({}, { status: 200 });
    }) as typeof globalThis.fetch;

    const scope: Record<string, unknown> = { q: "hello" };
    const insert = new TableInsert({
      table: "comments",
      values: { message: "${state.q} world" },
    }).resolve();
    expect(await insert(scope)).toBe(true);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ message: "hello world" });
    expect(scope._v).toBe(1);

    const update = new TableUpdate({
      id: "c1",
      table: "comments",
      values: { message: "x" },
    }).resolve();
    await update(scope);
    expect(calls[1]!.url).toBe("/_jx/data/comments/c1");
    expect(calls[1]!.init.method).toBe("PATCH");

    const remove = new TableDelete({ id: "c1", table: "comments" }).resolve();
    await remove(scope);
    expect(calls[2]!.init.method).toBe("DELETE");
    expect(calls[2]!.init.body).toBeUndefined();
    expect(scope._v).toBe(3);
  });
});
