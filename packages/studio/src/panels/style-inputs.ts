/// <reference lib="dom" />
/** Style input widgets — keyword, select, combobox, and font renderers for the style panel. */

import { html } from "lit-html";
import { live } from "lit-html/directives/live.js";
import { debouncedStyleCommit } from "../store";
import { activeTab } from "../workspace/workspace";
import { mutateUpdateStyle, transactDoc } from "../tabs/transact";
import { widgetForType as _widgetForType } from "../ui/widgets";
import { friendlyNameToVar, kebabToLabel, varDisplayName } from "../utils/studio-utils";
import {
  TYPO_PREVIEW_PROPS,
  camelToKebab,
  currentFontFamily,
  getCssInitialMap,
  getFontVars,
} from "./style-utils";

/**
 * Dual-mode keyword input — shared by select (enum) and combobox (examples) widgets.
 *
 * @param {string[]} options @param {string} prop @param {string} value @param {(value: string) =>
 *   void} onChange
 */
export function renderKeywordInput(
  options: string[],
  prop: string,
  value: string,
  onChange: (value: string) => void,
) {
  const cssInitialMap = getCssInitialMap();
  const isTypoPreview = TYPO_PREVIEW_PROPS.has(prop) || prop === "fontWeight";
  const font = isTypoPreview ? currentFontFamily() : "";
  const cssProp = isTypoPreview ? camelToKebab(prop) : "";

  const comboOptions = options.map((v: string) => {
    const label = v.includes("-")
      ? kebabToLabel(v)
      : v.replace(/^./, (c: string) => c.toUpperCase());
    const style = isTypoPreview ? `${cssProp}: ${v};${font ? ` font-family: ${font}` : ""}` : "";
    return { label, style, value: v };
  });

  return html`<jx-value-selector
    size="s"
    .value=${value || ""}
    placeholder=${cssInitialMap.get(prop) || ""}
    .options=${comboOptions}
    @change=${(e: Event) => onChange((e.target as HTMLInputElement).value)}
    @input=${debouncedStyleCommit(`kw:${prop}`, 400, (e: Event) =>
      onChange((e.target as HTMLInputElement).value),
    )}
  ></jx-value-selector>`;
}

/**
 * @param {Record<string, unknown>} entry @param {string} prop @param {string | number | undefined}
 *   value @param {(value: string) => void} onChange
 */
export function renderSelectInput(
  entry: Record<string, unknown>,
  prop: string,
  value: string | number | undefined,
  onChange: (value: string) => void,
) {
  const options = Array.isArray(entry.enum) ? (entry.enum as string[]) : [];
  return renderKeywordInput(options, prop, String(value ?? ""), onChange);
}

/** @param {{ title: string; value: string }} preset @param {(value: string) => void} onChange */
function handleFontPresetSelection(
  preset: { title: string; value: string },
  onChange: (value: string) => void,
) {
  const varName = friendlyNameToVar(preset.title, "--font-");
  if (!activeTab.value?.doc.document?.style?.[varName]) {
    transactDoc(activeTab.value, (t) => mutateUpdateStyle(t, [], varName, preset.value));
  }
  onChange(`var(${varName})`);
}

/**
 * @param {string} val @param {{ title: string; value: string }[]} presets @param {(value: string)
 *   => void} onChange
 */
function handleFontSelection(
  val: string,
  presets: { title: string; value: string }[],
  onChange: (value: string) => void,
) {
  if (!val) {
    return;
  }
  if (val.startsWith("__preset__:")) {
    const title = val.slice("__preset__:".length);
    const preset = presets.find(
      (/** @type {{ title: string; value: string }} */ p) => p.title === title,
    );
    if (preset) {
      handleFontPresetSelection(preset, onChange);
    }
    return;
  }
  if (val.startsWith("--")) {
    onChange(`var(${val})`);
    return;
  }
  const preset = presets.find(
    (/** @type {{ title: string; value: string }} */ p) => p.title === val,
  );
  if (preset) {
    handleFontPresetSelection(preset, onChange);
    return;
  }
  const fontVars = getFontVars();
  const matchedVar = fontVars.find(
    (/** @type {{ name: string; value: string }} */ fv) =>
      varDisplayName(fv.name, "--font-") === val,
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
 * @param {{ name: string; value: string }[]} fontVars @param {{ title: string; value: string }[]}
 *   presets
 * @returns {({ value: string; label: string; style: string } | { divider: true })[]}
 */
export function buildFontOptions(
  fontVars: { name: string; value: string }[],
  presets: { title: string; value: string }[],
) {
  const opts: ({ value: string; label: string; style: string } | { divider: true })[] =
    fontVars.map((fv) => ({
      label: varDisplayName(fv.name, "--font-"),
      style: `font-family: ${fv.value}`,
      value: fv.name,
    }));
  const unadded = presets.filter(
    (/** @type {{ title: string; value: string }} */ p) =>
      !fontVars.some(
        (/** @type {{ name: string; value: string }} */ fv) =>
          fv.name === friendlyNameToVar(p.title, "--font-"),
      ),
  );
  if (unadded.length > 0 && opts.length > 0) {
    opts.push({ divider: true });
  }
  for (const p of unadded) {
    opts.push({
      label: p.title,
      style: `font-family: ${p.value}`,
      value: `__preset__:${p.title}`,
    });
  }
  return opts;
}

/**
 * @param {{
 *   enum?: string[];
 *   examples?: string[];
 *   presets?: { title: string; value: string }[];
 * }} entry
 * @param {string} prop @param {string} value @param {(value: string) => void} onChange
 */
export function renderComboboxInput(
  entry: Record<string, unknown>,
  prop: string,
  rawValue: string | number | undefined,
  onChange: (value: string) => void,
) {
  const value = String(rawValue ?? "");
  const cssInitialMap = getCssInitialMap();
  const fontVars = prop === "fontFamily" ? getFontVars() : [];
  const presets = Array.isArray(entry.presets)
    ? (entry.presets as { title: string; value: string }[])
    : [];
  const examples = Array.isArray(entry.examples) ? (entry.examples as string[]) : [];

  if (prop === "fontFamily") {
    const varMatch = typeof value === "string" && value.match(/^var\((--[^)]+)\)$/);
    const comboValue = varMatch ? varMatch[1] : value || "";
    const fontOptions = buildFontOptions(fontVars, presets);
    return html`<jx-value-selector
      size="s"
      .value=${comboValue}
      placeholder=${cssInitialMap.get("fontFamily") || ""}
      .options=${fontOptions}
      @change=${(e: Event) =>
        handleFontSelection((e.target as HTMLInputElement).value, presets, onChange)}
      @input=${debouncedStyleCommit("combo:fontFamily", 400, (e: Event) =>
        onChange((e.target as HTMLInputElement).value),
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
      @input=${debouncedStyleCommit(`combo:${prop}`, 400, (e: Event) =>
        onChange((e.target as HTMLInputElement).value),
      )}
    ></sp-textfield>
  `;
}

/**
 * Style-aware widgetForType — wraps the generic widget renderer with style-specific select/combobox
 * inputs and CSS initial-value placeholders.
 */
export function widgetForType(
  type: string,
  entry: Record<string, unknown>,
  prop: string,
  value: string,
  onCommit: (value: string) => void,
  opts: { placeholder?: string } = {},
) {
  const cssInitialMap = getCssInitialMap();
  return _widgetForType(type, entry, prop, value, onCommit as (val: string | number) => void, {
    placeholder: opts.placeholder || cssInitialMap.get(prop) || "",
    renderCombobox: renderComboboxInput,
    renderSelect: renderSelectInput,
  });
}
