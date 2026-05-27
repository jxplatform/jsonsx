/**
 * Button-group.js — Action group + overflow picker widget.
 *
 * Renders a compact button group for enum values with an optional overflow picker for additional
 * options that don't fit in the button bar.
 */

import { html, nothing } from "lit-html";
import { classMap } from "lit-html/directives/class-map.js";
import { abbreviateValue, kebabToLabel } from "../utils/studio-utils.js";
import icons from "./icons.js";

/**
 * Render a button group widget with optional overflow menu.
 *
 * @param {Record<string, unknown>} entry — css-meta entry with $buttonValues, enum, $icons
 * @param {string} prop — property key (for menu ID namespace)
 * @param {string | number | undefined} value — current value
 * @param {(val: string) => void} onChange — commit callback
 * @returns {import("lit-html").TemplateResult}
 */
export function renderButtonGroup(
  /** @type {Record<string, unknown>} */ entry,
  /** @type {string} */ prop,
  /** @type {string | number | undefined} */ value,
  /** @type {(val: string) => void} */ onChange,
) {
  const values = /** @type {string[]} */ (entry.$buttonValues || entry.enum || []);
  /** @type {Record<string, string>} */
  const iconMap = /** @type {Record<string, string>} */ (entry.$icons || {});
  const buttonValues = /** @type {string[] | undefined} */ (entry.$buttonValues);
  const enumValues = /** @type {string[] | undefined} */ (entry.enum);
  const extra =
    buttonValues && enumValues && enumValues.length > buttonValues.length
      ? enumValues.filter((/** @type {string} */ v) => !buttonValues.includes(v))
      : [];

  const menuId = `style-btngrp-${prop}`;
  const hasExtra = extra.length > 0;
  const extraSelected = hasExtra && extra.includes(/** @type {string} */ (value));

  return html`
    <div class=${classMap({ "button-group-combo": true, "has-overflow": hasExtra })}>
      <sp-action-group size="s" compact>
        ${values.map(
          (/** @type {string} */ v) => html`
            <sp-action-button
              size="s"
              value=${v}
              title=${v}
              ?selected=${v === value}
              @click=${() => onChange(v === value ? "" : v)}
            >
              ${iconMap[v] && /** @type {Record<string, unknown>} */ (icons)[iconMap[v]]
                ? /** @type {Record<string, unknown>} */ (icons)[iconMap[v]]
                : abbreviateValue(v)}
            </sp-action-button>
          `,
        )}
      </sp-action-group>
      ${hasExtra
        ? html`
            <sp-picker-button
              size="s"
              id=${menuId}
              class=${classMap({ "has-selection": extraSelected })}
            ></sp-picker-button>
            <sp-overlay trigger="${menuId}@click" placement="bottom-end" type="auto">
              <sp-popover>
                <sp-menu
                  @change=${(/** @type {Event} */ e) => {
                    if (/** @type {HTMLInputElement} */ (e.target).value)
                      onChange(/** @type {HTMLInputElement} */ (e.target).value);
                  }}
                >
                  <sp-menu-item value="__none__">—</sp-menu-item>
                  ${extra.map((/** @type {string} */ v) => {
                    const label = v.includes("-")
                      ? kebabToLabel(v)
                      : v.replace(/^./, (/** @type {string} */ c) => c.toUpperCase());
                    return html`<sp-menu-item value=${v} ?selected=${v === value}
                      >${label}</sp-menu-item
                    >`;
                  })}
                </sp-menu>
              </sp-popover>
            </sp-overlay>
          `
        : nothing}
    </div>
  `;
}
