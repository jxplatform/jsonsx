/// <reference lib="dom" />
/**
 * The Document Header card (§3.2 ⑧) — the artefact's own header, drawn IN the stage.
 *
 * It replaces the old "Properties" bar, which was a fourth full-width band that **appeared and
 * vanished as a side effect of the canvas mode** with no control to summon it, and which showed
 * nothing at all unless `findContentTypeSchema` matched the document to a content collection — so
 * it never appeared on the default home page, the one document every new author opens first.
 *
 * Three gates are gone, and each was a lie about what the card is for:
 *
 * - The **collection gate** (`if (!fieldSet?.collection)`) — a page's `title` is frontmatter whether
 *   or not a collection schema describes it;
 * - The **mode gate** (`getCanvasMode() === "edit"`) — the header is part of the document, not a view
 *   of it, so switching to Design must not delete it;
 * - The **document-mode gate** (`doc.mode === "content"`) — a JSON page carries `title` and `$head`
 *   directly on the root node, and it has a header for exactly the same reason.
 *
 * What it renders instead: **any** document with frontmatter or `$head`, in every named layout and
 * in both authoring views of the stage — Title, Route, the layout picker, the
 * schema-and-frontmatter field list, a collapsible SEO block and a "Raw head tags" disclosure.
 * `hasDocumentHeader` is the whole predicate, and it is a fact about the DOCUMENT.
 *
 * **One reserved-key policy, one `collectFmFields` call.** The two field sets this card merges used
 * to disagree: this module passed an empty reserved set and `head-panel.ts` passed `{title}`, so
 * `title` could render twice with two different commit paths. `RESERVED_FM_KEYS` wins and is
 * imported, not restated — see the note on its declaration.
 *
 * **The card has no host of its own.** `#frontmatter-panel` — the grid row, the `hidden` div, the
 * `frontmatterPanelEl` ref and the 40vh cap that came with them — is deleted. The STAGE renders the
 * host now ({@link attachDocumentHeaderHost}, called from a `ref` in `canvas/canvas-render.ts`), so
 * the card sits inside the artefact rather than in a band above it. This module keeps only the
 * focus-aware scheduler and the reactive effect, because a field commit must still repaint the card
 * WITHOUT repainting the canvas — a full canvas render remounts the document iframe.
 */

import { html, nothing, render as litRender } from "lit-html";
import { projectState } from "../store";
import { activeTab } from "../workspace/workspace";
import { effect, effectScope } from "../reactivity";
import { createPanelScheduler } from "./panel-scheduler";
import { collectFmFields, renderFmField } from "./frontmatter-fields";
import { renderFieldRow } from "../ui/field-row";
import { spTextField } from "../ui/field-input";
import { transact } from "../tabs/transact";
import { pageRoute } from "./tab-strip";
import {
  OG_FIELDS,
  PAGE_FIELDS,
  RESERVED_FM_KEYS,
  applyContentMutation,
  buildHeadDoc,
  entryLabel,
  entryValue,
  findLinkEntry,
  isPageDocument,
  isManagedEntry,
  renderLayoutPickerRow,
  renderMetaFieldRow,
  upsertLink,
} from "./head-panel";
import { renderMediaPicker } from "../ui/media-picker";
import { isGoogleFontEntry, isGoogleFontPreconnect } from "../utils/google-fonts";

import type { JxHeadEntry, JxMutableNode } from "@jxsuite/schema/types";
import type { Tab } from "../tabs/tab";
import type { PanelScheduler } from "./panel-scheduler";
import type { TemplateResult } from "lit-html";

let _scheduler: PanelScheduler | null = null;
let _host: HTMLElement | null = null;
let _scope: { stop: () => void; run: <T>(fn: () => T) => T | undefined } | null = null;

/** Per-document disclosure state, keyed by tab id — not stored on the document. */
const _seoOpen = new Set<string>();
const _rawOpen = new Set<string>();

/**
 * The element the stage has made available for the card, or `null` while no stage hosts it.
 *
 * Called from a lit `ref` in `canvas/canvas-render.ts`, so the host's lifetime is the stage's: the
 * canvas creates it when it draws a document that has a header and drops it otherwise. The
 * scheduler is re-created per host because it binds `focusin`/`focusout` to that exact node, and
 * the focus guard is the whole reason this module still owns a render path of its own.
 *
 * @param {HTMLElement | null} el
 */
