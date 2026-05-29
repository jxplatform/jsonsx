// ─── Clipboard & Context Menu ─────────────────────────────────────────────────
import { html } from "lit-html";
import { ref } from "lit-html/directives/ref.js";
import { htmlToJx } from "@jxsuite/parser/html-to-jx";
import { getNodeAtPath, parentElementPath, childIndex } from "../store.js";
import { activeTab, workspace } from "../workspace/workspace.js";
import {
  transactDoc,
  mutateInsertNode,
  mutateRemoveNode,
  mutateDuplicateNode,
  mutateWrapNode,
  mutateReplaceStyle,
} from "../tabs/transact.js";
import { statusMessage } from "../panels/statusbar.js";
import { convertToComponent } from "./convert-to-component.js";
import { convertToRepeater } from "./convert-to-repeater.js";
import { componentRegistry } from "../files/components.js";
import { renderPopover } from "../ui/layers.js";
import { startLayerTitleEdit } from "../panels/layers-panel.js";

/**
 * @typedef {import("../state.js").StudioState} StudioState
 *
 * @typedef {import("../state.js").JxPath} JxPath
 *
 * @typedef {JxMutableNode} JxNode
 */

// ─── Clipboard helpers ───────────────────────────────────────────────────────

const JX_MIME = "web application/jx+json";

/** @param {JxNode | string} node */
function nodeToHtml(node) {
  if (typeof node === "string") return node;
  const tag = node.tagName || "div";
  let attrs = "";
  if (node.attributes) {
    for (const [k, v] of Object.entries(node.attributes)) {
      attrs += v === "" ? ` ${k}` : ` ${k}="${v.replace(/"/g, "&quot;")}"`;
    }
  }
  if (node.style) {
    const css = Object.entries(node.style)
      .map(([k, v]) => `${k}:${v}`)
      .join(";");
    if (css) attrs += ` style="${css.replace(/"/g, "&quot;")}"`;
  }
  let inner = "";
  if (node.textContent) {
    inner = node.textContent;
  } else if (node.children) {
    inner = node.children.map((c) => nodeToHtml(c)).join("");
  }
  return `<${tag}${attrs}>${inner}</${tag}>`;
}

/**
 * Write a Jx node to the system clipboard with both jx+json and text/html types.
 *
 * @param {object} json
 */
async function writeToClipboard(json) {
  workspace.clipboard = json;
  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        [JX_MIME]: new Blob([JSON.stringify(json)], { type: JX_MIME }),
        "text/html": new Blob([nodeToHtml(json)], { type: "text/html" }),
      }),
    ]);
  } catch {
    // Fallback: write as plain text if custom MIME not supported
    try {
      await navigator.clipboard.writeText(JSON.stringify(json));
    } catch {
      // clipboard API unavailable — workspace.clipboard is the fallback
    }
  }
}

/**
 * Read from the system clipboard. Returns Jx node(s) or null.
 *
 * @returns {Promise<JxNode[] | null>}
 */
async function readFromClipboard() {
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      if (item.types.includes(JX_MIME)) {
        const blob = await item.getType(JX_MIME);
        const json = JSON.parse(await blob.text());
        return [json];
      }
      if (item.types.includes("text/html")) {
        const blob = await item.getType("text/html");
        const htmlStr = await blob.text();
        const nodes = htmlToJx(htmlStr);
        const jxNodes = /** @type {JxNode[]} */ (
          nodes.map((n) => (typeof n === "string" ? { tagName: "p", textContent: n } : n))
        );
        if (jxNodes.length > 0) return jxNodes;
      }
      if (item.types.includes("text/plain")) {
        const blob = await item.getType("text/plain");
        const text = await blob.text();
        // Try parsing as Jx JSON
        try {
          const parsed = JSON.parse(text);
          if (parsed && parsed.tagName) return [parsed];
        } catch {
          // plain text → paragraph node
        }
        if (text.trim()) return [{ tagName: "p", textContent: text.trim() }];
      }
    }
  } catch {
    // clipboard API unavailable — use workspace fallback
    if (workspace.clipboard) {
      return [JSON.parse(JSON.stringify(workspace.clipboard))];
    }
  }
  return null;
}

// ─── Clipboard actions ───────────────────────────────────────────────────────

