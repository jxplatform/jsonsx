/** Elements panel — block/component palette with categorized accordion and search filter. */

import { html, nothing } from "lit-html";
import { getNodeAtPath } from "../store.js";
import { activeTab } from "../workspace/workspace.js";
import { transactDoc, mutateInsertNode } from "../tabs/transact.js";
import { view } from "../view.js";
import { getEffectiveElements } from "../site-context.js";
import { componentRegistry } from "../files/components.js";

/** @typedef {import("../files/components.js").ComponentEntry} ComponentEntry */

/**
 * @param {{
 *   webdata: { elements: Record<string, { tag: string }[]> };
 *   defaultDef: (tag: string) => JxMutableNode;
 *   rerender: () => void;
 * }} ctx
 * @returns {import("lit-html").TemplateResult}
 */
export function renderElementsTemplate(ctx) {
  const tab = activeTab.value;

  const categories = Object.entries(ctx.webdata.elements).map(
    (/** @type {[string, { tag: string }[]]} */ [category, elements]) => {
      const filtered = view.elementsFilter
        ? elements.filter((/** @type {{ tag: string }} */ e) => e.tag.includes(view.elementsFilter))
        : elements;
      if (filtered.length === 0) return nothing;

      return html`
        <sp-accordion-item
          label=${category}
          ?open=${!view.elementsCollapsed.has(category)}
          @sp-accordion-item-toggle=${(/** @type {Event} */ e) => {
            if (/** @type {HTMLElement & { open: boolean }} */ (e.target).open)
              view.elementsCollapsed.delete(category);
            else view.elementsCollapsed.add(category);
          }}
        >
          ${filtered.map((/** @type {{ tag: string }} */ { tag }) => {
            const def = ctx.defaultDef(tag);
            return html`
              <div
                class="element-card"
                data-block-tag=${tag}
                @click=${() => {
                  const t = activeTab.value;
                  const parentPath = t?.session.selection || [];
                  const parent = getNodeAtPath(t?.doc.document, parentPath);
                  const idx = parent?.children ? parent.children.length : 0;
                  transactDoc(t, (tr) =>
                    mutateInsertNode(tr, parentPath, idx, structuredClone(def)),
                  );
                }}
              >
                <div class="element-card-preview"></div>
                <div class="element-card-label">&lt;${tag}&gt;</div>
              </div>
            `;
          })}
        </sp-accordion-item>
      `;
    },
  );

  const effectiveEls = getEffectiveElements(
    /** @type {(string | JxElement)[] | undefined} */ (tab?.doc.document?.$elements),
  );
  /** @type {Set<string>} */
  const enabledTags = new Set();
  for (const entry of effectiveEls) {
    if (typeof entry !== "string") continue;
    const comp = componentRegistry.find(
      (/** @type {ComponentEntry} */ c) =>
        c.source === "npm" && c.modulePath && entry === `${c.package}/${c.modulePath}`,
    );
    if (comp) {
      enabledTags.add(comp.tagName);
    } else {
      for (const c of componentRegistry) {
        if (c.source === "npm" && c.package === entry) enabledTags.add(c.tagName);
      }
    }
  }
  const compsFiltered =
    componentRegistry.length > 0
      ? componentRegistry
          .filter(
            (/** @type {ComponentEntry} */ c) => c.source !== "npm" || enabledTags.has(c.tagName),
          )
          .filter(
            (/** @type {ComponentEntry} */ c) =>
              !view.elementsFilter || c.tagName.toLowerCase().includes(view.elementsFilter),
          )
      : [];

  const componentsAccordion =
    compsFiltered.length > 0
      ? html`
          <sp-accordion-item
            label="Components"
            ?open=${!view.elementsCollapsed.has("Components")}
            @sp-accordion-item-toggle=${(/** @type {Event} */ e) => {
              if (/** @type {HTMLElement & { open: boolean }} */ (e.target).open)
                view.elementsCollapsed.delete("Components");
              else view.elementsCollapsed.add("Components");
            }}
          >
            <div class="components-section">
              ${compsFiltered.map(
                (/** @type {ComponentEntry} */ comp) => html`
                  <div
                    class="element-card"
                    data-component-tag=${comp.tagName}
                    title=${comp.source === "npm"
                      ? `${comp.package}: <${comp.tagName}>`
                      : comp.path}
                    @click=${() => {
                      const t = activeTab.value;
                      const parentPath = t?.session.selection || [];
                      const parent = getNodeAtPath(t?.doc.document, parentPath);
                      const idx = parent?.children ? parent.children.length : 0;
                      const instanceDef = {
                        tagName: comp.tagName,
                        $props: Object.fromEntries(
                          (comp.props || []).map(
                            (/** @type {{ name: string; default?: unknown }} */ p) => [
                              p.name,
                              p.default !== undefined ? p.default : "",
                            ],
                          ),
                        ),
                      };
                      transactDoc(t, (tr) =>
                        mutateInsertNode(tr, parentPath, idx, structuredClone(instanceDef)),
                      );
                    }}
                  >
                    <div class="element-card-preview">
                      <span style="color:var(--fg-dim);font-size:11px;font-style:italic"
                        >&lt;${comp.tagName}&gt;</span
                      >
                    </div>
                    <div class="element-card-label">${comp.tagName}</div>
                  </div>
                `,
              )}
            </div>
          </sp-accordion-item>
        `
      : nothing;

  return html`
    <sp-search
      size="s"
      placeholder="Filter elements…"
      value=${view.elementsFilter}
      @input=${(/** @type {Event} */ e) => {
        view.elementsFilter = /** @type {HTMLInputElement} */ (e.target).value.toLowerCase();
        ctx.rerender();
      }}
    ></sp-search>
    <sp-accordion class="elements-list" allow-multiple
      >${componentsAccordion}${categories}</sp-accordion
    >
  `;
}
