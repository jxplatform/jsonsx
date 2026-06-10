/// <reference lib="dom" />
/**
 * Unit-selector.js — Number + unit picker widget.
 *
 * Renders a text field for numeric input paired with a unit picker dropdown. Handles keywords
 * (auto, inherit, etc.) alongside numeric+unit values.
 */

import { html, nothing } from "lit-html";
import { live } from "lit-html/directives/live.js";
import { classMap } from "lit-html/directives/class-map.js";
import { debouncedStyleCommit, cancelStyleDebounce } from "../store";

export const UNIT_RE = /^(-?[\d.]+)(px|rem|em|%|vw|vh|svw|svh|dvh|ms|s|fr|ch|ex|deg)?$/;

/**
 * Render a number + unit selector widget.
 *
 * @param {Record<string, unknown>} entry — css-meta entry with $units and $keywords arrays
 * @param {string} prop — property key (for debounce namespace)
 * @param {string | number | undefined} value — current value (e.g. "12px", "auto", "")
 * @param {(val: string) => void} onChange — commit callback
 * @param {string} [placeholder]
 * @returns {import("lit-html").TemplateResult}
 */
export function renderUnitSelector(
  /** @type {Record<string, unknown>} */ entry: Record<string, unknown>,
  /** @type {string} */ prop: string,
  /** @type {string | number | undefined} */ value: string | number | undefined,
  /** @type {(val: string) => void} */ onChange: (val: string) => void,
  /** @type {string} */ placeholder: string = "",
) {
  const units = (entry.$units || []) as string[];
  const keywords = (entry.$keywords || []) as string[];
  const strVal = String(value ?? "");
  const match = strVal.match(UNIT_RE);
  const isKeyword = !match && strVal !== "" && keywords.includes(strVal);
  const isNumericVal = (v: string) => /^-?\d*\.?\d*$/.test(v);

  const currentUnit = isKeyword ? units[0] || "" : match ? match[2] || "" : units[0] || "";
  let displayValue;
  if (isKeyword) displayValue = strVal;
  else if (match) displayValue = match[1];
  else if (strVal !== "") {
    const num = parseFloat(strVal);
    displayValue = isNaN(num) ? strVal : String(num);
  } else displayValue = "";

  // Parse placeholder so inherited values display as "500" not "500px"
  const placeholderMatch = placeholder.match(UNIT_RE);
  const numericPlaceholder = placeholderMatch ? placeholderMatch[1] : placeholder || "0";

  const isExpression = isKeyword || (displayValue !== "" && !isNumericVal(displayValue));
  const hasUnits = units.length > 0 || keywords.length > 0;
  const btnId = `style-unit-${prop}`;

  const commitValue = (rawVal: string) => {
    const val = rawVal.trim();
    if (val === "") {
      onChange("");
      return;
    }
    if (isNumericVal(val)) onChange(units.length > 0 ? val + currentUnit : val);
    else onChange(val);
  };

  return html`
    <div class="style-input-number-unit">
      <div
        class=${classMap({
          "input-group": true,
          "is-expression": isExpression,
        })}
      >
        <sp-textfield
          size="s"
          placeholder=${numericPlaceholder}
          .value=${live(displayValue)}
          @input=${debouncedStyleCommit(`nui:${prop}`, 400, (e: Event) => {
            commitValue((e.target as HTMLInputElement).value);
          })}
          @change=${(e: Event) => {
            cancelStyleDebounce(`nui:${prop}`);
            commitValue((e.target as HTMLInputElement).value);
          }}
        ></sp-textfield>
        ${hasUnits
          ? html`
              <sp-picker-button id=${btnId} size="s">
                <span slot="label">${currentUnit || units[0] || ""}</span>
              </sp-picker-button>
              <sp-overlay trigger="${btnId}@click" placement="bottom-end" offset="4">
                <sp-popover style="min-width: var(--spectrum-component-width-900, 64px)">
                  <sp-menu
                    label="CSS unit"
                    @change=${(e: Event) => {
                      const chosen = (e.target as HTMLInputElement).value;
                      if (keywords.includes(chosen)) {
                        onChange(chosen);
                      } else if (units.includes(chosen)) {
                        const curMatch = String(value ?? "").match(UNIT_RE);
                        const numPart = curMatch ? curMatch[1] : "";
                        if (numPart) onChange(numPart + chosen);
                      }
                    }}
                  >
                    ${units.map((u: string) => html`<sp-menu-item value=${u}>${u}</sp-menu-item>`)}
                    ${keywords.length > 0 && units.length > 0
                      ? html`<sp-menu-divider></sp-menu-divider>`
                      : nothing}
                    ${keywords.map(
                      (kw: string) => html`<sp-menu-item value=${kw}>${kw}</sp-menu-item>`,
                    )}
                  </sp-menu>
                </sp-popover>
              </sp-overlay>
            `
          : nothing}
      </div>
    </div>
  `;
}
