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
import { invalidateLayoutCache } from "../site-context";
import { getPlatform } from "../platform";

import type { JxHeadEntry, JxMutableNode } from "@jxsuite/schema/types";
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

export function invalidateLayoutPickerCache() {
  layoutEntries = null;
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

  const layoutSection = renderLayoutSection(doc, applyMutation);

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
 * Whether the open document is a page of a site project — the only documents a layout applies to.
 *
 * @returns {boolean}
 */
export function isPageDocument(): boolean {
  const path = activeTab.value?.documentPath;
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
  doc: JxMutableNode,
  applyMutation: (fn: (doc: JxMutableNode) => void) => void,
): TemplateResult | typeof nothing {
  if (!isPageDocument()) {
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
