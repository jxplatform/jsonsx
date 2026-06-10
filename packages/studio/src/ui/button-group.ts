/// <reference lib="dom" />
/**
 * Button-group.js — Action group + overflow picker widget.
 *
 * Renders a compact button group for enum values with an optional overflow picker for additional
 * options that don't fit in the button bar.
 */

import { html, nothing } from "lit-html";
import { classMap } from "lit-html/directives/class-map.js";
import { abbreviateValue, kebabToLabel } from "../utils/studio-utils";
import icons from "./icons";

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
  /** @type {Record<string, unknown>} */ entry: Record<string, unknown>,
  /** @type {string} */ prop: string,
  /** @type {string | number | undefined} */ value: string | number | undefined,
  /** @type {(val: string) => void} */ onChange: (val: string) => void,
) {
  const values = (entry.$buttonValues || entry.enum || []) as string[];
  const iconMap: Record<string, string> = (entry.$icons || {}) as Record<string, string>;
  const buttonValues = entry.$buttonValues as string[] | undefined;
  const enumValues = entry.enum as string[] | undefined;
  const extra =
    buttonValues && enumValues && enumValues.length > buttonValues.length
      ? enumValues.filter((v: string) => !buttonValues.includes(v))
      : [];

  const menuId = `style-btngrp-${prop}`;
  const hasExtra = extra.length > 0;
  const extraSelected = hasExtra && extra.includes(String(value));

  return html`
    <div
      class=${classMap({
        "button-group-combo": true,
        "has-overflow": hasExtra,
      })}
    >
      <sp-action-group size="s" compact>
        ${values.map(
          (v: string) => html`
            <sp-action-button
              size="s"
              value=${v}
              title=${v}
              ?selected=${v === value}
              @click=${() => onChange(v === value ? "" : v)}
            >
              ${iconMap[v] && (icons as Record<string, unknown>)[iconMap[v]]
                ? (icons as Record<string, unknown>)[iconMap[v]]
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
                  @change=${(e: Event) => {
                    if ((e.target as HTMLInputElement).value)
                      onChange((e.target as HTMLInputElement).value);
                  }}
                >
                  <sp-menu-item value="__none__">—</sp-menu-item>
                  ${extra.map((v: string) => {
                    const label = v.includes("-")
                      ? kebabToLabel(v)
                      : v.replace(/^./, (c: string) => c.toUpperCase());
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
