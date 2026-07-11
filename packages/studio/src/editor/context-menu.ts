/// <reference lib="dom" />
// ─── Clipboard & Context Menu ─────────────────────────────────────────────────
import { html } from "lit-html";
import { jsonClone } from "../utils/studio-utils";
import { ref } from "lit-html/directives/ref.js";
import { htmlToJx } from "@jxsuite/markup/html-to-jx";
import { childIndex, getNodeAtPath, parentElementPath } from "../store";
import { activeTab, workspace } from "../workspace/workspace";
import {
  mutateDuplicateNode,
  mutateInsertNode,
  mutateRemoveNode,
  mutateReplaceStyle,
  mutateWrapNode,
  transactDoc,
} from "../tabs/transact";
import { statusMessage } from "../panels/statusbar";
import { convertToComponent } from "./convert-to-component";
import { convertToRepeater } from "./convert-to-repeater";
import { componentRegistry } from "../files/components";
import { renderPopover } from "../ui/layers";
import { rectOf } from "../utils/geometry";

import type { JxPath } from "../state";
import type { JxMutableNode } from "@jxsuite/schema/types";

type JxNode = JxMutableNode;

// ─── Clipboard helpers ───────────────────────────────────────────────────────

const JX_MIME = "web application/jx+json";

/** @param {JxNode | string} node */
function nodeToHtml(node: JxNode | string): string {
  if (typeof node === "string") {
    return node;
  }
  const tag = node.tagName || "div";
  let attrs = "";
  if (node.attributes) {
    for (const [k, v] of Object.entries(node.attributes)) {
      // Bound ($ref) attribute values have no static HTML representation — skip.
      if (typeof v === "object") {
        continue;
      }
      attrs += v === "" ? ` ${k}` : ` ${k}="${String(v).replaceAll('"', "&quot;")}"`;
    }
  }
  if (node.style) {
    const css = Object.entries(node.style)
      .map(([k, v]) => `${k}:${v}`)
      .join(";");
    if (css) {
      attrs += ` style="${css.replaceAll('"', "&quot;")}"`;
    }
  }
  let inner = "";
  if (typeof node.textContent === "string") {
    inner = node.textContent;
  } else if (Array.isArray(node.children)) {
    inner = node.children.map((c) => nodeToHtml(c)).join("");
  }
  return `<${tag}${attrs}>${inner}</${tag}>`;
}

/**
 * Write a Jx node to the system clipboard with both jx+json and text/html types.
 *
 * @param {object} json
 */
async function writeToClipboard(json: Record<string, unknown>) {
  workspace.clipboard = json;
  try {
    const jxBlob = new Blob([JSON.stringify(json)], { type: JX_MIME });
    const htmlBlob = new Blob([nodeToHtml(json)], { type: "text/html" });
    await navigator.clipboard.write([
      new ClipboardItem({
        [JX_MIME]: jxBlob,
        "text/html": htmlBlob,
      }),
    ]);
  } catch {
    // Fallback: write as plain text if custom MIME not supported
    try {
      await navigator.clipboard.writeText(JSON.stringify(json));
    } catch {
      // Clipboard API unavailable — workspace.clipboard is the fallback
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
        const json = JSON.parse(await blob.text()) as JxNode;
        return [json];
      }
      if (item.types.includes("text/html")) {
        const blob = await item.getType("text/html");
        const htmlStr = await blob.text();
        const nodes = htmlToJx(htmlStr);
        const jxNodes = nodes.map((n) =>
          typeof n === "string" ? { tagName: "p", textContent: n } : n,
        ) as JxNode[];
        if (jxNodes.length > 0) {
          return jxNodes;
        }
      }
      if (item.types.includes("text/plain")) {
        const blob = await item.getType("text/plain");
        const text = await blob.text();
        // Try parsing as Jx JSON
        try {
          const parsed = JSON.parse(text) as JxNode;
          if (parsed && parsed.tagName) {
            return [parsed];
          }
        } catch {
          // Plain text → paragraph node
        }
        if (text.trim()) {
          return [{ tagName: "p", textContent: text.trim() }];
        }
      }
    }
  } catch {
    // Clipboard API unavailable — use workspace fallback
    if (workspace.clipboard) {
      return [jsonClone(workspace.clipboard)];
    }
  }
  return null;
}

