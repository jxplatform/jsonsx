/// <reference lib="dom" />
/**
 * Head panel — Page meta, OpenGraph, Frontmatter, and custom `$head` entries.
 *
 * Uses `renderFieldRow()` for consistent indicator-dot fields and `renderMediaPicker()` for image
 * selection (icon, og:image).
 */

import { html, nothing } from "lit-html";
import { renderFieldRow } from "../ui/field-row";
import { spTextArea, spTextField } from "../ui/field-input";
import { renderMediaPicker } from "../ui/media-picker";
import { projectState, renderOnly } from "../store";
import type { DirEntry, JsonValue } from "../types";
import { activeTab } from "../workspace/workspace";
import { renderEmptyState } from "./empty-state";
import { registerPanel } from "./panel-registry";
import { mutateUpdateFrontmatter, transact } from "../tabs/transact";
import { collectFmFields, renderFmField } from "./frontmatter-fields";
import { isGoogleFontEntry, isGoogleFontPreconnect } from "../utils/google-fonts";
import { getEffectiveLayoutPath, invalidateLayoutCache, resolveLayoutDoc } from "../site-context";
import { getPlatform } from "../platform";
import { pageRoute } from "./tab-strip";

import type { JxHeadEntry, JxMutableNode } from "@jxsuite/schema/types";
import type { Tab } from "../tabs/tab";
import type { TemplateResult } from "lit-html";

interface MetaField {
  label: string;
  attr: "name" | "property";
  key: string;
  multiline?: boolean;
  media?: boolean;
}

// ─── Layout picker ──────────────────────────────────────────────────────────

/** @type {{ name: string; path: string }[] | null} */
let layoutEntries: { name: string; path: string }[] | null = null;

async function loadLayoutEntries() {
  try {
    const platform = getPlatform();
    const listing = await platform.listDirectory("layouts");
    layoutEntries = listing
      .filter((f: DirEntry) => f.type === "file" && f.name.endsWith(".json"))
      .map((f: DirEntry) => ({
        name: f.name
          .replace(/\.json$/, "")
          .replaceAll(/[-_]+/g, " ")
          .replaceAll(/\b\w/g, (c) => c.toUpperCase()),
        path: `./layouts/${f.name}`,
      }));
  } catch {
    layoutEntries = [];
  }
  renderOnly("leftPanel");
  renderOnly("frontmatterPanel");
}

/**
 * Forget every cached fact about layouts this module holds — the picker's listing AND the effective
 * layout's `$head`, because "the layouts changed" is one event and answering it in two halves is
 * how a preview ends up attributing a deleted layout's description to the open page.
 */
export function invalidateLayoutPickerCache() {
  layoutEntries = null;
  invalidateLayoutHeadCache();
}

// ─── Field definitions ───────────────────────────────────────────────────

export const PAGE_FIELDS: MetaField[] = [
  { attr: "name", key: "description", label: "Description" },
  { attr: "name", key: "viewport", label: "Viewport" },
];

export const OG_FIELDS: MetaField[] = [
  { attr: "property", key: "og:title", label: "Title" },
  {
    attr: "property",
    key: "og:description",
    label: "Description",
    multiline: true,
  },
  { attr: "property", key: "og:image", label: "Image", media: true },
  { attr: "property", key: "og:type", label: "Type" },
];

/** Set of `name`/`property` values managed by the structured forms. */
const MANAGED_META_KEYS = new Set([...PAGE_FIELDS, ...OG_FIELDS].map((f) => f.key));

/**
 * Frontmatter keys the Document Header card owns with a dedicated control, so the generic field
 * list must not print them a second time.
 *
 * **The one policy.** `frontmatter-panel.ts` used to pass an EMPTY reserved set while this module
 * passed `{title}`, so the same key rendered as a bare Obsidian-style property above the canvas and
 * as the Page panel's Title field at the same time, with two different commit paths. Merging the
 * two field sets was only safe once one of the two policies won, and it is this one: a document has
 * ONE title, and the surface that gives it a named row is the one that owns the key.
 */
export const RESERVED_FM_KEYS = new Set(["title"]);

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Find a `$head` meta entry by attribute match.
 *
 * @param {JxHeadEntry[]} head
 * @param {"name" | "property"} attr
 * @param {string} key
 * @returns {JxHeadEntry | undefined}
 */
function findMetaEntry(head: JxHeadEntry[], attr: "name" | "property", key: string) {
  if (!head) {
    return;
  }
  return head.find((e: JxHeadEntry) => e?.tagName === "meta" && e?.attributes?.[attr] === key);
}

/**
 * Find a `$head` link entry by `rel` attribute.
 *
 * @param {JxHeadEntry[]} head
 * @param {string} rel
 * @returns {JxHeadEntry | undefined}
 */
export function findLinkEntry(head: JxHeadEntry[], rel: string) {
  if (!head) {
    return;
  }
  return head.find((e: JxHeadEntry) => e?.tagName === "link" && e?.attributes?.rel === rel);
}

/**
 * Check if a `$head` entry is managed by the structured forms.
 *
 * @param {JxHeadEntry} entry
 * @returns {boolean}
 */
