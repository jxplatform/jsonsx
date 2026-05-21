/**
 * Color-selector.js — Color input widget with swatch, text field, and popover picker.
 *
 * Uses sp-overlay trigger pattern for positioning (same as unit-selector and value-selector). The
 * popover content is a JxColorPopover LitElement that reactively syncs color between the area,
 * slider, and text field via a single `color` property.
 *
 * When the value is a var(--color-*) reference matching a defined color variable, the input
 * switches to picker mode showing the title-cased variable name (e.g. "Primary Blue") with a
 * swatch, similar to jx-value-selector's dual-mode behavior.
 */

import { LitElement, html, nothing } from "lit";
import { html as litHtml } from "lit-html";
import { live } from "lit-html/directives/live.js";
import { debouncedStyleCommit } from "../store.js";
import { activeTab } from "../workspace/workspace.js";
import { getEffectiveStyle } from "../site-context.js";
import { kebabToLabel } from "../utils/studio-utils.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Extract --color-* CSS custom properties from the effective (site + document) style. */
function getColorVars() {
  const style = getEffectiveStyle(activeTab.value?.doc.document?.style);
  if (!style) return [];
  const vars = [];
  for (const [k, v] of Object.entries(style)) {
    if (k.startsWith("--color") && (typeof v === "string" || typeof v === "number")) {
      vars.push({ name: k, value: String(v) });
    }
  }
  return vars;
}

/**
 * Convert a color variable name to a title-case label. Strips the "--color-" prefix and converts
 * kebab to title case. e.g. "--color-primary-blue" → "Primary Blue"
 */
function varToLabel(/** @type {string} */ name) {
  return kebabToLabel(name.replace(/^--color-?/, ""));
}

/** Resolve a color value for display — if it's a var() reference, look up the actual color. */
function resolveColorForDisplay(/** @type {any} */ val) {
  if (!val) return "transparent";
  const m = val.match(/^var\((--[^)]+)\)$/);
  if (m) {
    const style = getEffectiveStyle(activeTab.value?.doc.document?.style);
    const resolved = style?.[m[1]];
    if (typeof resolved === "string") return resolved;
    return "transparent";
  }
  return val;
}

function safeColor(/** @type {any} */ val) {
  if (!val) return "transparent";
  return resolveColorForDisplay(val);
}

/** Normalize a color string to include # prefix for hex values. */
function normalizeHex(/** @type {string} */ c) {
  if (!c) return c;
  if (c.startsWith("var(") || c.startsWith("rgb") || c.startsWith("hsl")) return c;
  return c.replace(/^#?/, "#");
}

/**
 * Check if a value is a var() reference that matches a defined color variable.
 *
 * @param {any} value
 * @param {{ name: string; value: string }[]} colorVars
 */
function matchesColorVar(value, colorVars) {
  if (!value || typeof value !== "string") return null;
  const m = value.match(/^var\((--[^)]+)\)$/);
  if (!m) return null;
  return colorVars.find((cv) => cv.name === m[1]) || null;
}

// ─── JxColorPopover LitElement ──────────────────────────────────────────────

/** @typedef {{ name: string; value: string }} ColorVar */

export class JxColorPopover extends LitElement {
  static properties = {
    color: { type: String },
    displayColor: { type: String, attribute: false },
    colorVars: { attribute: false },
  };

  constructor() {
    super();
    /** @type {string} */ this.color = "";
    /** @type {string} */ this.displayColor = "#000000";
    /** @type {ColorVar[]} */ this.colorVars = [];
  }

  /** No shadow DOM — render directly into light DOM for Spectrum theming */
  createRenderRoot() {
    return this;
  }

  /** @param {Map<string, any>} changed */
  willUpdate(changed) {
    if (changed.has("color")) {
      const raw = resolveColorForDisplay(this.color);
      if (!raw || raw === "transparent") {
        this.displayColor = "#000000";
      } else if (raw.startsWith("#") || raw.startsWith("rgb") || raw.startsWith("hsl")) {
        this.displayColor = raw;
      } else {
        this.displayColor = `#${raw}`;
      }
    }
  }

  _handleArea(/** @type {any} */ e) {
    const color = normalizeHex(String(e.target.color));
    this.displayColor = color;
    this.color = color;
    this.dispatchEvent(new CustomEvent("color-change", { detail: color, bubbles: true }));
  }

  _handleSlider(/** @type {any} */ e) {
    const color = normalizeHex(String(e.target.color));
    this.displayColor = color;
    this.color = color;
    this.dispatchEvent(new CustomEvent("color-change", { detail: color, bubbles: true }));
  }

  _handleText(/** @type {any} */ e) {
    const val = e.target.value.trim();
    if (!val) return;
    this.displayColor = val;
    this.color = val;
    this.dispatchEvent(new CustomEvent("color-change", { detail: val, bubbles: true }));
  }

