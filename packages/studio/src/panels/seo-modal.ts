/// <reference lib="dom" />
/**
 * Seo-modal.ts — Search appearance, as a surface of its own.
 *
 * It was a collapsible block inside the Document Header card: two rendered previews, a resolved
 * field list, a warning list, the page and Open Graph meta rows, and an icon picker — all disclosed
 * under one summary row, inside a card whose job is the four or five fields you fill in while
 * writing. A previewed SERP result is not a field; it is a picture you study, and studying it in a
 * strip above the canvas meant the card grew taller than the thing it describes.
 *
 * So it opens as a modal, from two places — the Document Header card and the Navigator's Page
 * panel. Two doors because the two are different moments: one while writing the page, one while
 * working on its head material. Both run `document.openSeo`, so there is a third door in the
 * palette and no surface owns the capability (§2 principle 1).
 *
 * **The card keeps the fields; the modal keeps the picture.** Title still lives on the card,
 * because it is the one head value you type while writing. Everything the modal holds is either a
 * rendering of what the build will emit or a field you set once and leave.
 *
 * The mutation path is the card's, unchanged: a markdown page commits through
 * `applyContentMutation` and a JSON one through `transact`, both taking the tab so the modal edits
 * the document it was opened over rather than whichever pane has focus.
 */

import { html, nothing } from "lit-html";
import { activeRegistry } from "../commands/active-registry";
import { loopbackAssetSrc } from "../canvas/canvas-origin";
import { previewAssetSrc } from "../canvas/content-assets";
import { renderFieldRow } from "../ui/field-row";
import { renderMediaPicker } from "../ui/media-picker";
import { renderProvenanceChip } from "./provenance";
import { tabLabel } from "./tab-strip";
import { openModal } from "../ui/layers";
import { transact } from "../tabs/transact";
import { activeTab } from "../workspace/workspace";
import {
  OG_FIELDS,
  PAGE_FIELDS,
  applyContentMutation,
  buildHeadDoc,
  findLinkEntry,
  renderMetaFieldRow,
  seoField,
  seoPreviewFor,
  upsertLink,
  visibleLength,
} from "./head-panel";
import type { SeoField, SeoPreview } from "./head-panel";
import type { FieldProvenance } from "./provenance";
import type { JxHeadEntry, JxMutableNode } from "@jxsuite/schema/types";
import type { Tab } from "../tabs/tab";
import type { AnyCommand, CommandRegistry } from "../commands/registry";
import type { TemplateResult } from "lit-html";

// ─── The body ─────────────────────────────────────────────────────────────────

/*
 * Two rendered previews, a resolved-field list and a warning list, over the MERGED head — and no
 * score. A number out of a hundred aggregates unrelated facts into a verdict, and a verdict is
 * what gets optimised; a count beside a limit and a named consequence say the same thing without
 * ranking anything (plan §9.2, §14).
 *
 * The previews are pictures of what the build emits, so a value the page did not author is marked
 * as inherited with the donor NAMED — the third cascade to use `panels/provenance.ts`'s vocabulary
 * after the style cascade and component props, and deliberately not a fourth vocabulary. It is the
 * whole reason the block can say "no description reaches this page" without saying it to a page
 * that inherits one from the site.
 */

/**
 * A resolved field's provenance chip, in the shared vocabulary.
 *
 * The two chips that can go somewhere do: a value from the site's own `$head` opens Project
 * Settings › Site head, and one from the site `name` opens Overview. The layout and build donors
 * get a `<span>` rather than a `<button>`, because the card has no verb for "open that layout" and
 * a control that looks pressable and does nothing is the defect §6.2 exists to remove.
 *
 * @param {SeoField} field
 * @returns {FieldProvenance}
 */
function seoProvenance(field: SeoField): FieldProvenance {
  const open = (section: string) => () => {
    void activeRegistry()?.run("settings.open", { section });
  };
  switch (field.source) {
    case "page": {
      return { state: "set", title: `${field.label} is set on this page` };
    }
    case "layout": {
      const donor = field.donor ?? "the layout";
      return {
        donor,
        state: "inherited",
        title: `${field.label} comes from the ${donor} layout — this page does not set it`,
      };
    }
    case "site": {
      const fromName = field.donor === "Site name";
      return {
        donor: field.donor ?? "the site",
        onClick: open(fromName ? "overview" : "head"),
        state: "inherited",
        title: `${field.label} comes from ${fromName ? "the project's name" : "the site-level $head"} — click to open it`,
      };
    }
    case "build": {
      return {
        donor: "the build",
        state: "inherited",
        title: `Nothing declares ${field.label}, so the build supplies “${field.value}”`,
      };
    }
    default: {
      return { state: "default" };
    }
  }
}

/** A previewed line of text, or the placeholder that says nothing supplies it. */
function previewText(field: SeoField): TemplateResult {
  const text = field.value.trim();
  return text
    ? html`<span>${text}</span>`
    : html`<span class="seo-unset">No ${field.label.toLowerCase()}</span>`;
}

