/// <reference lib="dom" />
import { getNodeAtPath } from "../store";
import { html, nothing } from "lit-html";
import { live } from "lit-html/directives/live.js";
import { activeTab } from "../workspace/workspace";
import { mutateUpdateProperty, transactDoc } from "../tabs/transact";
import { renderExpressionEditor } from "../ui/expression-editor";
import {
  getEventBinding,
  isExpressionDef,
  isFunctionDef,
  isJsonObject,
  isRef,
} from "@jxsuite/schema/guards";

import type { JsonValue } from "../types";
import type { CemEvent, JxFunctionDef, JxPrototypeDef } from "@jxsuite/schema/types";

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

/** @param {{ isCustomElementDoc: () => boolean }} helpers */
export function eventsSidebarTemplate(helpers: { isCustomElementDoc: () => boolean }) {
  const { isCustomElementDoc } = helpers;
  const tab = activeTab.value;
  const selection = tab?.session.selection;
  const document = tab?.doc.document;
  if (!selection) {
    return html`<div class="empty-state">Select an element to edit events</div>`;
  }
  const node = getNodeAtPath(document!, selection);
  if (!node) {
    return html`<div class="empty-state">Node not found</div>`;
  }

  const defs = document!.state || {};
  const functionDefs = Object.entries(defs).filter(
    ([, d]) =>
      (d as JxPrototypeDef)?.$prototype === "Function" || (d as Record<string, unknown>)?.$handler,
  );

  // Declared CEM events (custom element docs)
  let declaredEventsT: unknown = nothing;
  if (isCustomElementDoc()) {
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
                ${isJsonObject(ev.type) && typeof ev.type.text === "string"
                  ? html`<span class="event-type">${ev.type.text}</span>`
                  : nothing}
              </div>
            `,
          )}
        </div>
        <sp-divider size="s"></sp-divider>
      `;
    }
  }

  // Find existing event bindings
  const eventKeys = Object.keys(node).filter(
    (k) => k.startsWith("on") && getEventBinding(node, k) !== undefined,
  );

  return html`
    <div class="events-panel">
      ${declaredEventsT}
      <div class="events-section">
        ${eventKeys.length > 0
          ? html` <sp-field-label size="s">Event Bindings</sp-field-label> `
          : nothing}
        ${eventKeys.map((evKey) => {
          const evVal = getEventBinding(node, evKey);
          if (!evVal) {
            return nothing;
          }
          const inlineFn: JxFunctionDef | null = isFunctionDef(evVal) ? evVal : null;
          const expression = isExpressionDef(evVal) ? evVal.$expression : null;
          const refValue = isRef(evVal) ? evVal.$ref : null;
          const currentMode = inlineFn ? "inline" : expression ? "$expression" : "ref";
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
                      transactDoc(activeTab.value, (t) => {
                        mutateUpdateProperty(t, selection, evKey);
                        mutateUpdateProperty(t, selection, newKey, evVal as JsonValue);
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
                    const newMode = (e.target as HTMLInputElement).value;
                    if (newMode === "inline") {
                      transactDoc(activeTab.value, (t) =>
                        mutateUpdateProperty(t, selection, evKey, {
                          $prototype: "Function",
                          body: "",
                          parameters: [],
                        }),
                      );
                    } else if (newMode === "$expression") {
                      transactDoc(activeTab.value, (t) =>
                        mutateUpdateProperty(t, selection, evKey, {
                          $expression: { operator: "=", target: null },
                        }),
                      );
                    } else {
                      const [firstFn] = functionDefs;
                      transactDoc(activeTab.value, (t) =>
                        mutateUpdateProperty(
                          t,
                          selection,
                          evKey,
                          firstFn ? { $ref: `#/state/${firstFn[0]}` } : { $ref: "" },
                        ),
                      );
                    }
                  }}
                >
                  <sp-menu-item value="inline">inline</sp-menu-item>
                  <sp-menu-item value="$expression">$expression</sp-menu-item>
                  <sp-menu-item value="ref">$ref</sp-menu-item>
                </sp-picker>
                <sp-action-button
                  size="xs"
                  quiet
                  @click=${() =>
                    transactDoc(activeTab.value, (t) => mutateUpdateProperty(t, selection, evKey))}
                >
                  <sp-icon-delete slot="icon"></sp-icon-delete>
                </sp-action-button>
              </div>
              ${inlineFn
                ? html`
                    <div class="event-body-row">
                      <sp-textfield
                        size="s"
                        multiline
                        grows
                        placeholder="// handler body"
                        .value=${live(inlineFn?.body || "")}
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
                : expression
                  ? html`
                      <div class="event-body-row">
                        ${renderExpressionEditor(
                          expression,
                          (newNode: unknown) =>
                            transactDoc(activeTab.value, (t) =>
                              mutateUpdateProperty(t, selection, evKey, {
                                $expression: newNode,
                              }),
                            ),
                          { allowEventRef: true, stateDefs: Object.keys(defs) },
                        )}
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
                            html`<sp-menu-item value=${`#/state/${fName}`}>${fName}</sp-menu-item>`,
                        )}
                      </sp-picker>
                    `}
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
                  $ref: `#/state/${functionDefs[0][0]}`,
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
