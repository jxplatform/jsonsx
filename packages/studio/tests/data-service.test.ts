/**
 * Tests for src/services/data-service.ts — the thin PAL wrapper over the optional data-surface
 * members: availability probes, pass-through calls, per-call degradation when members are absent or
 * throw, and the derived secret env-name convention.
 */
import { installMockPlatform } from "./harness";
import { describe, expect, test } from "bun:test";
import { registerPlatform } from "../src/platform";
import {
  dataSurfaceAvailable,
  deleteRow,
  deriveSecretEnvName,
  fetchConnections,
  fetchRows,
  insertRow,
  listSecretNames,
  pushSchema,
  saveSecrets,
  secretsAvailable,
  testConnection,
  updateRow,
} from "../src/services/data-service";
import type { StudioPlatform } from "../src/types";

const CONNECTIONS = {
  connections: [
    {
      configured: true,
      connector: { kind: "sqlite", provider: "sqlite" },
      isDefault: true,
      missingSecrets: [],
      name: "main",
      provider: "sqlite",
      settings: {},
      tables: ["posts"],
    },
  ],
};

function dataPlatform(overrides: Partial<StudioPlatform> = {}) {
  return installMockPlatform({
    dataConnections: async () => CONNECTIONS,
    dataConnectionTest: async () => ({ ok: true }),
    dataDeleteRow: async () => ({ ok: true }),
    dataInsertRow: async (req) => ({ row: { id: "new", ...req.values } }),
    dataPush: async (opts) => ({
      applied: opts?.dryRun !== true,
      plan: [{ kind: "createTable", summary: 'Create table "posts"', table: "posts" }],
    }),
    dataRows: async () => ({ columns: [], rows: [], total: 0 }),
    dataUpdateRow: async (req) => ({ row: { id: req.pk, ...req.set } }),
    listSecrets: async () => ["MAIN_URL"],
    setSecrets: async (req) => ({ names: Object.keys(req.set ?? {}), ok: true }),
    ...overrides,
  });
}

describe("degradation without the member family", () => {
  test("probes are false and list-shaped calls resolve empty", async () => {
    installMockPlatform();
    expect(dataSurfaceAvailable()).toBe(false);
    expect(secretsAvailable()).toBe(false);
    expect(await fetchConnections()).toBeNull();
    expect(await listSecretNames()).toBeNull();
  });

  test("action-shaped calls resolve error results instead of throwing", async () => {
    installMockPlatform();
    const probe = await testConnection("main");
    expect(probe.ok).toBe(false);
    expect(probe.error).toContain("not supported");
    const push = await pushSchema();
    expect(push.applied).toBe(false);
    expect(push.errors?.[0]).toContain("not supported");
  });

  test("grid CRUD throws a uniform degradation error", () => {
    installMockPlatform();
    expect(() => fetchRows({ table: "posts" })).toThrow("dataRows surface is not supported");
    expect(() => insertRow({ table: "posts", values: {} })).toThrow("dataInsertRow");
    expect(() => updateRow({ pk: 1, set: {}, table: "posts" })).toThrow("dataUpdateRow");
    expect(() => deleteRow({ pk: 1, table: "posts" })).toThrow("dataDeleteRow");
    expect(() => saveSecrets({ set: {} })).toThrow("setSecrets");
  });

  test("survives a missing platform registration entirely", async () => {
    registerPlatform(undefined as never);
    expect(dataSurfaceAvailable()).toBe(false);
    expect(await fetchConnections()).toBeNull();
    const probe = await testConnection("main");
    expect(probe.ok).toBe(false);
  });
});

describe("pass-through with a data-capable platform", () => {
  test("probes are true and calls delegate to the platform", async () => {
    dataPlatform();
    expect(dataSurfaceAvailable()).toBe(true);
    expect(secretsAvailable()).toBe(true);
    expect(await fetchConnections()).toEqual(CONNECTIONS);
    expect(await testConnection("main")).toEqual({ ok: true });
    expect(await listSecretNames()).toEqual(["MAIN_URL"]);

    const rows = await fetchRows({ limit: 10, table: "posts" });
    expect(rows.total).toBe(0);
    const inserted = await insertRow({ table: "posts", values: { title: "Hi" } });
    expect(inserted.row).toEqual({ id: "new", title: "Hi" });
    const updated = await updateRow({ pk: "new", set: { title: "Edit" }, table: "posts" });
    expect(updated.row.title).toBe("Edit");
    expect(await deleteRow({ pk: "new", table: "posts" })).toEqual({ ok: true });
    const saved = await saveSecrets({ set: { MAIN_URL: "v" } });
    expect(saved).toEqual({ names: ["MAIN_URL"], ok: true });
  });

  test("push passes dryRun through", async () => {
    dataPlatform();
    const dry = await pushSchema({ dryRun: true });
    expect(dry.applied).toBe(false);
    expect(dry.plan).toHaveLength(1);
    const applied = await pushSchema({ connection: "main" });
    expect(applied.applied).toBe(true);
  });

  test("thrown platform errors degrade to error results for test/push", async () => {
    dataPlatform({
      dataConnectionTest: async () => {
        throw new Error("boom-test");
      },
      dataPush: async () => {
        throw new Error("boom-push");
      },
    });
    expect(await testConnection("main")).toEqual({ error: "boom-test", ok: false });
    const push = await pushSchema();
    expect(push).toEqual({ applied: false, errors: ["boom-push"], plan: [] });
  });
});

describe("deriveSecretEnvName", () => {
  test("map entries derive from the entry key and drop the Env suffix", () => {
    expect(deriveSecretEnvName("connections", "main", "urlEnv")).toBe("MAIN_URL");
    expect(deriveSecretEnvName("connections", "myDb", "clientSecretEnv")).toBe(
      "MY_DB_CLIENT_SECRET",
    );
  });

  test("form sections derive from the section key", () => {
    expect(deriveSecretEnvName("auth", null, "secretEnv")).toBe("AUTH_SECRET");
  });

  test("names are always valid env identifiers", () => {
    expect(deriveSecretEnvName("connections", "2fast", "urlEnv")).toBe("JX_2FAST_URL");
    expect(deriveSecretEnvName("connections", "prod-db", "urlEnv")).toBe("PROD_DB_URL");
    expect(deriveSecretEnvName("", null, "Env")).toBe("SECRET");
  });
});
