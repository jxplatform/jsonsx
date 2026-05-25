/**
 * Block action bar — extracted from studio.js (Phase 4h). Floating toolbar above selected elements
 * with parent selector, move arrows, drag handle, component actions, and inline formatting.
 */

import { html, render as litRender, nothing } from "lit-html";
import { styleMap } from "lit-html/directives/style-map.js";
import { draggable } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";

import { getNodeAtPath, nodeLabel, parentElementPath, childIndex } from "../store.js";
import { activeTab } from "../workspace/workspace.js";
import { transactDoc, mutateMoveNode } from "../tabs/transact.js";
import { view } from "../view.js";
import { isEditing, getActiveElement, getInlineActions } from "../editor/inline-edit.js";
import { toggleInlineFormat, isTagActiveInSelection } from "../editor/inline-format.js";
import { componentRegistry } from "../files/components.js";
import { convertToComponent } from "../editor/convert-to-component.js";
import { findCanvasElement, getActivePanel } from "../canvas/canvas-helpers.js";
import { getLayerSlot } from "../ui/layers.js";

/**
 * @typedef {import("../state.js").StudioState} StudioState
 *
 * @typedef {import("../state.js").JxPath} JxPath
 *
 * @typedef {{ command: string; tag: string; label: string; icon: string; shortcut?: string }} InlineAction
 */

/**
 * @type {{
 *   getCanvasMode: () => string;
 *   navigateToComponent: (path: string) => void;
 * } | null}
 */
let _ctx = null;

/**
 * Initialize the block action bar module.
 *
 * @param {{
 *   getCanvasMode: () => string;
 *   navigateToComponent: (path: string) => void;
 * }} ctx
 */
export function initBlockActionBar(ctx) {
  _ctx = ctx;
}

/** Pre-built icon templates for inline format buttons (avoids unsafeStatic) */
const formatIconMap = /** @type {Record<string, import("lit-html").TemplateResult>} */ ({
  "sp-icon-text-bold": html`<sp-icon-text-bold slot="icon"></sp-icon-text-bold>`,
  "sp-icon-text-italic": html`<sp-icon-text-italic slot="icon"></sp-icon-text-italic>`,
  "sp-icon-text-underline": html`<sp-icon-text-underline slot="icon"></sp-icon-text-underline>`,
  "sp-icon-text-strikethrough": html`<sp-icon-text-strikethrough
    slot="icon"
  ></sp-icon-text-strikethrough>`,
  "sp-icon-text-superscript": html`<sp-icon-text-superscript
    slot="icon"
  ></sp-icon-text-superscript>`,
  "sp-icon-text-subscript": html`<sp-icon-text-subscript slot="icon"></sp-icon-text-subscript>`,
  "sp-icon-code": html`<sp-icon-code slot="icon"></sp-icon-code>`,
  "sp-icon-link": html`<sp-icon-link slot="icon"></sp-icon-link>`,
});

/**
 * Prevent the bar from stealing focus from contenteditable
 *
 * @param {MouseEvent} e
 */
function onBarMousedown(e) {
  if (/** @type {HTMLElement} */ (e.target).closest("sp-textfield")) return;
  if (/** @type {HTMLElement} */ (e.target).closest(".bar-drag-handle")) return;
  e.preventDefault();
}

/** Saved selection range for format button mousedown→click flow */
function captureSelectionRange() {
  const sel = window.getSelection();
  if (sel && sel.rangeCount) view.savedRange = sel.getRangeAt(0).cloneRange();
}

/**
 * @param {MouseEvent} e
 * @param {InlineAction} action
 */
