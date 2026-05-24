// ─── Convert to Component ─────────────────────────────────────────────────────
import { html, render as litRender } from "lit-html";
import { getNodeAtPath, parentElementPath, childIndex } from "../store.js";
import { activeTab } from "../workspace/workspace.js";
import { transact } from "../tabs/transact.js";
import {
  computeRelativePath,
  loadComponentRegistry,
  componentRegistry,
} from "../files/components.js";
import { getPlatform } from "../platform.js";
import { statusMessage } from "../panels/statusbar.js";
import { showDialog } from "../ui/layers.js";

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
    const idx = childIndex(selectionPath);
    let parent = doc;
    for (const seg of pp) parent = parent[seg];
    parent.children[idx] = { tagName: name };

    // Ensure $elements exists and add the $ref
    if (!doc.$elements) doc.$elements = [];
    const alreadyReferenced = doc.$elements.some(
      (/** @type {any} */ el) => el && el.$ref === refPath,
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
  } catch (/** @type {any} */ err) {
    statusMessage(`Error saving component: ${err.message}`);
  }
}

/**
 * Derive a default tag name from a node.
 *
 * @param {any} node
 * @returns {string}
 */
function deriveDefaultName(node) {
  if (node.$id && node.$id.includes("-")) return node.$id.toLowerCase();
  const tag = (node.tagName ?? "div").toLowerCase();
  return tag.includes("-") ? tag : "jx-" + tag;
}

/**
 * Deep clone a node and strip page-specific keys.
 *
 * @param {any} node
 * @returns {any}
 */
function extractComponentDef(node) {
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
function validateName(val) {
  val = val.trim().toLowerCase();
  if (!val.includes("-")) {
    return { valid: false, error: "Name must contain a hyphen (e.g. my-component)" };
  }
  if (!VALID_NAME.test(val)) {
    return { valid: false, error: "Lowercase letters, digits, and hyphens only" };
  }
  const exists = componentRegistry.some((/** @type {any} */ c) => c.tagName === val);
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
function promptComponentName(defaultName) {
  let value = defaultName;
  let error = "";

  return showDialog((done) => {
    function confirm() {
      const result = validateName(value);
      if (!result.valid) {
        error = result.error;
        rerender();
        return;
      }
      done(value.trim().toLowerCase());
    }

    function onInput(/** @type {Event} */ e) {
      value = /** @type {any} */ (e.target).value || "";
      const result = validateName(value);
      error = result.valid ? "" : result.error;
      rerender();
    }

    function onKeydown(/** @type {KeyboardEvent} */ e) {
      if (e.key === "Enter") confirm();
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
          >
            <sp-help-text slot="negative-help-text">${error}</sp-help-text>
          </sp-textfield>
        </sp-dialog-wrapper>
      `;
    }

    requestAnimationFrame(() => {
      const layer = document.getElementById("layer-dialog");
      const tf = /** @type {any} */ (layer?.querySelector("sp-textfield"));
      if (tf) {
        tf.focus();
        const input = tf.shadowRoot?.querySelector("input");
        if (input) input.select();
      }
    });

    return buildTpl();
  });
}