export async function copyNode() {
  const tab = activeTab.value;
  if (!tab?.session.selection) return;
  const node = getNodeAtPath(tab.doc.document, tab.session.selection);
  if (!node) return;
  const json = JSON.parse(JSON.stringify(node));
  await writeToClipboard(json);
  statusMessage("Copied");
}

export async function cutNode() {
  const tab = activeTab.value;
  if (!tab?.session.selection || tab.session.selection.length < 2) return;
  const sel = tab.session.selection;
  const node = getNodeAtPath(tab.doc.document, sel);
  if (!node) return;
  const json = JSON.parse(JSON.stringify(node));
  await writeToClipboard(json);
  transactDoc(tab, (t) => mutateRemoveNode(t, sel));
  statusMessage("Cut");
}

export async function pasteNode() {
  const tab = activeTab.value;
  if (!tab) return;

  const nodes = await readFromClipboard();
  if (!nodes || nodes.length === 0) return;

  const pPath = tab.session.selection || [];
  const parent = getNodeAtPath(tab.doc.document, pPath);
  if (!parent) return;

  if (tab.session.selection && tab.session.selection.length >= 2) {
    const pp = /** @type {JxPath} */ (parentElementPath(tab.session.selection));
    const idx = /** @type {number} */ (childIndex(tab.session.selection));
    transactDoc(tab, (t) => {
      for (let i = 0; i < nodes.length; i++) {
        mutateInsertNode(t, pp, idx + 1 + i, nodes[i]);
      }
    });
  } else {
    const idx = parent.children ? parent.children.length : 0;
    transactDoc(tab, (t) => {
      for (let i = 0; i < nodes.length; i++) {
        mutateInsertNode(t, pPath, idx + i, nodes[i]);
      }
    });
  }
  statusMessage("Pasted");
}

export function copyStyles() {
  const tab = activeTab.value;
  if (!tab?.session.selection) return;
  const node = getNodeAtPath(tab.doc.document, tab.session.selection);
  if (!node?.style) return;
  workspace.styleClipboard = JSON.parse(JSON.stringify(node.style));
  statusMessage("Styles copied");
}

export function pasteStyles() {
  if (!workspace.styleClipboard) return;
  const tab = activeTab.value;
  if (!tab?.session.selection) return;
  const style = JSON.parse(JSON.stringify(workspace.styleClipboard));
  const sel = /** @type {JxPath} */ (tab.session.selection);
  transactDoc(tab, (t) => mutateReplaceStyle(t, sel, style));
  statusMessage("Styles pasted");
}

// ─── Context menu ─────────────────────────────────────────────────────────────

/** @type {ReturnType<typeof renderPopover> | null} */
let _ctxHandle = null;

/** Dismiss the context menu if open. */
export function dismissContextMenu() {
  if (_ctxHandle) {
    _ctxHandle.dismiss();
    _ctxHandle = null;
  }
}

/**
 * @param {MouseEvent} e
 * @param {JxPath} path
 * @param {{ onEditComponent?: (path: string) => void; rerender?: () => void }} [opts]
 */
