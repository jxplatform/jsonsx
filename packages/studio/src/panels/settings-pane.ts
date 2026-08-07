/// <reference lib="dom" />
/**
 * The Project Settings editor, drawn inside the pane — the stage, not an overlay.
 *
 * Two columns: the section list (inner nav) and the section body. It is deliberately the same
 * two-column shape the modal had, because the modal's IA was never the problem — its MODALITY was.
 * Moving the identical layout into `#canvas-wrap` is what makes the seven screenshot crops change
 * frame (`overlay.dialog:settings` → `pane.primary`) without one manifest STEP changing, which is
 * §13.7's proof that the command boundary was drawn in the right place.
 *
 * Mounting follows `grid/grid-panel.ts`: `canvas/canvas-render.ts` calls {@link renderSettingsPane}
 * when the tab enters this mode, and this module owns its reactivity from there — a subscription to
 * the section registry and to the chosen section, so an extension's section appearing a tick later
 * redraws the nav without the canvas being re-rendered.
 *
 * **It imports the registry, never the sections.** `canvas-render.ts` reaches this module, so
 * anything it imports joins the canvas's import graph; the section RENDERERS are registered by
 * `settings/settings-document.ts`, which the app loads when it registers its commands.
 *
 * Nothing here is stamped with a region of its own. `#canvas-wrap` already carries `pane.primary`
 * (`ui/regions.ts`'s `SHELL_REGION_HOSTS`), the entry rows and the entry editor are stamped by
 * `settings/contributed-section.ts` as `pane.primary/entry:<key>` and `pane.primary/editor`, and a
 * third id for "the settings body" would be a hand-stamped region with nothing to say.
 *
 * @docs studio/projects/settings
 */

import { html, render as litRender } from "lit-html";
import { classMap } from "lit-html/directives/class-map.js";
import { ref } from "lit-html/directives/ref.js";
import {
  onSettingsDocumentChanged,
  settingsSection,
  settingsDocumentSection,
  setSettingsSection,
  sortedSettingsSections,
} from "../settings/section-registry";
import type { CanvasSurface } from "../canvas/canvas-surface";

/**
 * One mounted editor per PANE.
 *
 * `config` is a kind the side pane may host, so the previous single `_host` had both panes' stages
 * competing for it: `settingsPaneMounted` answered false for whichever host lost, and that pane's
 * fast path rebuilt the whole section body on every render — throwing away an open inline form
 * mid-keystroke, which is the exact failure the idempotence was written to prevent.
 */
interface ActiveSettingsPane {
  host: HTMLElement;
  /** The section body container, handed to whichever section renderer is current. */
  body: HTMLElement | null;
  /** The section the body currently holds, so an idle re-render does not rebuild it. */
  rendered: string | null;
  /** Unsubscribe from the document's change notifications. */
  off: (() => void) | null;
}

const _active = new Map<string, ActiveSettingsPane>();

/**
 * Mount (or refresh) the settings editor inside the pane.
 *
 * Idempotent for the same host: canvas-render calls this on every render for this mode, and
 * rebuilding the section body on each one would throw away an open inline form mid-keystroke.
 *
 * @param {CanvasSurface} surface - The pane whose stage hosts the editor
 */
export function renderSettingsPane(surface: CanvasSurface): void {
  const { paneId, wrap: host } = surface;
  let panel = _active.get(paneId);
  if (panel?.host !== host) {
    detachSettingsPane(paneId);
    panel = {
      body: null,
      host,
      off: onSettingsDocumentChanged(() => draw(paneId, true)),
      rendered: null,
    };
    _active.set(paneId, panel);
  }
  draw(paneId, false);
}

/** Tear one pane's editor down — the mode-change and project-close path. */
export function detachSettingsPane(paneId: string): void {
  const panel = _active.get(paneId);
  if (!panel) {
    return;
  }
  panel.off?.();
  _active.delete(paneId);
}

/**
 * Whether the editor is mounted on this pane's stage — canvas-render's "did I already build this".
 *
 * @param {CanvasSurface} surface
 * @returns {boolean}
 */
export function settingsPaneMounted(surface: CanvasSurface): boolean {
  return _active.get(surface.paneId)?.host === surface.wrap;
}

/**
 * Draw the nav, then the body.
 *
 * @param {boolean} force - Re-run the section renderer even when the section has not changed. True
 *   for a real state change (a nav click, a section registering, an entry being selected by
 *   command); false for canvas-render's idempotent remount.
 */
function draw(paneId: string, force: boolean): void {
  const panel = _active.get(paneId);
  if (!panel) {
    return;
  }
  const active = settingsDocumentSection();
  const sections = sortedSettingsSections();

  const tpl = html`
    <div class="settings-doc">
      <nav class="settings-doc-nav" aria-label="Project Settings sections">
        ${sections.map(
          (section) => html`
            <button
              class=${classMap({
                active: active === section.key,
                "settings-nav-item": true,
              })}
              aria-current=${active === section.key ? "page" : "false"}
              @click=${() => setSettingsSection(section.key)}
            >
              ${section.label}
            </button>
          `,
        )}
      </nav>
      <div
        class="settings-doc-content"
        ${ref((el: Element | undefined) => {
          const next = (el as HTMLElement | undefined) ?? null;
          if (next !== panel.body) {
            panel.body = next;
            panel.rendered = null;
          }
        })}
      ></div>
    </div>
  `;

  litRender(tpl, panel.host);

  if (!panel.body || (!force && panel.rendered === active)) {
    return;
  }
  panel.rendered = active;
  const section = settingsSection(active);
  if (section) {
    section.render(panel.body);
    return;
  }
  /* Every section unregistered at once — a project closing while the editor is open. A blank
     content area beside a nav reads as a broken pane, so it says which it is. */
  litRender(html`<div class="settings-empty-state">No settings sections.</div>`, panel.body);
}