export function attachDocumentHeaderHost(el: HTMLElement | null): void {
  if (el === _host) {
    return;
  }
  _scheduler?.unbind();
  _scheduler = null;
  _host = el;
  if (!el) {
    return;
  }
  _scheduler = createPanelScheduler({ render: _doRender, root: el });
  _scheduler.bindFocus();
  _scheduler.schedule();
}

/**
 * The host the stage last handed over, or `null`. The stage reads it back to settle Lit's
 * order-independent detach report; nothing else needs to know where the card lives.
 */
export function documentHeaderHost(): HTMLElement | null {
  return _host;
}

/**
 * Mount the Document Header card: subscribe to the tab / document / frontmatter reads it renders
 * from, so a change repaints the card without repainting the canvas around it.
 *
 * The card takes no context. It used to take `getCanvasMode()` purely to decide whether to exist,
 * and that predicate is the thing this change deletes.
 */
export function mount() {
  _scope = effectScope();
  _scope.run(() => {
    effect(() => {
      const tab = activeTab.value;
      if (tab) {
        // Track everything the card reads: the document root (title / `$head` / `$layout` live
        // There for a JSON page) plus the frontmatter object AND its entries — field commits mutate
        // Keys in place while the source-mode round-trip swaps the whole object, and both must
        // Re-fire this effect.
        void tab.doc.mode;
        void tab.documentPath;
        void tab.doc.document;
        void tab.doc.document?.title;
        void tab.doc.document?.$head;
        void tab.doc.document?.$layout;
        const fm = tab.doc.content?.frontmatter;
        if (fm) {
          for (const key of Object.keys(fm)) {
            void fm[key];
          }
        }
      }
      render();
    });
  });
}

export function unmount() {
  _scope?.stop();
  _scope = null;
  _scheduler?.unbind();
  _scheduler = null;
  _host = null;
  _seoOpen.clear();
  _rawOpen.clear();
}

/**
 * Request a render. Coalesced and deferred while a text input in the card is focused, so re-renders
 * never clobber a field mid-edit.
 */
export function render() {
  _scheduler?.schedule();
}

/**
 * Whether a document has a header to show.
 *
 * The one remaining gate, and it is a fact about the document rather than about the view: a
 * component definition with no frontmatter, no title and no `$head` has no header, and printing an
 * empty card over its canvas would be chrome pretending to be content.
 *
 * @param {Tab} tab
 * @returns {boolean}
 */
export function hasDocumentHeader(tab: Tab): boolean {
  const fm = tab.doc.content?.frontmatter ?? {};
  const doc = tab.doc.document;
  if (Object.keys(fm).length > 0) {
    return true;
  }
  if (typeof doc?.title === "string" || (doc?.$head?.length ?? 0) > 0) {
    return true;
  }
  // A page always has one, even an empty one: Title and Route are the two facts it must state.
  return isPageDocument();
}

function _doRender() {
  const host = _host;
  if (!host) {
    return;
  }
  const tab = activeTab.value;
  if (!tab || !hasDocumentHeader(tab)) {
    // The stage decides whether the host exists; this only covers the window between a document
    // Losing its header and the canvas noticing. Lit leaves comment markers, so `:empty` cannot be
    // The signal and the host is hidden explicitly.
    litRender(nothing, host);
    host.hidden = true;
    return;
  }
  litRender(documentHeaderTemplate(tab), host);
  host.hidden = false;
}

/**
 * The card.
 *
 * Exported as a template because the STAGE hosts it: `canvas-render.ts` emits the host div and this
 * module paints into it. The region id (`pane.primary/frontmatter`) rides on the `<section>` rather
 * than on a shell host, which is what made the move a layout change instead of a rename — the id
 * names the card's PLACE in the pane, and the pane still has one.
 *
 * @param {Tab} tab
 * @returns {TemplateResult}
 */