// ─── Clipboard actions ───────────────────────────────────────────────────────

export async function copyNode() {
  const tab = activeTab.value;
  if (!tab?.session.selection) {
    return;
  }
  const node = getNodeAtPath(tab.doc.document, tab.session.selection);
  if (!node) {
    return;
  }
  const json = jsonClone(node);
  await writeToClipboard(json);
  statusMessage("Copied");
}

export async function cutNode() {
  const tab = activeTab.value;
  if (!tab?.session.selection || tab.session.selection.length < 2) {
    return;
  }
  const sel = tab.session.selection;
  const node = getNodeAtPath(tab.doc.document, sel);
  if (!node) {
    return;
  }
  const json = jsonClone(node);
  await writeToClipboard(json);
  transactDoc(tab, (t) => mutateRemoveNode(t, sel));
  statusMessage("Cut");
}

export async function pasteNode() {
  const tab = activeTab.value;
  if (!tab) {
    return;
  }

  const nodes = await readFromClipboard();
  if (!nodes || nodes.length === 0) {
    return;
  }

  const pPath = tab.session.selection || [];
  const parent = getNodeAtPath(tab.doc.document, pPath);
  if (!parent) {
    return;
  }

  if (tab.session.selection && tab.session.selection.length >= 2) {
    const pp = parentElementPath(tab.session.selection) as JxPath;
    const idx = childIndex(tab.session.selection) as number;
    transactDoc(tab, (t) => {
      for (let i = 0; i < nodes.length; i++) {
        mutateInsertNode(t, pp, idx + 1 + i, nodes[i]!);
      }
    });
  } else {
    const idx = Array.isArray(parent.children) ? parent.children.length : 0;
    transactDoc(tab, (t) => {
      for (let i = 0; i < nodes.length; i++) {
        mutateInsertNode(t, pPath, idx + i, nodes[i]!);
      }
    });
  }
  statusMessage("Pasted");
}

export function copyStyles() {
  const tab = activeTab.value;
  if (!tab?.session.selection) {
    return;
  }
  const node = getNodeAtPath(tab.doc.document, tab.session.selection);
  if (!node?.style) {
    return;
  }
  workspace.styleClipboard = jsonClone(node.style);
  statusMessage("Styles copied");
}

export function pasteStyles() {
  if (!workspace.styleClipboard) {
    return;
  }
  const tab = activeTab.value;
  if (!tab?.session.selection) {
    return;
  }
  const style = jsonClone(workspace.styleClipboard);
  const sel = tab.session.selection as JxPath;
  transactDoc(tab, (t) => mutateReplaceStyle(t, sel, style));
  statusMessage("Styles pasted");
}

// ─── Context menu ─────────────────────────────────────────────────────────────

