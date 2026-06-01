/**
 * Head editor — structured form for managing $head entries (link, meta, script, style tags) with
 * Monaco editor for script/style bodies. Also manages project-level Google Fonts.
 */

import { html, render as litRender, nothing } from "lit-html";
import { projectState } from "../store";
import { updateSiteConfig } from "../site-context";
import {
  isGoogleFontEntry,
  extractFontFamily,
  buildGoogleFontUrl,
  ensureGoogleFontPreconnects,
  cleanupGoogleFontPreconnects,
} from "../utils/google-fonts";

import type { JxHeadEntry, ProjectConfig } from "@jxsuite/schema/types";

/** @param {HTMLElement} container */
export function renderHeadEditor(container: HTMLElement) {
  const config = (projectState?.projectConfig || {}) as ProjectConfig;
  const headEntries = config.$head || ([] as JxHeadEntry[]);

  const save = () => {
    updateSiteConfig({ $head: headEntries });
  };

  const addEntry = (tag: string) => {
    const attrs: Record<string, string | boolean> = {};
    const entry: JxHeadEntry = { tagName: tag, attributes: attrs };
    if (tag === "link") {
      attrs.rel = "stylesheet";
      attrs.href = "";
    } else if (tag === "meta") {
      attrs.name = "";
      attrs.content = "";
    } else if (tag === "script") {
      attrs.src = "";
    } else if (tag === "style") {
      entry.textContent = "";
    }
    headEntries.push(entry);
    save();
    renderHeadEditor(container);
  };

  const removeEntry = (idx: number) => {
    headEntries.splice(idx, 1);
    save();
    renderHeadEditor(container);
  };

  const updateEntry = (idx: number, key: string, val: string) => {
    const entry = headEntries[idx];
    if (key === "content" && (entry.tagName === "script" || entry.tagName === "style")) {
      entry.textContent = val;
    } else {
      if (!entry.attributes) entry.attributes = {};
      entry.attributes[key] = val;
    }
    save();
  };

  const tpl = html`
    <div class="settings-section">
      <h3 class="settings-section-title">Google Fonts</h3>
      <p class="settings-field-desc">
        Manage Google Fonts imported across all pages in this project.
      </p>
      ${renderGoogleFontsSection(headEntries, save, () => renderHeadEditor(container))}
    </div>

    <div class="settings-section">
      <h3 class="settings-section-title">Head</h3>
      <p class="settings-field-desc">
        Manage global &lt;head&gt; tags — stylesheets, meta tags, scripts, and inline styles.
      </p>

      <div class="head-entries">
        ${headEntries.map(
          (entry: JxHeadEntry, idx: number) => html`
            <div class="head-entry">
              <div class="head-entry-header">
                <span class="head-entry-tag">&lt;${entry.tagName}&gt;</span>
                <sp-action-button quiet size="s" @click=${() => removeEntry(idx)}>
                  <sp-icon-delete slot="icon"></sp-icon-delete>
                </sp-action-button>
              </div>
              <div class="head-entry-fields">${renderEntryFields(entry, idx, updateEntry)}</div>
            </div>
          `,
        )}
      </div>

      <div class="head-add-actions" style="margin-top:12px;display:flex;gap:8px">
        <sp-action-button size="s" @click=${() => addEntry("link")}> + Link </sp-action-button>
        <sp-action-button size="s" @click=${() => addEntry("meta")}> + Meta </sp-action-button>
        <sp-action-button size="s" @click=${() => addEntry("script")}> + Script </sp-action-button>
        <sp-action-button size="s" @click=${() => addEntry("style")}> + Style </sp-action-button>
      </div>
    </div>
  `;

  litRender(tpl, container);
}

/**
 * @param {JxHeadEntry} entry
 * @param {number} idx
 * @param {(idx: number, key: string, val: string) => void} updateEntry
 */
