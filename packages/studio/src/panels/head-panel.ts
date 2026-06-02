/**
 * Head panel — Page meta, OpenGraph, Frontmatter, and custom `$head` entries.
 *
 * Uses `renderFieldRow()` for consistent indicator-dot fields and `renderMediaPicker()` for image
 * selection (icon, og:image).
 */

import { html, nothing } from "lit-html";
import { live } from "lit-html/directives/live.js";
import { renderFieldRow } from "../ui/field-row";
import { renderMediaPicker } from "../ui/media-picker";
import { debouncedStyleCommit, renderOnly, projectState } from "../store";
import type { JsonValue } from "../types";
import { activeTab } from "../workspace/workspace";
import { transactDoc, mutateUpdateFrontmatter } from "../tabs/transact";
import { findContentTypeSchema } from "../utils/studio-utils";
import { isGoogleFontEntry, isGoogleFontPreconnect } from "../utils/google-fonts";
import { invalidateLayoutCache } from "../site-context";
import { getPlatform } from "../platform";

import type { JxHeadEntry } from "@jxsuite/schema/types";

interface MetaField {
  label: string;
  attr: "name" | "property";
  key: string;
  multiline?: boolean;
  media?: boolean;
}

interface FmSchemaEntry {
  type?: string;
  enum?: string[];
  format?: string;
  properties?: Record<string, unknown>;
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
          .replace(/[-_]+/g, " ")
          .replace(/\b\w/g, (c) => c.toUpperCase()),
        path: `./layouts/${f.name}`,
      }));
  } catch {
    layoutEntries = [];
  }
  renderOnly("leftPanel");
}

export function invalidateLayoutPickerCache() {
  layoutEntries = null;
}

// ─── Field definitions ───────────────────────────────────────────────────

const PAGE_FIELDS: MetaField[] = [
  { label: "Description", attr: "name", key: "description" },
  { label: "Viewport", attr: "name", key: "viewport" },
];

const OG_FIELDS: MetaField[] = [
  { label: "Title", attr: "property", key: "og:title" },
  { label: "Description", attr: "property", key: "og:description", multiline: true },
  { label: "Image", attr: "property", key: "og:image", media: true },
  { label: "Type", attr: "property", key: "og:type" },
];

/** Set of `name`/`property` values managed by the structured forms. */
const MANAGED_META_KEYS = new Set([...PAGE_FIELDS, ...OG_FIELDS].map((f) => f.key));

/** Frontmatter keys managed by the PAGE dedicated controls (others live inside $head). */
const RESERVED_FM_KEYS = new Set(["title"]);

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
  if (!head) return undefined;
  return head.find((e: JxHeadEntry) => e?.tagName === "meta" && e?.attributes?.[attr] === key);
}

/**
 * Find a `$head` link entry by `rel` attribute.
 *
 * @param {JxHeadEntry[]} head
 * @param {string} rel
 * @returns {JxHeadEntry | undefined}
 */
function findLinkEntry(head: JxHeadEntry[], rel: string) {
  if (!head) return undefined;
  return head.find((e: JxHeadEntry) => e?.tagName === "link" && e?.attributes?.rel === rel);
}

/**
 * Check if a `$head` entry is managed by the structured forms.
 *
 * @param {JxHeadEntry} entry
 * @returns {boolean}
 */
