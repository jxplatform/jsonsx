/**
 * Client — the headless browser search client.
 *
 * Bundled into `/assets/` by the site build (spec.md §5.3); no UI. Fetches the emitted index
 * envelope once, builds a MiniSearch index in-memory (tens of milliseconds at docs scale), and
 * answers synchronous queries with section-anchored results — either grouped under their page, or
 * flat and presentation-ready (breadcrumbs plus highlight tokens for the title and a body excerpt).
 * Field boosts and indexed fields come from the envelope — the emitter bakes the project's `search`
 * section in, so the client needs no configuration.
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

/**
 * One run of display text. `m` is true when the run matched a query term — renderers wrap those in
 * `<mark>` (or equivalent). Tokens rather than an HTML string so declarative renderers can
 * highlight without injecting markup.
 */
export interface SearchToken {
  t: string;
  m: boolean;
}

/** One flat, presentation-ready result row: a page or one of its heading sections. */
export interface SearchResult {
  id: string;
  collection: string;
  slug: string;
  /** Page URL, or page URL + `#anchor` for a section row. */
  url: string;
  /** Page title. */
  title: string;
  /** Heading text for a section row; `""` for a page row. */
  heading: string;
  description: string;
  score: number;
  /** Breadcrumb trail: slug ancestors, plus the page title on a section row. */
  crumbs: string[];
  /** The row's display title (heading, else page title), highlighted. */
  titleTokens: SearchToken[];
  /** A window of body text around the first match, highlighted. */
  excerptTokens: SearchToken[];
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
  /** Maximum rows returned (default 8). */
  limit?: number;
  /**
   * Group section hits under their page (default true), yielding `SearchResultGroup[]`; false
   * returns flat, presentation-ready `SearchResult[]` — one row per matching page or section.
   */
  group?: boolean;
  /**
   * In flat mode, the most rows one page may contribute (default 3). Keeps long pages from flooding
   * the list.
   */
  pageCap?: number;
}

interface ClientState {
  mini: MiniSearch<SearchDocument> | null;
  loading: Promise<void> | null;
  indexUrl: string;
}

const state: ClientState = { indexUrl: "/search-index.json", loading: null, mini: null };

/** `text` is stored so flat results can carry a highlighted excerpt of the body. */
const STORE_FIELDS = ["collection", "slug", "url", "title", "description", "heading", "text"];

/** A fresh word scanner — regexes with `g` carry `lastIndex`, so never share one. */
function wordScanner(): RegExp {
  return /[\p{L}\p{N}_]+/gu;
}

/** Excerpt window, in characters. */
const EXCERPT_WIDTH = 160;

/** How much of the excerpt window sits before the first match. */
const EXCERPT_LEAD = 60;

/** Default cap on rows one page may contribute to a flat result list. */
const PAGE_CAP = 3;

/** Lowercased needles a word must start with to count as a match. */
function needlesOf(terms: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const term of terms) {
    if (term) {
      seen.add(term.toLowerCase());
    }
  }
  return [...seen];
}

/** `[start, end)` spans of the whole words in `text` that begin with one of `needles`. */
function matchSpans(text: string, needles: readonly string[]): [number, number][] {
  const spans: [number, number][] = [];
  if (!text || needles.length === 0) {
    return spans;
  }
  const lower = text.toLowerCase();
  const scanner = wordScanner();
  let match = scanner.exec(lower);
  while (match !== null) {
    const [word] = match;
    if (needles.some((needle) => word.startsWith(needle))) {
      spans.push([match.index, match.index + word.length]);
    }
    match = scanner.exec(lower);
  }
  return spans;
}

/**
 * Split `text` into alternating plain and matched runs. A word is matched when it starts with one
 * of the query's terms, so a prefix search for "intro" highlights the whole word "introduction".
 */
export function buildTokens(text: string, terms: readonly string[]): SearchToken[] {
  if (!text) {
    return [];
  }
  const tokens: SearchToken[] = [];
  let cursor = 0;
  for (const [start, end] of matchSpans(text, needlesOf(terms))) {
    if (start > cursor) {
      tokens.push({ m: false, t: text.slice(cursor, start) });
    }
    tokens.push({ m: true, t: text.slice(start, end) });
    cursor = end;
  }
  if (cursor < text.length) {
    tokens.push({ m: false, t: text.slice(cursor) });
  }
  return tokens;
}

