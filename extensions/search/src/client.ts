/**
 * Client — the headless browser search client.
 *
 * Bundled into `/assets/` by the site build (spec.md §5.3); no UI. Fetches the emitted index
 * envelope once, builds a MiniSearch index in-memory (tens of milliseconds at docs scale), and
 * answers synchronous queries with page-grouped, section-anchored results. Field boosts and indexed
 * fields come from the envelope — the emitter bakes the project's `search` section in, so the
 * client needs no configuration.
 *
 * Two integration surfaces: - `preload` / `isReady` / `query` — the core API (used by lowered
 * `Search` defs). - `searchInit` / `runSearch` — state-convention helpers for `$src` use inside
 * compiled components (export name = state key; spec.md §5.3).
 *
 * @docs framework/site/search
 */

import MiniSearch from "minisearch";
import type { SearchDocument, SearchIndexEnvelope } from "./search-index.ts";

/** One section hit inside a result group. */
export interface SearchHit {
  heading: string;
  url: string;
  score: number;
}

/** One result group: a page and its matching sections, best-score first. */
export interface SearchResultGroup {
  collection: string;
  slug: string;
  title: string;
  description: string;
  /** Page URL without a fragment. */
  url: string;
  /** Best score across the page and its section hits. */
  score: number;
  hits: SearchHit[];
}

/** Query options. */
export interface QueryOptions {
  /** Maximum result groups (default 8). */
  limit?: number;
  /** Group section hits under their page (default true); false returns flat documents. */
  group?: boolean;
}

interface ClientState {
  mini: MiniSearch<SearchDocument> | null;
  loading: Promise<void> | null;
  indexUrl: string;
}

const state: ClientState = { indexUrl: "/search-index.json", loading: null, mini: null };

const STORE_FIELDS = ["collection", "slug", "url", "title", "description", "heading"];

/** Override the default index URL for subsequent `preload()` calls. */
export function configure(opts: { indexUrl?: string }): void {
  if (opts.indexUrl) {
    state.indexUrl = opts.indexUrl;
  }
}

/** True once the index is fetched and built. */
export function isReady(): boolean {
  return state.mini !== null;
}

/**
 * Fetch the index envelope and build the MiniSearch index. Memoized: concurrent and repeat calls
 * share one load. A failed load clears the memo so a later call can retry.
 */
export function preload(indexUrl?: string): Promise<void> {
  if (indexUrl) {
    state.indexUrl = indexUrl;
  }
  state.loading ??= (async () => {
    const response = await fetch(state.indexUrl);
    if (!response.ok) {
      throw new Error(`search index fetch failed: ${response.status} ${state.indexUrl}`);
    }
    const envelope = (await response.json()) as SearchIndexEnvelope;
    const mini = new MiniSearch<SearchDocument>({
      fields: envelope.fields,
      searchOptions: {
        boost: envelope.boost,
        fuzzy: 0.2,
        prefix: true,
      },
      storeFields: STORE_FIELDS,
    });
    mini.addAll(envelope.documents);
    state.mini = mini;
  })().catch((error: unknown) => {
    state.loading = null;
    throw error;
  });
  return state.loading;
}

/** Raw MiniSearch hit with our stored fields. */
interface RawHit {
  id: string;
  score: number;
  collection: string;
  slug: string;
  url: string;
  title: string;
  description: string;
  heading: string;
}

/**
 * Search synchronously. Returns `[]` until `preload` completes (and kicks it off if nobody has).
 * With `group: true` (default), section hits nest under their page, groups sorted by best score;
 * `group: false` returns the flat scored documents.
 */
export function query(q: string, opts: QueryOptions = {}): SearchResultGroup[] | RawHit[] {
  const limit = opts.limit ?? 8;
  const group = opts.group ?? true;
  if (!state.mini) {
    void preload().catch(() => {});
    return [];
  }
  const text = q.trim();
  if (!text) {
    return [];
  }
  const raw = state.mini.search(text) as unknown as RawHit[];
  if (!group) {
    return raw.slice(0, limit);
  }

  const groups = new Map<string, SearchResultGroup>();
  for (const hit of raw) {
    const key = `${hit.collection}:${hit.slug}`;
    let entry = groups.get(key);
    if (!entry) {
      entry = {
        collection: hit.collection,
        description: hit.description,
        hits: [],
        score: hit.score,
        slug: hit.slug,
        title: hit.title,
        url: hit.url.replace(/#.*$/, ""),
      };
      groups.set(key, entry);
    }
    entry.score = Math.max(entry.score, hit.score);
    if (hit.heading) {
      entry.hits.push({ heading: hit.heading, score: hit.score, url: hit.url });
    }
  }
  return [...groups.values()].toSorted((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * State-convention init for `$src` component use: preload the index and flip `state.searchReady`;
 * re-runs the pending query once ready.
 */
export function searchInit(componentState: Record<string, unknown>): boolean {
  void preload(
    typeof componentState.searchIndexUrl === "string" ? componentState.searchIndexUrl : undefined,
  )
    .then(() => {
      componentState.searchReady = true;
      if (typeof componentState.searchQuery === "string" && componentState.searchQuery) {
        runSearch(componentState);
      }
    })
    .catch((error: unknown) => console.warn("search client failed to load:", error));
  return true;
}

/**
 * State-convention query handler for `$src` component use: reads the query from the input event (or
 * `state.searchQuery`), stores grouped results on `state.searchResults`, and resets the active-row
 * index.
 */
export function runSearch(
  componentState: Record<string, unknown>,
  event?: { target?: { value?: unknown } | null },
): unknown[] {
  const fromEvent =
    event?.target && typeof event.target.value === "string" ? event.target.value : null;
  const q =
    fromEvent ?? (typeof componentState.searchQuery === "string" ? componentState.searchQuery : "");
  componentState.searchQuery = q;
  const results = query(q);
  componentState.searchResults = results;
  componentState.searchActive = 0;
  return results;
}
