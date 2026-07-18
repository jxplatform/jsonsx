/// <reference lib="dom" />
/**
 * CSS Variables editor — form-based editor for managing design tokens. Colors are scheme-aware
 * (per-scheme overrides in `@--dark`-style blocks, spec §9.5); sizes/spacing are media-aware; fonts
 * are neither.
 */

import { html, render as litRender, nothing } from "lit-html";
import { ref } from "lit-html/directives/ref.js";
import { projectState } from "../store";
import { getEffectiveMedia, updateSiteConfig } from "../site-context";
import { postSiteStyleToLiveHosts } from "../canvas/iframe-host";
import { isSchemeQuery, schemeOfQuery } from "../utils/canvas-media";
import { friendlyNameToVar, varDisplayName } from "../utils/studio-utils";

import type { JxStyle } from "@jxsuite/schema/types";

/** A declared scheme query in $media: the block key name plus the scheme it targets. */
export interface SchemeEntry {
  name: string;
  scheme: "light" | "dark";
}

/** @param {HTMLElement} container */
export function renderCssVarsEditor(container: HTMLElement) {
  const config = projectState?.projectConfig || {};
  const rootStyle = config.style || {};
  const media = getEffectiveMedia(config.$media);

  /**
   * @type {{
   *   color: [string, string | number][];
   *   font: [string, string | number][];
   *   size: [string, string | number][];
   *   other: [string, string | number][];
   * }}
   */
  const groups: {
    color: [string, string | number][];
    font: [string, string | number][];
    size: [string, string | number][];
    other: [string, string | number][];
  } = { color: [], font: [], other: [], size: [] };
  for (const [k, v] of Object.entries(rootStyle)) {
    if (!k.startsWith("--")) {
      continue;
    }
    if (typeof v !== "string" && typeof v !== "number") {
      continue;
    }
    if (k.startsWith("--color")) {
      groups.color.push([k, v]);
    } else if (k.startsWith("--font")) {
      groups.font.push([k, v]);
    } else if (k.startsWith("--size") || k.startsWith("--spacing") || k.startsWith("--radius")) {
      groups.size.push([k, v]);
    } else {
      groups.other.push([k, v]);
    }
  }

  const mediaNames = media
    ? Object.keys(media).filter((m) => m !== "--" && !isSchemeQuery(String(media[m])))
    : [];
  const schemeEntries: SchemeEntry[] = media
    ? Object.entries(media).flatMap(([name, query]) => {
        const scheme = schemeOfQuery(String(query));
        return scheme ? [{ name, scheme }] : [];
      })
    : [];

  const save = () => {
    void updateSiteConfig({ style: { ...rootStyle } });
    // Live canvas feedback: replace the site-style sheet in place — no re-render needed.
    postSiteStyleToLiveHosts();
  };

  const updateVar = (name: string, val: string) => {
    rootStyle[name] = val;
    save();
  };

  // Write/clear a per-scheme token override in the scheme's `@--name` block (spec §9.5). An empty
  // Value clears the override (and drops the block when it empties) — the token inherits the base.
  const updateSchemeVar = (schemeName: string, varName: string, val: string) => {
    const key = `@${schemeName}`;
    if (val) {
      const block = (rootStyle[key] ??= {}) as Record<string, unknown>;
      block[varName] = val;
    } else {
      const block = rootStyle[key];
      if (block && typeof block === "object") {
        delete (block as Record<string, unknown>)[varName];
        if (Object.keys(block).length === 0) {
          delete rootStyle[key];
        }
      }
    }
    save();
    renderCssVarsEditor(container);
  };

  // Without a declared scheme query nothing ever shows the scheme UI (here or in the tab bar) —
  // This is the opt-in affordance for existing projects. Re-render after the async config update
  // Lands (unlike style edits, $media is not mutated in place).
  const enableDarkScheme = () => {
    void updateSiteConfig({
      $media: { ...config.$media, "--dark": "(prefers-color-scheme: dark)" },
    }).then(() => renderCssVarsEditor(container));
  };

  const deleteVar = (name: string) => {
    delete rootStyle[name];
    save();
    renderCssVarsEditor(container);
  };

  const addVar = (prefix: string, friendlyName: string, val: string) => {
    const varName = friendlyNameToVar(friendlyName, prefix);
    if (!varName || !val) {
      return;
    }
    rootStyle[varName] = val;
    save();
    renderCssVarsEditor(container);
  };

  const tpl = html`
    <div class="settings-section">
      <h3 class="settings-section-title">CSS Variables</h3>

      ${renderColorSection(
        groups.color,
        updateVar,
        deleteVar,
        addVar,
        rootStyle,
        schemeEntries,
        updateSchemeVar,
        enableDarkScheme,
      )}
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
 * @param {[string, string | number][]} vars
 * @param {(name: string, val: string) => void} updateVar
 * @param {(name: string) => void} deleteVar
 * @param {(prefix: string, friendlyName: string, val: string) => void} addVar
 */
function renderColorSection(
  vars: [string, string | number][],
  updateVar: (name: string, val: string) => void,
  deleteVar: (name: string) => void,
  addVar: (prefix: string, friendlyName: string, val: string) => void,
  rootStyle: JxStyle,
  schemeEntries: SchemeEntry[],
  updateSchemeVar: (schemeName: string, varName: string, val: string) => void,
  enableDarkScheme: () => void,
) {
  return html`
    <div class="css-vars-group">
      <h4 class="css-vars-group-title">Colors</h4>
      ${vars.map(
        ([name, val]) => html`
          <div class="css-var-row">
            <div class="css-var-swatch" style="background:${val}">
              <input
                type="color"
                .value=${val && String(val).startsWith("#") ? val : "#3b82f6"}
                @input=${(e: Event) => updateVar(name, (e.target as HTMLInputElement).value)}
              />
            </div>
            <span class="css-var-name">${varDisplayName(name, "--color-")}</span>
            <sp-textfield
              size="s"
              .value=${String(val)}
              @change=${(e: Event) => updateVar(name, (e.target as HTMLInputElement).value)}
              style="flex:1;max-width:160px"
            ></sp-textfield>
            <sp-action-button quiet size="s" @click=${() => deleteVar(name)}>
              <sp-icon-delete slot="icon"></sp-icon-delete>
            </sp-action-button>
          </div>
          ${schemeEntries.map((entry) =>
            renderSchemeOverride(name, rootStyle, entry, updateSchemeVar),
          )}
        `,
      )}
      ${renderAddRow("--color-", "Primary Blue", "#3b82f6", addVar)}
      ${schemeEntries.length === 0
        ? html`
            <sp-action-button
              size="s"
              class="css-vars-enable-dark"
              title="Add a dark color scheme: declares --dark in $media so every color token can carry a dark value"
              @click=${enableDarkScheme}
            >
              Enable dark scheme
            </sp-action-button>
          `
        : nothing}
    </div>
  `;
}

/**
 * One per-scheme override row under a color token: swatch + field bound to the scheme block's
 * value. Empty shows "inherits" (the base value applies); clearing deletes the override.
 *
 * @param {string} varName
 * @param {JxStyle} rootStyle
 * @param {SchemeEntry} entry
 * @param {(schemeName: string, varName: string, val: string) => void} updateSchemeVar
 */
function renderSchemeOverride(
  varName: string,
  rootStyle: JxStyle,
  entry: SchemeEntry,
  updateSchemeVar: (schemeName: string, varName: string, val: string) => void,
) {
  const block = rootStyle[`@${entry.name}`];
  const current =
    block && typeof block === "object" ? (block as Record<string, unknown>)[varName] : undefined;
  const label = entry.scheme === "dark" ? "Dark" : "Light";
  return html`
    <div class="css-var-media-row css-var-scheme-row">
      <span class="css-var-media-label">${label}</span>
      <div class="css-var-swatch" style="background:${current ?? "transparent"}">
        <input
          type="color"
          .value=${current && String(current).startsWith("#") ? String(current) : "#111111"}
          @input=${(e: Event) =>
            updateSchemeVar(entry.name, varName, (e.target as HTMLInputElement).value)}
        />
      </div>
      <sp-textfield
        size="s"
        placeholder="inherits"
        .value=${current == null ? "" : String(current)}
        @change=${(e: Event) =>
          updateSchemeVar(entry.name, varName, (e.target as HTMLInputElement).value)}
        style="flex:1;max-width:160px"
      ></sp-textfield>
    </div>
  `;
}

/**
 * @param {[string, string | number][]} vars
 * @param {(name: string, val: string) => void} updateVar
 * @param {(name: string) => void} deleteVar
 * @param {(prefix: string, friendlyName: string, val: string) => void} addVar
 */
function renderFontSection(
  vars: [string, string | number][],
  updateVar: (name: string, val: string) => void,
  deleteVar: (name: string) => void,
  addVar: (prefix: string, friendlyName: string, val: string) => void,
) {
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
              @change=${(e: Event) => updateVar(name, (e.target as HTMLInputElement).value)}
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
 * @param {[string, string | number][]} vars
 * @param {(name: string, val: string) => void} updateVar
 * @param {(name: string) => void} deleteVar
 * @param {(prefix: string, friendlyName: string, val: string) => void} addVar
 * @param {JxStyle} rootStyle
 * @param {string[]} mediaNames
 */
function renderSizeSection(
  vars: [string, string | number][],
  updateVar: (name: string, val: string) => void,
  deleteVar: (name: string) => void,
  addVar: (prefix: string, friendlyName: string, val: string) => void,
  rootStyle: JxStyle,
  mediaNames: string[],
) {
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
              @change=${(e: Event) => updateVar(name, (e.target as HTMLInputElement).value)}
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
 * @param {[string, string | number][]} vars
 * @param {(name: string, val: string) => void} updateVar
 * @param {(name: string) => void} deleteVar
 * @param {(prefix: string, friendlyName: string, val: string) => void} addVar
 * @param {JxStyle} rootStyle
 * @param {string[]} mediaNames
 */
function renderOtherSection(
  vars: [string, string | number][],
  updateVar: (name: string, val: string) => void,
  deleteVar: (name: string) => void,
  addVar: (prefix: string, friendlyName: string, val: string) => void,
  rootStyle: JxStyle,
  mediaNames: string[],
) {
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
              @change=${(e: Event) => updateVar(name, (e.target as HTMLInputElement).value)}
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
 * @param {JxStyle} rootStyle
 * @param {string[]} mediaNames
 */
function renderMediaOverrides(varName: string, rootStyle: JxStyle, mediaNames: string[]) {
  const overrides = [];
  for (const mediaName of mediaNames) {
    const mediaKey = `@${mediaName}`;
    const mediaBlock = rootStyle[mediaKey];
    if (mediaBlock && typeof mediaBlock === "object" && mediaBlock[varName]) {
      overrides.push({ mediaName, value: mediaBlock[varName] });
    }
  }

  if (overrides.length === 0) {
    return nothing;
  }

  return html`
    <div class="css-var-media-overrides">
      ${overrides.map(
        (o) => html`
          <div class="css-var-media-row">
            <span class="css-var-media-label">@${o.mediaName}</span>
            <sp-textfield
              size="s"
              .value=${String(o.value)}
              @change=${(e: Event) => {
                if (!rootStyle[`@${o.mediaName}`]) {
                  rootStyle[`@${o.mediaName}`] = {};
                }
                (rootStyle[`@${o.mediaName}`] as Record<string, unknown>)[varName] = (
                  e.target as HTMLInputElement
                ).value;
                void updateSiteConfig({ style: { ...rootStyle } });
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
 * @param {(prefix: string, friendlyName: string, val: string) => void} addVar
 */
function renderAddRow(
  prefix: string,
  placeholder: string,
  valuePlaceholder: string,
  addVar: (prefix: string, friendlyName: string, val: string) => void,
) {
  let nameEl: HTMLInputElement | null = null;
  let valEl: HTMLInputElement | null = null;

  return html`
    <div class="css-var-add-row">
      <sp-textfield
        size="s"
        placeholder=${placeholder}
        ${ref((el) => {
          if (el) {
            nameEl = el as HTMLInputElement;
          }
        })}
      ></sp-textfield>
      <sp-textfield
        size="s"
        placeholder=${valuePlaceholder}
        ${ref((el) => {
          if (el) {
            valEl = el as HTMLInputElement;
          }
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
