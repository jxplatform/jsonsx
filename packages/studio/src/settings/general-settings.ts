/// <reference lib="dom" />
/**
 * Overview — the project's identity: name, description, production URL, favicon, global styles.
 *
 * It has lost a field twice for the same reason. Breakpoints were one of **four** places `$media`
 * could be defined (plan §4.2) and this was the only one that named them; they live in Contexts
 * now, beside the colour schemes and feature queries they share a map with. The platform adapter
 * has moved to Deploy in P6.2, because §2 principle 5 says a definition site is a LEVEL, not a
 * field on some other level's form — and "what this site is" and "where it ships" are two levels.
 */

import { html, render as litRender, nothing } from "lit-html";
import { live } from "lit-html/directives/live.js";
import { errorMessage } from "@jxsuite/schema/parse";
import { projectState, updateUi } from "../store";
import { updateSiteConfig } from "../site-context";
import { tabOfContainer } from "../canvas/canvas-surface";
import { getPlatform } from "../platform";

import type { JxHeadEntry, ProjectConfig } from "@jxsuite/schema/types";

/** Which control an error belongs under. `"section"` puts it at the top of the section. */
type ErrorField = "name" | "description" | "url" | "favicon" | "section";

interface GeneralError {
  field: ErrorField;
  message: string;
}

/**
 * The last failed write, per rendered section.
 *
 * A `project.json` write can fail — the disk is full, the file is read-only, the desktop RPC is
 * gone — and every other settings editor in the tree drops that rejection on the floor with a bare
 * `void updateSiteConfig(...)`, so the field silently snaps back to its old value. Every write in
 * this section goes through {@link persist} instead, which parks the failure here and re-renders so
 * the user sees it. Keyed by container so two mounted copies (and two tests) never share a
 * message.
 */
const errors = new WeakMap<HTMLElement, GeneralError>();

// ─── Site description ($head meta) ───────────────────────────────────────────

/** True for the `<meta name="description">` entry the site description lives in. */
function isDescriptionMeta(entry: JxHeadEntry): boolean {
  return entry.tagName === "meta" && entry.attributes?.name === "description";
}

/**
 * The site description. It is not a top-level `project.json` key — the composed project schema is
 * closed (`unevaluatedProperties: false`) — so it lives where `@jxsuite/create` writes it and where
 * the browser reads it: the `<meta name="description">` entry of `$head`.
 */
function readDescription(config: ProjectConfig): string {
  const entry = (config.$head ?? []).find((e) => isDescriptionMeta(e));
  return typeof entry?.attributes?.content === "string" ? entry.attributes.content : "";
}

/** `$head` with the description meta upserted (or dropped, when cleared). */
function headWithDescription(head: JxHeadEntry[], text: string): JxHeadEntry[] {
  const trimmed = text.trim();
  if (!head.some((e) => isDescriptionMeta(e))) {
    return trimmed
      ? [...head, { attributes: { content: trimmed, name: "description" }, tagName: "meta" }]
      : [...head];
  }
  if (!trimmed) {
    return head.filter((entry) => !isDescriptionMeta(entry));
  }
  return head.map((entry) =>
    isDescriptionMeta(entry)
      ? { ...entry, attributes: { ...entry.attributes, content: trimmed } }
      : entry,
  );
}

/**
 * The patch that _removes_ `url`. `undefined` survives the object spread inside `updateSiteConfig`
 * and `JSON.stringify` then drops the key, so clearing the field clears the setting instead of
 * persisting an empty string the build would have to special-case (`site-build.ts` gates the
 * sitemap on `Boolean(url)` but still forwards `""` into the render context). The cast is the price
 * of `exactOptionalPropertyTypes` — `ProjectConfig["url"]` is `string`, never `string |
 * undefined`.
 */
const CLEAR_URL = { url: undefined } as unknown as Partial<ProjectConfig>;

// ─── Render ──────────────────────────────────────────────────────────────────