function renderEntryFields(
  entry: JxHeadEntry,
  idx: number,
  updateEntry: (idx: number, key: string, val: string) => void,
) {
  let debounce: ReturnType<typeof setTimeout> | undefined;
  const onFieldChange = (key: string) => (e: Event) => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      updateEntry(idx, key, (e.target as HTMLInputElement).value);
    }, 300);
  };

  const attrs = entry.attributes || {};

  switch (entry.tagName) {
    case "link":
      return html`
        <div class="settings-field-row">
          <sp-textfield
            size="s"
            label="rel"
            .value=${attrs.rel || ""}
            @change=${onFieldChange("rel")}
          ></sp-textfield>
          <sp-textfield
            size="s"
            label="href"
            .value=${attrs.href || ""}
            @change=${onFieldChange("href")}
            style="flex:1"
          ></sp-textfield>
        </div>
      `;
    case "meta":
      return html`
        <div class="settings-field-row">
          <sp-textfield
            size="s"
            label="name"
            .value=${attrs.name || ""}
            @change=${onFieldChange("name")}
          ></sp-textfield>
          <sp-textfield
            size="s"
            label="content"
            .value=${attrs.content || ""}
            @change=${onFieldChange("content")}
            style="flex:1"
          ></sp-textfield>
        </div>
      `;
    case "script":
      return html`
        <div class="settings-field-row">
          <sp-textfield
            size="s"
            label="src"
            .value=${attrs.src || ""}
            @change=${onFieldChange("src")}
            placeholder="URL or leave empty for inline"
            style="flex:1"
          ></sp-textfield>
        </div>
        ${!attrs.src
          ? html`
              <div class="head-entry-body">
                <label class="settings-field-label">Script body</label>
                <textarea
                  class="head-code-editor"
                  .value=${entry.textContent || ""}
                  @input=${onFieldChange("content")}
                  rows="6"
                  spellcheck="false"
                ></textarea>
              </div>
            `
          : nothing}
      `;
    case "style":
      return html`
        <div class="head-entry-body">
          <label class="settings-field-label">Style body</label>
          <textarea
            class="head-code-editor"
            .value=${entry.textContent || ""}
            @input=${onFieldChange("content")}
            rows="8"
            spellcheck="false"
          ></textarea>
        </div>
      `;
    default:
      return nothing;
  }
}

/**
 * Render the Google Fonts management section.
 *
 * @param {JxHeadEntry[]} headEntries
 * @param {() => void} save
 * @param {() => void} rerender
 */
function renderGoogleFontsSection(
  headEntries: JxHeadEntry[],
  save: () => void,
  rerender: () => void,
) {
  const fontEntries = headEntries.filter((e) => isGoogleFontEntry(e));

  const addFont = (family: string) => {
    ensureGoogleFontPreconnects(headEntries);
    headEntries.push({
      tagName: "link",
      attributes: { rel: "stylesheet", href: buildGoogleFontUrl(family) },
    });
    save();
    rerender();
  };

  const removeFont = (entry: JxHeadEntry) => {
    const idx = headEntries.indexOf(entry);
    if (idx >= 0) headEntries.splice(idx, 1);
    const cleaned = cleanupGoogleFontPreconnects(headEntries);
    if (cleaned !== headEntries) {
      headEntries.length = 0;
      headEntries.push(...cleaned);
    }
    save();
    rerender();
  };

  return html`
    <div class="head-entries" style="margin-bottom:12px">
      ${fontEntries.length > 0
        ? fontEntries.map(
            (entry) => html`
              <div class="head-entry" style="flex-direction:row;align-items:center;gap:8px">
                <span style="flex:1"
                  >${extractFontFamily(String(entry.attributes?.href || ""))}</span
                >
                <sp-action-button quiet size="s" @click=${() => removeFont(entry)}>
                  <sp-icon-delete slot="icon"></sp-icon-delete>
                </sp-action-button>
              </div>
            `,
          )
        : html`<p class="settings-field-desc" style="margin:0">No fonts imported.</p>`}
    </div>
    <div style="display:flex;gap:8px;align-items:center">
      <sp-textfield
        size="s"
        placeholder="Font family name…"
        style="flex:1"
        @keydown=${(e: KeyboardEvent) => {
          if (e.key !== "Enter") return;
          const family = (e.target as HTMLInputElement).value?.trim();
          if (!family) return;
          (e.target as HTMLInputElement).value = "";
          addFont(family);
        }}
      ></sp-textfield>
      <sp-action-button
        size="s"
        @click=${(e: MouseEvent) => {
          const input = (e.target as HTMLElement).closest("div")?.querySelector("sp-textfield");
          const family = (input as HTMLInputElement | null)?.value?.trim();
          if (!family) return;
          (input as HTMLInputElement).value = "";
          addFont(family);
        }}
      >
        + Add
      </sp-action-button>
    </div>
  `;
}
