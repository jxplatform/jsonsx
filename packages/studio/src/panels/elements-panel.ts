/// <reference lib="dom" />
/** Elements panel — block/component palette with categorized accordion and search filter. */

import { html, nothing } from "lit-html";
import { childList, getNodeAtPath } from "../store";
import { activeTab } from "../workspace/workspace";
import { mutateInsertNode, transactDoc } from "../tabs/transact";
import { view } from "../view";
import { getEffectiveElements } from "../site-context";
import { componentRegistry } from "../files/components";

import type { ComponentEntry } from "../files/components";
import type { JxElement, JxMutableNode } from "@jxsuite/schema/types";

/**
 * @param {{
 *   webdata: { elements: Record<string, { tag: string }[]> };
 *   defaultDef: (tag: string) => JxMutableNode;
 *   rerender: () => void;
 * }} ctx
 * @returns {import("lit-html").TemplateResult}
 */
export function renderElementsTemplate(ctx: {
  webdata: { elements: Record<string, { tag: string }[]> };
  defaultDef: (tag: string) => JxMutableNode;
  rerender: () => void;
}) {
  const tab = activeTab.value;

  const categories = Object.entries(ctx.webdata.elements).map(
    (/** @type {[string, { tag: string }[]]} */ [category, elements]) => {
      const filtered = view.elementsFilter
        ? elements.filter((/** @type {{ tag: string }} */ e) => e.tag.includes(view.elementsFilter))
        : elements;
      if (filtered.length === 0) {
        return nothing;
      }

      return html`
        <sp-accordion-item
          label=${category}
          ?open=${!view.elementsCollapsed.has(category)}
          @sp-accordion-item-toggle=${(e: Event) => {
            if ((e.target as HTMLElement & { open: boolean }).open) {
              view.elementsCollapsed.delete(category);
            } else {
              view.elementsCollapsed.add(category);
            }
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
                  const parent = getNodeAtPath(t!.doc.document, parentPath);
                  const idx = childList(parent).length;
                  transactDoc(t!, (tr) =>
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
    tab?.doc.document?.$elements as (string | JxElement)[] | undefined,
  );
  const enabledTags = new Set<string>();
  for (const entry of effectiveEls) {
    if (typeof entry !== "string") {
      continue;
    }
    const comp = componentRegistry.find(
      (c: ComponentEntry) =>
        c.source === "npm" && c.modulePath && entry === `${c.package}/${c.modulePath}`,
    );
    if (comp) {
      enabledTags.add(comp.tagName);
    } else {
      for (const c of componentRegistry) {
        if (c.source === "npm" && c.package === entry) {
          enabledTags.add(c.tagName);
        }
      }
    }
  }
  const compsFiltered =
    componentRegistry.length > 0
      ? componentRegistry
          .filter((c: ComponentEntry) => c.source !== "npm" || enabledTags.has(c.tagName))
          .filter(
            (c: ComponentEntry) =>
              !view.elementsFilter || c.tagName.toLowerCase().includes(view.elementsFilter),
          )
      : [];

  const componentsAccordion =
    compsFiltered.length > 0
      ? html`
          <sp-accordion-item
            label="Components"
            ?open=${!view.elementsCollapsed.has("Components")}
            @sp-accordion-item-toggle=${(e: Event) => {
              if ((e.target as HTMLElement & { open: boolean }).open) {
                view.elementsCollapsed.delete("Components");
              } else {
                view.elementsCollapsed.add("Components");
              }
            }}
          >
            <div class="components-section">
              ${compsFiltered.map(
                (comp: ComponentEntry) => html`
                  <div
                    class="element-card"
                    data-component-tag=${comp.tagName}
                    title=${comp.source === "npm"
                      ? `${comp.package}: <${comp.tagName}>`
                      : comp.path}
                    @click=${() => {
                      const t = activeTab.value;
                      const parentPath = t?.session.selection || [];
                      const parent = getNodeAtPath(t!.doc.document, parentPath);
                      const idx = childList(parent).length;
                      const instanceDef = {
                        $props: Object.fromEntries(
                          (comp.props || []).map(
                            (/** @type {{ name: string; default?: unknown }} */ p) => [
                              p.name,
                              p.default !== undefined ? p.default : "",
                            ],
                          ),
                        ),
                        tagName: comp.tagName,
                      };
                      transactDoc(t!, (tr) =>
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
      @input=${(e: Event) => {
        view.elementsFilter = (e.target as HTMLInputElement).value.toLowerCase();
        ctx.rerender();
      }}
    ></sp-search>
    <sp-accordion class="elements-list" allow-multiple
      >${componentsAccordion}${categories}</sp-accordion
    >
  `;
}
