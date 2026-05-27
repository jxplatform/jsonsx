/**
 * Slash-menu.js — Shared slash command menu for element insertion
 *
 * A single implementation used by both inline-edit (Edit/Content modes) and component inline
 * editing (Design mode). Renders a Spectrum-styled popover with keyboard navigation. Uses a
 * document-level capturing keydown listener so it intercepts Enter/Arrow/Escape before any
 * element-level handlers.
 */

import { html, render as litRender, nothing } from "lit-html";
import { getLayerSlot } from "../ui/layers.js";

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

/** @typedef {{ label: string; tag: string; description: string }} SlashCommand */

// ─── State ────────────────────────────────────────────────────────────────────

/** @type {{ onSelect: (cmd: SlashCommand) => void; showFilter?: boolean } | null} */
let callbacks = null;
let activeIdx = 0;
/** @type {SlashCommand[]} */
let filteredItems = [];
let open = false;
/** @type {HTMLElement | null} */
let _anchorEl = null;
/** @type {DOMRect | null} */
let _anchorRect = null;

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
 * @param {{ onSelect: (cmd: SlashCommand) => void; showFilter?: boolean }} cbs
 */
export function showSlashMenu(anchorEl, filter, cbs) {
  callbacks = cbs;
  _anchorEl = anchorEl;
  _anchorRect = anchorEl.getBoundingClientRect();

  filteredItems = filter
    ? SLASH_COMMANDS.filter(
        (c) => c.label.toLowerCase().includes(filter) || c.tag.toLowerCase().includes(filter),
      )
    : SLASH_COMMANDS;

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
      const input = /** @type {HTMLInputElement | null} */ (
        getHost().querySelector(".slash-filter")
      );
      if (input) input.focus();
    });
  }
}

export function dismissSlashMenu() {
  if (!open) return;
  open = false;
  callbacks = null;
  _anchorEl = null;
  _anchorRect = null;
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
function render(anchorEl, showFilter) {
  const rect = _anchorRect || anchorEl.getBoundingClientRect();

  litRender(
    html`
      <sp-popover
        open
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
              @input=${onFilterInput}
            />`
          : nothing}
        <sp-menu style="min-width:220px">
          ${filteredItems.length
            ? filteredItems.map(
                (cmd, i) => html`
                  <sp-menu-item
                    ?focused=${i === 0}
                    @click=${(/** @type {Event} */ e) => {
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
function onOutsideClick(e) {
  const host = getHost();
  const popover = host.querySelector("sp-popover");
  if (popover && !popover.contains(/** @type {Node} */ (e.target))) {
    dismissSlashMenu();
  }
}

/** @param {SlashCommand} cmd */
function select(cmd) {
  const cbs = callbacks;
  dismissSlashMenu();
  cbs?.onSelect(cmd);
}

/** @param {Event} e */
function onFilterInput(e) {
  const input = /** @type {HTMLInputElement} */ (e.target);
  const filter = input.value.toLowerCase();

  filteredItems = filter
    ? SLASH_COMMANDS.filter(
        (c) => c.label.toLowerCase().includes(filter) || c.tag.toLowerCase().includes(filter),
      )
    : SLASH_COMMANDS;

  activeIdx = 0;
  if (_anchorEl) render(_anchorEl, true);

  // Re-focus input after re-render
  requestAnimationFrame(() => {
    const el = /** @type {HTMLInputElement | null} */ (getHost().querySelector(".slash-filter"));
    if (el && el !== document.activeElement) {
      el.focus();
      el.selectionStart = el.selectionEnd = el.value.length;
    }
  });
}

/** @param {KeyboardEvent} e */
function onKeydown(e) {
  if (!open) return;

  const items = /** @type {NodeListOf<Element>} */ (
    getHost().querySelectorAll("sp-menu-item:not([disabled])")
  );

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