export function isManagedEntry(entry: JxHeadEntry) {
  if (!entry?.tagName) {
    return false;
  }
  // Managed meta tags
  if (entry.tagName === "meta") {
    const name = String(entry?.attributes?.name ?? "");
    const prop = String(entry?.attributes?.property ?? "");
    return (
      Boolean(name && MANAGED_META_KEYS.has(name)) || Boolean(prop && MANAGED_META_KEYS.has(prop))
    );
  }
  // Managed link: favicon
  if (entry.tagName === "link" && entry?.attributes?.rel === "icon") {
    return true;
  }
  return false;
}

/**
 * Upsert or remove a meta entry in `doc.$head`.
 *
 * @param {JxMutableNode} doc
 * @param {"name" | "property"} attr
 * @param {string} key
 * @param {string} content
 */
function upsertMeta(doc: JxMutableNode, attr: "name" | "property", key: string, content: string) {
  if (!doc.$head) {
    doc.$head = [];
  }
  const idx = doc.$head.findIndex(
    (e: JxHeadEntry) => e?.tagName === "meta" && e?.attributes?.[attr] === key,
  );
  if (content) {
    const entry = { attributes: { [attr]: key, content }, tagName: "meta" };
    if (idx !== -1) {
      doc.$head[idx] = entry;
    } else {
      doc.$head.push(entry);
    }
  } else if (idx !== -1) {
    doc.$head.splice(idx, 1);
  }
}

/**
 * Upsert or remove a link entry in `doc.$head`.
 *
 * @param {JxMutableNode} doc
 * @param {string} rel
 * @param {string} href
 */
export function upsertLink(doc: JxMutableNode, rel: string, href: string) {
  if (!doc.$head) {
    doc.$head = [];
  }
  const idx = doc.$head.findIndex(
    (e: JxHeadEntry) => e?.tagName === "link" && e?.attributes?.rel === rel,
  );
  if (href) {
    const entry = { attributes: { href, rel }, tagName: "link" };
    if (idx !== -1) {
      doc.$head[idx] = entry;
    } else {
      doc.$head.push(entry);
    }
  } else if (idx !== -1) {
    doc.$head.splice(idx, 1);
  }
}

/**
 * Get a display label for an arbitrary $head entry.
 *
 * @param {JxHeadEntry} entry
 * @returns {string}
 */
export function entryLabel(entry: JxHeadEntry) {
  if (!entry?.tagName) {
    return "unknown";
  }
  const a = entry.attributes ?? {};
  if (a.name) {
    return `<meta name="${String(a.name)}">`;
  }
  if (a.property) {
    return `<meta property="${String(a.property)}">`;
  }
  if (a.rel && a.href) {
    return `<link rel="${String(a.rel)}">`;
  }
  if (a.src) {
    return `<script src="${String(a.src)}">`;
  }
  if (a.charset) {
    return `<meta charset="${String(a.charset)}">`;
  }
  return `<${entry.tagName}>`;
}

/**
 * Get a display value for an arbitrary $head entry.
 *
 * @param {JxHeadEntry} entry
 * @returns {string}
 */
export function entryValue(entry: JxHeadEntry) {
  const a = entry?.attributes ?? {};
  return String(a.content ?? a.href ?? a.src ?? entry?.textContent ?? "");
}

// ─── The merged `$head`, as a preview model ──────────────────────────────

/*
 * Everything below answers ONE question — what actually reaches the browser? — and it is a
 * different question from what this panel's fields edit. A page that inherits its description from
 * the site is not a page missing a description, and the old SEO gap was that no surface could tell
 * the two apart. The contract mirrored here is `packages/compiler/src/site/head-merger.ts`:
 * site → layout → page, later wins, keyed by `name` / `property` / `rel`. Studio does not depend
 * on `@jxsuite/compiler`, so the merge is restated for the handful of keys the previews read
 * rather than copied wholesale; `tests/head-panel.test.ts` pins each rule against that file.
 */

/**
 * Which layer of the cascade supplied a previewed value.
 *
 * `build` is the compiler's own contribution — the `"Jx Site"` title fallback, the canonical link
 * and `og:url` it derives from the site URL and the route. It is a donor like any other, and saying
 * so is what stops the preview from claiming the author wrote something they did not.
 */
export type HeadSource = "page" | "layout" | "site" | "build" | "none";

/** One value that reaches the browser, and where it came from. */
export interface ResolvedHeadField {
  /** The emitted value, or `""` when the merged head carries none. */
  value: string;
  source: HeadSource;
  /**
   * The donor's name in the words a reader would use — `"Base"`, `"Site head"`, `"Site name"`,
   * `"the build"`. `null` for `page` (nothing to name; the author is looking at it) and `none`.
   */
  donor: string | null;
}

/** The three `$head` arrays the build merges, plus the name of the layout supplying the middle one. */
export interface HeadLayers {
  site: JxHeadEntry[];
  layout: JxHeadEntry[];
  page: JxHeadEntry[];
  layoutName: string | null;
}

/** The title the build emits when neither the page nor the site names one (`head-merger.ts`). */
export const BUILD_FALLBACK_TITLE = "Jx Site";

