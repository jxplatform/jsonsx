/// <reference lib="dom" />
/**
 * The two Project Settings sections the document adds directly — Deploy and Raw JSON.
 *
 * They live together because each is a small, direct view of ONE `project.json` key and neither
 * owns a dialog, a picker or a schema form: `build.adapter` (one enum), and the file itself.
 *
 * **Extensions used to be the third.** It was a free-text field over the `extensions` array, which
 * wrote `project.json` and nothing else — so a name that was not installed produced a project that
 * failed to build. It now needs a catalogue, a package list and an install path, which is more than
 * "a direct view of one key", and it lives in `./extensions-section.ts`. What stayed behind is the
 * error plumbing both still share.
 *
 * **Raw JSON does not open a second editor.** It shows what is on disk and hands the author to the
 * Code editor over the SAME tab — one document, three editors (§9.3), so switching to the text and
 * back keeps one undo stack instead of forking two.
 *
 * @docs studio/projects/settings
 */

import { html, render as litRender, nothing } from "lit-html";
import { errorMessage } from "@jxsuite/schema/parse";
import { projectState, updateUi } from "../store";
import { serializeProjectConfig } from "../tabs/project-config";
import { tabOfContainer } from "../canvas/canvas-surface";
import { updateSiteConfig } from "../site-context";

import type { ProjectConfig } from "@jxsuite/schema/types";

/** The mode the Code editor draws under — `tabs/tab.ts`'s `EDITOR_KIND_BY_MODE` maps it to `code`. */
const CODE_MODE = "source";

/**
 * The last failed write per rendered section container.
 *
 * Keyed by container so two mounted copies (and two tests) never share a message — the same shape
 * `general-settings.ts` uses, and for the same reason: these sections save on change, so a silent
 * rejection would read as "my edit just vanished".
 */
const errors = new WeakMap<HTMLElement, string>();

/** Drop a parked error and re-render. */
function clearError(container: HTMLElement): void {
  errors.delete(container);
}

/** The error line for a section, if its last write failed. */
export function errorLine(container: HTMLElement) {
  const message = errors.get(container);
  return message === undefined
    ? nothing
    : html`<p class="settings-field-error" role="alert">${message}</p>`;
}

/**
 * Persist a patch, surfacing the rejection instead of swallowing it.
 *
 * `updateSiteConfig` rejects on a failed write and the chokepoint has already filed the Problem, so
 * all that is left here is to keep the form honest about what is on disk.
 *
 * @param {HTMLElement} container
 * @param {Partial<ProjectConfig>} patch
 * @param {() => void} rerender
 */
async function persist(
  container: HTMLElement,
  patch: Partial<ProjectConfig>,
  rerender: () => void,
): Promise<void> {
  try {
    await updateSiteConfig(patch);
    clearError(container);
  } catch (error) {
    errors.set(container, `Could not save project.json — ${errorMessage(error)}`);
  }
  rerender();
}

/** The live project configuration, or an empty one before a project is open. */
function config(): ProjectConfig {
  return (projectState?.projectConfig ?? {}) as ProjectConfig;
}

// ─── Deploy ───────────────────────────────────────────────────────────────────

/** The build adapters `@jxsuite/compiler` ships. One enumeration, shared with New Project. */
export const BUILD_ADAPTERS: readonly { value: string; label: string }[] = [
  { label: "Static", value: "static" },
  { label: "Bun", value: "bun" },
  { label: "Node", value: "node" },
  { label: "Cloudflare Workers", value: "cloudflare-workers" },
  { label: "Cloudflare Pages", value: "cloudflare-pages" },
];

/**
 * Where the project is built for, and what it is built with.
 *
 * The adapter moved off Overview: Overview says what the site IS, and the adapter is a fact about
 * where it SHIPS — the same split §2 principle 5 applies to Contexts.
 *
 * @param {HTMLElement} container
 */
export function renderDeploySection(container: HTMLElement): void {
  const rerender = () => renderDeploySection(container);
  const current = config().build?.adapter || "static";

  const onAdapterChange = (e: Event) => {
    void persist(
      container,
      { build: { ...config().build, adapter: (e.target as HTMLInputElement).value } },
      rerender,
    );
  };

  const tpl = html`
    <div class="settings-section">
      <h3 class="settings-section-title">Deploy</h3>
      ${errorLine(container)}
      <div class="settings-field">
        <label class="settings-field-label">Platform Adapter</label>
        <p class="settings-field-desc">
          What the site is built for. Static writes plain files; the others emit a server entry for
          that runtime.
        </p>
        <sp-picker
          size="s"
          label="Platform Adapter"
          class="settings-build-adapter"
          .value=${current}
          @change=${onAdapterChange}
        >
          ${BUILD_ADAPTERS.map(
            (adapter) => html`<sp-menu-item value=${adapter.value}>${adapter.label}</sp-menu-item>`,
          )}
        </sp-picker>
      </div>
    </div>
  `;

  litRender(tpl, container);
}

// ─── Raw JSON ─────────────────────────────────────────────────────────────────

/**
 * `project.json` as it is written, and the way into editing it as text.
 *
 * The serialisation is the chokepoint's own (`serializeProjectConfig`), so what this shows is what
 * a save writes — not a second pretty-printer that would disagree with the file by an indent.
 *
 * @param {HTMLElement} container
 */
export function renderRawJsonSection(container: HTMLElement): void {
  const tpl = html`
    <div class="settings-section">
      <h3 class="settings-section-title">Raw JSON</h3>
      <p class="settings-field-desc">
        The whole of <code>project.json</code>, as it is saved. Editing it as code opens the same
        document in the Code editor — one undo stack, one dirty flag.
      </p>
      <pre class="settings-raw-json">${serializeProjectConfig(config())}</pre>
      <sp-action-button
        size="s"
        class="settings-edit-as-code"
        @click=${() => updateUi(tabOfContainer(container), "canvasMode", CODE_MODE)}
      >
        Edit as code
      </sp-action-button>
    </div>
  `;

  litRender(tpl, container);
}
