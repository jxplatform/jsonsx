/**
 * Route-table integrity: every entry is well-formed, paths are unique per method under the
 * /__studio namespace, and the core/optional split matches the degradation notes.
 */
import { describe, expect, test } from "bun:test";
import {
  coreRouteNames,
  optionalRouteNames,
  STUDIO_PROTOCOL_VERSION,
  STUDIO_ROUTES,
} from "../src/index";

const entries = Object.entries(STUDIO_ROUTES);

describe("STUDIO_ROUTES", () => {
  test("declares protocol version 1", () => {
    expect(STUDIO_PROTOCOL_VERSION).toBe(1);
  });

  test("every route lives under /__studio and carries a summary", () => {
    for (const [name, route] of entries) {
      expect(route.path.startsWith("/__studio/"), `${name} path`).toBe(true);
      expect(route.summary.length, `${name} summary`).toBeGreaterThan(0);
      expect(["GET", "POST", "PUT", "DELETE"]).toContain(route.method);
    }
  });

  test("method+path pairs are unique", () => {
    const seen = new Set<string>();
    for (const [, route] of entries) {
      const key = `${route.method} ${route.path}`;
      expect(seen.has(key), key).toBe(false);
      seen.add(key);
    }
  });

  test("optional routes each explain their degradation; core routes have none", () => {
    for (const [name, route] of entries) {
      if (route.optional) {
        expect(route.degradation, `${name} degradation`).toBeTruthy();
      } else {
        expect(route.degradation, `${name} degradation`).toBeUndefined();
      }
    }
  });

  test("core/optional helpers partition the table", () => {
    const core = coreRouteNames();
    const optional = optionalRouteNames();
    expect(core.length + optional.length).toBe(entries.length);
    expect(core.some((name) => STUDIO_ROUTES[name].optional)).toBe(false);
    expect(optional.every((name) => STUDIO_ROUTES[name].optional)).toBe(true);
    // The load-bearing core endpoints are present by name.
    for (const name of ["fileRead", "fileWrite", "gitStatus", "gitCommit", "aiChat"] as const) {
      expect(core).toContain(name);
    }
    // Known-optional surfaces stay optional.
    for (const name of ["sites", "starters", "cfProxy", "gitClone", "projectSchemas"] as const) {
      expect(optional).toContain(name);
    }
  });

  test("the formats route documents the additive extensions payload", () => {
    expect(STUDIO_ROUTES.formats.summary).toContain("extensions");
    expect(STUDIO_ROUTES.formats.summary).toContain("listExtensions");
  });

  test("the project-schemas route serves pre-bundled entry documents", () => {
    expect(STUDIO_ROUTES.projectSchemas.path).toBe("/__studio/project-schemas");
    expect(STUDIO_ROUTES.projectSchemas.method).toBe("GET");
    expect(STUDIO_ROUTES.projectSchemas.optional).toBe(true);
    expect(STUDIO_ROUTES.projectSchemas.summary).toContain("fetchProjectSchemas");
    expect(STUDIO_ROUTES.projectSchemas.degradation).toContain("bundled core schemas");
  });

  test("data routes cover the owner-console surface as optional routes", () => {
    const names = [
      "dataConnections",
      "dataConnectionTest",
      "dataPush",
      "dataRows",
      "dataInsertRow",
      "dataUpdateRow",
      "dataDeleteRow",
    ] as const;
    for (const name of names) {
      expect(STUDIO_ROUTES[name].optional, name).toBe(true);
      expect(STUDIO_ROUTES[name].path.startsWith("/__studio/data/"), name).toBe(true);
    }
    expect(STUDIO_ROUTES.dataConnections.method).toBe("GET");
    expect(STUDIO_ROUTES.dataConnectionTest.method).toBe("POST");
    expect(STUDIO_ROUTES.dataPush.method).toBe("POST");
    expect(STUDIO_ROUTES.dataPush.summary).toContain("DataPushStep");
  });

  test("row routes share one path across GET/POST/PUT/DELETE", () => {
    expect(STUDIO_ROUTES.dataRows.path).toBe("/__studio/data/rows");
    expect(STUDIO_ROUTES.dataInsertRow.path).toBe(STUDIO_ROUTES.dataRows.path);
    expect(STUDIO_ROUTES.dataUpdateRow.path).toBe(STUDIO_ROUTES.dataRows.path);
    expect(STUDIO_ROUTES.dataDeleteRow.path).toBe(STUDIO_ROUTES.dataRows.path);
    expect(STUDIO_ROUTES.dataRows.method).toBe("GET");
    expect(STUDIO_ROUTES.dataInsertRow.method).toBe("POST");
    expect(STUDIO_ROUTES.dataUpdateRow.method).toBe("PUT");
    expect(STUDIO_ROUTES.dataDeleteRow.method).toBe("DELETE");
  });

  test("secrets routes are optional and names-only on the way out", () => {
    expect(STUDIO_ROUTES.secretsList.path).toBe("/__studio/secrets");
    expect(STUDIO_ROUTES.secretsSet.path).toBe("/__studio/secrets");
    expect(STUDIO_ROUTES.secretsList.method).toBe("GET");
    expect(STUDIO_ROUTES.secretsSet.method).toBe("PUT");
    expect(STUDIO_ROUTES.secretsList.optional).toBe(true);
    expect(STUDIO_ROUTES.secretsSet.optional).toBe(true);
    expect(STUDIO_ROUTES.secretsList.summary).toContain("NAMES");
    expect(STUDIO_ROUTES.secretsList.summary).toContain("never values");
  });

  test("file routes share one path across GET/PUT/DELETE", () => {
    expect(STUDIO_ROUTES.fileRead.path).toBe(STUDIO_ROUTES.fileWrite.path);
    expect(STUDIO_ROUTES.fileRead.path).toBe(STUDIO_ROUTES.fileDelete.path);
    expect(STUDIO_ROUTES.fileRead.method).toBe("GET");
    expect(STUDIO_ROUTES.fileWrite.method).toBe("PUT");
    expect(STUDIO_ROUTES.fileDelete.method).toBe("DELETE");
  });
});