const NOT_SUPPLIED: ResolvedHeadField = { donor: null, source: "none", value: "" };

/**
 * The `content` of the LAST matching meta entry in one layer, or `null` when the layer is silent.
 *
 * Last rather than first, because the merger folds a layer into a keyed map in array order: a layer
 * that lists `description` twice emits the second one.
 */
function metaContentIn(head: JxHeadEntry[], attr: "name" | "property", key: string): string | null {
  let found: string | null = null;
  for (const entry of head) {
    if (entry?.tagName === "meta" && entry?.attributes?.[attr] === key) {
      found = String(entry.attributes?.content ?? "");
    }
  }
  return found;
}

/**
 * Resolve one meta key through site → layout → page.
 *
 * A page entry whose `content` is empty still counts as the page speaking: the merged map is keyed
 * by `meta:<key>`, so an empty page entry SHADOWS the site's. The preview reports the empty result,
 * which is what the browser gets.
 *
 * @param {HeadLayers} layers
 * @param {"name" | "property"} attr
 * @param {string} key
 * @returns {ResolvedHeadField}
 */
export function resolveMetaField(
  layers: HeadLayers,
  attr: "name" | "property",
  key: string,
): ResolvedHeadField {
  const page = metaContentIn(layers.page, attr, key);
  if (page !== null) {
    return { donor: null, source: "page", value: page };
  }
  const layout = metaContentIn(layers.layout, attr, key);
  if (layout !== null) {
    return { donor: layers.layoutName ?? "the layout", source: "layout", value: layout };
  }
  const site = metaContentIn(layers.site, attr, key);
  if (site !== null) {
    return { donor: "Site head", source: "site", value: site };
  }
  return NOT_SUPPLIED;
}

/**
 * Resolve `<title>`: the page's `title` property, then the site's `name`, then `"Jx Site"`.
 *
 * A layout never supplies one. `site/site-build.ts` reads `pageDoc.title ?? layoutDoc._pageTitle`,
 * and `_pageTitle` is a carrier for the PAGE's title through layout distribution, not a layout
 * value of its own. A `<title>` entry inside any `$head` does not supply one either — the merger
 * overwrites the `title` key from its context after the layers are folded in, which is what
 * {@link seoWarnings}' `head-title-ignored` exists to say out loud.
 *
 * @param {string} pageTitle
 * @param {string} [siteName]
 * @returns {ResolvedHeadField}
 */
export function resolveTitleField(pageTitle: string, siteName?: string): ResolvedHeadField {
  const own = pageTitle.trim();
  if (own) {
    return { donor: null, source: "page", value: own };
  }
  const site = siteName?.trim();
  if (site) {
    return { donor: "Site name", source: "site", value: site };
  }
  return { donor: "the build", source: "build", value: BUILD_FALLBACK_TITLE };
}

/** The URL a result row prints, and the canonical the build derives — or the honest absence of one. */
export interface SeoUrl {
  /** `<link rel="canonical">` / `og:url`, or `null` when Project Settings names no site URL. */
  href: string | null;
  /** `example.com › blog › hello` — the breadcrumb a search result prints. */
  crumb: string;
  /** The bare host a social card prints, or `""` when unknown. */
  host: string;
}

/**
 * The canonical URL and its two printed forms.
 *
 * `head-merger.ts` emits a canonical link and `og:url` only when BOTH a site URL and a route exist,
 * so this returns `href: null` in every case where the build would emit neither.
 *
 * @param {string | null} route
 * @param {string} [siteUrl]
 * @returns {SeoUrl}
 */
export function resolveSeoUrl(route: string | null, siteUrl?: string): SeoUrl {
  const path = route ?? "";
  const segments = path.split("/").filter((s) => s !== "");
  if (!siteUrl || route === null) {
    return { crumb: path || "/", host: "", href: null };
  }
  let absolute: URL;
  try {
    absolute = new URL(path, siteUrl);
  } catch {
    // A malformed `url` in project.json is a settings problem, not a preview crash — fall back to
    // The route, exactly as a build with no site URL would.
    return { crumb: path || "/", host: "", href: null };
  }
  const { host } = absolute;
  return {
    crumb: [host, ...segments].join(" › "),
    host,
    href: absolute.href,
  };
}

/** One row of the resolved-field list: the value, its provenance, and its character budget. */
export interface SeoField extends ResolvedHeadField {
  /** The head key — `title`, `description`, `og:image`, … */
  key: string;
  label: string;
  /** The width at which the surface that shows it truncates, or `null` when nobody counts it. */
  limit: number | null;
}

/**
 * Character budgets, in the only role a number is allowed here: a counter's reference line.
 *
 * There is deliberately no score. A single figure out of a hundred aggregates unrelated facts into
 * a verdict, and the verdict is what gets optimised (plan §14). A count beside a limit says the
 * same thing without pretending to rank it.
 */
export const SEO_LIMITS: Readonly<Record<string, number>> = {
  description: 160,
  "og:description": 200,
  "og:title": 60,
  title: 60,
};

