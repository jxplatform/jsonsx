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

interface SlashCommand {
  label: string;
  tag: string;
  description: string;
}

// ─── Commands ─────────────────────────────────────────────────────────────────

const SLASH_COMMANDS = [
  { label: "Heading 1", tag: "h1", description: "Large heading" },
  { label: "Heading 2", tag: "h2", description: "Medium heading" },
  { label: "Heading 3", tag: "h3", description: "Small heading" },
  { label: "Paragraph", tag: "p", description: "Plain text" },
  { label: "Bulleted List", tag: "ul", description: "Unordered list" },
  { label: "Numbered List", tag: "ol", description: "Numbered list" },
  { label: "Blockquote", tag: "blockquote", description: "Quote block" },
  { label: "Image", tag: "img", description: "Insert image" },
  { label: "Horizontal Rule", tag: "hr", description: "Divider line" },
  { label: "Button", tag: "button", description: "Button element" },
  { label: "Link", tag: "a", description: "Anchor link" },
  { label: "Code Block", tag: "pre", description: "Preformatted code" },
  { label: "Table", tag: "table", description: "Insert table" },
  { label: "Div", tag: "div", description: "Container" },
  { label: "Section", tag: "section", description: "Section container" },
];

// ─── State ────────────────────────────────────────────────────────────────────

let callbacks: {
  onSelect: (cmd: SlashCommand) => void;
  showFilter?: boolean;
  commands?: SlashCommand[];
} | null = null;
let activeIdx = 0;
let filteredItems: SlashCommand[] = [];
let open = false;
let _anchorEl: HTMLElement | null = null;
let _anchorRect: DOMRect | null = null;
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
 * @param {{
 *   onSelect: (cmd: SlashCommand) => void;
 *   showFilter?: boolean;
 *   commands?: SlashCommand[];
 * }} cbs
 */
export function showSlashMenu(
  anchorEl: HTMLElement,
  filter: string,
  cbs: { onSelect: (cmd: SlashCommand) => void; showFilter?: boolean; commands?: SlashCommand[] },
) {
  callbacks = cbs;
  _anchorEl = anchorEl;
  _anchorRect = anchorEl.getBoundingClientRect();

  const source = cbs.commands || SLASH_COMMANDS;
  filteredItems = filter
    ? source.filter(
        (c) => c.label.toLowerCase().includes(filter) || c.tag.toLowerCase().includes(filter),
      )
    : source;

  if (!filteredItems.length && !cbs.showFilter) {
    dismissSlashMenu();
    return;
  }

  activeIdx = 0;

  render(anchorEl, cbs.showFilter || false);

  if (!open) {
    open = true;
    document.addEventListener("keydown", onKeydown, true); // capture phase
    requestAnimationFrame(() => {
      document.addEventListener("mousedown", onOutsideClick, true);
    });
  }

  if (cbs.showFilter) {
    requestAnimationFrame(() => {
      if (_filterEl) _filterEl.focus();
    });
  }
}

export function dismissSlashMenu() {
  if (!open) return;
  open = false;
  callbacks = null;
  _anchorEl = null;
  _anchorRect = null;
  _filterEl = null;
  _popoverEl = null;
  filteredItems = [];
  document.removeEventListener("keydown", onKeydown, true);
  document.removeEventListener("mousedown", onOutsideClick, true);
  litRender(nothing, getHost());
}

// ─── Internal ─────────────────────────────────────────────────────────────────

/**
 * @param {HTMLElement} anchorEl
 * @param {boolean} showFilter
 */
function render(anchorEl: HTMLElement, showFilter: boolean) {
  const rect = _anchorRect || anchorEl.getBoundingClientRect();

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
          ${filteredItems.length
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
  if (_anchorEl) render(_anchorEl, true);

  // Re-focus input after re-render
  requestAnimationFrame(() => {
    if (_filterEl && _filterEl !== document.activeElement) {
      _filterEl.focus();
      _filterEl.selectionStart = _filterEl.selectionEnd = _filterEl.value.length;
    }
  });
}

/** @param {KeyboardEvent} e */
function onKeydown(e: KeyboardEvent) {
  if (!open) return;

  const items = getHost().querySelectorAll("sp-menu-item:not([disabled])") as NodeListOf<Element>;

  if (e.key === "ArrowDown") {
    e.preventDefault();
    e.stopPropagation();
    if (!items.length) return;
    items[activeIdx]?.removeAttribute("focused");
    activeIdx = (activeIdx + 1) % items.length;
    items[activeIdx]?.setAttribute("focused", "");
    items[activeIdx]?.scrollIntoView({ block: "nearest" });
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    e.stopPropagation();
    if (!items.length) return;
    items[activeIdx]?.removeAttribute("focused");
    activeIdx = (activeIdx - 1 + items.length) % items.length;
    items[activeIdx]?.setAttribute("focused", "");
    items[activeIdx]?.scrollIntoView({ block: "nearest" });
  } else if (e.key === "Enter") {
    e.preventDefault();
    e.stopPropagation();
    const cmd = filteredItems[activeIdx];
    if (cmd) select(cmd);
  } else if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    dismissSlashMenu();
  }
}
