/// <reference lib="dom" />
// ─── Convert to Component ─────────────────────────────────────────────────────
import { html, render as litRender } from "lit-html";
import { ref } from "lit-html/directives/ref.js";
import { getNodeAtPath, parentElementPath, childIndex } from "../store";
import { activeTab } from "../workspace/workspace";
import { transact } from "../tabs/transact";
import { computeRelativePath, loadComponentRegistry, componentRegistry } from "../files/components";
import { getPlatform } from "../platform";
import { statusMessage } from "../panels/statusbar";
import { showDialog } from "../ui/layers";

import type { JxMutableNode } from "@jxsuite/schema/types";

const VALID_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)+$/;

/** Convert the currently selected element into a reusable component. */
export async function convertToComponent() {
  const tab = activeTab.value;
  if (!tab?.session.selection || tab.session.selection.length < 2) return;

  const node = getNodeAtPath(tab.doc.document, tab.session.selection);
  if (!node || !node.tagName) return;

  const defaultName = deriveDefaultName(node);
  const name = await promptComponentName(defaultName);
  if (!name) return;

  // Extract component definition
  const componentDef = extractComponentDef(node);
  componentDef.tagName = name;

  // Compute paths
  const componentFile = "components/" + name + ".json";
  const refPath = computeRelativePath(tab.documentPath, componentFile);

  // Single atomic mutation: replace node + add $elements ref
  const selectionPath = tab.session.selection;
  transact(tab, (doc) => {
    // Navigate to parent's children array and replace the node
    const pp = parentElementPath(selectionPath) ?? [];
    const idx = childIndex(selectionPath) as number;
    let parent = doc;
    for (const seg of pp) parent = parent[seg];
    if (!parent.children) parent.children = [];
    parent.children[idx] = { tagName: name };

    // Ensure $elements exists and add the $ref
    if (!doc.$elements) doc.$elements = [];
    const alreadyReferenced = doc.$elements.some(
      (/** @type {JxMutableNode | string | { $ref: string }} */ el) =>
        el && typeof el === "object" && "$ref" in el && el.$ref === refPath,
    );
    if (!alreadyReferenced) {
      doc.$elements.push({ $ref: refPath });
    }
  });

  // Write component file and refresh registry
  try {
    const platform = getPlatform();
    await platform.writeFile(componentFile, JSON.stringify(componentDef, null, 2));
    await loadComponentRegistry();
    statusMessage(`Converted to <${name}>`);
  } catch (err) {
    statusMessage(`Error saving component: ${(err as Error).message}`);
  }
}

/**
 * Derive a default tag name from a node.
 *
 * @param {JxMutableNode} node
 * @returns {string}
 */
function deriveDefaultName(node: JxMutableNode) {
  if (node.$id && node.$id.includes("-")) return node.$id.toLowerCase();
  const tag = (node.tagName ?? "div").toLowerCase();
  return tag.includes("-") ? tag : "jx-" + tag;
}

/**
 * Deep clone a node and strip page-specific keys.
 *
 * @param {JxMutableNode} node
 * @returns {JxMutableNode}
 */
function extractComponentDef(node: JxMutableNode) {
  const clone = structuredClone(node);
  delete clone.$id;
  delete clone.$layout;
  delete clone.$paths;
  return clone;
}

/**
 * Validate a component name against naming rules and existing registry.
 *
 * @param {string} val
 * @returns {{ valid: boolean; error: string }}
 */
function validateName(val: string) {
  val = val.trim().toLowerCase();
  if (!val.includes("-")) {
    return {
      valid: false,
      error: "Name must contain a hyphen (e.g. my-component)",
    };
  }
  if (!VALID_NAME.test(val)) {
    return {
      valid: false,
      error: "Lowercase letters, digits, and hyphens only",
    };
  }
  const exists = componentRegistry.some((c: JxMutableNode) => c.tagName === val);
  if (exists) {
    return { valid: false, error: `Component <${val}> already exists` };
  }
  return { valid: true, error: "" };
}

/**
 * Show a naming dialog using Lit-rendered sp-dialog-wrapper.
 *
 * @param {string} defaultName
 * @returns {Promise<string | null>}
 */
function promptComponentName(defaultName: string) {
  let value = defaultName;
  let error = "";

  return showDialog<string | null>((done) => {
    function confirm() {
      const result = validateName(value);
      if (!result.valid) {
        error = result.error;
        rerender();
        return;
      }
      done(value.trim().toLowerCase());
    }

    function onInput(e: Event) {
      value = (e.target as HTMLInputElement).value || "";
      const result = validateName(value);
      error = result.valid ? "" : result.error;
      rerender();
    }

    function onKeydown(e: KeyboardEvent) {
      if (e.key === "Enter") confirm();
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
          headline="Convert to Component"
          confirm-label="Convert"
          cancel-label="Cancel"
          size="s"
          @confirm=${confirm}
          @cancel=${() => done(null)}
          @close=${() => done(null)}
        >
          <p>Enter a hyphenated tag name for the new component.</p>
          <sp-textfield
            placeholder="my-component"
            value=${value}
            ?negative=${!!error}
            @input=${onInput}
            @keydown=${onKeydown}
            ${ref((el) => {
              if (el)
                requestAnimationFrame(() => {
                  (el as HTMLElement).focus();
                  const input = (el as HTMLElement).shadowRoot?.querySelector("input");
                  if (input) input.select();
                });
            })}
          >
            <sp-help-text slot="negative-help-text">${error}</sp-help-text>
          </sp-textfield>
        </sp-dialog-wrapper>
      `;
    }

    return buildTpl();
  });
}
