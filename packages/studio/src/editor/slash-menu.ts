/// <reference lib="dom" />
/**
 * Slash-menu.js — Shared slash command menu for element insertion
 *
 * A single implementation used by both inline-edit (Edit/Content modes) and component inline
 * editing (Design mode). Renders a Spectrum-styled popover with keyboard navigation. Uses a
 * document-level capturing keydown listener so it intercepts Enter/Arrow/Escape before any
 * element-level handlers.
 */

import { html, render as litRender, nothing } from "lit-html";
import { ref } from "lit-html/directives/ref.js";
import { getLayerSlot } from "../ui/layers";
import { rectOf } from "../utils/geometry";

interface SlashCommand {
  label: string;
  tag: string;
  description: string;
}

// ─── Commands ─────────────────────────────────────────────────────────────────

const SLASH_COMMANDS = [
  { description: "Large heading", label: "Heading 1", tag: "h1" },
  { description: "Medium heading", label: "Heading 2", tag: "h2" },
  { description: "Small heading", label: "Heading 3", tag: "h3" },
  { description: "Plain text", label: "Paragraph", tag: "p" },
  { description: "Unordered list", label: "Bulleted List", tag: "ul" },
  { description: "Numbered list", label: "Numbered List", tag: "ol" },
  { description: "Quote block", label: "Blockquote", tag: "blockquote" },
  { description: "Insert image", label: "Image", tag: "img" },
  { description: "Divider line", label: "Horizontal Rule", tag: "hr" },
  { description: "Button element", label: "Button", tag: "button" },
  { description: "Anchor link", label: "Link", tag: "a" },
  { description: "Preformatted code", label: "Code Block", tag: "pre" },
  { description: "Insert table", label: "Table", tag: "table" },
  { description: "Container", label: "Div", tag: "div" },
  { description: "Section container", label: "Section", tag: "section" },
];

// ─── State ────────────────────────────────────────────────────────────────────

/** Callbacks a caller passes to {@link showSlashMenu}/{@link showSlashMenuAtRect}. */
export interface SlashMenuCallbacks {
  onSelect: (cmd: SlashCommand) => void;
  /** Fired whenever the menu closes (outside click, Escape, no matches, and just before select). */
  onDismiss?: () => void;
  showFilter?: boolean;
  commands?: SlashCommand[];
}

/** The anchor geometry the menu positions from (a DOMRect satisfies this). */
export interface SlashMenuAnchorRect {
  left: number;
  bottom: number;
}

let callbacks: SlashMenuCallbacks | null = null;
let activeIdx = 0;
let filteredItems: SlashCommand[] = [];
let open = false;
let _anchorRect: SlashMenuAnchorRect | null = null;
let _filterEl: HTMLInputElement | null = null;
let _popoverEl: HTMLElement | null = null;