let _ctxHandle: ReturnType<typeof renderPopover> | null = null;

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
export function showContextMenu(
  e: MouseEvent,
  path: JxPath,
  opts: {
    onEditComponent?: (path: string) => void;
    rerender?: () => void;
  } = {},
) {
  e.preventDefault();
  dismissContextMenu();

  const tab = activeTab.value;
  if (!tab) {
    return;
  }
  const node = getNodeAtPath(tab.doc.document, path);
  if (!node) {
    return;
  }

  // Select the node
  tab.session.selection = path;

  // Index-based structural actions (cut/duplicate/insert/wrap/delete) require a numeric child
  // Index. Repeater templates (path tail "map") and the document root don't have one — they get
  // Copy only — so we never splice with a non-numeric index.
  const idxIsNumber = typeof childIndex(path) === "number";

  const items: { label: string; action?: () => void | Promise<void>; danger?: boolean }[] = [
    { action: () => copyNode(), label: "Copy" },
  ];

  if (path.length >= 2 && idxIsNumber) {
    items.push(
      { action: () => cutNode(), label: "Cut" },
      {
        action: () => transactDoc(activeTab.value, (t) => mutateDuplicateNode(t, path)),
        label: "Duplicate",
      },
    );
    if (node.style) {
      const nodeStyle = node.style;
      items.push({
        action: () => {
          workspace.styleClipboard = jsonClone(nodeStyle);
          statusMessage("Styles copied");
        },
        label: "Copy styles",
      });
    }
    if (workspace.styleClipboard) {
      items.push({
        action: () => {
          if (!workspace.styleClipboard) {
            return;
          }
          const style = jsonClone(workspace.styleClipboard);
          transactDoc(activeTab.value, (t) => mutateReplaceStyle(t, path, style));
          statusMessage("Styles pasted");
        },
        label: "Paste styles",
      });
    }
    // Separator
    items.push(
      { label: "—" },
      {
        action: () => {
          const pp = parentElementPath(path) as JxPath;
          const idx = childIndex(path) as number;
          transactDoc(activeTab.value, (t) =>
            mutateInsertNode(t, pp, idx, { children: [], tagName: "p" }),
          );
        },
        label: "Insert before",
      },
      {
        action: () => {
          const pp = parentElementPath(path) as JxPath;
          const idx = childIndex(path) as number;
          transactDoc(activeTab.value, (t) =>
            mutateInsertNode(t, pp, idx + 1, { children: [], tagName: "p" }),
          );
        },
        label: "Insert after",
      },
      {
        action: () => transactDoc(activeTab.value, (t) => mutateWrapNode(t, path)),
        label: "Wrap in Div",
      },
    );
    // Don't offer Repeat on a repeater template (path tail "map") or on an array node itself.
    if (path.at(-1) !== "map" && (node as JxMutableNode).$prototype !== "Array") {
      items.push({
        action: () => convertToRepeater(),
        label: "Repeat...",
      });
    }
    items.push({
      action: async () => {
        if (opts.rerender) {
          // Lazy import breaks the context-menu ↔ layers-panel module cycle
          const { startLayerTitleEdit } = await import("../panels/layers-panel");
          startLayerTitleEdit(path, opts.rerender);
        }
      },
      label: "Set Title",
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
          action: () => opts.onEditComponent?.(comp?.path as string),
          label: "Edit Component",
        });
      } else if (!isComponent) {
        items.push({
          action: () => convertToComponent(),
          label: "Convert to Component",
        });
      }
    }
    // Separator
    items.push(
      { label: "—" },
      {
        action: () => transactDoc(activeTab.value, (t) => mutateRemoveNode(t, path)),
        danger: true,
        label: "Delete",
      },
    );
  }
  // Paste targets — never into/after an array node (its content is the single map template).
  if (path.length >= 2 && (node as JxMutableNode).$prototype !== "Array") {
    items.push(
      { label: "—" },
      {
        action: async () => {
          const nodes = await readFromClipboard();
          if (!nodes || nodes.length === 0) {
            return;
          }
          const idx = Array.isArray(node.children) ? node.children.length : 0;
          transactDoc(activeTab.value, (t) => {
            for (let i = 0; i < nodes.length; i++) {
              mutateInsertNode(t, path, idx + i, nodes[i]!);
            }
          });
          statusMessage("Pasted");
        },
        label: "Paste inside",
      },
    );
    if (idxIsNumber) {
      items.push({
        action: async () => {
          const nodes = await readFromClipboard();
          if (!nodes || nodes.length === 0) {
            return;
          }
          const pp = parentElementPath(path) as JxPath;
          const idx = childIndex(path) as number;
          transactDoc(activeTab.value, (t) => {
            for (let i = 0; i < nodes.length; i++) {
              mutateInsertNode(t, pp, idx + 1 + i, nodes[i]!);
            }
          });
          statusMessage("Pasted");
        },
        label: "Paste after",
      });
    }
  }

  let x = e.clientX,
    y = e.clientY;

  _ctxHandle = renderPopover(
    html`<sp-popover
      open
      style="position:fixed;z-index:10000;left:${x}px;top:${y}px"
      ${ref((el) => {
        if (!el) {
          return;
        }
        requestAnimationFrame(() => {
          const popover = el as HTMLElement;
          const menuRect = rectOf(popover);
          if (x + menuRect.width > window.innerWidth) {
            x = window.innerWidth - menuRect.width - 4;
          }
          if (y + menuRect.height > window.innerHeight) {
            y = window.innerHeight - menuRect.height - 4;
          }
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
                  void item.action?.();
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