/** The mock search result: the breadcrumb the canonical produces, the title, the description. */
function serpCard(preview: SeoPreview): TemplateResult {
  return html`
    <figure class="seo-card seo-card--serp" aria-label="Search result preview">
      <figcaption class="seo-card-label">Search result</figcaption>
      <div class="seo-serp-url">${preview.url.crumb}</div>
      <div class="seo-serp-title">${seoField(preview, "title").value}</div>
      <div class="seo-serp-desc">${previewText(seoField(preview, "description"))}</div>
    </figure>
  `;
}

/**
 * The mock social card.
 *
 * The image is resolved the same way every other image in the studio chrome is —
 * `loopbackAssetSrc(previewAssetSrc(…))` — so a content-relative `./images/hero.jpg` previews at
 * its asset-mount URL while the authored ref stays exactly as written.
 */
function socialCard(preview: SeoPreview): TemplateResult {
  const image = seoField(preview, "og:image").value.trim();
  return html`
    <figure class="seo-card seo-card--social" aria-label="Social card preview">
      <figcaption class="seo-card-label">Social card</figcaption>
      <div class="seo-social-media">
        ${
          image
            ? html`<img src=${loopbackAssetSrc(previewAssetSrc(image))} alt="" />`
            : html`<span class="seo-unset">No image</span>`
        }
      </div>
      <div class="seo-social-text">
        <span class="seo-social-domain"
          >${preview.url.host || html`<span class="seo-unset">No site URL</span>`}</span
        >
        <span class="seo-social-title">${previewText(seoField(preview, "og:title"))}</span>
        <span class="seo-social-desc">${previewText(seoField(preview, "og:description"))}</span>
      </div>
    </figure>
  `;
}

/** One row per resolved field: what reaches the browser, how long it is, and where it came from. */
function seoFieldList(preview: SeoPreview): TemplateResult {
  return html`
    <ul class="seo-fields">
      ${preview.fields.map((field) => {
        const length = visibleLength(field.value);
        const over = field.limit !== null && length > field.limit;
        return html`
          <li class="seo-field" data-seo-field=${field.key}>
            <span class="seo-field-label">${field.label}</span>
            <span class="seo-field-value" title=${field.value}>${previewText(field)}</span>
            ${
              field.limit === null
                ? nothing
                : html`<span
                    class=${over ? "seo-field-count seo-field-count--over" : "seo-field-count"}
                    >${length}/${field.limit}</span
                  >`
            }
            ${renderProvenanceChip(field.key, seoProvenance(field))}
          </li>
        `;
      })}
    </ul>
  `;
}

/** The named warnings. A list, never a total — see the note at the top of this section. */
function seoWarningList(preview: SeoPreview): TemplateResult {
  if (preview.warnings.length === 0) {
    return html`<p class="doc-header-empty">
      Nothing to flag — every previewed field resolves to a value.
    </p>`;
  }
  return html`
    <ul class="seo-warnings">
      ${preview.warnings.map(
        (warning) => html`
          <li class="seo-warning" data-seo-warning=${warning.id}>
            <code class="seo-warning-field">${warning.field}</code>
            <span>${warning.message}</span>
          </li>
        `,
      )}
    </ul>
  `;
}

/**
 * The previews, the resolved fields, then the controls that change them.
 *
 * That order on purpose: what it looks like, what is wrong with it, and only then the form. The
 * form was all this block used to be, and a form cannot tell you that the description you are about
 * to write is already coming from the site.
 */
function seoBody(
  tab: Tab,
  headDoc: JxMutableNode,
  head: JxHeadEntry[],
  applyMutation: (fn: (doc: JxMutableNode) => void) => void,
): TemplateResult {
  const iconHref = String(findLinkEntry(head, "icon")?.attributes?.href ?? "");
  // The card's tab, so the SERP row shows this document's route and this document's layout layer.
  const preview = seoPreviewFor(tab, headDoc);
  return html`
    <div class="seo-previews">${serpCard(preview)} ${socialCard(preview)}</div>
    ${seoFieldList(preview)} ${seoWarningList(preview)}
    <!-- GROUPED, because the two sets collide by name: Open Graph has its own Title, Description
         and Image, and eight unlabelled rows in a column made "Description" mean two things. Each
         group is headed by the preview card it feeds, so a row and the picture it changes are
         nameable together. -->
    <div class="seo-modal-group">
      <h3 class="seo-modal-group-title">Search result</h3>
      ${PAGE_FIELDS.map((field) => renderMetaFieldRow(field, head, applyMutation))}
      ${renderFieldRow({
        hasValue: Boolean(iconHref),
        label: "Icon",
        onClear: () => applyMutation((d) => upsertLink(d, "icon", "")),
        prop: "icon",
        widget: renderMediaPicker("icon", iconHref, (v: string) => {
          applyMutation((d) => upsertLink(d, "icon", v || ""));
        }),
      })}
    </div>
    <div class="seo-modal-group">
      <h3 class="seo-modal-group-title">Social card</h3>
      <!-- No fallback is promised here, because the build emits none: the warning list above says
           an unset og:title means "a shared link carries no headline of its own", and a note
           claiming otherwise would contradict the app two inches higher. -->
      <p class="seo-modal-group-note">Open Graph — what a shared link shows.</p>
      ${OG_FIELDS.map((field) => renderMetaFieldRow(field, head, applyMutation))}
    </div>
  `;
}