function onFormatClick(e, action) {
  e.stopPropagation();
  if (action.command === "link") {
    showLinkPopover(
      /** @type {HTMLElement} */ (
        /** @type {HTMLElement} */ (e.target).closest("sp-action-button")
      ),
    );
  } else if (view.savedRange) {
    const sel = window.getSelection();
    const anchor = view.savedRange.startContainer;
    const editableRoot = (
      anchor?.nodeType === Node.ELEMENT_NODE
        ? /** @type {Element} */ (anchor)
        : anchor?.parentElement
    )?.closest("[contenteditable]");
    if (editableRoot) {
      /** @type {HTMLElement} */ (editableRoot).focus();
      sel?.removeAllRanges();
      sel?.addRange(view.savedRange);
      applyInlineFormat(action);
    }
  }
}

function renderParentSelector() {
  const tab = activeTab.value;
  if (!tab?.session.selection) return nothing;
  const pPath = parentElementPath(tab.session.selection);
  if (!pPath) return nothing;
  const parentNode = getNodeAtPath(tab.doc.document, pPath);
  return html`
    <sp-action-button
      size="xs"
      quiet
      title="Select parent: ${nodeLabel(parentNode)}"
      @click=${(/** @type {MouseEvent} */ e) => {
        e.stopPropagation();
        activeTab.value.session.selection = pPath;
      }}
    >
      <sp-icon-back slot="icon"></sp-icon-back>
    </sp-action-button>
  `;
}

function renderMoveArrows() {
  const tab = activeTab.value;
  if (!tab?.session.selection) return nothing;
  const sel = tab.session.selection;
  const idx = /** @type {number} */ (childIndex(sel));
  const pPath = parentElementPath(sel);
  const parentNode = getNodeAtPath(tab.doc.document, /** @type {JxPath} */ (pPath));
  const siblings = parentNode?.children;
  return html`
    <sp-action-button
      size="xs"
      quiet
      title="Move up"
      ?disabled=${idx <= 0}
      @click=${(/** @type {MouseEvent} */ e) => {
        e.stopPropagation();
        moveSelectionUp();
      }}
    >
      <sp-icon-arrow-up slot="icon"></sp-icon-arrow-up>
    </sp-action-button>
    <sp-action-button
      size="xs"
      quiet
      title="Move down"
      ?disabled=${!siblings || idx >= siblings.length - 1}
      @click=${(/** @type {MouseEvent} */ e) => {
        e.stopPropagation();
        moveSelectionDown();
      }}
    >
      <sp-icon-arrow-down slot="icon"></sp-icon-arrow-down>
    </sp-action-button>
  `;
}

/**
 * Apply an inline format action.
 *
 * @param {InlineAction} action
 */
function applyInlineFormat(action) {
  /** @type {Record<string, string>} */
  const cmdToTag = {
    bold: "strong",
    italic: "em",
    underline: "u",
    strikethrough: "del",
    superscript: "sup",
    subscript: "sub",
    code: "code",
  };

  const tag = cmdToTag[action.command];
  if (tag) {
    const editableRoot = getActiveElement();
    toggleInlineFormat(tag, editableRoot);
  }
  requestAnimationFrame(() => renderBlockActionBar());
}

/** Dismiss the link popover if open. */
export function dismissLinkPopover() {
  const host = getLayerSlot("popover", "link-popover");
  litRender(nothing, host);
}

/** Dismiss the block action bar. */
export function dismissBlockActionBar() {
  if (view.blockActionBarEl) litRender(nothing, view.blockActionBarEl);
}

