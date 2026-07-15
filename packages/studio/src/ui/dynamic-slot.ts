/// <reference lib="dom" />
/**
 * Dynamic-slot — the shared "make this dynamic" control for any bindable document position.
 *
 * Renders the panel-provided static widget alongside an fx mode menu that escalates the value up
 * the Rule of Least Power ladder (spec §2.2): literal → $ref pointer → ${} template → $expression.
 * Capability-driven: each slot offers only the modes its schema position allows, so panels stay
 * decoupled from which rungs are blessed where.
 */

import { html, nothing } from "lit-html";
import { live } from "lit-html/directives/live.js";
import { isRef, isTemplateString } from "@jxsuite/schema/guards";
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

export interface SignalOption {
  value: string;
  label: string;
}

export interface DynamicSlotOpts {
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
      ${opts.extraSignals?.length
        ? html`
            <sp-menu-divider></sp-menu-divider>
            ${opts.extraSignals.map(
              (sig) => html`<sp-menu-item value=${sig.value}>${sig.label}</sp-menu-item>`,
            )}
          `
        : nothing}
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

/**
 * Render a bindable slot: the active mode's widget plus the trailing fx mode menu. The menu is
 * quiet/gray while static and accent-tinted once the value is dynamic — the "everything can be
 * dynamic" affordance without visual noise on static rows.
 */
export function renderDynamicSlot(opts: DynamicSlotOpts): TemplateResult {
  const caps: SlotMode[] = opts.caps.length > 0 ? opts.caps : ["literal", "ref"];
  const mode = slotMode(opts.value);
  const dynamic = mode !== "literal";

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

  return html`
    <div
      class="dynamic-slot"
      style="display:flex;gap:4px;align-items:${mode === "expression"
        ? "flex-start"
        : "center"};flex:1;min-width:0"
    >
      <div style="flex:1;min-width:0">${widget}</div>
      <sp-picker
        size="s"
        quiet
        class="dynamic-slot-mode"
        title="Value mode"
        style=${dynamic
          ? "color:var(--spectrum-accent-content-color-default, #5c9dff);flex-shrink:0;width:56px"
          : "color:var(--spectrum-gray-600, #808080);flex-shrink:0;width:56px"}
        .value=${live(mode)}
        @change=${(e: Event) => {
          const newMode = (e.target as HTMLInputElement).value as SlotMode;
          if (newMode !== mode) {
            opts.onChange(defaultForSlotMode(newMode, opts));
          }
        }}
      >
        ${caps.map((m) => html`<sp-menu-item value=${m}>${MODE_LABELS[m]}</sp-menu-item>`)}
      </sp-picker>
    </div>
  `;
}