// ─── The modal ───────────────────────────────────────────────────────────────

/** The open modal, or `null`. One at a time: it is about the focused document. */
let _handle: { update: (tpl: TemplateResult) => void; close: () => void } | null = null;

/** The tab it was opened over, so a re-render draws the same document the author opened. */
let _tab: Tab | null = null;

/**
 * What the SEO body needs from a tab, resolved once.
 *
 * Both realms in one place: a markdown page keeps its head material in frontmatter and a JSON one
 * in root properties, and `buildHeadDoc` is the card's own view of that difference.
 */
function seoContextFor(tab: Tab): {
  headDoc: JxMutableNode;
  head: JxHeadEntry[];
  applyMutation: (fn: (doc: JxMutableNode) => void) => void;
} {
  const isContent = tab.doc.mode === "content";
  const fm = (tab.doc.content?.frontmatter ?? {}) as Record<string, unknown>;
  const headDoc = isContent ? buildHeadDoc(tab.doc.document, fm) : tab.doc.document;
  return {
    applyMutation: isContent
      ? (fn: (doc: JxMutableNode) => void) => applyContentMutation(tab, renderSeoModal, fn)
      : (fn: (doc: JxMutableNode) => void) => {
          transact(tab, fn);
        },
    head: headDoc.$head ?? [],
    headDoc,
  };
}

/** Repaint the modal if it is open. Every field commits live, so the picture follows the edit. */
export function renderSeoModal(): void {
  if (!_handle || !_tab) {
    return;
  }
  const { applyMutation, head, headDoc } = seoContextFor(_tab);
  const tab = _tab;
  _handle.update(html`
    <!-- The region goes on the BODY, not on the layer slot: the slot is a zero-height wrapper
         around a fixed-position body, so a shot capturing it would capture nothing. The publish
         panel stamps its own for the same reason. An overlay.instance:id name is a DERIVED shape,
         so this costs the manifest no non-derived-region budget. -->
    <div class="seo-modal" data-jx-region="overlay.dialog:seo">
      <div class="settings-modal-header">
        <h2 class="settings-modal-title">Search appearance</h2>
        <!-- WHICH document, in the header. A modal has no tab strip behind it to say so, and every
             field below resolves through this document's layout and site head. -->
        <span class="seo-modal-doc">${tab.documentPath ?? tabLabel(tab)}</span>
        <sp-action-button quiet size="s" title="Close" @click=${closeSeoModal}>
          <sp-icon-close slot="icon"></sp-icon-close>
        </sp-action-button>
      </div>
      <div class="seo-modal-body">${seoBody(tab, headDoc, head, applyMutation)}</div>
    </div>
  `);
}

/** Open it over `tab`. Idempotent — opening it again re-points it at the current document. */
export function openSeoModal(tab: Tab): void {
  _tab = tab;
  if (!_handle) {
    _handle = openModal(html``, { label: "Search appearance", onDismiss: closeSeoModal });
  }
  renderSeoModal();
}

/** Close it, and forget the document it was about. */
export function closeSeoModal(): void {
  _handle?.close();
  _handle = null;
  _tab = null;
}

/**
 * `document.openSeo` — the one capability behind both buttons.
 *
 * The Document Header card and the Page panel each render a control that runs this, so neither owns
 * it and the palette has it by name. A record rather than two click handlers, for the reason the
 * rendering-context axes became records: a surface that IS the capability is a capability the
 * palette, the assistant and `__jxAutomation` cannot reach.
 *
 * @returns {AnyCommand[]}
 */
export function seoCommands(): AnyCommand[] {
  return [
    {
      category: "Document",
      id: "document.openSeo",
      level: "document",
      menus: ["palette"],
      group: "2_document",
      requires: "an open document",
      when: (ctx) => ctx.document.open,
      aiTool: {
        description:
          "Open Search appearance for the current document — the SERP and social previews, the " +
          "resolved head fields with their donors, and the page/Open Graph meta fields.",
        name: "open_seo",
      },
      run: () => {
        const tab = activeTab.value;
        if (!tab) {
          throw new RangeError(`command "document.openSeo" needs an open document`);
        }
        openSeoModal(tab);
      },
      title: "Search Appearance",
    },
  ];
}

/**
 * Register it.
 *
 * @param {CommandRegistry} registry
 */
export function registerSeoCommands(registry: CommandRegistry): void {
  registry.registerAll(seoCommands());
}
