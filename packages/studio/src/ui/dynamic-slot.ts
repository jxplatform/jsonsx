/// <reference lib="dom" />
/**
 * Dynamic-slot — the shared Value Source control for any bindable document position.
 *
 * Renders the panel-provided static widget plus a label-side chip that names, in plain language,
 * how this value is produced — Fixed value / From data… / Mixed text / Formula
 * (`ui/value-source.ts` owns the vocabulary). Clicking the chip opens a picker listing every rung
 * the position permits, so **any rung is one action away**. It used to be a cycle ring: `$ref →
 * literal` meant passing through `${}`, committing a template to the document on the way past, and
 * the only way to know where the next click would land was the tooltip.
 *
 * The rungs are not declared by the caller but **derived from the schema** at the named position
 * (plan §6.3): `caps` is a {@link SlotPosition}, or a schema handed in for the one case a position
 * name cannot cover — a field in an extension's config form, whose schema arrives at runtime. There
 * is no way for a caller to state a rung list of its own.
 *
 * Each mode's last value is remembered per field for the session, so switching back to an earlier
 * mode restores what the user had there. The same memory is exported for the Events tab, which
 * offers the same ladder in its own layout.
 */

import { html, nothing } from "lit-html";
import { live } from "lit-html/directives/live.js";
import { isRef } from "@jxsuite/schema/guards";
import { cloneValue } from "../tabs/doc-op-apply";
import { activeTab } from "../workspace/workspace";
import { renderExpressionEditor } from "./expression-editor";
import { VALUE_SOURCE_HINTS, VALUE_SOURCE_LABELS, slotCaps, slotMode } from "./value-source";

import type { TemplateResult } from "lit-html";
import type { EditorPreview } from "./expression-editor";
import type { JxStateDefinition } from "@jxsuite/schema/types";
import type { JsonValue } from "../types";
import type { SlotCapsSource, SlotMode } from "./value-source";

export type { SlotCapsSource, SlotMode, SlotPosition } from "./value-source";
export { slotCaps, slotMode } from "./value-source";

/*
 * Session memory of each field's last value per mode, so switching modes round-trips user input.
 * Keyed `${tabId}|${fieldKey}|${mode}`; the mode key is derived from the value at stash time, so a
 * restore always lands a value whose slotMode() matches the target mode. `undefined` is a
 * legitimate stash (cleared literal), hence Map.has() discrimination on recall.
 */
const slotModeMemory = new Map<string, JsonValue | undefined>();

/*
 * The rung each field is CURRENTLY being edited at, keyed `${tabId}|${fieldKey}`.
 *
 * Without this the rendered rung was re-sniffed from the document value on every render, so typing
 * `${` into a Fixed value field swapped the widget out from under the cursor mid-keystroke — and
 * typing the closing brace away swapped it back. A keystroke can only ever move a value between
 * the literal and mixed-text rungs (both are plain strings); every other transition needs a
 * structural change to the value, which a text edit cannot make. So those two rungs hold once
 * entered, and everything else still follows the document.
 */
const slotModeRendered = new Map<string, SlotMode>();

/** Test hook: drop all remembered per-mode field values and per-field rungs. */
export function resetSlotModeMemory(): void {
  slotModeMemory.clear();
  slotModeRendered.clear();
}

function memoryKey(fieldKey: string, mode: SlotMode): string {
  return `${activeTab.value?.id ?? "-"}|${fieldKey}|${mode}`;
}

function fieldScopeKey(fieldKey: string): string {
  return `${activeTab.value?.id ?? "-"}|${fieldKey}`;
}

/** Remember `value` as this field's representation at `mode`, for a later switch back. */
export function stashSlotValue(
  fieldKey: string,
  mode: SlotMode,
  value: JsonValue | undefined,
): void {
  slotModeMemory.set(memoryKey(fieldKey, mode), cloneValue(value));
}

/** Whether this field has a remembered representation at `mode`. */
export function hasStashedSlotValue(fieldKey: string, mode: SlotMode): boolean {
  return slotModeMemory.has(memoryKey(fieldKey, mode));
}

