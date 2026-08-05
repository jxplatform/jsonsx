/// <reference lib="dom" />
/**
 * The Logic tab — everything about how this element BEHAVES.
 *
 * Plan §6.5 re-split the inspector by task rather than by data type, and this is the tab that
 * gained by it. Wiring a `$switch`, wiring a repeater to a collection and wiring a click handler
 * are one job; they were three, split across two tabs, because a `$switch` is stored as a property
 * and a click handler is stored as a property-shaped function, and the old split followed the
 * storage. So Logic is now:
 *
 * - **Repeating list** — the `$prototype: "Array"` node's items / filter / sort, and its template.
 * - **Condition** — the `$switch` expression and its cases.
 * - **Events** — declared events, bindings, inline bodies, expressions.
 * - **Observed Attributes · CSS Properties · CSS Parts** — a custom element's outward contract.
 *
 * The last three arrived from the Content tab, where they were three near-identical hand-written
 * flex rows; they are now three calls to {@link renderStaticKvRow}.
 *
 * Everything here reads `session.selection`, so the tab is selection-level in the same sense the
 * rest of the inspector is: no selection is an empty state, not a blank panel.
 */

import { getNodeAtPath, renderOnly } from "../store";
import { html, nothing } from "lit-html";
import { live } from "lit-html/directives/live.js";
import { activeTab } from "../workspace/workspace";
import { primarySelection, unifyValues } from "../tabs/selection";
import { renderProvenanceChip } from "./provenance";
import {
  mutateAddDef,
  mutateAddSwitchCase,
  mutateRemoveSwitchCase,
  mutateRenameSwitchCase,
  mutateUpdateProperty,
  transactDoc,
} from "../tabs/transact";
import { clickAnythingTo, renderEmptyState, staleSelectionMessage } from "./empty-state";
import { renderExpressionEditor } from "../ui/expression-editor";
import { renderStatementEditor } from "./statement-editor";
import { livePreviewExpression } from "../services/live-preview";
import { renderFieldRow, renderStaticKvRow } from "../ui/field-row";
import { renderDynamicSlot, slotMode, switchSlotMode } from "../ui/dynamic-slot";
import { VALUE_SOURCE_LABELS, capsForPosition } from "../ui/value-source";
import { spTextField } from "../ui/field-input";
import {
  bindableSignalNames,
  defaultAsString,
  isInspectorSectionOpen,
  mapSignalsFor,
  setInspectorSection,
} from "./properties-panel";
import { collectCssParts } from "./signals-panel";
import {
  getEventBinding,
  isExpressionDef,
  isFunctionDef,
  isJsonObject,
  isRef,
} from "@jxsuite/schema/guards";

import type { JsonValue } from "../types";
import type { TemplateResult } from "lit-html";
import type { SlotCapsSource, SlotMode, SignalOption } from "../ui/dynamic-slot";
import type { JxPath } from "../state";
import type {
  CemEvent,
  JxEventBinding,
  JxFunctionDef,
  JxMutableNode,
  JxPrototypeDef,
} from "@jxsuite/schema/types";

export const EVENT_NAMES = [
  "onclick",
  "oninput",
  "onchange",
  "onsubmit",
  "onkeydown",
  "onkeyup",
  "onfocus",
  "onblur",
  "onmouseenter",
  "onmouseleave",
];

/**
 * The rungs an `on*` handler permits, derived from the schema (`RefObject | ExpressionEntry |
 * FunctionDef`) rather than listed here.
 *
 * This picker used to read Inline code / Expression / Existing function — a fourth private dialect
 * for the one ladder §6.6 collapses, so a user who learned "Formula" on a property row met
 * "Expression" here and had no reason to think they were the same thing.
 */
const HANDLER_MODES: SlotMode[] = capsForPosition("eventHandler");

/** The value a handler starts at on each rung, when the user has never been on that rung before. */
function seedForHandlerMode(mode: SlotMode, functionDefs: [string, unknown][]): JsonValue {
  if (mode === "function") {
    return { $prototype: "Function", body: "", parameters: [] };
  }
  if (mode === "expression") {
    return { $expression: { operator: "=", target: null } };
  }
  const [firstFn] = functionDefs;
  return firstFn ? { $ref: `#/state/${firstFn[0]}` } : { $ref: "" };
}

// ─── The bindable row ────────────────────────────────────────────────────────