export function documentHeaderTemplate(tab: Tab): TemplateResult {
  const isContent = tab.doc.mode === "content";
  const fm = (tab.doc.content?.frontmatter ?? {}) as Record<string, unknown>;
  // ONE view of the document's head material, whichever realm it lives in: frontmatter keys for a
  // Markdown page, root properties for a JSON one.
  const headDoc = isContent ? buildHeadDoc(tab.doc.document, fm) : tab.doc.document;
  const applyMutation = isContent
    ? (fn: (doc: JxMutableNode) => void) => applyContentMutation(render, fn)
    : (fn: (doc: JxMutableNode) => void) => {
        transact(activeTab.value, fn);
      };

  // ONE call. The old pair of surfaces made two, with two different reserved-key policies.
  const { collection, fields, requiredFields } = collectFmFields(
    tab,
    projectState?.projectConfig,
    RESERVED_FM_KEYS,
  );

  const route = tab.documentPath ? pageRoute(tab.documentPath) : null;
  const title = typeof headDoc.title === "string" ? headDoc.title : "";
  const head = headDoc.$head ?? [];

  return html`
    <section
      class="doc-header"
      aria-label="Document header"
      data-jx-region="pane.primary/frontmatter"
    >
      <header class="doc-header-bar">
        <span class="doc-header-title">${collection ? collection.name : "Document"}</span>
        ${
          route === null
            ? nothing
            : html`<code class="doc-header-route" title="This page's route">${route}</code>`
        }
      </header>
      <div class="doc-header-body">
        ${renderFieldRow({
          hasValue: Boolean(title),
          label: "Title",
          onClear: () =>
            applyMutation((d) => {
              delete d.title;
            }),
          prop: "title",
          widget: spTextField(
            "doc-header:title",
            title,
            (v: string) =>
              applyMutation((d) => {
                const val = v.trim();
                if (val) {
                  d.title = val;
                } else {
                  delete d.title;
                }
              }),
            { placeholder: "Untitled" },
          ),
        })}
        ${isPageDocument() ? renderLayoutPickerRow(headDoc, applyMutation) : nothing}
        ${fields.map((f) => renderFmField(f.field, f.entry, f.value, requiredFields))}
      </div>
      ${disclosure(tab.id, _seoOpen, "SEO", seoBody(head, applyMutation))}
      ${disclosure(tab.id, _rawOpen, "Raw head tags", rawHeadBody(head))}
    </section>
  `;
}

/**
 * A collapsible block whose open state is per tab and lives in this module.
 *
 * Deliberately NOT on `tab.session.ui`: P3's first workstream is hoisting view flags OUT of the tab
 * record, and adding two more would be moving in the wrong direction for a disclosure nobody needs
 * restored across a relaunch.
 */
function disclosure(
  tabId: string,
  open: Set<string>,
  label: string,
  body: TemplateResult,
): TemplateResult {
  const isOpen = open.has(tabId);
  return html`
    <details
      class="doc-header-disclosure"
      ?open=${isOpen}
      @toggle=${(e: Event) => {
        const el = e.target as HTMLDetailsElement;
        if (el.open) {
          open.add(tabId);
        } else {
          open.delete(tabId);
        }
      }}
    >
      <summary>${label}</summary>
      <div class="doc-header-body">${body}</div>
    </details>
  `;
}

/** Description, viewport, favicon and the OpenGraph card, from head-panel's field definitions. */
function seoBody(
  head: JxHeadEntry[],
  applyMutation: (fn: (doc: JxMutableNode) => void) => void,
): TemplateResult {
  const iconHref = String(findLinkEntry(head, "icon")?.attributes?.href ?? "");
  return html`
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
    ${OG_FIELDS.map((field) => renderMetaFieldRow(field, head, applyMutation))}
  `;
}

/**
 * The `$head` entries no structured control owns, listed read-only.
 *
 * Read-only on purpose: the card discloses what is there so the author is never surprised by a tag
 * they cannot see, and the Page panel remains the surface that adds and removes them.
 */
function rawHeadBody(head: JxHeadEntry[]): TemplateResult {
  const custom = head.filter(
    (e: JxHeadEntry) => !isManagedEntry(e) && !isGoogleFontEntry(e) && !isGoogleFontPreconnect(e),
  );
  if (custom.length === 0) {
    return html`<p class="doc-header-empty">No custom head tags on this document.</p>`;
  }
  return html`
    <ul class="doc-header-raw">
      ${custom.map(
        (entry) => html`
          <li>
            <code>${entryLabel(entry)}</code>
            <span title=${entryValue(entry)}>${entryValue(entry)}</span>
          </li>
        `,
      )}
    </ul>
  `;
}
