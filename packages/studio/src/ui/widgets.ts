/// <reference lib="dom" />
/**
 * Widgets.js — Widget type dispatcher and simple widget renderers.
 *
 * This module provides `widgetForType()` which dispatches to the appropriate widget based on the
 * inferred type from css-meta/schema entries, plus the simpler widget renderers (text, number,
 * select/combobox).
 *
 * Complex widgets are imported from their dedicated modules: - renderColorSelector →
 * ui/color-selector.js - renderUnitSelector → ui/unit-selector.js - renderButtonGroup →
 * ui/button-group.js
 */

import { html } from "lit-html";
import { live } from "lit-html/directives/live.js";
import { ifDefined } from "lit-html/directives/if-defined.js";
import { debouncedStyleCommit } from "../store";
import { renderColorSelector } from "./color-selector";
import { renderUnitSelector } from "./unit-selector";
import { renderButtonGroup } from "./button-group";
import { renderMediaPicker } from "./media-picker";
import type { TemplateResult } from "lit-html";

/**
 * Render a plain text input widget.
 *
 * @param {string} prop
 * @param {string | number | undefined} value
 * @param {(val: string) => void} onChange
 * @param {string} [placeholder]
 * @returns {import("lit-html").TemplateResult}
 */
export function renderTextInput(
  prop: string,
  value: string | number | undefined,
  onChange: (val: string) => void,
  placeholder = "",
) {
  return html`
    <sp-textfield
      size="s"
      placeholder=${placeholder}
      .value=${live(String(value ?? ""))}
      @input=${debouncedStyleCommit(`text:${prop}`, 400, (e: Event) =>
        onChange((e.target as HTMLInputElement).value),
      )}
    ></sp-textfield>
  `;
}

/**
 * Render a number input widget (sp-number-field).
 *
 * @param {Record<string, unknown>} entry
 * @param {string} prop
 * @param {string | number | undefined} value
 * @param {(val: string | number) => void} onChange
 * @param {string} [placeholder]
 * @returns {import("lit-html").TemplateResult}
 */
export function renderNumberInput(
  entry: Record<string, unknown>,
  prop: string,
  value: string | number | undefined,
  onChange: (val: string | number) => void,
  placeholder = "",
) {
  const minimum = entry.minimum as number | undefined;
  const maximum = entry.maximum as number | undefined;
  return html`
    <sp-number-field
      size="s"
      hide-stepper
      .value=${live(value !== undefined && value !== "" ? Number(value) : undefined)}
      placeholder=${placeholder}
      min=${ifDefined(minimum)}
      max=${ifDefined(maximum)}
      step=${ifDefined(maximum !== undefined && maximum <= 1 ? 0.1 : undefined)}
      @change=${debouncedStyleCommit(`num:${prop}`, 400, (e: Event) => {
        const v = (e.target as HTMLInputElement & { value: number | undefined }).value;
        if (v === undefined || Number.isNaN(v)) {
          onChange("");
        } else {
          onChange(Number(v));
        }
      })}
    ></sp-number-field>
  `;
}

/**
 * Dispatch to the appropriate widget based on inferred type.
 *
 * @param {string} type — one of: button-group, color, number-unit, number, select, combobox, text
 * @param {Record<string, unknown>} entry — css-meta or schema entry
 * @param {string} prop — property key
 * @param {string | number | undefined} value — current value
 * @param {(val: string | number) => void} onCommit — commit callback
 * @param {{
 *   placeholder?: string;
 *   renderSelect?: (
 *     entry: Record<string, unknown>,
 *     prop: string,
 *     value: string | number | undefined,
 *     onCommit: (val: string | number) => void,
 *   ) => import("lit-html").TemplateResult;
 *   renderCombobox?: (
 *     entry: Record<string, unknown>,
 *     prop: string,
 *     value: string | number | undefined,
 *     onCommit: (val: string | number) => void,
 *   ) => import("lit-html").TemplateResult;
 * }} [opts]
 * @returns {import("lit-html").TemplateResult}
 */
export function widgetForType(
  type: string,
  entry: Record<string, unknown>,
  prop: string,
  value: string | number | undefined,
  onCommit: (val: string | number) => void,
  opts: {
    placeholder?: string;
    renderSelect?: (
      entry: Record<string, unknown>,
      prop: string,
      value: string | number | undefined,
      onCommit: (val: string | number) => void,
    ) => TemplateResult;
    renderCombobox?: (
      entry: Record<string, unknown>,
      prop: string,
      value: string | number | undefined,
      onCommit: (val: string | number) => void,
    ) => TemplateResult;
  } = {},
) {
  switch (type) {
    case "button-group": {
      return renderButtonGroup(entry, prop, value, onCommit);
    }
    case "color": {
      return renderColorSelector(prop, value, onCommit);
    }
    case "number-unit": {
      return renderUnitSelector(entry, prop, value, onCommit, opts.placeholder);
    }
    case "number": {
      return renderNumberInput(entry, prop, value, onCommit, opts.placeholder);
    }
    case "media": {
      return renderMediaPicker(prop, String(value ?? ""), onCommit);
    }
    case "select": {
      // Allow caller to override select rendering (e.g. for typography preview)
      if (opts.renderSelect) {
        return opts.renderSelect(entry, prop, value, onCommit);
      }
      return renderTextInput(prop, value, onCommit, opts.placeholder);
    }
    case "combobox": {
      // Allow caller to override combobox rendering (e.g. for font family)
      if (opts.renderCombobox) {
        return opts.renderCombobox(entry, prop, value, onCommit);
      }
      return renderTextInput(prop, value, onCommit, opts.placeholder);
    }
    default: {
      return renderTextInput(prop, value, onCommit, opts.placeholder);
    }
  }
}
