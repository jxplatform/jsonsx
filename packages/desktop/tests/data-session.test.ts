/**
 * Tests for the project-session data-surface + secrets members — the desktop twins of
 * /__studio/data/* and /__studio/secrets, delegating verbatim to @jxsuite/server/data against this
 * session's project root (plan Part 4a).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createProjectSession } from "../src/project-session";
import type { ProjectSession } from "../src/project-session";

const TMP = resolve(import.meta.dir, "__test-data-session__");

let session: ProjectSession;

beforeAll(() => {
  rmSync(TMP, { force: true, recursive: true });
  mkdirSync(TMP, { recursive: true });
  writeFileSync(
    resolve(TMP, "project.json"),
    JSON.stringify(
      {
        connections: { main: { provider: "sqlite" } },
        data: {
          notes: {
            connection: "main",
            schema: { properties: { body: { type: "string" } }, type: "object" },
          },
        },
        extensions: ["@jxsuite/connector"],
        name: "Desktop Data Fixture",
      },
      null,
      2,
    ),
    "utf8",
  );
  writeFileSync(resolve(TMP, ".dev.vars"), "SEEDED=1\n", "utf8");
  session = createProjectSession(TMP);
});

afterAll(() => {
  session.dispose();
  rmSync(TMP, { force: true, recursive: true });
});

describe("without a project root", () => {
  test("every data member refuses with No project open", () => {
    const bare = createProjectSession(null);
    expect(() => bare.dataConnections()).toThrow("No project open");
    expect(() => bare.dataConnectionTest({ connection: "main" })).toThrow("No project open");
    expect(() => bare.dataPush({})).toThrow("No project open");
    expect(() => bare.dataRows({ table: "notes" })).toThrow("No project open");
    expect(() => bare.dataInsertRow({ table: "notes", values: {} })).toThrow("No project open");
    expect(() => bare.dataUpdateRow({ pk: 1, set: {}, table: "notes" })).toThrow("No project open");
    expect(() => bare.dataDeleteRow({ pk: 1, table: "notes" })).toThrow("No project open");
    expect(() => bare.listSecrets()).toThrow("No project open");
    expect(() => bare.setSecrets({ set: { A: "1" } })).toThrow("No project open");
    bare.dispose();
  });
});

describe("data surface delegation", () => {
  test("dataConnections lists the project's connections through the registry", async () => {
    const { connections } = await session.dataConnections();
    expect(connections).toHaveLength(1);
    expect(connections[0]!.name).toBe("main");
    expect(connections[0]!.isDefault).toBe(true);
    expect(connections[0]!.configured).toBe(true);
    expect(connections[0]!.connector?.kind).toBe("sqlite");
  });

  test("dataConnectionTest probes the connection", async () => {
    expect(await session.dataConnectionTest({ connection: "main" })).toEqual({ ok: true });
  });

  test("dataPush dry-runs and applies, then row CRUD round-trips", async () => {
    const dry = await session.dataPush({ connection: "main", dryRun: true });
    expect(dry.applied).toBe(false);
    expect(dry.plan.some((s) => s.kind === "createTable" && s.table === "notes")).toBe(true);

    const applied = await session.dataPush({ connection: "main" });
    expect(applied.applied).toBe(true);

    const inserted = await session.dataInsertRow({ table: "notes", values: { body: "hello" } });
    expect(typeof inserted.row.id).toBe("string");

    const page = await session.dataRows({ table: "notes" });
    expect(page.total).toBe(1);
    expect(page.columns.find((c) => c.name === "id")?.pk).toBe(true);

    const updated = await session.dataUpdateRow({
      pk: inserted.row.id as string,
      set: { body: "edited" },
      table: "notes",
    });
    expect(updated.row.body).toBe("edited");

    expect(await session.dataDeleteRow({ pk: inserted.row.id as string, table: "notes" })).toEqual({
      ok: true,
    });
    const after = await session.dataRows({ table: "notes" });
    expect(after.total).toBe(0);
  });
});

describe("secrets delegation", () => {
  test("listSecrets returns names only; setSecrets writes .dev.vars", async () => {
    expect(await session.listSecrets()).toEqual({ names: ["SEEDED"] });
    const result = await session.setSecrets({ set: { NEW_KEY: "value" } });
    expect(result).toEqual({ names: ["SEEDED", "NEW_KEY"], ok: true });
    const text = readFileSync(resolve(TMP, ".dev.vars"), "utf8");
    expect(text).toBe("SEEDED=1\nNEW_KEY=value\n");
  });
});