/** This field's remembered representation at `mode` (a fresh clone). */
export function recallSlotValue(fieldKey: string, mode: SlotMode): JsonValue | undefined {
  return cloneValue(slotModeMemory.get(memoryKey(fieldKey, mode)));
}

/** Record the rung the user just chose for this field, so the next render honours it. */
export function setSlotMode(fieldKey: string, mode: SlotMode): void {
  slotModeRendered.set(fieldScopeKey(fieldKey), mode);
}

/** Whether a keystroke alone could have produced this rung transition. */
function isTextEditRung(mode: SlotMode): boolean {
  return mode === "literal" || mode === "template";
}

/**
 * The rung to render this field at: the one it is already being edited at when a text edit could
 * explain the difference, otherwise whatever the document value says. Records its answer.
 */
export function effectiveSlotMode(fieldKey: string, value: unknown): SlotMode {
  const key = fieldScopeKey(fieldKey);
  const sniffed = slotMode(value);
  const previous = slotModeRendered.get(key);
  const mode =
    previous !== undefined && isTextEditRung(previous) && isTextEditRung(sniffed)
      ? previous
      : sniffed;
  slotModeRendered.set(key, mode);
  return mode;
}

function hasRefOptions(opts: DynamicSlotOpts): boolean {
  return opts.stateDefs.length > 0 || Boolean(opts.extraSignals?.length);
}

export interface SignalOption {
  value: string;
  label: string;
}

export interface DynamicSlotOpts {
  /** Stable identity for per-mode value memory; must incorporate the node path. */
  fieldKey: string;
  /** Current raw document value at this position. */
  value: unknown;
  /** Write-through to the document; `undefined` clears the position. */
  onChange: (v?: JsonValue) => void;
  /** Panel-provided literal editor for this slot's type. */
  staticWidget: unknown;
  /** Where this slot's rungs are derived from — a named document position, or a schema. */
  caps: SlotCapsSource;
  /** State keys offered by the ref picker and expression editor. */
  stateDefs: string[];
  /**
   * Let the From data… rung take a pointer that is not in its list.
   *
   * The list is complete wherever it is a component's own signals. It is not complete in an
   * extension's config form, where a value may point at a route param, a signal, or a pointer
   * neither the form nor the panel enumerates — so there the same rung is a combobox whose options
   * are suggestions, which is what `jx-value-selector` is for.
   */
  allowCustomRef?: boolean;
  /** Full state defs map — lets expression mode resolve named-formula catalog entries. */
  stateEntries?: Record<string, JxStateDefinition> | null;
  /** Extra pointer options beyond #/state/* (e.g. $map/item within repeater templates). */
  extraSignals?: SignalOption[] | null;
  /** Offer event#/ refs inside expression mode (handler positions only). */
  allowEventRef?: boolean;
  /** Live values for expression mode badges (services/preview-eval.ts). */
  preview?: EditorPreview | null;
  /** Static value restored when de-escalating to literal mode. */
  literalDefault?: JsonValue;
  /**
   * A position-specific seed for a rung, overriding the generic one.
   *
   * The generic expression seed is `{ operator: "??" }`, which is a sensible starting point almost
   * everywhere and an INVALID document in a position whose schema narrows which operators it takes.
   * An element's `tagName` is the first such position — a `TagExpression` is `?:` or `switch` and
   * nothing else — so a generic seed would drop a document that fails its own validator the moment
   * the chip is clicked. Return `undefined` to accept the generic seed.
   */
  seedFor?: (mode: SlotMode) => JsonValue | undefined;
}

function defaultForSlotMode(mode: SlotMode, opts: DynamicSlotOpts): JsonValue | undefined {
  switch (mode) {
    case "ref": {
      const [first] = opts.stateDefs;
      return first ? { $ref: `#/state/${first}` } : { $ref: opts.extraSignals?.[0]?.value ?? "" };
    }
    case "template": {
      const [first] = opts.stateDefs;
      return first ? `\${state.${first}}` : "${}";
    }
    case "expression": {
      return { $expression: { operator: "??", target: null, value: null } };
    }
    case "function": {
      return { $prototype: "Function", body: "", parameters: [] };
    }
    default: {
      return opts.literalDefault;
    }
  }
}

