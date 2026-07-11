/**
 * Table-state — the TableQuery and TableEntry state classes.
 *
 * Both are ordinary external classes (constructor + resolve) with a static `lower` capability
 * (specs/extensions.md §8.3). In browsers, resolve() fetches the live /_jx/data routes (dev server
 * and deployed workers serve the same wire contract). Under node/Bun (dev-server resolve proxy,
 * compiler-timing SSG bakes) it reaches the database directly through the node-only sibling module,
 * loaded through an opaque specifier so browser bundles never pull kysely dialects in. When the
 * database is unreachable at compile time (e.g. D1 without CLOUDFLARE_API_TOKEN) the bake degrades
 * to an empty result with a warning, never a failed build.
 *
 * Lowering: in compiled sites a `timing: "client"` TableQuery becomes a core `Request` def whose
 * URL carries the query params (template placeholders preserved) plus the `_v` read-after-write
 * cache-busting param — see table-shared.ts.
 */

import { buildDataUrl, resolveIdValue } from "./table-shared.ts";
import type { TableQueryDef } from "./table-shared.ts";

/** Route/document context injected by hosts under `_document`. */
interface DocumentContext {
  route?: { _pathParams?: Record<string, string> };
  [key: string]: unknown;
}

/** The context object hosts pass to `lower(def, context)`. */
export interface LowerContext {
  route?: { _pathParams?: Record<string, string>; sourcePath?: string };
  projectConfig?: Record<string, unknown>;
  root?: string;
}

interface TableStateConfig extends TableQueryDef {
  id?: unknown;
  _document?: DocumentContext;
  _project?: Record<string, unknown>;
}

/** True when running in a browser (canvas/client); node hosts take the direct-database path. */
function inBrowser(): boolean {
  return typeof document !== "undefined" && typeof fetch === "function";
}

/** The surface of the node-only sibling module (see table-node.ts). */
interface TableNodeModule {
  queryTable: (config: TableStateConfig) => Promise<unknown>;
  getEntry: (config: TableStateConfig, id: string) => Promise<unknown>;
}

/** Import the node-only sibling through an opaque specifier (bundlers must not follow it). */
async function nodeModule(): Promise<TableNodeModule> {
  const specifier = "./table-node.ts";
  return (await import(specifier)) as TableNodeModule;
}

export class TableQuery {
  config: TableStateConfig;

  constructor(config: TableStateConfig) {
    this.config = config;
  }

  /** Rows matching the def's filter/sort/limit — over HTTP in browsers, directly under node. */
  async resolve(): Promise<unknown> {
    if (inBrowser()) {
      const response = await fetch(buildDataUrl(this.config));
      return response.ok ? await response.json() : [];
    }
    try {
      const { queryTable } = await nodeModule();
      return await queryTable(this.config);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`TableQuery("${this.config.table}") could not reach the database: ${message}`);
      return [];
    }
  }

  /** Static `lower` capability: compile away into a core Request def (client fetch). */
  static lower(def: Record<string, unknown>): Record<string, unknown> {
    return {
      $prototype: "Request",
      timing: "client",
      url: buildDataUrl(def as TableQueryDef, { versionParam: true }),
      ...(def.default === undefined ? { default: [] } : { default: def.default }),
    };
  }
}

export class TableEntry {
  config: TableStateConfig;

  constructor(config: TableStateConfig) {
    this.config = config;
  }

  /** One row by id (`#/$params/` refs resolve against the route), or null. */
  async resolve(): Promise<unknown> {
    const { _document } = this.config;
    const id = resolveIdValue(this.config.id, _document?.route?._pathParams);
    if (id === undefined || id === "") {
      return null;
    }
    if (inBrowser()) {
      const response = await fetch(buildDataUrl(this.config, { id }));
      return response.ok ? await response.json() : null;
    }
    try {
      const { getEntry } = await nodeModule();
      return await getEntry(this.config, id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`TableEntry("${this.config.table}") could not reach the database: ${message}`);
      return null;
    }
  }

  /** Static `lower` capability: compile away into a core Request def for one row. */
  static lower(def: Record<string, unknown>, context: LowerContext = {}): Record<string, unknown> {
    const id = resolveIdValue(def.id, context.route?._pathParams);
    if (id === undefined) {
      console.warn(
        `TableEntry("${String(def.table)}"): id did not resolve at lower time — ` +
          `the compiled Request will fetch an empty id`,
      );
    }
    return {
      $prototype: "Request",
      timing: "client",
      url: buildDataUrl(def as TableQueryDef, { id: id ?? "", versionParam: true }),
      ...(def.default === undefined ? { default: null } : { default: def.default }),
    };
  }
}