/** A named thing that is wrong, or absent. Never summed — the list IS the report. */
export interface SeoWarning {
  /** Stable id, so a test and a shot name the same warning. */
  id: string;
  /** The head key the warning is about, so the field row can carry it. */
  field: string;
  message: string;
}

/** Everything the two preview cards, the field list and the warning list render. */
export interface SeoPreview {
  url: SeoUrl;
  /** In render order: `title`, `description`, then the four OpenGraph keys. */
  fields: SeoField[];
  warnings: SeoWarning[];
}

/** Look one field up by key — the previews read four of the six by name. */
export function seoField(preview: SeoPreview, key: string): SeoField {
  return (
    preview.fields.find((f) => f.key === key) ?? {
      ...NOT_SUPPLIED,
      key,
      label: key,
      limit: SEO_LIMITS[key] ?? null,
    }
  );
}

/** Whether any layer declares a `<title>` element, which the merger discards. */
function hasTitleEntry(layers: HeadLayers): boolean {
  return [...layers.site, ...layers.layout, ...layers.page].some((e) => e?.tagName === "title");
}

/**
 * The named warnings, in the order they are rendered.
 *
 * Every one of them states a consequence rather than a grade, and every one is checkable against
 * `head-merger.ts`. "Missing" is decided on the MERGED value, so a page that inherits a description
 * from the site is never told it has none — the defect §9.2 names by name.
 *
 * @param {SeoPreview} preview — `warnings` is ignored; this computes it.
 * @param {HeadLayers} layers
 * @returns {SeoWarning[]}
 */
export function seoWarnings(
  preview: Omit<SeoPreview, "warnings">,
  layers: HeadLayers,
): SeoWarning[] {
  const warnings: SeoWarning[] = [];
  const get = (key: string) => preview.fields.find((f) => f.key === key);

  const title = get("title");
  if (title?.source === "build") {
    warnings.push({
      field: "title",
      id: "title-missing",
      message: `Neither this page nor the project names a title, so the build ships “${BUILD_FALLBACK_TITLE}”.`,
    });
  }
  if (get("description")?.value.trim() === "") {
    warnings.push({
      field: "description",
      id: "description-missing",
      message:
        "No description reaches this page from the site, its layout or the page itself — a " +
        "result row shows whatever text the engine picks instead.",
    });
  }
  if (get("og:title")?.value.trim() === "") {
    warnings.push({
      field: "og:title",
      id: "og-title-missing",
      message: "No og:title — a shared link carries no headline of its own.",
    });
  }
  if (get("og:description")?.value.trim() === "") {
    warnings.push({
      field: "og:description",
      id: "og-description-missing",
      message: "No og:description — a shared link carries no summary of its own.",
    });
  }
  if (get("og:image")?.value.trim() === "") {
    warnings.push({
      field: "og:image",
      id: "og-image-missing",
      message: "No og:image — a shared link renders as a text-only card.",
    });
  }
  for (const field of preview.fields) {
    if (field.limit !== null && field.value.length > field.limit) {
      const kind = field.key.endsWith("description") ? "summaries" : "headlines";
      warnings.push({
        field: field.key,
        id: `${field.key}-long`,
        message: `${field.label} is ${field.value.length} characters; ${kind} are cut near ${field.limit}.`,
      });
    }
  }
  if (preview.url.href === null) {
    warnings.push({
      field: "url",
      id: "site-url-missing",
      message:
        "Project Settings names no site URL, so the build emits no canonical link and no og:url.",
    });
  }
  if (hasTitleEntry(layers)) {
    warnings.push({
      field: "title",
      id: "head-title-ignored",
      message:
        "A <title> element in $head is discarded — the build writes the title from the " +
        "document's own title property.",
    });
  }
  return warnings;
}

/**
 * Build the whole preview from the three layers, the page title, the route and the site config.
 *
 * Pure, and the reason the previews are testable without a stage: everything asynchronous
 * (resolving the layout document) happens in {@link layoutHeadEntries} before this is called.
 *
 * @param {HeadLayers} layers
 * @param {{ pageTitle: string; route: string | null; siteName?: string; siteUrl?: string }} ctx
 * @returns {SeoPreview}
 */
export function buildSeoPreview(
  layers: HeadLayers,
  ctx: { pageTitle: string; route: string | null; siteName?: string; siteUrl?: string },
): SeoPreview {
  const field = (key: string, label: string, resolved: ResolvedHeadField): SeoField => ({
    ...resolved,
    key,
    label,
    limit: SEO_LIMITS[key] ?? null,
  });

  const fields: SeoField[] = [
    field("title", "Title", resolveTitleField(ctx.pageTitle, ctx.siteName)),
    field("description", "Description", resolveMetaField(layers, "name", "description")),
    field("og:title", "Social title", resolveMetaField(layers, "property", "og:title")),
    field(
      "og:description",
      "Social description",
      resolveMetaField(layers, "property", "og:description"),
    ),
    field("og:image", "Social image", resolveMetaField(layers, "property", "og:image")),
    field("og:type", "Social type", resolveMetaField(layers, "property", "og:type")),
  ];
  const url = resolveSeoUrl(ctx.route, ctx.siteUrl);
  const withoutWarnings = { fields, url };
  return { ...withoutWarnings, warnings: seoWarnings(withoutWarnings, layers) };
}