/** Arguments for {@link bindableFieldRow}. */
interface BindableRowOpts {
  /** The `data-prop` key — what `inspector/field:<prop>` addresses. */
  prop: string;
  label: string;
  /** The raw document value: a JSON literal, `{ $ref }`, a `${}` template or an `$expression`. */
  rawValue: unknown;
  onChange: (v?: JsonValue) => void;
  /** Removes the position outright. Absent means the position is mandatory and cannot be cleared. */
  onClear?: (() => void) | undefined;
  /** Extra signals this position may bind to — `$map/item` and friends inside a template. */
  extraSignals?: SignalOption[] | null;
  /** Stable identity for the dynamic slot's per-mode value memory; must include the node path. */
  fieldKey: string;
  /** The document position being edited — the rungs follow from its schema, never from here. */
  caps: SlotCapsSource;
}

/**
 * A bindable value as a first-class field row.
 *
 * This used to render a bare `<div class="field-row">` with a label and a widget: no set-dot, no
 * clear affordance, no error slot — the three things every other row in the inspector has had since
 * `renderFieldRow` landed. Repeater and Switch fields were the last second-class rows in the
 * inspector, which is exactly what §12 P5 item 6 names.
 *
 * Every position it serves is a single-line expression (a collection, a filter, a sort key, a
 * `$switch`), so it draws one literal editor rather than dispatching over a widget type — the
 * textarea and checkbox arms it used to carry had no caller in either tab.
 */
function bindableFieldRow({
  prop,
  label,
  rawValue,
  onChange,
  onClear,
  extraSignals = null,
  fieldKey,
  caps,
}: BindableRowOpts) {
  const defs = activeTab.value!.doc.document.state || {};
  const boundRef = isRef(rawValue) ? rawValue.$ref : null;
  const staticVal = slotMode(rawValue) === "literal" ? (rawValue ?? "") : "";

  // De-escalating to literal restores the bound signal's declared default (old unbind behavior).
  const literalDefault = boundRef
    ? defaultAsString(defs[boundRef.startsWith("#/state/") ? boundRef.slice(8) : boundRef]) ||
      undefined
    : undefined;

  const slot = renderDynamicSlot({
    caps,
    extraSignals,
    fieldKey,
    literalDefault,
    onChange,
    staticWidget: spTextField(`prop:${label}`, String(staticVal), (v: string) => onChange(v)),
    stateDefs: bindableSignalNames(activeTab.value!.doc.document),
    value: rawValue,
  });
  return renderFieldRow({
    hasValue: rawValue !== undefined && rawValue !== "",
    label,
    labelExtra: slot.modeButton,
    prop,
    widget: slot.widget,
    ...(onClear ? { onClear } : {}),
  });
}

// ─── Repeating list ──────────────────────────────────────────────────────────

/**
 * The repeater's items / filter / sort, and the way into its template.
 *
 * Filter and Sort are always drawn. They used to hide behind `+ Add filter`, which seeded `{ $ref:
 * "#/state/" }` — a binding to the empty pointer, which is not a signal — so the row opened already
 * bound to nothing and the only way to type a literal was to cycle the mode ring twice (§11.4).
 * There is no seed to fix, because a repeater has exactly three inputs and an empty row states that
 * better than a button does: type into it and it is set, clear it and it is gone.
 */
function renderRepeaterFieldsTemplate(node: JxMutableNode, path: JxPath) {
  const key = path.join("/");
  const clear = (name: string) => () =>
    transactDoc(activeTab.value, (t) => mutateUpdateProperty(t, path, name));
  const optional = (name: "filter" | "sort", label: string) =>
    bindableFieldRow({
      caps: name === "filter" ? "repeaterFilter" : "repeaterSort",
      fieldKey: `prop|${key}|${name}`,
      label,
      onChange: (v?: JsonValue) =>
        transactDoc(activeTab.value, (t) => mutateUpdateProperty(t, path, name, v || undefined)),
      onClear: clear(name),
      prop: name,
      rawValue: node[name],
    });
  return html`
    ${bindableFieldRow({
      caps: "repeaterItems",
      fieldKey: `prop|${key}|items`,
      label: "Items",
      onChange: (v?: JsonValue) =>
        transactDoc(activeTab.value, (t) => mutateUpdateProperty(t, path, "items", v)),
      prop: "items",
      rawValue: node.items,
    })}
    ${optional("filter", "Filter")} ${optional("sort", "Sort")}
    ${
      node.map
        ? html`
            <sp-action-button
              size="s"
              class="logic-edit-template"
              @click=${() => {
                activeTab.value!.session.selection = [[...path, "map"]];
              }}
              >Edit template →</sp-action-button
            >
          `
        : nothing
    }
  `;
}