/** @param {HTMLElement} anchorBtn */
function showLinkPopover(anchorBtn) {
  const host = getLayerSlot("popover", "link-popover");
  litRender(nothing, host);

  const sel = window.getSelection();
  /** @type {HTMLAnchorElement | null} */
  let existingLink = null;
  if (sel?.rangeCount) {
    /** @type {Node | null} */
    let node = sel.anchorNode;
    while (node && node !== document.body) {
      if (
        node.nodeType === Node.ELEMENT_NODE &&
        /** @type {Element} */ (node).tagName.toLowerCase() === "a"
      ) {
        existingLink = /** @type {HTMLAnchorElement} */ (node);
        break;
      }
      node = node.parentNode;
    }
  }

  const rect = anchorBtn.getBoundingClientRect();

  const onApply = () => {
    const field = /** @type {HTMLInputElement | null} */ (host.querySelector("sp-textfield"));
    const url = field?.value || "";
    if (existingLink) {
      existingLink.setAttribute("href", url);
    } else if (url) {
      document.execCommand("createLink", false, url);
    }
    litRender(nothing, host);
    renderBlockActionBar();
  };

  const onRemove = () => {
    if (!existingLink?.parentNode) return;
    const frag = document.createDocumentFragment();
    while (existingLink.firstChild) frag.appendChild(existingLink.firstChild);
    existingLink.parentNode.replaceChild(frag, existingLink);
    litRender(nothing, host);
    renderBlockActionBar();
  };

  const onKeydown = (/** @type {KeyboardEvent} */ e) => {
    if (e.key === "Enter") onApply();
    else if (e.key === "Escape") {
      litRender(nothing, host);
    }
  };

  litRender(
    html`
      <sp-popover
        class="link-popover"
        open
        style=${styleMap({
          position: "fixed",
          left: `${rect.left}px`,
          top: `${rect.bottom + 4}px`,
          zIndex: "30",
        })}
      >
        <sp-textfield
          placeholder="https://..."
          size="s"
          style="width:200px"
          value=${existingLink?.getAttribute("href") || ""}
          @keydown=${onKeydown}
        ></sp-textfield>
        <sp-action-button size="xs" @click=${onApply}>
          ${existingLink ? "Update" : "Apply"}
        </sp-action-button>
        ${existingLink
          ? html` <sp-action-button size="xs" @click=${onRemove}>Remove</sp-action-button> `
          : nothing}
      </sp-popover>
    `,
    host,
  );

  requestAnimationFrame(
    () => /** @type {HTMLElement | null} */ (host.querySelector("sp-textfield"))?.focus(),
  );
}

/** Move the selected node up (swap with previous sibling). */
function moveSelectionUp() {
  const tab = activeTab.value;
  if (!tab?.session.selection || tab.session.selection.length < 2) return;
  const sel = tab.session.selection;
  const idx = /** @type {number} */ (childIndex(sel));
  if (idx <= 0) return;
  const pPath = /** @type {JxPath} */ (parentElementPath(sel));
  transactDoc(tab, (t) => mutateMoveNode(t, sel, pPath, idx - 1));
  tab.session.selection = [...pPath, "children", idx - 1];
}

/** Move the selected node down (swap with next sibling). */
function moveSelectionDown() {
  const tab = activeTab.value;
  if (!tab?.session.selection || tab.session.selection.length < 2) return;
  const sel = tab.session.selection;
  const idx = /** @type {number} */ (childIndex(sel));
  const pPath = /** @type {JxPath} */ (parentElementPath(sel));
  const parentNode = getNodeAtPath(tab.doc.document, pPath);
  const siblings = parentNode?.children;
  if (!siblings || idx >= siblings.length - 1) return;
  transactDoc(tab, (t) => mutateMoveNode(t, sel, pPath, idx + 2));
  tab.session.selection = [...pPath, "children", idx + 1];
}

