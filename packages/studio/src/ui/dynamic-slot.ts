/// <reference lib="dom" />
/**
 * Dynamic-slot — the shared "make this dynamic" control for any bindable document position.
 *
 * Renders the panel-provided static widget plus a label-side mode button that cycles the value up
 * the Rule of Least Power ladder (spec §2.2): literal → $ref pointer → ${} template → $expression.
 * Capability-driven: each slot offers only the modes its schema position allows, so panels stay
 * decoupled from which rungs are blessed where. Each mode's last value is remembered per field for
 * the session, so cycling back to an earlier mode restores what the user had there.
 */

import { html, nothing } from "lit-html";
import { live } from "lit-html/directives/live.js";
import { isRef, isTemplateString } from "@jxsuite/schema/guards";
import { cloneValue } from "../tabs/doc-op-apply";
import { activeTab } from "../workspace/workspace";
import { renderExpressionEditor } from "./expression-editor";

import type { TemplateResult } from "lit-html";
import type { EditorPreview } from "./expression-editor";
import type { JxStateDefinition } from "@jxsuite/schema/types";
import type { JsonValue } from "../types";

export type SlotMode = "literal" | "ref" | "template" | "expression";

const MODE_LABELS: Record<SlotMode, string> = {
  expression: "fx",
  literal: "abc",
  ref: "$ref",
  template: "${}",
};

const MODE_NOUNS: Record<SlotMode, string> = {
  expression: "expression",
  literal: "static",
  ref: "signal binding",
  template: "template literal",
};

/*
 * Session memory of each field's last value per mode, so cycling modes round-trips user input.
 * Keyed `${tabId}|${fieldKey}|${mode}`; the mode key is derived from the value at stash time, so a
 * restore always lands a value whose slotMode() matches the target mode. `undefined` is a
 * legitimate stash (cleared literal), hence Map.has() discrimination on recall.
 */
const slotModeMemory = new Map<string, JsonValue | undefined>();

/** Test hook: drop all remembered per-mode field values. */
export function resetSlotModeMemory(): void {
  slotModeMemory.clear();
}

function memoryKey(fieldKey: string, mode: SlotMode): string {
  return `${activeTab.value?.id ?? "-"}|${fieldKey}|${mode}`;
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
  /** Modes this schema position allows, in ladder order. "literal" and "ref" are the floor. */
  caps: SlotMode[];
  /** State keys offered by the ref picker and expression editor. */
  stateDefs: string[];
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
}

/** Detect which rung of the ladder a raw document value occupies. */
export function slotMode(value: unknown): SlotMode {
  if (isRef(value)) {
    return "ref";
  }
  if (isTemplateString(value)) {
    return "template";
  }
  if (value && typeof value === "object" && "$expression" in value) {
    return "expression";
  }
  return "literal";
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
    default: {
      return opts.literalDefault;
    }
  }
}

function renderRefWidget(refVal: string, opts: DynamicSlotOpts) {
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
  /** Label-side mode-cycle button. */
  modeButton: TemplateResult;
  /** Active-mode widget, sized to fill the row's widget column. */
  widget: TemplateResult;
}

/**
 * The label-side field-mode button. Shows the current mode's glyph — quiet/gray while static and
 * accent-tinted once the value is dynamic — and each click cycles to the next capped mode, stashing
 * the outgoing mode's value and restoring the incoming mode's remembered one.
 */
function renderModeButton(mode: SlotMode, caps: SlotMode[], opts: DynamicSlotOpts): TemplateResult {
  const color =
    mode !== "literal"
      ? "color:var(--spectrum-accent-content-color-default, #5c9dff)"
      : "color:var(--spectrum-gray-600, #808080)";
  // A ref rung with nothing to point at is a dead end — drop it rather than trap the cycle there.
  const cycle = caps.filter((m) => m !== "ref" || hasRefOptions(opts));
  if (cycle.length < 2) {
    const hint = `Field mode: ${MODE_NOUNS[mode]} (no other modes available)`;
    return html`
      <sp-action-button
        size="xs"
        quiet
        disabled
        class="dynamic-slot-mode"
        style=${color}
        title=${hint}
        aria-label=${hint}
        >${MODE_LABELS[mode]}</sp-action-button
      >
    `;
  }
  // An uncapped current mode indexes to -1, so its next stop is cycle[0] (literal).
  const next = cycle[(cycle.indexOf(mode) + 1) % cycle.length]!;
  const hint = `Field mode: ${MODE_NOUNS[mode]} — click for ${MODE_NOUNS[next]}`;
  return html`
    <sp-action-button
      size="xs"
      quiet
      class="dynamic-slot-mode"
      style=${color}
      title=${hint}
      aria-label=${hint}
      @click=${() => {
        slotModeMemory.set(
          memoryKey(opts.fieldKey, mode),
          cloneValue(opts.value as JsonValue | undefined),
        );
        // Leaving ref seeds an empty literal stash with the signal's declared default.
        // Unbind-restores-default thus survives multi-hop cycles (ref → template → literal).
        if (mode === "ref" && opts.literalDefault !== undefined) {
          const litKey = memoryKey(opts.fieldKey, "literal");
          if (!slotModeMemory.has(litKey)) {
            slotModeMemory.set(litKey, cloneValue(opts.literalDefault));
          }
        }
        const key = memoryKey(opts.fieldKey, next);
        opts.onChange(
          slotModeMemory.has(key)
            ? cloneValue(slotModeMemory.get(key))
            : defaultForSlotMode(next, opts),
        );
      }}
      >${MODE_LABELS[mode]}</sp-action-button
    >
  `;
}

/**
 * Render a bindable slot as two parts the panel places independently: the active mode's widget for
 * the row's value column, and the mode-cycle button for the label side.
 */
export function renderDynamicSlot(opts: DynamicSlotOpts): DynamicSlotParts {
  const caps: SlotMode[] = opts.caps.length > 0 ? opts.caps : ["literal", "ref"];
  const mode = slotMode(opts.value);

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
    modeButton: renderModeButton(mode, caps, opts),
    widget: html`
      <div class="dynamic-slot" style="display:flex;flex:1;min-width:0">
        <div style="flex:1;min-width:0">${widget}</div>
      </div>
    `,
  };
}