  _handleSwatch(/** @type {any} */ e, /** @type {string} */ varName) {
    e.stopPropagation();
    const varRef = `var(${varName})`;
    this.color = varRef;
    this.dispatchEvent(new CustomEvent("color-change", { detail: varRef, bubbles: true }));
  }

  render() {
    return html`
      <div class="color-popover-inner">
        <sp-color-area
          style="width:200px; height:150px; --mod-colorarea-width:200px; --mod-colorarea-height:150px"
          .color=${this.displayColor}
          @input=${this._handleArea}
        ></sp-color-area>
        <sp-color-slider
          style="width:200px; --mod-colorslider-length:200px"
          .color=${this.displayColor}
          @input=${this._handleSlider}
        ></sp-color-slider>
        <sp-textfield
          size="s"
          style="width:200px"
          .value=${live(this.color || "")}
          placeholder="#000000"
          @change=${this._handleText}
        ></sp-textfield>
        ${this.colorVars.length > 0
          ? html`
              <sp-divider size="s"></sp-divider>
              <span class="color-popover-swatches-label">Color Tokens</span>
              <sp-swatch-group size="xs" border="light" rounding="none">
                ${this.colorVars.map(
                  (cv) => html`
                    <sp-swatch
                      color=${cv.value}
                      .value=${cv.name}
                      title=${cv.name}
                      @click=${(/** @type {any} */ e) => this._handleSwatch(e, cv.name)}
                    ></sp-swatch>
                  `,
                )}
              </sp-swatch-group>
            `
          : nothing}
      </div>
    `;
  }
}

// ─── Color input widget ─────────────────────────────────────────────────────

/**
 * Render a color selector: swatch + text field + overlay popover. Uses sp-overlay trigger pattern
 * (same as unit-selector and value-selector).
 *
 * When value is a var(--color-*) matching a defined variable, switches to picker mode showing
 * title-cased label with swatch (e.g. "Primary Blue").
 *
 * @param {string} prop — property key (for debounce namespace)
 * @param {any} value — current color value
 * @param {(color: string) => void} onChange — commit callback
 * @returns {any}
 */
export function renderColorSelector(
  /** @type {any} */ prop,
  /** @type {any} */ value,
  /** @type {any} */ onChange,
) {
  const colorVars = getColorVars();
  const matchedVar = matchesColorVar(value, colorVars);
  const triggerId = `color-trigger-${prop}`;
  const pickerTriggerId = `color-picker-${prop}`;

  // ─── Picker mode: value matches a defined color variable ───
  if (matchedVar) {
    return litHtml`
      <div class="style-input-color">
        <sp-swatch
          size="s"
          rounding="none"
          border="light"
          color=${matchedVar.value}
          id=${triggerId}
        ></sp-swatch>
        <sp-overlay trigger="${triggerId}@click" placement="bottom-start" type="auto">
          <sp-popover style="padding:12px">
            <jx-color-popover
              .color=${value || ""}
              .colorVars=${colorVars}
              @color-change=${(/** @type {CustomEvent} */ e) => onChange(e.detail)}
            ></jx-color-popover>
          </sp-popover>
        </sp-overlay>
        <sp-picker
          id=${pickerTriggerId}
          size="s"
          style="flex:1; min-width:0"
          .value=${`var(${matchedVar.name})`}
          @change=${(/** @type {any} */ e) => {
            e.stopPropagation();
            onChange(e.target.value);
          }}
        >
          ${colorVars.map(
            (cv) => litHtml`
              <sp-menu-item value=${`var(${cv.name})`}>
                <sp-swatch
                  slot="icon"
                  size="xs"
                  rounding="none"
                  border="light"
                  color=${cv.value}
                ></sp-swatch>
                ${varToLabel(cv.name)}
              </sp-menu-item>
            `,
          )}
        </sp-picker>
      </div>
    `;
  }

  // ─── Text mode: custom color value or empty ───
  return litHtml`
    <div class="style-input-color" id=${triggerId}>
      <sp-swatch
        size="s"
        rounding="none"
        border="light"
        color=${safeColor(value)}
      ></sp-swatch>
      <sp-textfield
        size="s"
        style="flex:1; min-width:0"
        .value=${live(value || "")}
        @click=${(/** @type {Event} */ e) => e.stopPropagation()}
        @input=${debouncedStyleCommit(`color:${prop}`, 400, (/** @type {any} */ e) => {
          onChange(e.target.value.trim());
        })}
      ></sp-textfield>
      <sp-overlay trigger="${triggerId}@click" placement="bottom-start" type="auto">
        <sp-popover style="padding:12px">
          <jx-color-popover
            .color=${value || ""}
            .colorVars=${colorVars}
            @color-change=${(/** @type {CustomEvent} */ e) => onChange(e.detail)}
          ></jx-color-popover>
        </sp-popover>
      </sp-overlay>
    </div>
  `;
}

/** Whether any color popover is currently open. */
export function isColorPopoverOpen() {
  return !!document.querySelector(".style-input-color sp-overlay[open]");
}