/** Render the unified block action bar above the selected element. */
export function renderBlockActionBar() {
  if (!_ctx) return;
  if (!view.blockActionBarEl) {
    view.blockActionBarEl = getLayerSlot("popover", "block-action-bar");
  }

  if (view.selDragCleanup) {
    view.selDragCleanup();
    view.selDragCleanup = null;
  }

  const tab = activeTab.value;
  const canvasMode = _ctx.getCanvasMode();

  if (!tab?.session.selection || (canvasMode !== "design" && canvasMode !== "edit")) {
    litRender(nothing, view.blockActionBarEl);
    return;
  }

  const selection = tab.session.selection;
  const activePanel = getActivePanel();
  if (!activePanel) {
    litRender(nothing, view.blockActionBarEl);
    return;
  }
  const el = findCanvasElement(selection, activePanel.canvas);
  const node = el && getNodeAtPath(tab.doc.document, selection);
  if (!el || !node) {
    litRender(nothing, view.blockActionBarEl);
    return;
  }

  const tag = (node.tagName ?? "div").toLowerCase();
  const elRect = el.getBoundingClientRect();
  const topPos = elRect.top < 80 ? elRect.bottom + 4 : elRect.top - 38;

  // Inline format state
  const inlineEditing = isEditing() || el.contentEditable === "true";
  const actions = getInlineActions(tag) || [];
  const showFormat = inlineEditing && actions.length > 0;
  const activeValues = showFormat
    ? actions.filter((a) => isTagActiveInSelection(a.tag, el)).map((a) => a.tag)
    : [];

  litRender(
    html`
      <div
        class="block-action-bar"
        style=${styleMap({ left: `${elRect.left}px`, top: `${topPos}px` })}
        @mousedown=${onBarMousedown}
      >
        ${selection.length >= 2 ? renderParentSelector() : nothing}

        <span class="bar-tag">${node.$id || (node.tagName ?? "div")}</span>

        ${selection.length >= 2
          ? html`<span class="bar-drag-handle" title="Drag to reorder">⡇</span>`
          : nothing}
        ${selection.length >= 2 ? renderMoveArrows() : nothing}
        ${selection.length >= 2 && node.tagName
          ? (() => {
              const isComp =
                node.tagName.includes("-") &&
                componentRegistry.some(
                  (/** @type {{ tagName: string }} */ c) => c.tagName === node.tagName,
                );
              if (isComp) {
                const comp = componentRegistry.find(
                  (/** @type {{ tagName: string; path: string }} */ c) =>
                    c.tagName === node.tagName,
                );
                return html`<sp-action-button
                  size="xs"
                  quiet
                  title="Edit Component"
                  @click=${() => _ctx?.navigateToComponent(/** @type {string} */ (comp?.path))}
                  ><sp-icon-edit slot="icon" size="xs"></sp-icon-edit
                ></sp-action-button>`;
              }
              return html`<sp-action-button
                size="xs"
                quiet
                title="Convert to Component"
                @click=${() => convertToComponent()}
                ><sp-icon-box slot="icon" size="xs"></sp-icon-box
              ></sp-action-button>`;
            })()
          : nothing}
        ${showFormat
          ? html`
              <sp-divider size="s" vertical></sp-divider>
              <sp-action-group
                size="xs"
                compact
                emphasized
                selects="multiple"
                selected=${activeValues.length ? JSON.stringify(activeValues) : nothing}
              >
                ${actions.map(
                  (action) => html`
                    <sp-action-button
                      size="xs"
                      value=${action.tag}
                      title="${action.label}${action.shortcut ? ` (${action.shortcut})` : ""}"
                      @mousedown=${captureSelectionRange}
                      @click=${(/** @type {MouseEvent} */ e) => onFormatClick(e, action)}
                    >
                      ${formatIconMap[action.icon] ?? nothing}
                    </sp-action-button>
                  `,
                )}
              </sp-action-group>
            `
          : nothing}
      </div>
    `,
    view.blockActionBarEl,
  );

  // Post-render side effects
  requestAnimationFrame(() => {
    const bar = view.blockActionBarEl?.firstElementChild;
    if (!bar) return;
    // Clamp to window
    const barRect = bar.getBoundingClientRect();
    if (barRect.right > window.innerWidth) {
      bar.style.left = `${Math.max(0, window.innerWidth - barRect.width)}px`;
    }
    // Attach drag handle
    const currentTab = activeTab.value;
    if (currentTab?.session.selection && currentTab.session.selection.length >= 2) {
      const handle = bar.querySelector(".bar-drag-handle");
      if (handle) {
        if (view.selDragCleanup) {
          view.selDragCleanup();
          view.selDragCleanup = null;
        }
        view.selDragCleanup = draggable({
          element: handle,
          getInitialData: () => ({ type: "tree-node", path: activeTab.value?.session.selection }),
        });
      }
    }
  });
}
