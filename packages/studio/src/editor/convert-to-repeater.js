// ─── Convert to Repeater ──────────────────────────────────────────────────────
import { html, render as litRender, nothing } from "lit-html";
import { getNodeAtPath, parentElementPath, childIndex } from "../store.js";
import { activeTab } from "../workspace/workspace.js";
import { transactDoc } from "../tabs/transact.js";
import { showDialog } from "../ui/layers.js";
import { defCategory } from "../panels/signals-panel.js";

/**
 * @typedef {{
 *   items: { $ref: string } | unknown[];
 *   filter?: { $ref: string };
 *   sort?: { $ref: string };
 *   newDef?: { name: string };
 * }} RepeaterConfig
 */

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
    const idx = /** @type {number} */ (childIndex(path));
    const parent = getNodeAtPath(doc, pp);
    const element = parent.children[idx];

    /** @type {Record<string, unknown>} */
    const repeater = {
      $prototype: "Array",
      items: config.items,
      map: element,
    };
    if (config.filter) repeater.filter = config.filter;
    if (config.sort) repeater.sort = config.sort;

    parent.children[idx] = { tagName: "div", children: repeater };
  });
}

/**
 * @param {Record<string, unknown>} defs
 * @returns {Promise<RepeaterConfig | null>}
 */
function promptRepeaterConfig(defs) {
  const arrayDefs = Object.entries(defs).filter(
    ([, d]) =>
      /** @type {any} */ (d)?.type === "array" ||
      Array.isArray(/** @type {any} */ (d)?.default) ||
      /** @type {any} */ (d)?.$prototype === "Array",
  );
  const fnDefs = Object.entries(defs).filter(([, d]) => defCategory(d) === "function");

  let source = arrayDefs.length > 0 ? arrayDefs[0][0] : "__new__";
  let newDefName = "";
  let filterDef = "";
  let sortDef = "";
  let error = "";

  return showDialog((done) => {
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
          items: { $ref: `#/$defs/${name}` },
          filter: filterDef ? { $ref: `#/$defs/${filterDef}` } : undefined,
          sort: sortDef ? { $ref: `#/$defs/${sortDef}` } : undefined,
          newDef: { name },
        });
      } else {
        done({
          items: { $ref: `#/$defs/${source}` },
          filter: filterDef ? { $ref: `#/$defs/${filterDef}` } : undefined,
          sort: sortDef ? { $ref: `#/$defs/${sortDef}` } : undefined,
        });
      }
    }

    function rerender() {
      const layer = document.getElementById("layer-dialog");
      const slot = layer?.lastElementChild;
      if (slot) litRender(buildTpl(), /** @type {HTMLElement} */ (slot));
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
                @change=${(/** @type {Event} */ e) => {
                  source = /** @type {HTMLInputElement} */ (e.target).value;
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
                      @input=${(/** @type {Event} */ e) => {
                        newDefName = /** @type {HTMLInputElement} */ (e.target).value || "";
                        error = "";
                        rerender();
                      }}
                      @keydown=${(/** @type {KeyboardEvent} */ e) => {
                        if (e.key === "Enter") confirm();
                      }}
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
                      @change=${(/** @type {Event} */ e) => {
                        filterDef = /** @type {HTMLInputElement} */ (e.target).value;
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
                      @change=${(/** @type {Event} */ e) => {
                        sortDef = /** @type {HTMLInputElement} */ (e.target).value;
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

    requestAnimationFrame(() => {
      const layer = document.getElementById("layer-dialog");
      if (source === "__new__") {
        const tf = /** @type {HTMLElement | null} */ (layer?.querySelector("sp-textfield"));
        if (tf) tf.focus();
      }
    });

    return buildTpl();
  });
}