// ─── Condition ───────────────────────────────────────────────────────────────

/** The `$switch` expression and its cases — each case a field row like every other. */
function renderSwitchFieldsTemplate(
  node: JxMutableNode,
  path: JxPath,
  mapSignals: SignalOption[] | null,
) {
  const caseNames = Object.keys(node.cases || {});
  return html`
    ${bindableFieldRow({
      // `SwitchDef` is a $ref and nothing else, so From data… is the only rung — a $switch is
      // Inherently dynamic, and de-escalating it would delete the key and demote the node.
      caps: "switchDiscriminant",
      extraSignals: mapSignals,
      fieldKey: `prop|${path.join("/")}|$switch`,
      label: "Expression",
      onChange: (v?: JsonValue) =>
        transactDoc(activeTab.value, (t) => mutateUpdateProperty(t, path, "$switch", v)),
      prop: "$switch",
      rawValue: node.$switch,
    })}
    <div class="logic-subhead">Cases</div>
    ${caseNames.map((caseName) => {
      let debounce: ReturnType<typeof setTimeout> | undefined;
      return renderFieldRow({
        hasValue: true,
        label: "Case",
        prop: `case:${caseName}`,
        provenance: {
          onClick: () =>
            transactDoc(activeTab.value!, (t) => mutateRemoveSwitchCase(t, path, caseName)),
          state: "set",
          title: `Remove case "${caseName}"`,
        },
        widget: html`
          <div class="logic-case-row">
            <sp-textfield
              size="s"
              class="logic-case-name"
              .value=${live(caseName)}
              @input=${(e: Event) => {
                clearTimeout(debounce);
                const next = (e.target as HTMLInputElement).value;
                debounce = setTimeout(() => {
                  if (next && next !== caseName) {
                    transactDoc(activeTab.value, (t) =>
                      mutateRenameSwitchCase(t, path, caseName, next),
                    );
                  }
                }, 500);
              }}
            ></sp-textfield>
            <sp-action-button
              size="xs"
              quiet
              class="logic-case-open"
              title="Edit case"
              @click=${(e: Event) => {
                e.stopPropagation();
                activeTab.value!.session.selection = [[...path, "cases", caseName]];
              }}
              >→</sp-action-button
            >
          </div>
        `,
      });
    })}
    <span
      class="kv-add"
      @click=${() => {
        transactDoc(activeTab.value, (t) =>
          mutateAddSwitchCase(t, path, `case${caseNames.length + 1}`),
        );
      }}
      >+ Add case</span
    >
  `;
}

// ─── Events ──────────────────────────────────────────────────────────────────

/** The event bindings themselves — declared events, then one block per bound `on*` key. */
/**
 * The Logic tab's Mixed contract (§6.5), stated once because it is a judgement, not a mechanism.
 *
 * Wiring splits in two, and a multi-selection treats the halves differently:
 *
 * - **Which events exist, and how each is produced** — the event key, its Value Source rung, and its
 *   removal — is a property of the BATCH. Binding one handler to six buttons, or clearing it off
 *   all six, is a single decision, so those three controls write to every selected element inside
 *   one transaction and one undo step.
 * - **What a handler CONTAINS** — a function body, an expression's operands, a repeater's source and
 *   template — is the PRIMARY's. Six elements do not share one handler body; broadcasting a
 *   keystroke into six different bodies would destroy five of them, and showing one body while
 *   claiming to edit six is the lie the Mixed chip exists to prevent.
 *
 * So the row header states `mixed (n)` when the selected elements disagree about a key — including
 * when some of them do not bind it at all — and the body below it stays what it always was: the
 * primary's, edited alone.
 *
 * @param {readonly JxPath[]} targets
 * @param {string} key
 * @param {JsonValue} [value] — omitted deletes the key.
 */
function commitToTargets(targets: readonly JxPath[], key: string, value?: JsonValue): void {
  transactDoc(activeTab.value, (t) => {
    for (const target of targets) {
      mutateUpdateProperty(t, target, key, value);
    }
  });
}

