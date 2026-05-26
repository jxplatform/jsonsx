import { getNodeAtPath } from "../store.js";
import { html, nothing } from "lit-html";
import { live } from "lit-html/directives/live.js";
import { activeTab } from "../workspace/workspace.js";
import { transactDoc, mutateUpdateProperty } from "../tabs/transact.js";

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
export function eventsSidebarTemplate(helpers) {
  const { isCustomElementDoc } = helpers;
  const tab = activeTab.value;
  const selection = tab?.session.selection;
  const document = tab?.doc.document;
  if (!selection) return html`<div class="empty-state">Select an element to edit events</div>`;
  const node = getNodeAtPath(document, selection);
  if (!node) return html`<div class="empty-state">Node not found</div>`;

  const defs = document.state || {};
  const functionDefs = Object.entries(defs).filter(
    ([, d]) => d.$prototype === "Function" || d.$handler,
  );

  // Declared CEM events (custom element docs)
  /** @type {unknown} */
  let declaredEventsT = nothing;
  if (isCustomElementDoc()) {
    const allEmits = [];
    for (const [fnName, d] of Object.entries(defs)) {
      if (Array.isArray(d.emits)) {
        for (const ev of d.emits) allEmits.push({ ...ev, _fn: fnName });
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
                ${ev.type?.text ? html`<span class="event-type">${ev.type.text}</span>` : nothing}
              </div>
            `,
          )}
        </div>
        <sp-divider size="s"></sp-divider>
      `;
    }
  }

  // Find existing event bindings
  const eventKeys = Object.keys(node).filter((k) => {
    if (!k.startsWith("on")) return false;
    const v = node[k];
    if (!v || typeof v !== "object") return false;
    return v.$ref || v.$prototype === "Function";
  });

  return html`
    <div class="events-panel">
      ${declaredEventsT}
      <div class="events-section">
        ${eventKeys.length > 0
          ? html` <sp-field-label size="s">Event Bindings</sp-field-label> `
          : nothing}
        ${eventKeys.map((evKey) => {
          const evVal = node[evKey];
          const isInline = evVal.$prototype === "Function";
          return html`
            <div class="event-binding">
              <div class="event-row">
                <sp-picker
                  size="s"
                  class="event-name"
                  .value=${live(evKey)}
                  @change=${(/** @type {Event} */ e) => {
                    const newKey = /** @type {HTMLInputElement} */ (e.target).value;
                    if (newKey && newKey !== evKey) {
                      transactDoc(activeTab.value, (t) => {
                        mutateUpdateProperty(t, selection, evKey, undefined);
                        mutateUpdateProperty(t, selection, newKey, node[evKey]);
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
                  .value=${live(isInline ? "inline" : "ref")}
                  @change=${(/** @type {Event} */ e) => {
                    if (/** @type {HTMLInputElement} */ (e.target).value === "inline") {
                      transactDoc(activeTab.value, (t) =>
                        mutateUpdateProperty(t, selection, evKey, {
                          $prototype: "Function",
                          body: "",
                          parameters: [],
                        }),
                      );
                    } else {
                      const firstFn = functionDefs[0];
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
                  <sp-menu-item value="ref">$ref</sp-menu-item>
                </sp-picker>
                <sp-action-button
                  size="xs"
                  quiet
                  @click=${() =>
                    transactDoc(activeTab.value, (t) =>
                      mutateUpdateProperty(t, selection, evKey, undefined),
                    )}
                >
                  <sp-icon-delete slot="icon"></sp-icon-delete>
                </sp-action-button>
              </div>
              ${isInline
                ? html`
                    <div class="event-body-row">
                      <sp-textfield
                        size="s"
                        multiline
                        grows
                        placeholder="// handler body"
                        .value=${live(evVal.body || "")}
                        @input=${(/** @type {Event} */ e) => {
                          transactDoc(activeTab.value, (t) =>
                            mutateUpdateProperty(t, selection, evKey, {
                              $prototype: "Function",
                              body: /** @type {HTMLInputElement} */ (e.target).value,
                              parameters: evVal.parameters || [],
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
                            type: "event",
                            path: selection,
                            eventKey: evKey,
                          };
                        }}
                      >
                        <sp-icon-code slot="icon"></sp-icon-code>
                      </sp-action-button>
                    </div>
                  `
                : html`
                    <sp-picker
                      size="s"
                      class="event-handler"
                      .value=${live(evVal.$ref || "__none__")}
                      @change=${(/** @type {Event} */ e) => {
                        if (
                          /** @type {HTMLInputElement} */ (e.target).value &&
                          /** @type {HTMLInputElement} */ (e.target).value !== "__none__"
                        ) {
                          transactDoc(activeTab.value, (t) =>
                            mutateUpdateProperty(t, selection, evKey, {
                              $ref: /** @type {HTMLInputElement} */ (e.target).value,
                            }),
                          );
                        } else {
                          transactDoc(activeTab.value, (t) =>
                            mutateUpdateProperty(t, selection, evKey, undefined),
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