// ─── The layout's `$head` ────────────────────────────────────────────────

/*
 * The middle layer is the only one the studio does not already hold in memory: it lives in a file.
 * It is fetched once per layout path and cached here, and the fetch rides `platform.readFile`, so
 * `probe.idle()`'s platform source already accounts for it — no new in-flight declaration.
 */

let _layoutHeadPath: string | null = null;
let _layoutHead: JxHeadEntry[] = [];
let _layoutHeadPending: string | null = null;

/** Drop the cached layout head, so the next preview re-reads the file. */
export function invalidateLayoutHeadCache(): void {
  _layoutHeadPath = null;
  _layoutHead = [];
  _layoutHeadPending = null;
}

async function loadLayoutHead(path: string): Promise<void> {
  if (_layoutHeadPending === path) {
    return;
  }
  _layoutHeadPending = path;
  const doc = await resolveLayoutDoc(path);
  if (_layoutHeadPending !== path) {
    // A different layout was asked for while this one was in flight; that request owns the cache.
    return;
  }
  _layoutHeadPending = null;
  _layoutHeadPath = path;
  _layoutHead = doc?.$head ?? [];
  renderOnly("frontmatterPanel");
}

/**
 * A layout path as a reader would name it — `./layouts/blog-post.json` → `Blog Post`.
 *
 * @param {string} path
 * @returns {string}
 */
