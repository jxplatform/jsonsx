/**
 * Search-state — the `Search` state class.
 *
 * An ordinary external class (constructor + resolve) with a static `lower` capability
 * (extensions.md §8.3). In browsers, resolve() lazily imports the bundled headless client and
 * queries the emitted index. Under node (compiler-timing bakes, dev-server resolve proxy) it
 * degrades to an empty result — search is a client-side interaction.
 *
 * Lowering: in compiled sites a `timing: "client"` Search def becomes a core `Function` computed
 * that lazy-imports the client bundle, preloads the index once per page, and re-runs reactively
 * when the query state or the ready flag changes. The client module itself reaches the browser
 * through the sidecar bundler via the `$bundle` hint (spec.md §5.3).
 *
 * @docs extending/extensions/search
 * @docs framework/site/search
 */

import { sidecarAssetPath } from "@jxsuite/schema/asset-paths";

/** The npm specifier of the headless browser client, bundled by the site build. */
export const CLIENT_SPECIFIER = "npm:@jxsuite/search/client";

/** A `Search` state def as authored in page state. */
export interface SearchDef {
  $prototype?: string;
  timing?: string;
  /** Query text: a literal string or a `$ref` into page state. */
  query?: string | { $ref: string };
  /** Maximum result groups returned. */
  limit?: number;
  /** Group section hits under their page (default true). */
  group?: boolean;
  /** Override the index URL (defaults to the project's `search.output`). */
  index?: string;
  default?: unknown;
  [key: string]: unknown;
}

/** The context object hosts pass to `lower(def, context)`. */
export interface LowerContext {
  projectConfig?: { search?: { output?: string } } & Record<string, unknown>;
  root?: string;
  route?: Record<string, unknown>;
}

/** True when running in a browser; node hosts degrade to empty results. */
function inBrowser(): boolean {
  return typeof document !== "undefined" && typeof fetch === "function";
}

/** Compile a def's `query` into a client JS expression (`$ref` → state path, literal → string). */
function queryExpression(query: SearchDef["query"]): string {
  if (typeof query === "object" && query !== null && typeof query.$ref === "string") {
    const path = query.$ref.replace(/^#\//, "").split("/");
    if (path[0] === "state" && path.length > 1) {
      return ["state", ...path.slice(1)].join(".");
    }
  }
  return JSON.stringify(typeof query === "string" ? query : "");
}

export class Search {
  config: SearchDef & { _project?: { search?: { output?: string } } };

  constructor(config: SearchDef) {
    this.config = config;
  }

  /** Grouped search results for the configured query — browser only. */
  async resolve(): Promise<unknown> {
    if (!inBrowser()) {
      console.warn("Search resolves to [] outside the browser — search is a client interaction");
      return [];
    }
    const clientUrl = sidecarAssetPath(CLIENT_SPECIFIER);
    const client = (await import(clientUrl)) as {
      preload: (url?: string) => Promise<void>;
      query: (q: string, opts?: { limit?: number; group?: boolean }) => unknown;
    };
    await client.preload(this.indexUrl());
    const query = typeof this.config.query === "string" ? this.config.query : "";
    return client.query(query, {
      group: this.config.group ?? true,
      limit: this.config.limit ?? 8,
    });
  }

  /** The index URL: def override, then the project's `search.output`, then the default. */
  indexUrl(): string {
    return this.config.index ?? this.config._project?.search?.output ?? "/search-index.json";
  }

  /**
   * Static `lower` capability: compile away into a core Function computed that lazily loads the
   * bundled client + index, then queries reactively. `$bundle` registers the client module with the
   * sidecar bundler (extensions.md §8.3).
   */
  static lower(def: SearchDef, context: LowerContext = {}): Record<string, unknown> {
    const indexUrl = def.index ?? context.projectConfig?.search?.output ?? "/search-index.json";
    const clientUrl = sidecarAssetPath(CLIENT_SPECIFIER);
    const opts = JSON.stringify({ group: def.group ?? true, limit: def.limit ?? 8 });
    const body = [
      // Reading the ready flag makes the computed re-run when the client finishes loading.
      "void state.__jxSearchReady;",
      "if (!globalThis.__jxSearch) {",
      "  globalThis.__jxSearch = {};",
      `  import(${JSON.stringify(clientUrl)})`,
      `    .then((m) => { globalThis.__jxSearch.m = m; return m.preload(${JSON.stringify(indexUrl)}); })`,
      "    .then(() => { state.__jxSearchReady = true; })",
      "    .catch((err) => console.warn('search client failed to load:', err));",
      "}",
      "const m = globalThis.__jxSearch.m;",
      `return m && m.isReady() ? m.query(${queryExpression(def.query)}, ${opts}) : [];`,
    ].join("\n");
    return {
      $bundle: [CLIENT_SPECIFIER],
      $prototype: "Function",
      body,
      timing: "client",
      ...(def.default === undefined ? {} : { default: def.default }),
    };
  }
}
