/// <reference lib="dom" />
// ─── Convert to Repeater ──────────────────────────────────────────────────────
import { html, render as litRender, nothing } from "lit-html";
import { ref } from "lit-html/directives/ref.js";
import { getNodeAtPath, parentElementPath, childIndex } from "../store";
import { activeTab } from "../workspace/workspace";
import { transactDoc } from "../tabs/transact";
import { showDialog } from "../ui/layers";
import { defCategory } from "../panels/signals-panel";
import { fetchPluginSchema } from "../services/code-services";

import type { JxMutableNode } from "@jxsuite/schema/types";

interface RepeaterConfig {
  items: { $ref: string } | unknown[];
  filter?: { $ref: string };
  sort?: { $ref: string };
  newDef?: { name: string };
}

/** Convert the currently selected element into a repeater template. */
export async function convertToRepeater() {
  const tab = activeTab.value;
  if (!tab?.session.selection || tab.session.selection.length < 2) return;

  const path = tab.session.selection;
  const node = getNodeAtPath(tab.doc.document, path);
  if (!node) return;

  const defs = tab.doc.document.state || {};
  const config = await promptRepeaterConfig(defs);
  if (!config) return;

  transactDoc(tab, (t) => {
    const doc = t.doc.document;
    if (config.newDef) {
      if (!doc.state) doc.state = {};
      doc.state[config.newDef.name] = { type: "array", default: [] };
    }
    const pp = parentElementPath(path);
    if (!pp) return;
    const idx = childIndex(path) as number;
    const parent = getNodeAtPath(doc, pp);
    if (!parent?.children) return;
    const element = parent.children[idx];

    const repeater: Record<string, unknown> = {
      $prototype: "Array",
      items: config.items,
      map: element,
    };
    if (config.filter) repeater.filter = config.filter;
    if (config.sort) repeater.sort = config.sort;

    (parent.children as (string | JxMutableNode)[])[idx] = {
      tagName: "div",
      children: repeater as unknown as (string | JxMutableNode)[],
    };
  });
}

/**
 * @param {Record<string, unknown>} defs
 * @returns {Promise<RepeaterConfig | null>}
 */
async function promptRepeaterConfig(defs: Record<string, unknown>) {
  const arrayDefs = Object.entries(defs).filter(
    ([, d]) =>
      (d as Record<string, unknown> | null)?.type === "array" ||
      Array.isArray((d as Record<string, unknown> | null)?.default) ||
      (d as Record<string, unknown> | null)?.$prototype === "Array",
  );

  const tab = activeTab.value;
  const docPath = tab?.documentPath;
  for (const [name, d] of Object.entries(defs)) {
    const def = d as Record<string, unknown> | null;
    if (!def?.$prototype || def.$prototype === "Function" || def.$prototype === "Array") continue;
    if (arrayDefs.some(([n]) => n === name)) continue;
    const schema = await fetchPluginSchema(
      { $src: def.$src as string | undefined, $prototype: def.$prototype as string },
      { documentPath: docPath || undefined },
    );
    if (schema?.returns?.type === "array") {
      arrayDefs.push([name, d]);
    }
  }

  const fnDefs = Object.entries(defs).filter(([, d]) => defCategory(d) === "function");

  let source = arrayDefs.length > 0 ? arrayDefs[0][0] : "__new__";
  let newDefName = "";
  let filterDef = "";
  let sortDef = "";
  let error = "";

  return showDialog<RepeaterConfig | null>((done) => {
    function confirm() {
      if (source === "__new__") {
        const name = newDefName.trim();
        if (!name) {
          error = "Enter a name for the new state definition.";
          rerender();
          return;
        }
        if (defs[name]) {
          error = `"${name}" already exists.`;
          rerender();
          return;
        }
        if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name)) {
          error = "Invalid identifier name.";
          rerender();
          return;
        }
        done({
          items: { $ref: `#/state/${name}` },
          filter: filterDef ? { $ref: `#/state/${filterDef}` } : undefined,
          sort: sortDef ? { $ref: `#/state/${sortDef}` } : undefined,
          newDef: { name },
        });
      } else {
        done({
          items: { $ref: `#/state/${source}` },
          filter: filterDef ? { $ref: `#/state/${filterDef}` } : undefined,
          sort: sortDef ? { $ref: `#/state/${sortDef}` } : undefined,
        });
      }
    }

    function rerender() {
      const layer = document.getElementById("layer-dialog");
      const slot = layer?.lastElementChild;
      if (slot) litRender(buildTpl(), slot as HTMLElement);
    }

    function buildTpl() {
      return html`
        <sp-dialog-wrapper
          open
          underlay
          headline="Repeat..."
          confirm-label="Create Repeater"
          cancel-label="Cancel"
          size="s"
          @confirm=${confirm}
          @cancel=${() => done(null)}
          @close=${() => done(null)}
        >
          <div style="display:flex;flex-direction:column;gap:12px">
            <label>
              <sp-field-label size="s">Items source</sp-field-label>
              <sp-picker
                label="Items source"
                size="s"
                .value=${source}
                @change=${(e: Event) => {
                  source = (e.target as HTMLInputElement).value;
                  error = "";
                  rerender();
                }}
              >
                ${arrayDefs.map(
                  ([name]) => html`<sp-menu-item value=${name}>${name}</sp-menu-item>`,
                )}
                <sp-menu-divider></sp-menu-divider>
                <sp-menu-item value="__new__">Create new...</sp-menu-item>
              </sp-picker>
            </label>

            ${source === "__new__"
              ? html`
                  <label>
                    <sp-field-label size="s">New definition name</sp-field-label>
                    <sp-textfield
                      size="s"
                      placeholder="myItems"
                      .value=${newDefName}
                      ?negative=${!!error}
                      @input=${(e: Event) => {
                        newDefName = (e.target as HTMLInputElement).value || "";
                        error = "";
                        rerender();
                      }}
                      @keydown=${(e: KeyboardEvent) => {
                        if (e.key === "Enter") confirm();
                      }}
                      ${ref((el) => {
                        if (el && source === "__new__")
                          requestAnimationFrame(() => (el as HTMLElement).focus());
                      })}
                    >
                      <sp-help-text slot="negative-help-text">${error}</sp-help-text>
                    </sp-textfield>
                  </label>
                `
              : nothing}
            ${fnDefs.length > 0
              ? html`
                  <label>
                    <sp-field-label size="s">Filter (optional)</sp-field-label>
                    <sp-picker
                      label="Filter"
                      size="s"
                      .value=${filterDef}
                      @change=${(e: Event) => {
                        filterDef = (e.target as HTMLInputElement).value;
                        rerender();
                      }}
                    >
                      <sp-menu-item value="">None</sp-menu-item>
                      ${fnDefs.map(
                        ([name]) => html`<sp-menu-item value=${name}>${name}</sp-menu-item>`,
                      )}
                    </sp-picker>
                  </label>
                  <label>
                    <sp-field-label size="s">Sort (optional)</sp-field-label>
                    <sp-picker
                      label="Sort"
                      size="s"
                      .value=${sortDef}
                      @change=${(e: Event) => {
                        sortDef = (e.target as HTMLInputElement).value;
                        rerender();
                      }}
                    >
                      <sp-menu-item value="">None</sp-menu-item>
                      ${fnDefs.map(
                        ([name]) => html`<sp-menu-item value=${name}>${name}</sp-menu-item>`,
                      )}
                    </sp-picker>
                  </label>
                `
              : nothing}
          </div>
        </sp-dialog-wrapper>
      `;
    }

    return buildTpl();
  });
}