/** @param {HTMLElement} container */
export function renderGeneralSettings(container: HTMLElement) {
  const config = (projectState?.projectConfig || {}) as ProjectConfig;
  const shown = errors.get(container);

  /** Persist a patch, surfacing the rejection instead of swallowing it. */
  const persist = async (patch: Partial<ProjectConfig>, field: ErrorField = "section") => {
    try {
      await updateSiteConfig(patch);
      errors.delete(container);
    } catch (error) {
      errors.set(container, {
        field,
        message: `Could not save project.json — ${errorMessage(error)}`,
      });
    }
    renderGeneralSettings(container);
  };

  /** Park a validation failure under `field` without writing anything. */
  const reject = (field: ErrorField, message: string) => {
    errors.set(container, { field, message });
    renderGeneralSettings(container);
  };

  /** The error line for one control, if that is where the current failure belongs. */
  const errorFor = (field: ErrorField) =>
    shown?.field === field
      ? html`<p class="settings-field-error" role="alert">${shown.message}</p>`
      : nothing;

  // ─── Site identity ─────────────────────────────────────────────────────────

  const onNameChange = (e: Event) => {
    const name = (e.target as HTMLInputElement).value.trim();
    if (!name) {
      reject("name", "A project name is required.");
      return;
    }
    void persist({ name }, "name");
  };

  const onDescriptionChange = (e: Event) => {
    const text = (e.target as HTMLInputElement).value;
    void persist({ $head: headWithDescription(config.$head ?? [], text) }, "description");
  };

  const onUrlChange = (e: Event) => {
    const url = (e.target as HTMLInputElement).value.trim();
    if (url && !/^https?:\/\/\S+$/.test(url)) {
      reject("url", "Enter a full address starting with http:// or https://");
      return;
    }
    void persist(url ? { url } : CLEAR_URL, "url");
  };

  // ─── Favicon ───────────────────────────────────────────────────────────────

  const onFaviconUpload = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*,.ico,.svg";
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) {
        return;
      }
      try {
        await getPlatform().uploadFile("public/favicon.ico", file);
      } catch (error) {
        reject("favicon", `Could not upload the favicon — ${errorMessage(error)}`);
        return;
      }
      await persist({ favicon: "/favicon.ico" }, "favicon");
    });
    input.click();
  };

  /*
   * Project Styles is the SAME document in a different editor, so this is a mode switch rather
   * than a navigation. The predecessor closed the settings modal and opened `project.json` in a
   * tab — the configuration IA jumping into the document IA, plan §9.3's own example of the split
   * P6 removes. Nothing closes now, because nothing was covering anything.
   */
  const onEditGlobalStyles = () => {
    // THIS pane's tab. The Project Settings editor is stage content, so a settings document
    // Open in the side pane used to send the PRIMARY into the Stylebook.
    updateUi(tabOfContainer(container), "canvasMode", "stylebook");
  };

  const currentFavicon = config.favicon;

  const tpl = html`
    <div class="settings-section">
      <h3 class="settings-section-title">Overview</h3>
      ${errorFor("section")}

      <div class="settings-field">
        <label class="settings-field-label">Site Name</label>
        <p class="settings-field-desc">
          What this site is called — used in page titles and the project list.
        </p>
        <sp-textfield
          size="s"
          class="settings-site-name"
          placeholder="My Site"
          .value=${live(config.name ?? "")}
          ?invalid=${shown?.field === "name"}
          @change=${onNameChange}
        ></sp-textfield>
        ${errorFor("name")}
      </div>

      <div class="settings-field">
        <label class="settings-field-label">Description</label>
        <p class="settings-field-desc">
          One or two sentences about the site. Search engines and link previews show this.
        </p>
        <sp-textfield
          multiline
          size="s"
          class="settings-site-description"
          placeholder="A short description of the site"
          .value=${live(readDescription(config))}
          @change=${onDescriptionChange}
        ></sp-textfield>
        ${errorFor("description")}
      </div>

      <div class="settings-field">
        <label class="settings-field-label">Production URL</label>
        <p class="settings-field-desc">
          Where the published site lives. Sitemaps and absolute links are built from it.
        </p>
        <sp-textfield
          size="s"
          class="settings-site-url"
          placeholder="https://example.com"
          .value=${live(config.url ?? "")}
          ?invalid=${shown?.field === "url"}
          @change=${onUrlChange}
        ></sp-textfield>
        ${errorFor("url")}
      </div>

      <div class="settings-field">
        <label class="settings-field-label">Favicon</label>
        <p class="settings-field-desc">Upload an image to use as the site favicon.</p>
        <div style="display:flex;align-items:center;gap:12px">
          ${
            currentFavicon
              ? html`<img
                  src=${currentFavicon}
                  alt="Current favicon"
                  style="width:32px;height:32px;object-fit:contain;border:1px solid var(--border);border-radius:var(--radius);padding:2px"
                />`
              : html`<div
                  style="width:32px;height:32px;border:1px dashed var(--border);border-radius:var(--radius);display:flex;align-items:center;justify-content:center;color:var(--fg-dim);font-size:var(--spectrum-font-size-50, 11px)"
                >
                  —
                </div>`
          }
          <sp-action-button size="s" @click=${onFaviconUpload}> Upload Favicon </sp-action-button>
          ${
            currentFavicon
              ? html`<span style="font-size:var(--spectrum-font-size-50, 11px);color:var(--fg-dim)"
                  >${currentFavicon}</span
                >`
              : nothing
          }
        </div>
        ${errorFor("favicon")}
      </div>

      <div class="settings-field">
        <label class="settings-field-label">Global Styles</label>
        <p class="settings-field-desc">
          Design tokens and the default element styles that apply across every page. Opens Project
          Styles over this same document.
        </p>
        <sp-action-button size="s" @click=${onEditGlobalStyles}>
          Edit Global Styles
        </sp-action-button>
      </div>
    </div>
  `;

  litRender(tpl, container);
}
