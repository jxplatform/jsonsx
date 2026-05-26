// ─── Clipboard & Context Menu ─────────────────────────────────────────────────
import { html } from "lit-html";
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

// ─── Clipboard ────────────────────────────────────────────────────────────────

export function copyNode() {
  const tab = activeTab.value;
  if (!tab?.session.selection) return;
  const node = getNodeAtPath(tab.doc.document, tab.session.selection);
  if (!node) return;
  workspace.clipboard = structuredClone(node);
  statusMessage("Copied");
}

export function cutNode() {
  const tab = activeTab.value;
  if (!tab?.session.selection || tab.session.selection.length < 2) return;
  const sel = tab.session.selection;
  const node = getNodeAtPath(tab.doc.document, sel);
  if (!node) return;
  workspace.clipboard = structuredClone(node);
  transactDoc(tab, (t) => mutateRemoveNode(t, sel));
  statusMessage("Cut");
}

export function pasteNode() {
  if (!workspace.clipboard) return;
  const tab = activeTab.value;
  if (!tab) return;
  const clip = workspace.clipboard;
  const pPath = tab.session.selection || [];
  const parent = getNodeAtPath(tab.doc.document, pPath);
  if (!parent) return;

  if (tab.session.selection && tab.session.selection.length >= 2) {
    const pp = /** @type {JxPath} */ (parentElementPath(tab.session.selection));
    const idx = /** @type {number} */ (childIndex(tab.session.selection));
    transactDoc(tab, (t) => mutateInsertNode(t, pp, idx + 1, structuredClone(clip)));
  } else {
    const idx = parent.children ? parent.children.length : 0;
    transactDoc(tab, (t) => mutateInsertNode(t, pPath, idx, structuredClone(clip)));
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
  if (workspace.clipboard) {
    const clip = workspace.clipboard;
    items.push({ label: "—" });
    items.push({
      label: "Paste inside",
      action: () => {
        const idx = node.children ? node.children.length : 0;
        transactDoc(activeTab.value, (t) => mutateInsertNode(t, path, idx, structuredClone(clip)));
      },
    });
    if (path.length >= 2) {
      items.push({
        label: "Paste after",
        action: () => {
          const pp = /** @type {JxPath} */ (parentElementPath(path));
          const idx = /** @type {number} */ (childIndex(path));
          transactDoc(activeTab.value, (t) =>
            mutateInsertNode(t, pp, idx + 1, structuredClone(clip)),
          );
        },
      });
    }
  }

  let x = e.clientX,
    y = e.clientY;

  _ctxHandle = renderPopover(
    html`<sp-popover open style="position:fixed;z-index:10000;left:${x}px;top:${y}px">
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

  requestAnimationFrame(() => {
    const popover = /** @type {HTMLElement | null} */ (
      _ctxHandle?.host.querySelector("sp-popover")
    );
    if (!popover) return;
    const menuRect = popover.getBoundingClientRect();
    if (x + menuRect.width > window.innerWidth) x = window.innerWidth - menuRect.width - 4;
    if (y + menuRect.height > window.innerHeight) y = window.innerHeight - menuRect.height - 4;
    popover.style.left = `${x}px`;
    popover.style.top = `${y}px`;
  });
}