/**
 * A readable window of `text` around its first match, snapped to word boundaries and elided with
 * `…` on either side when truncated. With no match in the body, the opening of the text is used.
 */
export function buildExcerpt(text: string, terms: readonly string[]): string {
  const body = text.trim();
  if (!body) {
    return "";
  }
  const at = matchSpans(body, needlesOf(terms))[0]?.[0] ?? -1;
  let start = at < 0 ? 0 : Math.max(0, at - EXCERPT_LEAD);
  if (start > 0) {
    const space = body.indexOf(" ", start);
    start = space === -1 || space >= at ? start : space + 1;
  }
  let end = Math.min(body.length, start + EXCERPT_WIDTH);
  if (end < body.length) {
    const space = body.lastIndexOf(" ", end);
    if (space > start) {
      end = space;
    }
  }
  return `${start > 0 ? "…" : ""}${body.slice(start, end).trim()}${end < body.length ? "…" : ""}`;
}

/** Breadcrumb labels for a slug's ancestor segments: `framework/site/search` → `Framework › Site`. */
export function crumbsFromSlug(slug: string): string[] {
  return slug
    .split("/")
    .filter(Boolean)
    .slice(0, -1)
    .map((segment) =>
      segment.replaceAll(/[-_]+/g, " ").replaceAll(/\b\p{Ll}/gu, (char) => char.toUpperCase()),
    );
}

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

/** Raw MiniSearch hit with our stored fields and the terms it matched on. */
interface RawHit {
  id: string;
  score: number;
  terms: string[];
  queryTerms: string[];
  collection: string;
  slug: string;
  url: string;
  title: string;
  description: string;
  heading: string;
  text: string;
}

/** Turn a raw hit into a presentation-ready row: breadcrumbs plus highlighted title and excerpt. */
function toResult(hit: RawHit): SearchResult {
  // `terms` holds the matched document words, so a prefix or fuzzy search highlights the whole
  // `word` it landed on; `queryTerms` holds what the user actually typed.
  const terms = [...hit.terms, ...hit.queryTerms];
  const crumbs = crumbsFromSlug(hit.slug);
  if (hit.heading) {
    crumbs.push(hit.title);
  }
  return {
    collection: hit.collection,
    crumbs,
    description: hit.description,
    excerptTokens: buildTokens(buildExcerpt(hit.text ?? "", terms), terms),
    heading: hit.heading,
    id: hit.id,
    score: hit.score,
    slug: hit.slug,
    title: hit.title,
    titleTokens: buildTokens(hit.heading || hit.title, terms),
    url: hit.url,
  };
}

/**
 * Search synchronously. Returns `[]` until `preload` completes (and kicks it off if nobody has).
 * With `group: true` (default), section hits nest under their page, groups sorted by best score;
 * `group: false` returns flat `SearchResult` rows — one per matching page or section, at most
 * `pageCap` from any one page.
 */
export function query(q: string, opts: QueryOptions = {}): SearchResultGroup[] | SearchResult[] {
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
    const pageCap = opts.pageCap ?? PAGE_CAP;
    const perPage = new Map<string, number>();
    const rows: SearchResult[] = [];
    for (const hit of raw) {
      if (rows.length >= limit) {
        break;
      }
      const key = `${hit.collection}:${hit.slug}`;
      const taken = perPage.get(key) ?? 0;
      if (taken >= pageCap) {
        continue;
      }
      perPage.set(key, taken + 1);
      rows.push(toResult(hit));
    }
    return rows;
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

/** Rows a `$src` component search shows at once. */
const UI_LIMIT = 20;

/**
 * State-convention query handler for `$src` component use: reads the query from the input event (or
 * `state.searchQuery`), stores flat highlighted rows on `state.searchResults`, publishes the row
 * count as `state.searchCount`, and resets the active-row index.
 */
export function runSearch(
  componentState: Record<string, unknown>,
  event?: { target?: { value?: unknown } | null },
): SearchResult[] {
  const fromEvent =
    event?.target && typeof event.target.value === "string" ? event.target.value : null;
  const q =
    fromEvent ?? (typeof componentState.searchQuery === "string" ? componentState.searchQuery : "");
  componentState.searchQuery = q;
  const results = query(q, { group: false, limit: UI_LIMIT }) as SearchResult[];
  componentState.searchResults = results;
  componentState.searchCount = results.length;
  componentState.searchActive = 0;
  return results;
}
