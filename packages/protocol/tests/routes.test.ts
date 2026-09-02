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
    for (const name of [
      "sites",
      "starters",
      "cfProxy",
      "gitClone",
      "projectSchemas",
      "extensionCatalog",
    ] as const) {
      expect(optional).toContain(name);
    }
  });

  test("the formats route documents the additive extensions payload", () => {
    expect(STUDIO_ROUTES.formats.summary).toContain("extensions");
    expect(STUDIO_ROUTES.formats.summary).toContain("listExtensions");
  });

  test("the catalogue route is optional and says what its absence costs", () => {
    expect(STUDIO_ROUTES.extensionCatalog.path).toBe("/__studio/catalog");
    expect(STUDIO_ROUTES.extensionCatalog.method).toBe("GET");
    // Optional because a backend that cannot enumerate what it supports must be able to say so by
    // Omission; Studio then falls back to a typed package name, which is what it does today.
    expect(STUDIO_ROUTES.extensionCatalog.optional).toBe(true);
    expect(STUDIO_ROUTES.extensionCatalog.summary).toContain("listExtensionCatalog");
    expect(STUDIO_ROUTES.extensionCatalog.degradation).toContain("typed package name");
  });

  test("the catalogue is a separate route from formats, not a field on it", () => {
    /*
     * Load-bearing rather than stylistic. The formats route is scoped to the project's registry and
     * fails when a declared extension does not resolve — which is exactly the state a reader is in
     * when they need the catalogue to fix it. Riding on formats would make the catalogue
     * unavailable precisely when it is the answer.
     */
    expect(STUDIO_ROUTES.extensionCatalog.path).not.toBe(STUDIO_ROUTES.formats.path);
    // Each degrades on its own terms: losing formats costs non-JSON documents, losing the
    // Catalogue costs only the offer. One route could not carry two different degradations.
    expect(STUDIO_ROUTES.formats.degradation).toContain(".json");
    expect(STUDIO_ROUTES.extensionCatalog.degradation).not.toContain(".json");
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

  /**
   * `/raw` is the mount a canvas renders against, and it was a seam neither side of the cloud
   * conformance check could see: the session DO answers it with a `startsWith` arm rather than an
   * exact match, and the adapter never calls it — it hands the base to the canvas and the runtime
   * fetches against it from inside the iframe. Invisible, and load-bearing. Naming it here is what
   * turns a pair of textual assertions into a contract.
   */
  test("the raw-document mount is a declared route, and a PREFIX", () => {
    expect(STUDIO_ROUTES.documentRaw.path).toBe("/__studio/raw/");
    expect(STUDIO_ROUTES.documentRaw.method).toBe("GET");
    // The only route whose path ends in a slash: the project-relative path is appended to it.
    const trailing = Object.entries(STUDIO_ROUTES).filter(([, r]) => r.path.endsWith("/"));
    expect(trailing.map(([name]) => name)).toEqual(["documentRaw"]);
  });

  test("the upload route documents that its path is an answer, not an echo", () => {
    expect(STUDIO_ROUTES.fileUpload.summary).toContain("UploadResult");
  });

  test("file routes share one path across GET/PUT/DELETE", () => {
    expect(STUDIO_ROUTES.fileRead.path).toBe(STUDIO_ROUTES.fileWrite.path);
    expect(STUDIO_ROUTES.fileRead.path).toBe(STUDIO_ROUTES.fileDelete.path);
    expect(STUDIO_ROUTES.fileRead.method).toBe("GET");
    expect(STUDIO_ROUTES.fileWrite.method).toBe("PUT");
    expect(STUDIO_ROUTES.fileDelete.method).toBe("DELETE");
  });
});
