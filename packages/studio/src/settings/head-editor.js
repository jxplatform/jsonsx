/**
 * Head editor — structured form for managing $head entries (link, meta, script, style tags) with
 * Monaco editor for script/style bodies.
 */

import { html, render as litRender, nothing } from "lit-html";
import { projectState } from "../store.js";
import { updateSiteConfig } from "../site-context.js";

/** @param {HTMLElement} container */
export function renderHeadEditor(container) {
  const config = projectState.projectConfig || {};
  const headEntries = config.$head || [];

  const save = () => {
    updateSiteConfig({ $head: headEntries });
  };

  const addEntry = (/** @type {string} */ tag) => {
    /** @type {any} */
    const entry = { tagName: tag, attributes: {} };
    if (tag === "link") {
      entry.attributes.rel = "stylesheet";
      entry.attributes.href = "";
    } else if (tag === "meta") {
      entry.attributes.name = "";
      entry.attributes.content = "";
    } else if (tag === "script") {
      entry.attributes.src = "";
    } else if (tag === "style") {
      entry.content = "";
    }
    headEntries.push(entry);
    save();
    renderHeadEditor(container);
  };

  const removeEntry = (/** @type {number} */ idx) => {
    headEntries.splice(idx, 1);
    save();
    renderHeadEditor(container);
  };

  const updateEntry = (
    /** @type {number} */ idx,
    /** @type {string} */ key,
    /** @type {string} */ val,
  ) => {
    const entry = headEntries[idx];
    if (key === "content" && (entry.tagName === "script" || entry.tagName === "style")) {
      entry.content = val;
    } else {
      if (!entry.attributes) entry.attributes = {};
      entry.attributes[key] = val;
    }
    save();
  };

  const tpl = html`
    <div class="settings-section">
      <h3 class="settings-section-title">Head</h3>
      <p class="settings-field-desc">
        Manage global &lt;head&gt; tags — stylesheets, meta tags, scripts, and inline styles.
      </p>

      <div class="head-entries">
        ${headEntries.map(
          (/** @type {any} */ entry, /** @type {number} */ idx) => html`
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
 * @param {any} entry
 * @param {number} idx
 * @param {(idx: number, key: string, val: string) => void} updateEntry
 */
function renderEntryFields(entry, idx, updateEntry) {
  /** @type {any} */
  let debounce;
  const onFieldChange = (/** @type {string} */ key) => (/** @type {any} */ e) => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      updateEntry(idx, key, e.target.value);
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
                  .value=${entry.content || ""}
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
            .value=${entry.content || ""}
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