/** @returns {HTMLElement} */
function getHost() {
  return getLayerSlot("popover", "slash-menu");
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** @returns {boolean} */
export function isSlashMenuOpen() {
  return open;
}

/**
 * Show (or update) the slash menu anchored below `anchorEl`.
 *
 * @param {HTMLElement} anchorEl — the element being edited (for positioning)
 * @param {string} filter — current typed filter text (after the "/")
 * @param {SlashMenuCallbacks} cbs
 */
export function showSlashMenu(anchorEl: HTMLElement, filter: string, cbs: SlashMenuCallbacks) {
  showAt(rectOf(anchorEl), filter, cbs);
}

/**
 * Show (or update) the slash menu anchored below a PARENT-VIEWPORT rect — for callers with no
 * anchor element in this realm (the canvas iframe posts the edited element's rect across the bridge
 * and the host converts it).
 *
 * @param {SlashMenuAnchorRect} rect
 * @param {string} filter
 * @param {SlashMenuCallbacks} cbs
 */
export function showSlashMenuAtRect(
  rect: SlashMenuAnchorRect,
  filter: string,
  cbs: SlashMenuCallbacks,
) {
  showAt(rect, filter, cbs);
}

/** Shared body of the two show entry points. */
function showAt(rect: SlashMenuAnchorRect, filter: string, cbs: SlashMenuCallbacks) {
  callbacks = cbs;
  _anchorRect = rect;

  const source = cbs.commands || SLASH_COMMANDS;
  filteredItems = filter
    ? source.filter(
        (c) => c.label.toLowerCase().includes(filter) || c.tag.toLowerCase().includes(filter),
      )
    : source;

  if (filteredItems.length === 0 && !cbs.showFilter) {
    dismissSlashMenu();
    return;
  }

  activeIdx = 0;

  render(cbs.showFilter || false);

  if (!open) {
    open = true;
    document.addEventListener("keydown", onKeydown, true); // Capture phase
    requestAnimationFrame(() => {
      document.addEventListener("mousedown", onOutsideClick, true);
    });
  }

  if (cbs.showFilter) {
    requestAnimationFrame(() => {
      if (_filterEl) {
        _filterEl.focus();
      }
    });
  }
}

export function dismissSlashMenu() {
  if (!open) {
    return;
  }
  const cbs = callbacks;
  open = false;
  callbacks = null;
  _anchorRect = null;
  _filterEl = null;
  _popoverEl = null;
  filteredItems = [];
  document.removeEventListener("keydown", onKeydown, true);
  document.removeEventListener("mousedown", onOutsideClick, true);
  litRender(nothing, getHost());
  // After teardown so a re-entrant show from the callback sees a closed menu. select() relies on
  // This ordering too: dismiss (→ onDismiss) fires BEFORE onSelect.
  cbs?.onDismiss?.();
}

// ─── Internal ─────────────────────────────────────────────────────────────────

/** @param {boolean} showFilter */
function render(showFilter: boolean) {
  const rect = _anchorRect;
  if (!rect) {
    return;
  }

  litRender(
    html`
      <sp-popover
        open
        ${ref((el) => {
          _popoverEl = (el as HTMLElement | undefined) || null;
        })}
        style="position:fixed;left:${rect.left}px;top:${rect.bottom +
        4}px;z-index:9999;max-height:320px;overflow-y:auto"
      >
        ${showFilter
          ? html`<input
              class="slash-filter"
              type="text"
              placeholder="Filter…"
              autocomplete="off"
              style="display:block;width:100%;box-sizing:border-box;padding:6px 10px;border:none;border-bottom:1px solid var(--border, #444);outline:none;font-size:13px;background:transparent;color:inherit"
              ${ref((el) => {
                _filterEl = (el as HTMLInputElement | undefined) || null;
              })}
              @input=${onFilterInput}
            />`
          : nothing}
        <sp-menu style="min-width:220px">
          ${filteredItems.length > 0
            ? filteredItems.map(
                (cmd, i) => html`
                  <sp-menu-item
                    ?focused=${i === 0}
                    @click=${(e: Event) => {
                      e.preventDefault();
                      e.stopPropagation();
                      select(cmd);
                    }}
                  >
                    ${cmd.label}
                    ${cmd.description
                      ? html`<span slot="description">${cmd.description}</span>`
                      : nothing}
                  </sp-menu-item>
                `,
              )
            : html`<sp-menu-item disabled>No matches</sp-menu-item>`}
        </sp-menu>
      </sp-popover>
    `,
    getHost(),
  );
}

/** @param {MouseEvent} e */
function onOutsideClick(e: MouseEvent) {
  if (_popoverEl && !_popoverEl.contains(e.target as Node)) {
    dismissSlashMenu();
  }
}

/** @param {SlashCommand} cmd */
function select(cmd: SlashCommand) {
  const cbs = callbacks;
  dismissSlashMenu();
  cbs?.onSelect(cmd);
}

/** @param {Event} e */
function onFilterInput(e: Event) {
  const input = e.target as HTMLInputElement;
  const filter = input.value.toLowerCase();

  const source = callbacks?.commands || SLASH_COMMANDS;
  filteredItems = filter
    ? source.filter(
        (c) => c.label.toLowerCase().includes(filter) || c.tag.toLowerCase().includes(filter),
      )
    : source;

  activeIdx = 0;
  render(true);

  // Re-focus input after re-render
  requestAnimationFrame(() => {
    if (_filterEl && _filterEl !== document.activeElement) {
      _filterEl.focus();
      _filterEl.selectionStart = _filterEl.value.length;
      _filterEl.selectionEnd = _filterEl.value.length;
    }
  });
}

/**
 * Drive the open menu with a navigation key. The canvas-iframe bridge calls this DIRECTLY (the key
 * was pressed in the iframe realm — a synthetic keydown redispatch on this document would lose the
 * capture-first + stopPropagation semantics the menu relies on to shield other handlers).
 *
 * @param {string} key — "ArrowDown" | "ArrowUp" | "Enter" | "Escape"
 */
export function handleSlashMenuKey(key: string): void {
  if (!open) {
    return;
  }

  const items = getHost().querySelectorAll("sp-menu-item:not([disabled])") as NodeListOf<Element>;

  if (key === "ArrowDown") {
    if (items.length === 0) {
      return;
    }
    items[activeIdx]?.removeAttribute("focused");
    activeIdx = (activeIdx + 1) % items.length;
    items[activeIdx]?.setAttribute("focused", "");
    items[activeIdx]?.scrollIntoView({ block: "nearest" });
  } else if (key === "ArrowUp") {
    if (items.length === 0) {
      return;
    }
    items[activeIdx]?.removeAttribute("focused");
    activeIdx = (activeIdx - 1 + items.length) % items.length;
    items[activeIdx]?.setAttribute("focused", "");
    items[activeIdx]?.scrollIntoView({ block: "nearest" });
  } else if (key === "Enter") {
    const cmd = filteredItems[activeIdx];
    if (cmd) {
      select(cmd);
    }
  } else if (key === "Escape") {
    dismissSlashMenu();
  }
}

/** @param {KeyboardEvent} e */
function onKeydown(e: KeyboardEvent) {
  if (!open) {
    return;
  }
  if (["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(e.key)) {
    e.preventDefault();
    e.stopPropagation();
    handleSlashMenuKey(e.key);
  }
}