export function showContextMenu(e, path, opts = {}) {
  e.preventDefault();
  dismissContextMenu();

  const tab = activeTab.value;
  const node = getNodeAtPath(tab?.doc.document, path);
  if (!node) return;

  // Select the node
  tab.session.selection = path;

  /** @type {{ label: string; action?: () => void; danger?: boolean }[]} */
  const items = [];

  items.push({ label: "Copy", action: () => copyNode() });
  if (path.length >= 2) {
    items.push({ label: "Cut", action: () => cutNode() });
    items.push({
      label: "Duplicate",
      action: () => transactDoc(activeTab.value, (t) => mutateDuplicateNode(t, path)),
    });
    if (node.style) {
      items.push({
        label: "Copy styles",
        action: () => {
          workspace.styleClipboard = JSON.parse(JSON.stringify(node.style));
          statusMessage("Styles copied");
        },
      });
    }
    if (workspace.styleClipboard) {
      items.push({
        label: "Paste styles",
        action: () => {
          if (!workspace.styleClipboard) return;
          const style = JSON.parse(JSON.stringify(workspace.styleClipboard));
          transactDoc(activeTab.value, (t) => mutateReplaceStyle(t, path, style));
          statusMessage("Styles pasted");
        },
      });
    }
    items.push({ label: "—" }); // separator
    items.push({
      label: "Insert before",
      action: () => {
        const pp = /** @type {JxPath} */ (parentElementPath(path));
        const idx = /** @type {number} */ (childIndex(path));
        transactDoc(activeTab.value, (t) =>
          mutateInsertNode(t, pp, idx, { tagName: "p", children: [] }),
        );
      },
    });
    items.push({
      label: "Insert after",
      action: () => {
        const pp = /** @type {JxPath} */ (parentElementPath(path));
        const idx = /** @type {number} */ (childIndex(path));
        transactDoc(activeTab.value, (t) =>
          mutateInsertNode(t, pp, idx + 1, { tagName: "p", children: [] }),
        );
      },
    });
    items.push({
      label: "Wrap in Div",
      action: () => transactDoc(activeTab.value, (t) => mutateWrapNode(t, path)),
    });
    // Don't show Repeat if already inside a repeater (path ends with "children", "map")
    if (
      !(path.length >= 2 && path[path.length - 2] === "children" && path[path.length - 1] === "map")
    ) {
      items.push({
        label: "Repeat...",
        action: () => convertToRepeater(),
      });
    }
    items.push({
      label: "Set Title",
      action: () => {
        if (opts.rerender) startLayerTitleEdit(path, opts.rerender);
      },
    });
    if (node.tagName) {
      const isComponent =
        node.tagName.includes("-") &&
        componentRegistry.some(
          (/** @type {{ tagName: string }} */ c) => c.tagName === node.tagName,
        );
      if (isComponent && opts.onEditComponent) {
        const comp = componentRegistry.find(
          (/** @type {{ tagName: string; path: string }} */ c) => c.tagName === node.tagName,
        );
        items.push({
          label: "Edit Component",
          action: () => opts.onEditComponent?.(/** @type {string} */ (comp?.path)),
        });
      } else if (!isComponent) {
        items.push({
          label: "Convert to Component",
          action: () => convertToComponent(),
        });
      }
    }
    items.push({ label: "—" }); // separator
    items.push({
      label: "Delete",
      action: () => transactDoc(activeTab.value, (t) => mutateRemoveNode(t, path)),
      danger: true,
    });
  }
  if (path.length >= 2) {
    items.push({ label: "—" });
    items.push({
      label: "Paste inside",
      action: async () => {
        const nodes = await readFromClipboard();
        if (!nodes || nodes.length === 0) return;
        const idx = node.children ? node.children.length : 0;
        transactDoc(activeTab.value, (t) => {
          for (let i = 0; i < nodes.length; i++) {
            mutateInsertNode(t, path, idx + i, nodes[i]);
          }
        });
        statusMessage("Pasted");
      },
    });
    items.push({
      label: "Paste after",
      action: async () => {
        const nodes = await readFromClipboard();
        if (!nodes || nodes.length === 0) return;
        const pp = /** @type {JxPath} */ (parentElementPath(path));
        const idx = /** @type {number} */ (childIndex(path));
        transactDoc(activeTab.value, (t) => {
          for (let i = 0; i < nodes.length; i++) {
            mutateInsertNode(t, pp, idx + 1 + i, nodes[i]);
          }
        });
        statusMessage("Pasted");
      },
    });
  }

  let x = e.clientX,
    y = e.clientY;

  _ctxHandle = renderPopover(
    html`<sp-popover
      open
      style="position:fixed;z-index:10000;left:${x}px;top:${y}px"
      ${ref((el) => {
        if (!el) return;
        requestAnimationFrame(() => {
          const popover = /** @type {HTMLElement} */ (el);
          const menuRect = popover.getBoundingClientRect();
          if (x + menuRect.width > window.innerWidth) x = window.innerWidth - menuRect.width - 4;
          if (y + menuRect.height > window.innerHeight)
            y = window.innerHeight - menuRect.height - 4;
          popover.style.left = `${x}px`;
          popover.style.top = `${y}px`;
        });
      })}
    >
      <sp-menu>
        ${items.map((item) =>
          item.label === "—"
            ? html`<sp-menu-divider></sp-menu-divider>`
            : html`<sp-menu-item
                style=${item.danger ? "color: var(--danger)" : ""}
                @click=${() => {
                  dismissContextMenu();
                  item.action?.();
                }}
                >${item.label}</sp-menu-item
              >`,
        )}
      </sp-menu>
    </sp-popover>`,
    {
      dismissOnOutsideClick: true,
      onDismiss: () => {
        _ctxHandle = null;
      },
    },
  );
}