/** Every pointer the From data… rung offers, as `{ value, label }` options. */
function refOptions(opts: DynamicSlotOpts): SignalOption[] {
  return [
    ...opts.stateDefs.map((name) => ({ label: name, value: `#/state/${name}` })),
    ...(opts.extraSignals ?? []),
  ];
}

function renderCustomRefWidget(refVal: string, opts: DynamicSlotOpts) {
  return html`
    <jx-value-selector
      size="s"
      style="flex:1"
      placeholder="#/state/…"
      .value=${refVal}
      .options=${refOptions(opts)}
      @change=${(e: Event & { detail?: { value?: string } }) => {
        const v = (e.detail?.value ?? (e.target as HTMLInputElement).value ?? "").trim();
        if (v) {
          opts.onChange({ $ref: v });
        } else {
          opts.onChange();
        }
      }}
    ></jx-value-selector>
  `;
}

function renderRefWidget(refVal: string, opts: DynamicSlotOpts) {
  if (opts.allowCustomRef) {
    return renderCustomRefWidget(refVal, opts);
  }
  return html`
    <sp-picker
      size="s"
      quiet
      style="flex:1"
      placeholder="— select signal —"
      value=${refVal || nothing}
      @change=${(e: Event) => {
        const v = (e.target as HTMLInputElement).value;
        if (v) {
          opts.onChange({ $ref: v });
        } else {
          opts.onChange();
        }
      }}
    >
      ${opts.stateDefs.map(
        (name) => html`<sp-menu-item value=${`#/state/${name}`}>${name}</sp-menu-item>`,
      )}
      ${
        opts.extraSignals?.length
          ? html`
              <sp-menu-divider></sp-menu-divider>
              ${opts.extraSignals.map(
                (sig) => html`<sp-menu-item value=${sig.value}>${sig.label}</sp-menu-item>`,
              )}
            `
          : nothing
      }
    </sp-picker>
  `;
}

function renderTemplateWidget(value: unknown, opts: DynamicSlotOpts) {
  return html`
    <sp-textfield
      size="s"
      style="flex:1;font-family:var(--spectrum-code-font-family, monospace)"
      placeholder="\${state.…}"
      .value=${live(String(value ?? ""))}
      @change=${(e: Event) => opts.onChange((e.target as HTMLInputElement).value)}
    ></sp-textfield>
  `;
}

export interface DynamicSlotParts {
  /** Label-side Value Source chip and its picker. */
  modeButton: TemplateResult;
  /** Active-mode widget, sized to fill the row's widget column. */
  widget: TemplateResult;
}

/**
 * Switch a field to `next`: stash the outgoing representation, restore the incoming one if this
 * field has been there before, and record the new rung. Shared with the Events tab, which used to
 * throw the outgoing representation away on every mode change.
 */
export function switchSlotMode(
  fieldKey: string,
  from: SlotMode,
  to: SlotMode,
  current: JsonValue | undefined,
  seed: JsonValue | undefined,
): JsonValue | undefined {
  stashSlotValue(fieldKey, from, current);
  setSlotMode(fieldKey, to);
  return hasStashedSlotValue(fieldKey, to) ? recallSlotValue(fieldKey, to) : seed;
}

/** A DOM id for the chip, so `sp-overlay` can name it as its trigger. */
function chipId(fieldKey: string): string {
  return `value-source-${fieldKey.replaceAll(/[^\dA-Za-z]+/g, "-")}`;
}

/**
 * The label-side Value Source chip: the current rung in plain language — quiet while the value is
 * fixed, accent-tinted once it is produced from something else — opening a picker of every rung
 * this position permits.
 */
