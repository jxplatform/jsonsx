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
 * @param {any} entry — css-meta entry with $buttonValues, enum, $icons
 * @param {string} prop — property key (for menu ID namespace)
 * @param {any} value — current value
 * @param {(val: string) => void} onChange — commit callback
 * @returns {any}
 */
export function renderButtonGroup(
  /** @type {any} */ entry,
  /** @type {any} */ prop,
  /** @type {any} */ value,
  /** @type {any} */ onChange,
) {
  const values = entry.$buttonValues || entry.enum || [];
  /** @type {Record<string, any>} */
  const iconMap = entry.$icons || {};
  const extra =
    entry.$buttonValues && entry.enum && entry.enum.length > entry.$buttonValues.length
      ? entry.enum.filter((/** @type {any} */ v) => !entry.$buttonValues.includes(v))
      : [];

  const menuId = `style-btngrp-${prop}`;
  const hasExtra = extra.length > 0;
  const extraSelected = hasExtra && extra.includes(value);

  return html`
    <div class=${classMap({ "button-group-combo": true, "has-overflow": hasExtra })}>
      <sp-action-group size="s" compact>
        ${values.map(
          (/** @type {any} */ v) => html`
            <sp-action-button
              size="s"
              value=${v}
              title=${v}
              ?selected=${v === value}
              @click=${() => onChange(v === value ? "" : v)}
            >
              ${
                /** @type {any} */ (iconMap)[v] &&
                /** @type {any} */ (icons)[/** @type {any} */ (iconMap)[v]]
                  ? /** @type {any} */ (icons)[/** @type {any} */ (iconMap)[v]]
                  : abbreviateValue(v)
              }
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
                  @change=${(/** @type {any} */ e) => {
                    if (e.target.value) onChange(e.target.value);
                  }}
                >
                  <sp-menu-item value="__none__">—</sp-menu-item>
                  ${extra.map((/** @type {any} */ v) => {
                    const label = v.includes("-")
                      ? kebabToLabel(v)
                      : v.replace(/^./, (/** @type {any} */ c) => c.toUpperCase());
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