function isManagedEntry(entry: JxHeadEntry) {
  if (!entry?.tagName) return false;
  // Managed meta tags
  if (entry.tagName === "meta") {
    const name = String(entry?.attributes?.name ?? "");
    const prop = String(entry?.attributes?.property ?? "");
    return !!(name && MANAGED_META_KEYS.has(name)) || !!(prop && MANAGED_META_KEYS.has(prop));
  }
  // Managed link: favicon
  if (entry.tagName === "link" && entry?.attributes?.rel === "icon") return true;
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
  if (!doc.$head) doc.$head = [];
  const idx = doc.$head.findIndex(
    (e: JxHeadEntry) => e?.tagName === "meta" && e?.attributes?.[attr] === key,
  );
  if (content) {
    const entry = { tagName: "meta", attributes: { [attr]: key, content } };
    if (idx >= 0) {
      doc.$head[idx] = entry;
    } else {
      doc.$head.push(entry);
    }
  } else if (idx >= 0) {
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
function upsertLink(doc: JxMutableNode, rel: string, href: string) {
  if (!doc.$head) doc.$head = [];
  const idx = doc.$head.findIndex(
    (e: JxHeadEntry) => e?.tagName === "link" && e?.attributes?.rel === rel,
  );
  if (href) {
    const entry = { tagName: "link", attributes: { rel, href } };
    if (idx >= 0) {
      doc.$head[idx] = entry;
    } else {
      doc.$head.push(entry);
    }
  } else if (idx >= 0) {
    doc.$head.splice(idx, 1);
  }
}

/**
 * Get a display label for an arbitrary $head entry.
 *
 * @param {JxHeadEntry} entry
 * @returns {string}
 */
function entryLabel(entry: JxHeadEntry) {
  if (!entry?.tagName) return "unknown";
  const a = entry.attributes ?? {};
  if (a.name) return `<meta name="${String(a.name)}">`;
  if (a.property) return `<meta property="${String(a.property)}">`;
  if (a.rel && a.href) return `<link rel="${String(a.rel)}">`;
  if (a.src) return `<script src="${String(a.src)}">`;
  if (a.charset) return `<meta charset="${String(a.charset)}">`;
  return `<${entry.tagName}>`;
}

/**
 * Get a display value for an arbitrary $head entry.
 *
 * @param {JxHeadEntry} entry
 * @returns {string}
 */
function entryValue(entry: JxHeadEntry) {
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
function renderMetaFieldRow(
  field: MetaField,
  head: JxHeadEntry[],
  applyMutation: (fn: (doc: JxMutableNode) => void) => void,
) {
  const entry = findMetaEntry(head, field.attr, field.key);
  const val = String(entry?.attributes?.content ?? "");

  if (field.media) {
    return renderFieldRow({
      prop: field.key,
      label: field.label,
      hasValue: !!val,
      onClear: () => applyMutation((d: JxMutableNode) => upsertMeta(d, field.attr, field.key, "")),
      widget: renderMediaPicker(field.key, val, (v: string) => {
        applyMutation((d: JxMutableNode) => upsertMeta(d, field.attr, field.key, v || ""));
      }),
    });
  }

  const widget = field.multiline
    ? html`
        <sp-textfield
          size="s"
          multiline
          .value=${live(val)}
          placeholder="${field.label}…"
          @input=${debouncedStyleCommit(`head:${field.key}`, 400, (e: Event) => {
            const content = (e.target as HTMLInputElement).value?.trim() ?? "";
            applyMutation((d: JxMutableNode) => upsertMeta(d, field.attr, field.key, content));
          })}
        ></sp-textfield>
      `
    : html`
        <sp-textfield
          size="s"
          .value=${live(val)}
          placeholder=${field.key === "viewport"
            ? "width=device-width, initial-scale=1"
            : `${field.label}…`}
          @input=${debouncedStyleCommit(`head:${field.key}`, 400, (e: Event) => {
            const content = (e.target as HTMLInputElement).value?.trim() ?? "";
            applyMutation((d: JxMutableNode) => upsertMeta(d, field.attr, field.key, content));
          })}
        ></sp-textfield>
      `;

  return renderFieldRow({
    prop: field.key,
    label: field.label,
    hasValue: !!val,
    onClear: () => applyMutation((d: JxMutableNode) => upsertMeta(d, field.attr, field.key, "")),
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

  // Layout field
  const isPage =
    tab?.documentPath &&
    projectState?.isSiteProject &&
    (tab.documentPath.startsWith("pages/") || tab.documentPath.startsWith("./pages/"));

  let layoutSection: import("lit-html").TemplateResult | symbol = nothing;
  if (isPage) {
    if (layoutEntries === null) {
      loadLayoutEntries();
    } else {
      const currentLayout = doc.$layout;
      const defaultLayout = projectState?.projectConfig?.defaults?.layout;
      const displayValue =
        currentLayout === false ? "__none__" : currentLayout ? currentLayout : "__default__";
      const defaultLabel = defaultLayout
        ? defaultLayout
            .replace(/^\.\/layouts\//, "")
            .replace(/\.json$/, "")
            .replace(/[-_]+/g, " ")
            .replace(/\b\w/g, (c: string) => c.toUpperCase())
        : "";

      layoutSection = html`
        <div class="imports-section">
          <div class="imports-section-header">
            <span class="imports-section-title">Layout</span>
          </div>
          <div class="head-section-body">
            ${renderFieldRow({
              prop: "layout",
              label: "Layout",
              hasValue: currentLayout !== undefined,
              onClear: () =>
                applyMutation((d: JxMutableNode) => {
                  delete d.$layout;
                }),
              widget: html`
                <sp-picker
                  size="s"
                  value=${displayValue}
                  @change=${(e: Event) => {
                    const val = (e.target as HTMLInputElement).value;
                    applyMutation((d: JxMutableNode) => {
                      if (val === "__default__") delete d.$layout;
                      else if (val === "__none__") d.$layout = false;
                      else d.$layout = val;
                    });
                    invalidateLayoutCache();
                  }}
                >
                  <sp-menu-item value="__default__"
                    >Default${defaultLabel ? ` (${defaultLabel})` : ""}</sp-menu-item
                  >
                  <sp-menu-item value="__none__">None</sp-menu-item>
                  <sp-menu-divider></sp-menu-divider>
                  ${layoutEntries.map(
                    (l: { name: string; path: string }) =>
                      html`<sp-menu-item value=${l.path}>${l.name}</sp-menu-item>`,
                  )}
                </sp-picker>
              `,
            })}
          </div>
        </div>
      `;
    }
  }

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
            prop: "title",
            label: "Title",
            hasValue: !!title,
            onClear: () =>
              applyMutation((d: JxMutableNode) => {
                delete d.title;
              }),
            widget: html`
              <sp-textfield
                size="s"
                .value=${live(title)}
                placeholder="Page title…"
                @input=${debouncedStyleCommit("head:title", 400, (e: Event) => {
                  const val = (e.target as HTMLInputElement).value?.trim() ?? "";
                  applyMutation((d: JxMutableNode) => {
                    if (val) d.title = val;
                    else delete d.title;
                  });
                })}
              ></sp-textfield>
            `,
          })}
          ${PAGE_FIELDS.map((field) => renderMetaFieldRow(field, head, applyMutation))}
          ${renderFieldRow({
            prop: "icon",
            label: "Icon",
            hasValue: !!iconHref,
            onClear: () => applyMutation((d: JxMutableNode) => upsertLink(d, "icon", "")),
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
        ${customEntries.length > 0
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
                            if (!d.$head) return;
                            const idx = d.$head.indexOf(entry);
                            if (idx >= 0) d.$head.splice(idx, 1);
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
          : html`<div class="imports-empty">No custom tags</div>`}

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
              if (!attrKey || !attrVal) return;
              if (attrField) attrField.value = "";
              if (valField) valField.value = "";

              const entry: JxHeadEntry = { tagName, attributes: {} };
              if (tagName === "meta") {
                entry.attributes = { name: attrKey, content: attrVal };
              } else if (tagName === "link") {
                entry.attributes = { rel: attrKey, href: attrVal };
              } else if (tagName === "script") {
                entry.attributes = { [attrKey]: attrVal };
              }

              applyMutation((d: JxMutableNode) => {
                if (!d.$head) d.$head = [];
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

// ─── Frontmatter section ────────────────────────────────────────────────

function renderFrontmatterSection() {
  const tab = activeTab.value;
  if (!tab) return nothing;

  const fm = tab.doc.content?.frontmatter || {};
  const col = findContentTypeSchema(tab.documentPath, projectState?.projectConfig);
  const schema = col?.schema as
    | { properties?: Record<string, FmSchemaEntry>; required?: string[] }
    | undefined;
  const schemaProps = schema?.properties;
  const requiredFields = new Set(schema?.required || []);

  /** @type {{ field: string; entry: FmSchemaEntry; value: JsonValue }[]} */
  const fields = [];
  if (schemaProps) {
    for (const [field, fieldSchema] of Object.entries(
      /** @type {Record<string, FmSchemaEntry>} */ (schemaProps),
    )) {
      if (RESERVED_FM_KEYS.has(field)) continue;
      fields.push({ field, entry: fieldSchema, value: fm[field] as JsonValue });
    }
    for (const [field, value] of Object.entries(fm)) {
      if (schemaProps[field] || field.startsWith("$") || RESERVED_FM_KEYS.has(field)) continue;
      fields.push({
        field,
        entry: { type: typeof value === "boolean" ? "boolean" : "string" },
        value: /** @type {JsonValue} */ (value),
      });
    }
  } else {
    for (const [field, value] of Object.entries(fm)) {
      if (field.startsWith("$") || RESERVED_FM_KEYS.has(field)) continue;
      fields.push({
        field,
        entry: { type: typeof value === "boolean" ? "boolean" : "string" },
        value: /** @type {JsonValue} */ (value),
      });
    }
  }

  if (fields.length === 0 && !schemaProps) return nothing;

  return html`
    <div class="imports-section">
      <div class="imports-section-header">
        <span class="imports-section-title"
          >${col ? `Frontmatter (${col.name})` : "Frontmatter"}</span
        >
      </div>
      <div class="head-section-body">
        ${fields.map((f) => renderFmField(f.field, f.entry, f.value as JsonValue, requiredFields))}
      </div>
    </div>
  `;
}

function renderFmField(
  field: string,
  entry: FmSchemaEntry,
  value: JsonValue,
  requiredFields: Set<string>,
) {
  const isRequired = requiredFields.has(field);
  const label = field.replace(/([A-Z])/g, " $1").replace(/^./, (s) => s.toUpperCase());
  const displayLabel = label + (isRequired ? " *" : "");
  const hasVal = value !== undefined && value !== "" && value !== false;
  const onClear = () =>
    transactDoc(activeTab.value, (t) => mutateUpdateFrontmatter(t, field, undefined));

  if (entry.type === "boolean") {
    return renderFieldRow({
      prop: field,
      label: displayLabel,
      hasValue: hasVal,
      onClear,
      widget: html`
        <sp-checkbox
          size="s"
          .checked=${live(!!value)}
          @change=${(e: Event) =>
            transactDoc(activeTab.value, (t) =>
              mutateUpdateFrontmatter(
                t,
                field,
                (e.target as HTMLInputElement).checked || undefined,
              ),
            )}
        ></sp-checkbox>
      `,
    });
  }

  if (entry.type === "array") {
    const display = Array.isArray(value) ? value.join(", ") : value || "";
    return renderFieldRow({
      prop: field,
      label: displayLabel,
      hasValue: hasVal,
      onClear,
      widget: html`
        <sp-textfield
          size="s"
          placeholder="comma, separated"
          .value=${live(display)}
          @input=${debouncedStyleCommit(`fm:${field}`, 400, (e: Event) => {
            const arr = (e.target as HTMLInputElement).value
              ? (e.target as HTMLInputElement).value
                  .split(",")
                  .map((s: string) => s.trim())
                  .filter(Boolean)
              : undefined;
            transactDoc(activeTab.value, (t) => mutateUpdateFrontmatter(t, field, arr));
          })}
        ></sp-textfield>
      `,
    });
  }

  if (Array.isArray(entry.enum)) {
    return renderFieldRow({
      prop: field,
      label: displayLabel,
      hasValue: hasVal,
      onClear,
      widget: html`
        <sp-picker
          size="s"
          .value=${live(value || "")}
          @change=${(e: Event) =>
            transactDoc(activeTab.value, (t) =>
              mutateUpdateFrontmatter(t, field, (e.target as HTMLInputElement).value || undefined),
            )}
        >
          ${entry.enum.map((opt: string) => html`<sp-menu-item value=${opt}>${opt}</sp-menu-item>`)}
        </sp-picker>
      `,
    });
  }

  if (entry.format === "image") {
    return renderFieldRow({
      prop: field,
      label: displayLabel,
      hasValue: hasVal,
      onClear,
      widget: renderMediaPicker(field, value as string, (v: string) =>
        transactDoc(activeTab.value, (t) => mutateUpdateFrontmatter(t, field, v || undefined)),
      ),
    });
  }

  if (entry.type === "number") {
    return renderFieldRow({
      prop: field,
      label: displayLabel,
      hasValue: hasVal,
      onClear,
      widget: html`
        <sp-number-field
          size="s"
          hide-stepper
          .value=${live(value !== undefined ? Number(value) : undefined)}
          @change=${debouncedStyleCommit(`fm:${field}`, 400, (e: Event) => {
            const v = (e.target as HTMLInputElement).value;
            transactDoc(activeTab.value, (t) =>
              mutateUpdateFrontmatter(t, field, isNaN(Number(v)) ? undefined : Number(v)),
            );
          })}
        ></sp-number-field>
      `,
    });
  }

  return renderFieldRow({
    prop: field,
    label: displayLabel,
    hasValue: hasVal,
    onClear,
    widget: html`
      <sp-textfield
        size="s"
        placeholder=${entry.format === "date" ? "YYYY-MM-DD" : ""}
        .value=${live(value || "")}
        @input=${debouncedStyleCommit(`fm:${field}`, 400, (e: Event) => {
          transactDoc(activeTab.value, (t) =>
            mutateUpdateFrontmatter(t, field, (e.target as HTMLInputElement).value || undefined),
          );
        })}
      ></sp-textfield>
    `,
  });
}
