/**
 * Unit-selector.js — Number + unit picker widget.
 *
 * Renders a text field for numeric input paired with a unit picker dropdown. Handles keywords
 * (auto, inherit, etc.) alongside numeric+unit values.
 */

import { html, nothing } from "lit-html";
import { live } from "lit-html/directives/live.js";
import { classMap } from "lit-html/directives/class-map.js";
import { debouncedStyleCommit } from "../store.js";

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
  /** @type {Record<string, unknown>} */ entry,
  /** @type {string} */ prop,
  /** @type {string | number | undefined} */ value,
  /** @type {(val: string) => void} */ onChange,
  /** @type {string} */ placeholder = "",
) {
  const units = /** @type {string[]} */ (entry.$units || []);
  const keywords = /** @type {string[]} */ (entry.$keywords || []);
  const strVal = String(value ?? "");
  const match = strVal.match(UNIT_RE);
  const isKeyword = !match && strVal !== "" && keywords.includes(strVal);
  const isNumericVal = (/** @type {string} */ v) => /^-?\d*\.?\d*$/.test(v);

  const currentUnit = isKeyword ? units[0] || "" : match ? match[2] || "" : units[0] || "";
  let displayValue;
  if (isKeyword) displayValue = strVal;
  else if (match) displayValue = match[1];
  else if (strVal !== "") {
    const num = parseFloat(strVal);
    displayValue = isNaN(num) ? strVal : String(num);
  } else displayValue = "";

  const isExpression = isKeyword || (displayValue !== "" && !isNumericVal(displayValue));
  const hasUnits = units.length > 0 || keywords.length > 0;
  const btnId = `style-unit-${prop}`;

  return html`
    <div class="style-input-number-unit">
      <div class=${classMap({ "input-group": true, "is-expression": isExpression })}>
        <sp-textfield
          size="s"
          placeholder=${placeholder || "0"}
          .value=${live(displayValue)}
          @input=${debouncedStyleCommit(`nui:${prop}`, 400, (/** @type {Event} */ e) => {
            const val = /** @type {HTMLInputElement} */ (e.target).value.trim();
            if (val === "") {
              onChange("");
              return;
            }
            if (isNumericVal(val)) onChange(units.length > 0 ? val + currentUnit : val);
            else onChange(val);
          })}
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
                    @change=${(/** @type {Event} */ e) => {
                      const chosen = /** @type {HTMLInputElement} */ (e.target).value;
                      if (keywords.includes(chosen)) {
                        onChange(chosen);
                      } else if (units.includes(chosen)) {
                        const curMatch = String(value ?? "").match(UNIT_RE);
                        const numPart = curMatch ? curMatch[1] : "";
                        if (numPart) onChange(numPart + chosen);
                      }
                    }}
                  >
                    ${units.map(
                      (/** @type {string} */ u) =>
                        html`<sp-menu-item value=${u}>${u}</sp-menu-item>`,
                    )}
                    ${keywords.length > 0 && units.length > 0
                      ? html`<sp-menu-divider></sp-menu-divider>`
                      : nothing}
                    ${keywords.map(
                      (/** @type {string} */ kw) =>
                        html`<sp-menu-item value=${kw}>${kw}</sp-menu-item>`,
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
