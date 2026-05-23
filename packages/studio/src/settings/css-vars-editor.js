/**
 * CSS Variables editor — form-based editor for managing design tokens. Colors and fonts are NOT
 * media-aware; sizes/spacing are media-aware.
 */

import { html, render as litRender, nothing } from "lit-html";
import { ref } from "lit-html/directives/ref.js";
import { projectState } from "../store.js";
import { updateSiteConfig } from "../site-context.js";
import { getEffectiveMedia } from "../site-context.js";
import { friendlyNameToVar, varDisplayName } from "../utils/studio-utils.js";

/** @param {HTMLElement} container */
export function renderCssVarsEditor(container) {
  const config = projectState.projectConfig || {};
  const rootStyle = config.style || {};
  const media = getEffectiveMedia(config.$media);

  /**
   * @type {{
   *   color: [string, any][];
   *   font: [string, any][];
   *   size: [string, any][];
   *   other: [string, any][];
   * }}
   */
  const groups = { color: [], font: [], size: [], other: [] };
  for (const [k, v] of Object.entries(rootStyle)) {
    if (!k.startsWith("--")) continue;
    if (typeof v !== "string" && typeof v !== "number") continue;
    if (k.startsWith("--color")) groups.color.push([k, v]);
    else if (k.startsWith("--font")) groups.font.push([k, v]);
    else if (k.startsWith("--size") || k.startsWith("--spacing") || k.startsWith("--radius"))
      groups.size.push([k, v]);
    else groups.other.push([k, v]);
  }

  const mediaNames = media ? Object.keys(media).filter((m) => m !== "--") : [];

  const save = () => {
    updateSiteConfig({ style: { ...rootStyle } });
  };

  const updateVar = (/** @type {string} */ name, /** @type {string} */ val) => {
    rootStyle[name] = val;
    save();
  };

  const deleteVar = (/** @type {string} */ name) => {
    delete rootStyle[name];
    save();
    renderCssVarsEditor(container);
  };

  const addVar = (
    /** @type {string} */ prefix,
    /** @type {string} */ friendlyName,
    /** @type {string} */ val,
  ) => {
    const varName = friendlyNameToVar(friendlyName, prefix);
    if (!varName || !val) return;
    rootStyle[varName] = val;
    save();
    renderCssVarsEditor(container);
  };

  const tpl = html`
    <div class="settings-section">
      <h3 class="settings-section-title">CSS Variables</h3>

      ${renderColorSection(groups.color, updateVar, deleteVar, addVar)}
      ${renderFontSection(groups.font, updateVar, deleteVar, addVar)}
      ${renderSizeSection(groups.size, updateVar, deleteVar, addVar, rootStyle, mediaNames)}
      ${groups.other.length > 0
        ? renderOtherSection(groups.other, updateVar, deleteVar, addVar, rootStyle, mediaNames)
        : nothing}
    </div>
  `;

  litRender(tpl, container);
}

/**
 * @param {[string, any][]} vars
 * @param {Function} updateVar
 * @param {Function} deleteVar
 * @param {Function} addVar
 */
function renderColorSection(vars, updateVar, deleteVar, addVar) {
  return html`
    <div class="css-vars-group">
      <h4 class="css-vars-group-title">Colors</h4>
      ${vars.map(
        ([name, val]) => html`
          <div class="css-var-row">
            <div class="css-var-swatch" style="background:${val}">
              <input
                type="color"
                .value=${val && val.startsWith("#") ? val : "#007acc"}
                @input=${(/** @type {any} */ e) => updateVar(name, e.target.value)}
              />
            </div>
            <span class="css-var-name">${varDisplayName(name, "--color-")}</span>
            <sp-textfield
              size="s"
              .value=${String(val)}
              @change=${(/** @type {any} */ e) => updateVar(name, e.target.value)}
              style="flex:1;max-width:160px"
            ></sp-textfield>
            <sp-action-button quiet size="s" @click=${() => deleteVar(name)}>
              <sp-icon-delete slot="icon"></sp-icon-delete>
            </sp-action-button>
          </div>
        `,
      )}
      ${renderAddRow("--color-", "Primary Blue", "#007acc", addVar)}
    </div>
  `;
}

/**
 * @param {[string, any][]} vars
 * @param {Function} updateVar
 * @param {Function} deleteVar
 * @param {Function} addVar
 */
function renderFontSection(vars, updateVar, deleteVar, addVar) {
  return html`
    <div class="css-vars-group">
      <h4 class="css-vars-group-title">Fonts</h4>
      ${vars.map(
        ([name, val]) => html`
          <div class="css-var-row">
            <span class="css-var-name">${varDisplayName(name, "--font-")}</span>
            <sp-textfield
              size="s"
              .value=${String(val)}
              @change=${(/** @type {any} */ e) => updateVar(name, e.target.value)}
              style="flex:1"
            ></sp-textfield>
            <sp-action-button quiet size="s" @click=${() => deleteVar(name)}>
              <sp-icon-delete slot="icon"></sp-icon-delete>
            </sp-action-button>
          </div>
          <div class="css-var-font-preview" style="font-family:${val}">
            The quick brown fox jumps over the lazy dog
          </div>
        `,
      )}
      ${renderAddRow("--font-", "Body Serif", "'Georgia', serif", addVar)}
    </div>
  `;
}

