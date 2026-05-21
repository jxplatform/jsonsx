/** Style input widgets — keyword, select, combobox, and font renderers for the style panel. */

import { html } from "lit-html";
import { live } from "lit-html/directives/live.js";
import { getState, debouncedStyleCommit } from "../store.js";
import { activeTab } from "../workspace/workspace.js";
import { transactDoc, mutateUpdateStyle } from "../tabs/transact.js";
import { widgetForType as _widgetForType } from "../ui/widgets.js";
import { kebabToLabel, friendlyNameToVar, varDisplayName } from "../utils/studio-utils.js";
import {
  TYPO_PREVIEW_PROPS,
  currentFontFamily,
  getFontVars,
  getCssInitialMap,
  camelToKebab,
} from "./style-utils.js";

/**
 * Dual-mode keyword input — shared by select (enum) and combobox (examples) widgets.
 *
 * @param {any} options @param {any} prop @param {any} value @param {any} onChange
 */
export function renderKeywordInput(options, prop, value, onChange) {
  const cssInitialMap = getCssInitialMap();
  const isTypoPreview = TYPO_PREVIEW_PROPS.has(prop) || prop === "fontWeight";
  const font = isTypoPreview ? currentFontFamily() : "";
  const cssProp = isTypoPreview ? camelToKebab(prop) : "";

  const comboOptions = options.map((/** @type {any} */ v) => {
    const label = v.includes("-")
      ? kebabToLabel(v)
      : v.replace(/^./, (/** @type {any} */ c) => c.toUpperCase());
    const style = isTypoPreview ? `${cssProp}: ${v};${font ? ` font-family: ${font}` : ""}` : "";
    return { value: v, label, style };
  });

  return html`<jx-value-selector
    size="s"
    .value=${value || ""}
    placeholder=${cssInitialMap.get(prop) || ""}
    .options=${comboOptions}
    @change=${(/** @type {any} */ e) => onChange(e.target.value)}
    @input=${debouncedStyleCommit(`kw:${prop}`, 400, (/** @type {any} */ e) =>
      onChange(e.target.value),
    )}
  ></jx-value-selector>`;
}

/** @param {any} entry @param {any} prop @param {any} value @param {any} onChange */
export function renderSelectInput(entry, prop, value, onChange) {
  return renderKeywordInput(entry.enum || [], prop, value, onChange);
}

/** @param {any} preset @param {any} onChange */
function handleFontPresetSelection(preset, onChange) {
  const S = getState();
  const varName = friendlyNameToVar(preset.title, "--font-");
  if (!S.document?.style?.[varName]) {
    transactDoc(activeTab.value, (t) => mutateUpdateStyle(t, [], varName, preset.value));
  }
  onChange(`var(${varName})`);
}

/** @param {any} val @param {any} presets @param {any} onChange */
function handleFontSelection(val, presets, onChange) {
  if (!val) return;
  if (val.startsWith("__preset__:")) {
    const title = val.slice("__preset__:".length);
    const preset = presets.find((/** @type {any} */ p) => p.title === title);
    if (preset) handleFontPresetSelection(preset, onChange);
    return;
  }
  if (val.startsWith("--")) {
    onChange(`var(${val})`);
    return;
  }
  const preset = presets.find((/** @type {any} */ p) => p.title === val);
  if (preset) {
    handleFontPresetSelection(preset, onChange);
    return;
  }
  const fontVars = getFontVars();
  const matchedVar = fontVars.find(
    (/** @type {any} */ fv) => varDisplayName(fv.name, "--font-") === val,
  );
  if (matchedVar) {
    onChange(`var(${matchedVar.name})`);
    return;
  }
  onChange(val);
}

/**
 * Build font options array for jx-value-selector.
 *
 * @param {any[]} fontVars @param {any[]} presets
 * @returns {{ value: string; label: string; style: string }[] | { divider: true }[]}
 */
export function buildFontOptions(fontVars, presets) {
  /** @type {any[]} */
  const opts = fontVars.map((/** @type {any} */ fv) => ({
    value: fv.name,
    label: varDisplayName(fv.name, "--font-"),
    style: `font-family: ${fv.value}`,
  }));
  const unadded = presets.filter(
    (/** @type {any} */ p) =>
      !fontVars.some((/** @type {any} */ fv) => fv.name === friendlyNameToVar(p.title, "--font-")),
  );
  if (unadded.length > 0 && opts.length > 0) opts.push({ divider: true });
  for (const p of unadded) {
    opts.push({
      value: "__preset__:" + p.title,
      label: p.title,
      style: `font-family: ${p.value}`,
    });
  }
  return opts;
}

/** @param {any} entry @param {any} prop @param {any} value @param {any} onChange */
export function renderComboboxInput(entry, prop, value, onChange) {
  const cssInitialMap = getCssInitialMap();
  const fontVars = prop === "fontFamily" ? getFontVars() : [];
  const presets = entry.presets || [];
  const examples = entry.examples || [];

  if (prop === "fontFamily") {
    const varMatch = typeof value === "string" && value.match(/^var\((--[^)]+)\)$/);
    const comboValue = varMatch ? varMatch[1] : value || "";
    const fontOptions = buildFontOptions(fontVars, presets);
    return html`<jx-value-selector
      size="s"
      .value=${comboValue}
      placeholder=${cssInitialMap.get("fontFamily") || ""}
      .options=${fontOptions}
      @change=${(/** @type {any} */ e) => handleFontSelection(e.target.value, presets, onChange)}
      @input=${debouncedStyleCommit("combo:fontFamily", 400, (/** @type {any} */ e) =>
        onChange(e.target.value),
      )}
    ></jx-value-selector>`;
  }

  if (examples.length > 0) {
    return renderKeywordInput(examples, prop, value, onChange);
  }

  return html`
    <sp-textfield
      size="s"
      placeholder=${cssInitialMap.get(prop) || ""}
      .value=${live(value || "")}
      @input=${debouncedStyleCommit(`combo:${prop}`, 400, (/** @type {any} */ e) =>
        onChange(e.target.value),
      )}
    ></sp-textfield>
  `;
}

/**
 * Style-aware widgetForType — wraps the generic widget renderer with style-specific select/combobox
 * inputs and CSS initial-value placeholders.
 */
export function widgetForType(
  /** @type {any} */ type,
  /** @type {any} */ entry,
  /** @type {any} */ prop,
  /** @type {any} */ value,
  /** @type {any} */ onCommit,
  /** @type {any} */ opts = {},
) {
  const cssInitialMap = getCssInitialMap();
  return _widgetForType(type, entry, prop, value, onCommit, {
    placeholder: opts.placeholder || cssInitialMap.get(prop) || "",
    renderSelect: renderSelectInput,
    renderCombobox: renderComboboxInput,
  });
}
