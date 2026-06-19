/// <reference lib="dom" />
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
import { debouncedStyleCommit } from "../store";
import { activeTab } from "../workspace/workspace";
import { getEffectiveStyle } from "../site-context";
import { kebabToLabel } from "../utils/studio-utils";

interface ColorVar {
  name: string;
  value: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Extract --color-* CSS custom properties from the effective (site + document) style. */
function getColorVars() {
  const style = getEffectiveStyle(activeTab.value?.doc.document?.style);
  if (!style) {
    return [];
  }
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
function varToLabel(name: string) {
  return kebabToLabel(name.replace(/^--color-?/, ""));
}

/** Resolve a color value for display — if it's a var() reference, look up the actual color. */
function resolveColorForDisplay(val: string | number | undefined) {
  if (!val) {
    return "transparent";
  }
  const s = String(val);
  const m = s.match(/^var\((--[^)]+)\)$/);
  if (m) {
    const style = getEffectiveStyle(activeTab.value?.doc.document?.style);
    const resolved = style?.[m[1]!];
    if (typeof resolved === "string") {
      return resolved;
    }
    return "transparent";
  }
  return s;
}

function safeColor(val: string | number | undefined) {
  if (!val) {
    return "transparent";
  }
  return resolveColorForDisplay(val);
}

/** Normalize a color string to include # prefix for hex values. */
function normalizeHex(c: string) {
  if (!c) {
    return c;
  }
  if (c.startsWith("var(") || c.startsWith("rgb") || c.startsWith("hsl")) {
    return c;
  }
  return c.replace(/^#?/, "#");
}

/**
 * Check if a value is a var() reference that matches a defined color variable.
 *
 * @param {string | number | undefined} value
 * @param {{ name: string; value: string }[]} colorVars
 */
function matchesColorVar(
  value: string | number | undefined,
  colorVars: { name: string; value: string }[],
) {
  if (!value || typeof value !== "string") {
    return null;
  }
  const m = value.match(/^var\((--[^)]+)\)$/);
  if (!m) {
    return null;
  }
  return colorVars.find((cv) => cv.name === m[1]) || null;
}

// ─── JxColorPopover LitElement ──────────────────────────────────────────────

export class JxColorPopover extends LitElement {
  static override properties = {
    color: { type: String },
    colorVars: { attribute: false },
    displayColor: { attribute: false, type: String },
  };

  declare color: string;
  declare displayColor: string;
  declare colorVars: ColorVar[];

  constructor() {
    super();
    this.color = "";
    this.displayColor = "#000000";
    this.colorVars = [];
  }

  /** No shadow DOM — render directly into light DOM for Spectrum theming */
  override createRenderRoot() {
    return this;
  }

  /** @param {Map<string, unknown>} changed */
  override willUpdate(changed: Map<string, unknown>) {
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

  _handleArea(e: Event) {
    const color = normalizeHex(String((e.target as HTMLElement & { color: string }).color));
    this.displayColor = color;
    this.color = color;
    this.dispatchEvent(new CustomEvent("color-change", { bubbles: true, detail: color }));
  }

  _handleSlider(e: Event) {
    const color = normalizeHex(String((e.target as HTMLElement & { color: string }).color));
    this.displayColor = color;
    this.color = color;
    this.dispatchEvent(new CustomEvent("color-change", { bubbles: true, detail: color }));
  }

  _handleText(e: Event) {
    const val = (e.target as HTMLInputElement).value.trim();
    if (!val) {
      return;
    }
    this.displayColor = val;
    this.color = val;
    this.dispatchEvent(new CustomEvent("color-change", { bubbles: true, detail: val }));
  }

  _handleSwatch(e: Event, varName: string) {
    e.stopPropagation();
    const varRef = `var(${varName})`;
    this.color = varRef;
    this.dispatchEvent(new CustomEvent("color-change", { bubbles: true, detail: varRef }));
  }

  override render() {
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
                      @click=${(e: Event) => this._handleSwatch(e, cv.name)}
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
 * @param {string | number | undefined} value — current color value
 * @param {(color: string) => void} onChange — commit callback
 * @returns {import("lit-html").TemplateResult}
 */
export function renderColorSelector(
  /** @type {string} */ prop: string,
  /** @type {string | number | undefined} */ value: string | number | undefined,
  /** @type {(color: string) => void} */ onChange: (color: string) => void,
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
              @color-change=${(e: CustomEvent) => onChange(e.detail as string)}
            ></jx-color-popover>
          </sp-popover>
        </sp-overlay>
        <sp-picker
          id=${pickerTriggerId}
          size="s"
          style="flex:1; min-width:0"
          .value=${`var(${matchedVar.name})`}
          @change=${(e: Event) => {
            e.stopPropagation();
            onChange((e.target as HTMLInputElement).value);
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
        @click=${(e: Event) => e.stopPropagation()}
        @input=${debouncedStyleCommit(`color:${prop}`, 400, (e: Event) => {
          onChange((e.target as HTMLInputElement).value.trim());
        })}
      ></sp-textfield>
      <sp-overlay trigger="${triggerId}@click" placement="bottom-start" type="auto">
        <sp-popover style="padding:12px">
          <jx-color-popover
            .color=${value || ""}
            .colorVars=${colorVars}
            @color-change=${(e: CustomEvent) => onChange(e.detail as string)}
          ></jx-color-popover>
        </sp-popover>
      </sp-overlay>
    </div>
  `;
}

/** Whether any color popover is currently open. */
export function isColorPopoverOpen() {
  return Boolean(document.querySelector(".style-input-color sp-overlay[open]"));
}