/**
 * How many selected elements disagree about one event key — 0 when they agree or there is one.
 *
 * @param {JxMutableNode} doc
 * @param {readonly JxPath[]} targets
 * @param {string} evKey
 * @returns {number}
 */
function mixedEventCount(doc: JxMutableNode, targets: readonly JxPath[], evKey: string): number {
  if (targets.length < 2) {
    return 0;
  }
  const values = targets.map((path) => {
    const n = getNodeAtPath(doc, path) as JxMutableNode | undefined;
    return n ? (getEventBinding(n, evKey) ?? null) : null;
  });
  return unifyValues(values).mixed ? targets.length : 0;
}

function renderEventsBody(
  node: JxMutableNode,
  selection: JxPath,
  isCustomElement: boolean,
  targets: readonly JxPath[] = [selection],
) {
  const tab = activeTab.value!;
  const defs = tab.doc.document.state || {};
  const functionDefs = Object.entries(defs).filter(
    ([, d]) =>
      (d as JxPrototypeDef)?.$prototype === "Function" || (d as Record<string, unknown>)?.$handler,
  );

  // Declared CEM events (custom element docs)
  let declaredEventsT: unknown = nothing;
  if (isCustomElement) {
    const allEmits: (CemEvent & { _fn: string })[] = [];
    for (const [fnName, d] of Object.entries(defs)) {
      if (isFunctionDef(d) && Array.isArray(d.emits)) {
        for (const ev of d.emits) {
          allEmits.push({ ...ev, _fn: fnName });
        }
      }
    }
    if (allEmits.length > 0) {
      declaredEventsT = html`
        <div class="events-section">
          <sp-field-label size="s">Declared Events</sp-field-label>
          ${allEmits.map(
            (ev) => html`
              <div class="declared-event-row" title=${ev.description || ""}>
                <code class="event-code">${ev.name || "(unnamed)"}</code>
                <span class="event-source">← ${ev._fn}</span>
                ${
                  isJsonObject(ev.type) && typeof ev.type.text === "string"
                    ? html`<span class="event-type">${ev.type.text}</span>`
                    : nothing
                }
              </div>
            `,
          )}
        </div>
        <sp-divider size="s"></sp-divider>
      `;
    }
  }

  // Find existing event bindings. Resolved once, as pairs: asking `getEventBinding` for the key and
  // Then again for the value left a `if (!evVal) return nothing` arm nothing could ever reach.
  const eventEntries = Object.keys(node)
    .filter((k) => k.startsWith("on"))
    .map((k) => [k, getEventBinding(node, k)] as const)
    .filter((pair): pair is [string, JxEventBinding] => pair[1] !== undefined);

  return html`
    <div class="events-panel">
      ${declaredEventsT}
      <div class="events-section">
        ${
          eventEntries.length > 0
            ? html` <sp-field-label size="s">Event Bindings</sp-field-label> `
            : nothing
        }
        ${eventEntries.map(([evKey, evVal]) => {
          const inlineFn: JxFunctionDef | null = isFunctionDef(evVal) ? evVal : null;
          const expression = isExpressionDef(evVal) ? evVal.$expression : null;
          const refValue = isRef(evVal) ? evVal.$ref : null;
          const currentMode = slotMode(evVal);
          const modeFieldKey = `event|${selection.join("/")}|${evKey}`;
          return html`
            <div class="event-binding">
              <div class="event-row">
                <sp-picker
                  size="s"
                  class="event-name"
                  .value=${live(evKey)}
                  @change=${(e: Event) => {
                    const newKey = (e.target as HTMLInputElement).value;
                    if (newKey && newKey !== evKey) {
                      // Renaming the key moves the binding on every selected element, in one step.
                      transactDoc(activeTab.value, (t) => {
                        for (const target of targets) {
                          const existing = getEventBinding(
                            getNodeAtPath(t.doc.document, target) as JxMutableNode,
                            evKey,
                          );
                          if (existing === undefined) {
                            continue;
                          }
                          mutateUpdateProperty(t, target, evKey);
                          mutateUpdateProperty(t, target, newKey, existing as JsonValue);
                        }
                      });
                    }
                  }}
                >
                  ${[evKey, ...EVENT_NAMES.filter((n) => n !== evKey)].map(
                    (n) => html`<sp-menu-item value=${n}>${n}</sp-menu-item>`,
                  )}
                </sp-picker>
                <sp-picker
                  size="s"
                  class="event-mode"
                  .value=${live(currentMode)}
                  @change=${(e: Event) => {
                    const next = (e.target as HTMLInputElement).value as SlotMode;
                    /* The same ladder the inspector's rows offer, remembering the representation
                       it left: switching to Formula and back used to throw the handler body away. */
                    commitToTargets(
                      targets,
                      evKey,
                      switchSlotMode(
                        modeFieldKey,
                        currentMode,
                        next,
                        evVal as JsonValue,
                        seedForHandlerMode(next, functionDefs),
                      ) ?? seedForHandlerMode(next, functionDefs),
                    );
                  }}
                >
                  ${HANDLER_MODES.map(
                    (m) => html`<sp-menu-item value=${m}>${VALUE_SOURCE_LABELS[m]}</sp-menu-item>`,
                  )}
                </sp-picker>
                ${renderProvenanceChip(evKey, {
                  state: mixedEventCount(tab.doc.document, targets, evKey) > 0 ? "mixed" : "set",
                  donor: String(targets.length),
                  onClick: () => commitToTargets(targets, evKey),
                  title:
                    mixedEventCount(tab.doc.document, targets, evKey) > 0
                      ? `${targets.length} selected elements bind ${evKey} differently — ` +
                        `clearing removes it from all of them`
                      : `Clear ${evKey}`,
                })}
                <sp-action-button size="xs" quiet @click=${() => commitToTargets(targets, evKey)}>
                  <sp-icon-delete slot="icon"></sp-icon-delete>
                </sp-action-button>
              </div>
              ${
                inlineFn
                  ? html`
                      <div class="event-body-mode" style="display:flex;justify-content:flex-end">
                        <sp-action-group size="s" compact class="body-mode-toggle">
                          <sp-action-button
                            size="s"
                            class="body-mode-statements"
                            ?selected=${Array.isArray(inlineFn.body)}
                            @click=${() => {
                              if (!Array.isArray(inlineFn.body)) {
                                transactDoc(activeTab.value, (t) =>
                                  mutateUpdateProperty(t, selection, evKey, {
                                    ...inlineFn,
                                    body: [],
                                  }),
                                );
                              }
                            }}
                          >
                            Statements
                          </sp-action-button>
                          <sp-action-button
                            size="s"
                            class="body-mode-code"
                            ?selected=${!Array.isArray(inlineFn.body)}
                            @click=${() => {
                              if (Array.isArray(inlineFn.body)) {
                                transactDoc(activeTab.value, (t) =>
                                  mutateUpdateProperty(t, selection, evKey, {
                                    ...inlineFn,
                                    body: "",
                                  }),
                                );
                              }
                            }}
                          >
                            Code
                          </sp-action-button>
                        </sp-action-group>
                      </div>
                      ${
                        Array.isArray(inlineFn.body)
                          ? renderStatementEditor(
                              inlineFn.body,
                              (next) =>
                                transactDoc(activeTab.value, (t) =>
                                  mutateUpdateProperty(t, selection, evKey, {
                                    ...inlineFn,
                                    body: next,
                                  }),
                                ),
                              {
                                allowEventRef: true,
                                emits: inlineFn.emits ?? [],
                                stateDefs: Object.keys(defs),
                                stateEntries: defs,
                              },
                            )
                          : html`
                              <div class="event-body-row">
                                <sp-textfield
                                  size="s"
                                  multiline
                                  grows
                                  placeholder="// handler body"
                                  .value=${live(typeof inlineFn.body === "string" ? inlineFn.body : "")}
                                  @input=${(e: Event) => {
                                    transactDoc(activeTab.value, (t) =>
                                      mutateUpdateProperty(t, selection, evKey, {
                                        $prototype: "Function",
                                        body: (e.target as HTMLInputElement).value,
                                        parameters: inlineFn?.parameters || [],
                                      }),
                                    );
                                  }}
                                >
                                </sp-textfield>
                                <sp-action-button
                                  size="xs"
                                  quiet
                                  title="Open in editor"
                                  @click=${() => {
                                    tab.session.ui.editingFunction = {
                                      eventKey: evKey,
                                      path: selection,
                                      type: "event",
                                    };
                                  }}
                                >
                                  <sp-icon-code slot="icon"></sp-icon-code>
                                </sp-action-button>
                              </div>
                            `
                      }
                    `
                  : expression
                    ? html`
                        <div class="event-body-row">
                          <div style="flex:1;min-width:0">
                            ${renderExpressionEditor(
                              expression,
                              (newNode: unknown) =>
                                transactDoc(activeTab.value, (t) =>
                                  mutateUpdateProperty(t, selection, evKey, {
                                    $expression: newNode,
                                  }),
                                ),
                              {
                                allowEventRef: true,
                                // Live-context evaluation in the canvas iframe, snapshot fallback
                                // (M6). The selection path is the context, so a binding inside a
                                // Repeater template previews with the first item's $map scope.
                                preview: livePreviewExpression(
                                  tab,
                                  `event:${JSON.stringify(selection)}:${evKey}`,
                                  expression,
                                  selection,
                                  () => renderOnly("rightPanel"),
                                ),
                                onInsertDef: (defName, def) =>
                                  transactDoc(activeTab.value, (t) =>
                                    mutateAddDef(t, defName, def as Record<string, JsonValue>),
                                  ),
                                stateDefs: Object.keys(defs),
                                stateEntries: defs,
                              },
                            )}
                          </div>
                          <sp-action-button
                            size="xs"
                            quiet
                            title="Open in formula workspace"
                            @click=${() => {
                              tab.session.ui.editingFormula = {
                                eventKey: evKey,
                                path: selection,
                                type: "event",
                              };
                            }}
                          >
                            <sp-icon-full-screen slot="icon"></sp-icon-full-screen>
                          </sp-action-button>
                        </div>
                      `
                    : html`
                        <sp-picker
                          size="s"
                          class="event-handler"
                          .value=${live(refValue || "__none__")}
                          @change=${(e: Event) => {
                            if (
                              (e.target as HTMLInputElement).value &&
                              (e.target as HTMLInputElement).value !== "__none__"
                            ) {
                              transactDoc(activeTab.value, (t) =>
                                mutateUpdateProperty(t, selection, evKey, {
                                  $ref: (e.target as HTMLInputElement).value,
                                }),
                              );
                            } else {
                              transactDoc(activeTab.value, (t) =>
                                mutateUpdateProperty(t, selection, evKey),
                              );
                            }
                          }}
                        >
                          <sp-menu-item value="__none__">— none —</sp-menu-item>
                          ${functionDefs.map(
                            ([fName]) =>
                              html`<sp-menu-item value=${`#/state/${fName}`}
                                >${fName}</sp-menu-item
                              >`,
                          )}
                        </sp-picker>
                      `
              }
            </div>
          `;
        })}
        <sp-action-button
          size="s"
          quiet
          @click=${() => {
            let evName = "onclick";
            for (const name of EVENT_NAMES) {
              if (!node[name]) {
                evName = name;
                break;
              }
            }
            if (functionDefs.length > 0) {
              transactDoc(activeTab.value, (t) =>
                mutateUpdateProperty(t, selection, evName, {
                  $ref: `#/state/${functionDefs[0]![0]}`,
                }),
              );
            } else {
              transactDoc(activeTab.value, (t) =>
                mutateUpdateProperty(t, selection, evName, {
                  $prototype: "Function",
                  body: "",
                  parameters: [],
                }),
              );
            }
          }}
        >
          <sp-icon-add slot="icon"></sp-icon-add>
          Add Event
        </sp-action-button>
      </div>
    </div>
  `;
}

// ─── The custom element's outward contract ───────────────────────────────────

/** Observed attributes: the `attribute` names a page may set from markup, and what they feed. */
function renderObservedAttrsSection(document: JxMutableNode) {
  const state = document.state || {};
  const entries = Object.entries(state).filter(([, d]) => (d as Record<string, unknown>).attribute);
  return html`
    <sp-accordion-item
      label="Observed Attributes"
      ?open=${isInspectorSectionOpen("__observed", false)}
      @sp-accordion-item-toggle=${() =>
        setInspectorSection("__observed", !isInspectorSectionOpen("__observed", false))}
    >
      <div class="style-section-body">
        ${
          entries.length === 0
            ? renderEmptyState({
                compact: true,
                message:
                  "Attributes let a page set this component from markup. " +
                  'Name an "attribute" on a data entry to expose it here.',
              })
            : entries.map(([key, d]) => {
                const def = d as Record<string, unknown>;
                return renderStaticKvRow({
                  detail: `→ ${key}`,
                  name: String(def.attribute),
                  ...(def.type ? { value: String(def.type) } : {}),
                  ...(def.reflects ? { tags: ["reflects"] } : {}),
                });
              })
        }
      </div>
    </sp-accordion-item>
  `;
}

/** The `--custom-properties` a page may override on this component. */
function renderCssPropsSection(node: JxMutableNode) {
  const style = node.style || {};
  const cssProps = Object.entries(style).filter(([k]) => k.startsWith("--"));
  if (cssProps.length === 0) {
    return nothing;
  }
  return html`
    <sp-accordion-item
      label="CSS Properties"
      ?open=${isInspectorSectionOpen("__cssprops", false)}
      @sp-accordion-item-toggle=${() =>
        setInspectorSection("__cssprops", !isInspectorSectionOpen("__cssprops", false))}
    >
      <div class="style-section-body">
        ${cssProps.map(([prop, val]) => renderStaticKvRow({ name: prop, value: String(val) }))}
      </div>
    </sp-accordion-item>
  `;
}

/** The `part` names a page may style inside this component's shadow tree. */
function renderCssPartsSection(document: JxMutableNode) {
  const parts = collectCssParts(document);
  if (parts.length === 0) {
    return nothing;
  }
  return html`
    <sp-accordion-item
      label="CSS Parts"
      ?open=${isInspectorSectionOpen("__cssparts", false)}
      @sp-accordion-item-toggle=${() =>
        setInspectorSection("__cssparts", !isInspectorSectionOpen("__cssparts", false))}
    >
      <div class="style-section-body">
        ${parts.map((p) => renderStaticKvRow({ detail: `<${p.tag}>`, name: p.name }))}
      </div>
    </sp-accordion-item>
  `;
}

// ─── The tab ─────────────────────────────────────────────────────────────────

/**
 * The Logic tab.
 *
 * @param {{ isCustomElementDoc: () => boolean }} helpers — injected because the answer needs the
 *   tab's mode and ui, which the dock already has in hand.
 */
export function renderLogicPanelTemplate(helpers: {
  isCustomElementDoc: () => boolean;
}): TemplateResult {
  const { isCustomElementDoc } = helpers;
  const tab = activeTab.value;
  const selection = primarySelection(tab?.session.selection);
  const doc = tab?.doc.document;
  if (!selection) {
    return renderEmptyState({ message: clickAnythingTo("wire it up") });
  }
  const node = getNodeAtPath(doc!, selection);
  if (!node) {
    return renderEmptyState({ message: staleSelectionMessage() });
  }

  // The whole selection the Logic tab wires. `[selection]` when one element is selected — which is
  // Every existing call site's behaviour, unchanged.
  const targets: JxPath[] =
    tab!.session.selection.length > 0 ? tab!.session.selection : [selection];
  const isMapNode = node.$prototype === "Array";
  const isSwitchNode = Boolean(node.$switch);
  const isRoot = selection.length === 0;
  const isCustomElement = isCustomElementDoc();
  const mapSignals = mapSignalsFor(selection);

  const repeaterT = isMapNode
    ? html`
        <sp-accordion-item label="Repeating list" open>
          <div class="style-section-body">${renderRepeaterFieldsTemplate(node, selection)}</div>
        </sp-accordion-item>
      `
    : nothing;

  const switchT = isSwitchNode
    ? html`
        <sp-accordion-item label="Condition" open>
          <div class="style-section-body">
            ${renderSwitchFieldsTemplate(node, selection, mapSignals)}
          </div>
        </sp-accordion-item>
      `
    : nothing;

  // A repeater is not an element: it has no `on*` position to bind, and offering "Add Event" on one
  // Writes a handler onto a node the renderer never mounts.
  const eventsT = isMapNode
    ? nothing
    : html`
        <sp-accordion-item label="Events" open>
          <div class="style-section-body">
            ${renderEventsBody(node, selection, isCustomElement, targets)}
          </div>
        </sp-accordion-item>
      `;

  const contractT =
    isCustomElement && isRoot
      ? html`
          ${renderObservedAttrsSection(doc!)} ${renderCssPropsSection(node)}
          ${renderCssPartsSection(doc!)}
        `
      : nothing;

  return html`
    <div class="style-sidebar">
      <sp-accordion allow-multiple size="s">
        ${repeaterT} ${switchT} ${eventsT} ${contractT}
      </sp-accordion>
    </div>
  `;
}
