/// <reference lib="dom" />
/**
 * Frontmatter-panel.ts — Obsidian-style "Properties" panel above the canvas.
 *
 * Shown only when the active tab is a content-collection document (matched via
 * `findContentTypeSchema`) in content mode with the effective canvas mode "edit". The fields sit
 * inside a single collapsible accordion item so the panel can be dismissed to a slim header bar;
 * the expanded/collapsed state persists per tab (`tab.session.ui.frontmatterOpen`).
 *
 * Unlike the Document-tab section (head-panel), no keys are reserved here — `title` renders as a
 * regular property, matching Obsidian.
 */

import { html, nothing, render as litRender } from "lit-html";
import { frontmatterPanelEl, projectState } from "../store";
import { activeTab } from "../workspace/workspace";
import { effect, effectScope } from "../reactivity";
import { createPanelScheduler } from "./panel-scheduler";
import { collectFmFields, renderFmField } from "./frontmatter-fields";

import type { PanelScheduler } from "./panel-scheduler";

interface FrontmatterPanelCtx {
  /** Effective canvas mode (composes the base mode with the preview toggle). */
  getCanvasMode: () => string;
}

const NO_RESERVED_KEYS = new Set<string>();

let _ctx: FrontmatterPanelCtx | null = null;
let _scheduler: PanelScheduler | null = null;
let _scope: { stop: () => void; run: <T>(fn: () => T) => T | undefined } | null = null;

/**
 * Mount the frontmatter panel: bind the focus-aware scheduler to the shell host and re-render
 * reactively on tab/mode/frontmatter changes.
 *
 * @param {FrontmatterPanelCtx} ctx
 */
export function mount(ctx: FrontmatterPanelCtx) {
  if (!frontmatterPanelEl) {
    return;
  }
  _ctx = ctx;
  _scheduler = createPanelScheduler({ render: _doRender, root: frontmatterPanelEl });
  _scheduler.bindFocus();
  _scope = effectScope();
  _scope.run(() => {
    effect(() => {
      const tab = activeTab.value;
      if (tab) {
        // Track everything the panel reads: mode/ui flags plus the frontmatter object itself AND
        // Its entries — field commits mutate keys in place while the source-mode round-trip swaps
        // The whole object; both must re-fire this effect.
        void tab.doc.mode;
        void tab.session.ui.canvasMode;
        void tab.session.ui.preview;
        void tab.session.ui.frontmatterOpen;
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
  _ctx = null;
  _scheduler?.unbind();
  _scheduler = null;
}

/**
 * Request a render. Coalesced and deferred while a text input in the panel is focused, so
 * re-renders never clobber a field mid-edit.
 */
export function render() {
  _scheduler?.schedule();
}

function _doRender() {
  if (!_ctx || !frontmatterPanelEl) {
    return;
  }

  const tab = activeTab.value;
  const eligible = Boolean(
    tab && tab.doc.mode === "content" && _ctx.getCanvasMode() === "edit" && tab.documentPath,
  );
  const fieldSet = eligible
    ? collectFmFields(tab!, projectState?.projectConfig, NO_RESERVED_KEYS)
    : null;

  if (!fieldSet?.collection) {
    // Lit leaves comment markers, so the host is hidden explicitly rather than relying on :empty.
    litRender(nothing, frontmatterPanelEl);
    frontmatterPanelEl.hidden = true;
    return;
  }

  const { collection, fields, requiredFields } = fieldSet;
  const open = tab!.session.ui.frontmatterOpen !== false;

  litRender(
    html`
      <sp-accordion size="s">
        <sp-accordion-item
          label="Properties · ${collection.name}"
          ?open=${open}
          @sp-accordion-item-toggle=${(e: Event) => {
            const t = activeTab.value;
            if (t) {
              t.session.ui.frontmatterOpen = (e.target as HTMLElement & { open: boolean }).open;
            }
          }}
        >
          <div class="fm-panel-body">
            ${fields.map((f) => renderFmField(f.field, f.entry, f.value, requiredFields))}
          </div>
        </sp-accordion-item>
      </sp-accordion>
    `,
    frontmatterPanelEl,
  );
  frontmatterPanelEl.hidden = false;
}