function renderModeChip(mode: SlotMode, caps: SlotMode[], opts: DynamicSlotOpts): TemplateResult {
  const color =
    mode === "literal"
      ? "color:var(--spectrum-gray-600, #808080)"
      : "color:var(--spectrum-accent-content-color-default, #5c9dff)";
  // A ref rung with nothing to point at is a dead end — drop it rather than offer an empty picker.
  const offered = caps.filter((m) => m !== "ref" || hasRefOptions(opts));
  const label = VALUE_SOURCE_LABELS[mode];
  /* Disabled only when the rung this value already sits on is the only one there is. A value on a
     rung the position does NOT permit — a fixed string left in a `$switch`, say — is exactly the
     case that needs the chip most, and counting rungs alone used to grey it out. */
  if (!offered.some((m) => m !== mode)) {
    const hint = `Value source: ${label} (no other source available here)`;
    return html`
      <sp-action-button
        size="xs"
        quiet
        disabled
        class="dynamic-slot-mode"
        style=${color}
        title=${hint}
        aria-label=${hint}
        >${label}</sp-action-button
      >
    `;
  }
  const id = chipId(opts.fieldKey);
  const hint = `Value source: ${label} — click to change`;
  const choose = (next: SlotMode) => {
    if (next === mode) {
      return;
    }
    /* Leaving ref seeds an empty literal stash with the signal's declared default, so
       unbind-restores-default survives a detour (ref → mixed text → fixed value). */
    if (
      mode === "ref" &&
      opts.literalDefault !== undefined &&
      !hasStashedSlotValue(opts.fieldKey, "literal")
    ) {
      stashSlotValue(opts.fieldKey, "literal", opts.literalDefault);
    }
    opts.onChange(
      switchSlotMode(
        opts.fieldKey,
        mode,
        next,
        cloneValue(opts.value as JsonValue | undefined),
        opts.seedFor?.(next) ?? defaultForSlotMode(next, opts),
      ),
    );
  };
  return html`
    <sp-action-button
      id=${id}
      size="xs"
      quiet
      class="dynamic-slot-mode"
      style=${color}
      title=${hint}
      aria-label=${hint}
      >${label}</sp-action-button
    >
    <sp-overlay trigger="${id}@click" placement="bottom-start" type="auto">
      <sp-popover>
        <sp-menu size="s" label="Value source">
          ${offered.map(
            (m) => html`
              <sp-menu-item data-mode=${m} ?selected=${m === mode} @click=${() => choose(m)}
                >${VALUE_SOURCE_LABELS[m]}
                <span slot="description">${VALUE_SOURCE_HINTS[m]}</span></sp-menu-item
              >
            `,
          )}
        </sp-menu>
      </sp-popover>
    </sp-overlay>
  `;
}

/**
 * Render a bindable slot as two parts the panel places independently: the active mode's widget for
 * the row's value column, and the Value Source chip for the label side.
 */
export function renderDynamicSlot(opts: DynamicSlotOpts): DynamicSlotParts {
  const caps = slotCaps(opts.caps);
  const mode = effectiveSlotMode(opts.fieldKey, opts.value);

  const widget =
    mode === "ref"
      ? renderRefWidget(isRef(opts.value) ? opts.value.$ref : "", opts)
      : mode === "template"
        ? renderTemplateWidget(opts.value, opts)
        : mode === "expression"
          ? renderExpressionEditor(
              (opts.value as { $expression?: unknown }).$expression,
              (node) => opts.onChange({ $expression: node } as JsonValue),
              {
                allowEventRef: opts.allowEventRef ?? false,
                preview: opts.preview ?? null,
                stateDefs: opts.stateDefs,
                stateEntries: opts.stateEntries ?? null,
              },
            )
          : opts.staticWidget;

  return {
    modeButton: renderModeChip(mode, caps, opts),
    widget: html`
      <div class="dynamic-slot" style="display:flex;flex:1;min-width:0">
        <div style="flex:1;min-width:0">${widget}</div>
      </div>
    `,
  };
}