export function layoutDisplayName(path: string): string {
  return (
    path
      .replace(/^\.\//, "")
      .replace(/^layouts\//, "")
      .replace(/\.json$/, "")
      .replaceAll(/[-_/]+/g, " ")
      .replaceAll(/\b\w/g, (c) => c.toUpperCase()) || path
  );
}

/**
 * The effective layout's `$head`, and the name to print for it.
 *
 * Returns empty on the first call for a layout and schedules the read; the card repaints when it
 * lands. Showing nothing briefly is the honest state — the alternative is attributing the layout's
 * entries to the page.
 *
 * @param {Tab | null} tab — the tab whose document the entries are being resolved FOR.
 * @param {string | false} [docLayout]
 * @returns {{ entries: JxHeadEntry[]; name: string | null }}
 */
export function layoutHeadEntries(
  tab: Tab | null,
  docLayout?: string | false,
): {
  entries: JxHeadEntry[];
  name: string | null;
} {
  const path = isPageDocument(tab) ? getEffectiveLayoutPath(docLayout) : null;
  if (path === null) {
    return { entries: [], name: null };
  }
  const name = layoutDisplayName(path);
  if (path === _layoutHeadPath) {
    return { entries: _layoutHead, name };
  }
  void loadLayoutHead(path);
  return { entries: [], name };
}

/**
 * The preview for the document the card is showing.
 *
 * @param {Tab | null} tab — the tab the card was drawn for; its route and its layout, not the
 *   focused pane's.
 * @param {JxMutableNode} doc — the head-bearing view of the document (`buildHeadDoc` for content).
 * @returns {SeoPreview}
 */
export function seoPreviewFor(tab: Tab | null, doc: JxMutableNode): SeoPreview {
  const config = projectState?.projectConfig;
  const layout = layoutHeadEntries(tab, doc.$layout);
  const path = tab?.documentPath;
  return buildSeoPreview(
    {
      layout: layout.entries,
      layoutName: layout.name,
      page: doc.$head ?? [],
      site: config?.$head ?? [],
    },
    {
      pageTitle: typeof doc.title === "string" ? doc.title : "",
      route: path ? pageRoute(path) : null,
      ...(config?.name === undefined ? {} : { siteName: config.name }),
      ...(config?.url === undefined ? {} : { siteUrl: config.url }),
    },
  );
}

// ─── Field renderers ─────────────────────────────────────────────────────

/**
 * Render a meta field row using renderFieldRow.
 *
 * @param {MetaField} field
 * @param {JxHeadEntry[]} head
 * @param {(fn: (doc: JxMutableNode) => void) => void} applyMutation
 * @returns {import("lit-html").TemplateResult}
 */
export function renderMetaFieldRow(
  field: MetaField,
  head: JxHeadEntry[],
  applyMutation: (fn: (doc: JxMutableNode) => void) => void,
) {
  const entry = findMetaEntry(head, field.attr, field.key);
  const val = String(entry?.attributes?.content ?? "");

  if (field.media) {
    return renderFieldRow({
      hasValue: Boolean(val),
      label: field.label,
      onClear: () => applyMutation((d: JxMutableNode) => upsertMeta(d, field.attr, field.key, "")),
      prop: field.key,
      widget: renderMediaPicker(field.key, val, (v: string) => {
        applyMutation((d: JxMutableNode) => upsertMeta(d, field.attr, field.key, v || ""));
      }),
    });
  }

  const commit = (v: string) =>
    applyMutation((d: JxMutableNode) => upsertMeta(d, field.attr, field.key, v.trim()));
  const placeholder =
    field.key === "viewport" ? "width=device-width, initial-scale=1" : `${field.label}…`;
  const widget = field.multiline
    ? spTextArea(`head:${field.key}`, val, commit, {
        placeholder: `${field.label}…`,
      })
    : spTextField(`head:${field.key}`, val, commit, { placeholder });

  return renderFieldRow({
    hasValue: Boolean(val),
    label: field.label,
    onClear: () => applyMutation((d: JxMutableNode) => upsertMeta(d, field.attr, field.key, "")),
    prop: field.key,
    widget,
  });
}

// ─── Template ────────────────────────────────────────────────────────────

/**
 * @param {{
 *   document: JxMutableNode;
 *   applyMutation: (fn: (doc: JxMutableNode) => void) => void;
 *   renderLeftPanel: () => void;
 * }} ctx
 * @returns {import("lit-html").TemplateResult}
 */
export function renderHeadTemplate({
  document: doc,
  applyMutation,
  renderLeftPanel,
}: {
  document: JxMutableNode;
  applyMutation: (fn: (doc: JxMutableNode) => void) => void;
  renderLeftPanel: () => void;
}) {
  const head = doc.$head ?? [];
  const title = doc.title ?? "";

  // Icon (favicon) link
  const iconEntry = findLinkEntry(head, "icon");
  const iconHref = String(iconEntry?.attributes?.href ?? "");

  // Custom entries not managed by structured forms, fonts, or preconnects
  const customEntries = head.filter(
    (e: JxHeadEntry) => !isManagedEntry(e) && !isGoogleFontEntry(e) && !isGoogleFontPreconnect(e),
  );

  // Frontmatter section (content mode only)
  const tab = activeTab.value;
  const isContent = tab?.doc.mode === "content";
  const frontmatterSection = isContent ? renderFrontmatterSection() : nothing;

  // `tab` is the FOCUSED tab, and legitimately so: this template is the Navigator's Page panel,
  // Which is drawn once for the shell and follows the focus by design. Spelling it here is what
  // Lets `renderLayoutSection` and everything under it take a tab instead of asking.
  const layoutSection = renderLayoutSection(tab, doc, applyMutation);

  return html`
    <div class="imports-panel">
      ${frontmatterSection} ${layoutSection}

      <!-- Page section -->
      <div class="imports-section">
        <div class="imports-section-header">
          <span class="imports-section-title">Page</span>
        </div>
        <div class="head-section-body">
          ${renderFieldRow({
            hasValue: Boolean(title),
            label: "Title",
            onClear: () =>
              applyMutation((d: JxMutableNode) => {
                delete d.title;
              }),
            prop: "title",
            widget: spTextField(
              "head:title",
              title,
              (v: string) =>
                applyMutation((d: JxMutableNode) => {
                  const val = v.trim();
                  if (val) {
                    d.title = val;
                  } else {
                    delete d.title;
                  }
                }),
              { placeholder: "Page title…" },
            ),
          })}
          ${PAGE_FIELDS.map((field) => renderMetaFieldRow(field, head, applyMutation))}
          ${renderFieldRow({
            hasValue: Boolean(iconHref),
            label: "Icon",
            onClear: () => applyMutation((d: JxMutableNode) => upsertLink(d, "icon", "")),
            prop: "icon",
            widget: renderMediaPicker("icon", iconHref, (v: string) => {
              applyMutation((d: JxMutableNode) => upsertLink(d, "icon", v || ""));
            }),
          })}
        </div>
      </div>

      <!-- OpenGraph section -->
      <div class="imports-section">
        <div class="imports-section-header">
          <span class="imports-section-title">OpenGraph</span>
        </div>
        <div class="head-section-body">
          ${OG_FIELDS.map((field) => renderMetaFieldRow(field, head, applyMutation))}
        </div>
      </div>

      <!-- Custom $head entries -->
      <div class="imports-section">
        <div class="imports-section-header">
          <span class="imports-section-title">Custom Tags</span>
          <span class="imports-count">${customEntries.length}</span>
        </div>
        ${
          customEntries.length > 0
            ? html`
                <div class="imports-list">
                  ${customEntries.map((entry: JxHeadEntry) => {
                    const label = entryLabel(entry);
                    const value = entryValue(entry);
                    return html`
                      <div class="import-row">
                        <span class="import-name" title=${value}>${label}</span>
                        <span class="import-path">${value}</span>
                        <sp-action-button
                          quiet
                          size="xs"
                          title="Remove"
                          @click=${() => {
                            applyMutation((d: JxMutableNode) => {
                              if (!d.$head) {
                                return;
                              }
                              const idx = d.$head.indexOf(entry);
                              if (idx !== -1) {
                                d.$head.splice(idx, 1);
                              }
                            });
                            renderLeftPanel();
                          }}
                        >
                          <sp-icon-close slot="icon" size="xs"></sp-icon-close>
                        </sp-action-button>
                      </div>
                    `;
                  })}
                </div>
              `
            : renderEmptyState({
                compact: true,
                message:
                  "Custom tags add your own meta, link and script elements to this page — " +
                  "analytics, verification, a webfont. Add one below.",
              })
        }

        <!-- Add custom tag form -->
        <div class="head-add-form">
          <sp-picker size="s" label="Tag" class="head-add-tag" value="meta">
            <sp-menu-item value="meta">meta</sp-menu-item>
            <sp-menu-item value="link">link</sp-menu-item>
            <sp-menu-item value="script">script</sp-menu-item>
          </sp-picker>
          <sp-textfield
            placeholder="Attribute (e.g. name)"
            size="s"
            class="head-add-attr"
          ></sp-textfield>
          <sp-textfield placeholder="Value" size="s" class="head-add-val"></sp-textfield>
          <sp-action-button
            quiet
            size="xs"
            title="Add tag"
            @click=${(e: Event) => {
              const form = (e.target as HTMLElement).closest(".head-add-form");
              const tagPicker = form?.querySelector(".head-add-tag") as HTMLInputElement | null;
              const attrField = form?.querySelector(".head-add-attr") as HTMLInputElement | null;
              const valField = form?.querySelector(".head-add-val") as HTMLInputElement | null;
              const tagName = tagPicker?.value || "meta";
              const attrKey = attrField?.value?.trim();
              const attrVal = valField?.value?.trim();
              if (!attrKey || !attrVal) {
                return;
              }
              if (attrField) {
                attrField.value = "";
              }
              if (valField) {
                valField.value = "";
              }

              const entry: JxHeadEntry = { attributes: {}, tagName };
              if (tagName === "meta") {
                entry.attributes = { content: attrVal, name: attrKey };
              } else if (tagName === "link") {
                entry.attributes = { href: attrVal, rel: attrKey };
              } else if (tagName === "script") {
                entry.attributes = { [attrKey]: attrVal };
              }

              applyMutation((d: JxMutableNode) => {
                if (!d.$head) {
                  d.$head = [];
                }
                d.$head.push(entry);
              });
              renderLeftPanel();
            }}
          >
            <sp-icon-add slot="icon" size="xs"></sp-icon-add>
          </sp-action-button>
        </div>
      </div>
    </div>
  `;
}

// ─── Layout picker ───────────────────────────────────────────────────────

/**
 * Whether `tab`'s document is a page of a site project — the only documents a layout applies to.
 *
 * **It takes the tab, and that is the whole of finding 3.** It was zero-argument and read
 * `activeTab.value?.documentPath`, while both of its important callers had already been handed a
 * tab: `hasDocumentHeader(tab)` inspects THAT tab's frontmatter, title and `$head` and then fell
 * through to here for the "a page always has one" rule, and `documentHeaderTemplate(tab, paneId)`
 * gates the Layout picker on it. Both directions were visible with two panes — a page in the
 * unfocused pane lost its Title and Route because the focused tab was a component, and a bare
 * component GAINED a header card because the focused tab was a page — and the Layout picker
 * appeared or vanished in the pane you were editing according to the document in the other one.
 *
 * A caller whose subject genuinely IS the focused document (the Navigator's Page panel) passes
 * `activeTab.value`, where a reviewer can see it. The same bargain `setCanvasMode` made.
 *
 * @param {Tab | null} tab
 * @returns {boolean}
 */
export function isPageDocument(tab: Tab | null): boolean {
  const path = tab?.documentPath;
  return Boolean(
    path &&
    projectState?.isSiteProject &&
    (path.startsWith("pages/") || path.startsWith("./pages/")),
  );
}

/**
 * The layout picker as ONE field row, so the Page panel and the Document Header card render the
 * same control rather than two that drift.
 *
 * Returns `nothing` while the layouts directory is still being listed; the listing schedules a
 * re-render of both surfaces when it lands.
 *
 * @param {JxMutableNode} doc
 * @param {(fn: (doc: JxMutableNode) => void) => void} applyMutation
 * @returns {TemplateResult | typeof nothing}
 */
export function renderLayoutPickerRow(
  doc: JxMutableNode,
  applyMutation: (fn: (doc: JxMutableNode) => void) => void,
): TemplateResult | typeof nothing {
  if (layoutEntries === null) {
    void loadLayoutEntries();
    return nothing;
  }
  const currentLayout = doc.$layout;
  const defaultLayout = projectState?.projectConfig?.defaults?.layout;
  const displayValue = currentLayout === false ? "__none__" : currentLayout || "__default__";
  const defaultLabel = defaultLayout
    ? defaultLayout
        .replace(/^\.\/layouts\//, "")
        .replace(/\.json$/, "")
        .replaceAll(/[-_]+/g, " ")
        .replaceAll(/\b\w/g, (c: string) => c.toUpperCase())
    : "";
  const entries = layoutEntries;
  return renderFieldRow({
    hasValue: currentLayout !== undefined,
    label: "Layout",
    onClear: () =>
      applyMutation((d: JxMutableNode) => {
        delete d.$layout;
      }),
    prop: "layout",
    widget: html`
      <sp-picker
        size="s"
        value=${displayValue}
        @change=${(e: Event) => {
          const val = (e.target as HTMLInputElement).value;
          applyMutation((d: JxMutableNode) => {
            if (val === "__default__") {
              delete d.$layout;
            } else if (val === "__none__") {
              d.$layout = false;
            } else {
              d.$layout = val;
            }
          });
          invalidateLayoutCache();
        }}
      >
        <sp-menu-item value="__default__"
          >Default${defaultLabel ? ` (${defaultLabel})` : ""}</sp-menu-item
        >
        <sp-menu-item value="__none__">None</sp-menu-item>
        <sp-menu-divider></sp-menu-divider>
        ${entries.map(
          (l: { name: string; path: string }) =>
            html`<sp-menu-item value=${l.path}>${l.name}</sp-menu-item>`,
        )}
      </sp-picker>
    `,
  });
}

/** The Page panel's boxed wrapper around {@link renderLayoutPickerRow}. */
function renderLayoutSection(
  tab: Tab | null,
  doc: JxMutableNode,
  applyMutation: (fn: (doc: JxMutableNode) => void) => void,
): TemplateResult | typeof nothing {
  if (!isPageDocument(tab)) {
    return nothing;
  }
  const row = renderLayoutPickerRow(doc, applyMutation);
  if (row === nothing) {
    return nothing;
  }
  return html`
    <div class="imports-section">
      <div class="imports-section-header">
        <span class="imports-section-title">Layout</span>
      </div>
      <div class="head-section-body">${row}</div>
    </div>
  `;
}

// ─── Frontmatter section ────────────────────────────────────────────────

function renderFrontmatterSection() {
  const tab = activeTab.value;
  if (!tab) {
    return nothing;
  }

  const { collection, fields, hasSchema, requiredFields } = collectFmFields(
    tab,
    projectState?.projectConfig,
    RESERVED_FM_KEYS,
  );

  if (fields.length === 0 && !hasSchema) {
    return nothing;
  }

  return html`
    <div class="imports-section">
      <div class="imports-section-header">
        <span class="imports-section-title"
          >${collection ? `Frontmatter (${collection.name})` : "Frontmatter"}</span
        >
      </div>
      <div class="head-section-body">
        ${fields.map((f) => renderFmField(f.field, f.entry, f.value, requiredFields))}
      </div>
    </div>
  `;
}

/** Overlay content-mode frontmatter title/`$head` onto the document the panel edits. */
export function buildHeadDoc(doc: JxMutableNode, fm: Record<string, unknown>): JxMutableNode {
  const title = fm.title as string | undefined;
  const $head = fm.$head as JxHeadEntry[] | undefined;
  return {
    ...doc,
    ...(title === undefined ? {} : { title }),
    ...($head === undefined ? {} : { $head }),
  };
}

/**
 * The mutation path for a content-mode document, where title and `$head` live in frontmatter.
 *
 * The panel edits a `JxMutableNode`; a markdown page's head fields are frontmatter keys. This
 * adapts one to the other in the module that owns both, instead of in the Navigator orchestrator
 * that owns neither.
 */
export function applyContentMutation(rerender: () => void, fn: (doc: JxMutableNode) => void): void {
  const tabNow = activeTab.value;
  if (!tabNow) {
    return;
  }
  const fmNow = (tabNow.doc.content?.frontmatter ?? {}) as Record<string, unknown>;
  const fmHead = fmNow.$head as JxHeadEntry[] | undefined;
  const tmp: JxMutableNode = {
    ...(typeof fmNow.title === "string" ? { title: fmNow.title } : {}),
    ...(fmHead ? { $head: [...fmHead] } : {}),
  };
  fn(tmp);
  if (tmp.title !== fmNow.title) {
    mutateUpdateFrontmatter(tabNow, "title", tmp.title as JsonValue);
  }
  const newHead = tmp.$head && tmp.$head.length > 0 ? tmp.$head : undefined;
  // JxHeadEntry[] is JSON document content by construction.
  mutateUpdateFrontmatter(tabNow, "$head", newHead as JsonValue);
  rerender();
}

/**
 * Contribute the Page panel.
 *
 * `level: "document"` — title, description, social card and custom `$head` entries are the open
 * document's. The id is `page` now: "head" named an HTML element, and §3.2's DOCUMENT group calls
 * the surface Page. P3.10 moves these fields into the in-stage Document Header card; until then the
 * record is what keeps the surface addressable under one name.
 */
export function registerPagePanel(): void {
  registerPanel({
    id: "page",
    title: "Page",
    level: "document",
    dock: "navigator",
    icon: "sp-icon-view-all-tags",
    requiresDocument: "Open a page to edit its title, description and social preview.",
    render: (ctx) => {
      const doc = ctx.doc!;
      const isContent = doc.mode === "content";
      const fm = doc.content?.frontmatter ?? {};
      // Through `deps`, not the local binding: `studio.ts` owns the wiring, and the Navigator has
      // Injected these renderers since before the registry existed.
      return ctx.deps.renderHeadTemplate({
        applyMutation: isContent
          ? (fn) => applyContentMutation(ctx.rerender, fn)
          : (fn) => {
              transact(activeTab.value, fn);
            },
        document: isContent ? buildHeadDoc(doc.document, fm) : doc.document,
        renderLeftPanel: ctx.rerender,
      });
    },
  });
}