/**
 * @param {[string, any][]} vars
 * @param {Function} updateVar
 * @param {Function} deleteVar
 * @param {Function} addVar
 * @param {any} rootStyle
 * @param {string[]} mediaNames
 */
function renderSizeSection(vars, updateVar, deleteVar, addVar, rootStyle, mediaNames) {
  return html`
    <div class="css-vars-group">
      <h4 class="css-vars-group-title">Sizes &amp; Spacing</h4>
      ${vars.map(
        ([name, val]) => html`
          <div class="css-var-row">
            <span class="css-var-name"
              >${varDisplayName(name, "--size-") ||
              varDisplayName(name, "--spacing-") ||
              varDisplayName(name, "--radius-") ||
              name}</span
            >
            <sp-textfield
              size="s"
              .value=${String(val)}
              @change=${(/** @type {any} */ e) => updateVar(name, e.target.value)}
              style="max-width:120px"
            ></sp-textfield>
            <sp-action-button quiet size="s" @click=${() => deleteVar(name)}>
              <sp-icon-delete slot="icon"></sp-icon-delete>
            </sp-action-button>
          </div>
          ${mediaNames.length > 0 ? renderMediaOverrides(name, rootStyle, mediaNames) : nothing}
        `,
      )}
      ${renderAddRow("--size-", "Spacing Large", "32px", addVar)}
    </div>
  `;
}

/**
 * @param {[string, any][]} vars
 * @param {Function} updateVar
 * @param {Function} deleteVar
 * @param {Function} addVar
 * @param {any} rootStyle
 * @param {string[]} mediaNames
 */
function renderOtherSection(vars, updateVar, deleteVar, addVar, rootStyle, mediaNames) {
  return html`
    <div class="css-vars-group">
      <h4 class="css-vars-group-title">Other</h4>
      ${vars.map(
        ([name, val]) => html`
          <div class="css-var-row">
            <span class="css-var-name">${name}</span>
            <sp-textfield
              size="s"
              .value=${String(val)}
              @change=${(/** @type {any} */ e) => updateVar(name, e.target.value)}
              style="flex:1"
            ></sp-textfield>
            <sp-action-button quiet size="s" @click=${() => deleteVar(name)}>
              <sp-icon-delete slot="icon"></sp-icon-delete>
            </sp-action-button>
          </div>
          ${mediaNames.length > 0 ? renderMediaOverrides(name, rootStyle, mediaNames) : nothing}
        `,
      )}
      ${renderAddRow("--", "Custom Var", "value", addVar)}
    </div>
  `;
}

/**
 * @param {string} varName
 * @param {any} rootStyle
 * @param {string[]} mediaNames
 */
function renderMediaOverrides(varName, rootStyle, mediaNames) {
  const overrides = [];
  for (const mediaName of mediaNames) {
    const mediaKey = `@${mediaName}`;
    const mediaBlock = rootStyle[mediaKey];
    if (mediaBlock && typeof mediaBlock === "object" && mediaBlock[varName]) {
      overrides.push({ mediaName, value: mediaBlock[varName] });
    }
  }

  if (overrides.length === 0) return nothing;

  return html`
    <div class="css-var-media-overrides">
      ${overrides.map(
        (o) => html`
          <div class="css-var-media-row">
            <span class="css-var-media-label">@${o.mediaName}</span>
            <sp-textfield
              size="s"
              .value=${String(o.value)}
              @change=${(/** @type {any} */ e) => {
                if (!rootStyle[`@${o.mediaName}`]) rootStyle[`@${o.mediaName}`] = {};
                rootStyle[`@${o.mediaName}`][varName] = e.target.value;
                updateSiteConfig({ style: { ...rootStyle } });
              }}
              style="max-width:120px"
            ></sp-textfield>
          </div>
        `,
      )}
    </div>
  `;
}

/**
 * @param {string} prefix
 * @param {string} placeholder
 * @param {string} valuePlaceholder
 * @param {Function} addVar
 */
function renderAddRow(prefix, placeholder, valuePlaceholder, addVar) {
  /** @type {any} */
  let nameEl = null;
  /** @type {any} */
  let valEl = null;

  return html`
    <div class="css-var-add-row">
      <sp-textfield
        size="s"
        placeholder=${placeholder}
        ${ref((el) => {
          if (el) nameEl = el;
        })}
      ></sp-textfield>
      <sp-textfield
        size="s"
        placeholder=${valuePlaceholder}
        ${ref((el) => {
          if (el) valEl = el;
        })}
      ></sp-textfield>
      <sp-action-button
        size="s"
        @click=${() => {
          if (nameEl && valEl) {
            addVar(prefix, nameEl.value, valEl.value);
          }
        }}
        >Add</sp-action-button
      >
    </div>
  `;
}
