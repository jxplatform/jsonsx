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

/** The mounted host, or null when the settings editor is not on screen. */
let _host: HTMLElement | null = null;

/** The section body container, handed to whichever section renderer is current. */
let _body: HTMLElement | null = null;

/** The section the body currently holds, so an idle re-render does not rebuild it. */
let _rendered: string | null = null;

/** Unsubscribe from the document's change notifications. */
let _off: (() => void) | null = null;

/**
 * Mount (or refresh) the settings editor inside the pane.
 *
 * Idempotent for the same host: canvas-render calls this on every render for this mode, and
 * rebuilding the section body on each one would throw away an open inline form mid-keystroke.
 *
 * @param {HTMLElement} host - The pane's canvas host (`#canvas-wrap`)
 */
export function renderSettingsPane(host: HTMLElement): void {
  if (_host !== host) {
    detachSettingsPane();
    _host = host;
    _off = onSettingsDocumentChanged(() => draw(true));
  }
  draw(false);
}

/** Tear the editor down — the mode-change and project-close path. */
export function detachSettingsPane(): void {
  _off?.();
  _off = null;
  _host = null;
  _body = null;
  _rendered = null;
}

/**
 * Whether the editor is mounted on this host — canvas-render's "did I already build this".
 *
 * @param {HTMLElement} host
 * @returns {boolean}
 */
export function settingsPaneMounted(host: HTMLElement): boolean {
  return _host === host;
}

/**
 * Draw the nav, then the body.
 *
 * @param {boolean} force - Re-run the section renderer even when the section has not changed. True
 *   for a real state change (a nav click, a section registering, an entry being selected by
 *   command); false for canvas-render's idempotent remount.
 */
function draw(force: boolean): void {
  if (!_host) {
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
          if (next !== _body) {
            _body = next;
            _rendered = null;
          }
        })}
      ></div>
    </div>
  `;

  litRender(tpl, _host);

  if (!_body || (!force && _rendered === active)) {
    return;
  }
  _rendered = active;
  const section = settingsSection(active);
  if (section) {
    section.render(_body);
    return;
  }
  /* Every section unregistered at once — a project closing while the editor is open. A blank
     content area beside a nav reads as a broken pane, so it says which it is. */
  litRender(html`<div class="settings-empty-state">No settings sections.</div>`, _body);
}
