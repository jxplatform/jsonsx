// ─── Clipboard & Context Menu ─────────────────────────────────────────────────
import { html, render as litRender } from "lit-html";
import { getNodeAtPath, parentElementPath, childIndex } from "../store.js";
import { activeTab } from "../workspace/workspace.js";
import {
  transactDoc,
  mutateInsertNode,
  mutateRemoveNode,
  mutateDuplicateNode,
  mutateWrapNode,
} from "../tabs/transact.js";
import { statusMessage } from "../panels/statusbar.js";
import { convertToComponent } from "./convert-to-component.js";
import { componentRegistry } from "../files/components.js";

/**
 * @typedef {import("../state.js").StudioState} StudioState
 *
 * @typedef {import("../state.js").JxPath} JxPath
 *
 * @typedef {import("../state.js").JxNode} JxNode
 */

/** @type {JxNode | null} */
let clipboard = null;

// ─── Clipboard ────────────────────────────────────────────────────────────────

/** @param {StudioState} S */
export function copyNode(S) {
  if (!S.selection) return;
  const node = getNodeAtPath(S.document, S.selection);
  if (!node) return;
  clipboard = structuredClone(node);
  statusMessage("Copied");
}

/** @param {StudioState} S */
export function cutNode(S) {
  if (!S.selection || S.selection.length < 2) return;
  const sel = S.selection;
  const node = getNodeAtPath(S.document, sel);
  if (!node) return;
  clipboard = structuredClone(node);
  transactDoc(activeTab.value, (t) => mutateRemoveNode(t, sel));
  statusMessage("Cut");
}

/** @param {StudioState} S */
export function pasteNode(S) {
  if (!clipboard) return;
  const clip = clipboard;
  const pPath = S.selection || [];
  const parent = getNodeAtPath(S.document, pPath);
  if (!parent) return;

  if (S.selection && S.selection.length >= 2) {
    const pp = /** @type {JxPath} */ (parentElementPath(S.selection));
    const idx = /** @type {number} */ (childIndex(S.selection));
    transactDoc(activeTab.value, (t) => mutateInsertNode(t, pp, idx + 1, structuredClone(clip)));
  } else {
    const idx = parent.children ? parent.children.length : 0;
    transactDoc(activeTab.value, (t) => mutateInsertNode(t, pPath, idx, structuredClone(clip)));
  }
  statusMessage("Pasted");
}

// ─── Context menu ─────────────────────────────────────────────────────────────

const ctxMenu = document.createElement("sp-popover");
ctxMenu.style.position = "fixed";
ctxMenu.style.zIndex = "10000";
/** Append inside sp-theme so the popover inherits Spectrum styles */
(document.querySelector("sp-theme") || document.body).appendChild(ctxMenu);

document.addEventListener("click", () => {
  ctxMenu.removeAttribute("open");
});

/** Dismiss the context menu if open. */
export function dismissContextMenu() {
  ctxMenu.removeAttribute("open");
}

/**
 * @param {MouseEvent} e
 * @param {JxPath} path
 * @param {StudioState} S
 * @param {{ onEditComponent?: (path: string) => void }} [opts]
 */
export function showContextMenu(e, path, S, opts = {}) {
  e.preventDefault();
  ctxMenu.removeAttribute("open");

  const node = getNodeAtPath(S.document, path);
  if (!node) return;

  // Select the node
  activeTab.value.session.selection = path;

  /** @type {{ label: string; action?: () => void; danger?: boolean }[]} */
  const items = [];

  items.push({ label: "Copy", action: () => copyNode(S) });
  if (path.length >= 2) {
    items.push({ label: "Cut", action: () => cutNode(S) });
    items.push({
      label: "Duplicate",
      action: () => transactDoc(activeTab.value, (t) => mutateDuplicateNode(t, path)),
    });
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
  if (clipboard) {
    const clip = clipboard;
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

  litRender(
    html`<sp-menu>
      ${items.map((item) =>
        item.label === "—"
          ? html`<sp-menu-divider></sp-menu-divider>`
          : html`<sp-menu-item
              style=${item.danger ? "color: var(--danger)" : ""}
              @click=${() => {
                ctxMenu.removeAttribute("open");
                item.action?.();
              }}
              >${item.label}</sp-menu-item
            >`,
      )}
    </sp-menu>`,
    ctxMenu,
  );

  // Position the menu
  ctxMenu.setAttribute("open", "");
  const menuRect = ctxMenu.getBoundingClientRect();
  let x = e.clientX,
    y = e.clientY;
  if (x + menuRect.width > window.innerWidth) x = window.innerWidth - menuRect.width - 4;
  if (y + menuRect.height > window.innerHeight) y = window.innerHeight - menuRect.height - 4;
  ctxMenu.style.left = `${x}px`;
  ctxMenu.style.top = `${y}px`;
}
