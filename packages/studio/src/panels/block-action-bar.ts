/// <reference lib="dom" />
/**
 * Block action bar — extracted from studio.js (Phase 4h). Floating toolbar above selected elements
 * with parent selector, move arrows, drag handle, component actions, and inline formatting.
 */

import { html, render as litRender, nothing } from "lit-html";
import { styleMap } from "lit-html/directives/style-map.js";
import { ref } from "lit-html/directives/ref.js";
import { draggable } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { disableNativeDragPreview } from "@atlaskit/pragmatic-drag-and-drop/element/disable-native-drag-preview";

import {
  canvasWrap,
  childIndex,
  childList,
  getNodeAtPath,
  nodeLabel,
  parentElementPath,
} from "../store";
import { activeTab } from "../workspace/workspace";
import { mutateMoveNode, mutateUpdateProperty, transactDoc } from "../tabs/transact";
import { view } from "../view";
import { getInlineActions } from "../editor/inline-edit";
import type { InlineAction } from "../editor/inline-edit";
import { buildMergeTags, buildRepeaterTagsFromFields } from "../editor/merge-tags";
import { findEnclosingRepeater, resolveRepeaterItemFields } from "../editor/repeater-scope";
import { projectState } from "../state";
import { componentRegistry } from "../files/components";
import { convertToComponent } from "../editor/convert-to-component";
import { getEditBarAnchorRect, getEditSnapshot, postApplyFormat } from "../canvas/iframe-host";
import { getLayerSlot, isModalOpen } from "../ui/layers";
import { showSlashMenu } from "../editor/slash-menu";
import { getConvertTargets } from "../editor/convert-targets";
import { rectOf } from "../utils/geometry";

import type { ApplyFormatIntent } from "../canvas/iframe-protocol";
import type { JxPath } from "../state";
import type { TemplateResult } from "lit-html";
import type { SlashCommand } from "../editor/convert-targets.js";

/** The plain format commands (everything an action button posts except link/insertData). */
type FormatCommand = Extract<ApplyFormatIntent, { command: "bold" }>["command"];

/**
 * @type {{
 *   getCanvasMode: () => string;
 *   navigateToComponent: (path: string) => void;
 * } | null}
 */
let _ctx: {
  getCanvasMode: () => string;
  navigateToComponent: (path: string) => void;
} | null = null;

/**
 * Initialize the block action bar module.
 *
 * @param {{
 *   getCanvasMode: () => string;
 *   navigateToComponent: (path: string) => void;
 * }} ctx
 */
export function initBlockActionBar(ctx: {
  getCanvasMode: () => string;
  navigateToComponent: (path: string) => void;
}) {
  _ctx = ctx;
  if (!_formatShortcutBound) {
    document.addEventListener("keydown", handleParentFormatShortcut);
    // `scroll` doesn't bubble but IS deliverable capture-phase at the document — one app-lifetime
    // Listener covers .content-edit-canvas (edit mode), window scrolls, and any future scroll
    // Container, keeping the position:fixed bar tracking its (scrolling) anchor.
    document.addEventListener("scroll", onCanvasScroll, { capture: true, passive: true });
    _formatShortcutBound = true;
  }
}

/** Register the parent-document format-shortcut + scroll handlers exactly once. */
let _formatShortcutBound = false;

/** One reposition per frame, no matter how many scroll events land in it. */
let _scrollRafPending = false;

/**
 * Reposition the bar on a canvas-area scroll — rAF-throttled and via the style fast path ({@link
 * repositionBlockActionBar}), NOT a full lit re-render (which would tear down and re-create the
 * drag-handle's pragmatic-dnd registration every frame). Exported for tests.
 *
 * @param {Event} e
 */
export function onCanvasScroll(e: Event): void {
  if (!_ctx || _linkPopoverOpen) {
    return;
  }
  if (!activeTab.value?.session.selection) {
    return;
  }
  const mode = _ctx.getCanvasMode();
  if (mode !== "design" && mode !== "edit") {
    return;
  }
  // Only canvas-area scrolls (or the window itself) move the anchor; left/right panel scrolling
  // Never does.
  const isCanvasScroll =
    e.target === document ||
    (canvasWrap != null && e.target instanceof Node && canvasWrap.contains(e.target));
  if (!isCanvasScroll || _scrollRafPending) {
    return;
  }
  _scrollRafPending = true;
  requestAnimationFrame(() => {
    _scrollRafPending = false;
    repositionBlockActionBar();
  });
}

/**
 * Style-only fast path: move the existing bar to the anchor's current position (fresh
 * {@link getEditBarAnchorRect} — the iframe's GBCR moves with the scroll). Hides via `visibility`
 * when the anchor left the canvas area so the lit tree (and the drag handle's dnd registration)
 * survives; a bar hidden by the full render path (`nothing`) is resurrected with a full render.
 */
function repositionBlockActionBar(): void {
  const bar = view.blockActionBarEl?.firstElementChild as HTMLElement | null;
  if (!bar) {
    renderBlockActionBar();
    return;
  }
  const anchor = getEditBarAnchorRect();
  const pos = anchor ? barPosition(anchor) : null;
  if (!pos) {
    bar.style.visibility = "hidden";
    return;
  }
  bar.style.visibility = "";
  bar.style.left = `${pos.left}px`;
  bar.style.top = `${pos.top}px`;
  clampBarToWindow(bar);
}

/**
 * The bar's position for `anchor` (flipping below the element near the top edge), or null when the
 * anchor's vertical extent has left the canvas area — the popover layer has no clipping, so a
 * clamped bar would float detached over the app toolbar / panel headers.
 *
 * @param {{ left: number; top: number; height: number }} anchor
 */
function barPosition(anchor: {
  left: number;
  top: number;
  height: number;
}): { left: number; top: number } | null {
  if (canvasWrap) {
    const wrap = rectOf(canvasWrap);
    if (anchor.top + anchor.height < wrap.top || anchor.top > wrap.bottom) {
      return null;
    }
  }
  return {
    left: anchor.left,
    top: anchor.top < 80 ? anchor.top + anchor.height + 4 : anchor.top - 38,
  };
}

/**
 * Pull the bar back inside the window's right edge.
 *
 * @param {HTMLElement} bar
 */
function clampBarToWindow(bar: HTMLElement): void {
  const barRect = rectOf(bar);
  if (barRect.right > window.innerWidth) {
    bar.style.left = `${Math.max(0, window.innerWidth - barRect.width)}px`;
  }
}

/**
 * Route Ctrl/Cmd+B/I/`/K to the iframe while an inline-edit session is live but focus is on the
 * PARENT (the format toolbar or its link popover) — the keystroke never reaches the iframe's own
 * contenteditable handler. When focus is inside the canvas iframe, do nothing (the iframe handles
 * it and forwards globals via `forwardKey`). Exported so the unit test can dispatch it directly.
 *
 * @param {KeyboardEvent} e
 */
export function handleParentFormatShortcut(e: KeyboardEvent): void {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) {
    return;
  }
  // Same rule as the global shortcuts: a modal surface owns the keyboard, so ⌘B never reformats the
  // Document behind an underlay the author cannot click through.
  if (isModalOpen() || !getEditSnapshot().editing) {
    return;
  }
  // Focus inside the cross-origin canvas iframe surfaces as the <iframe> element being active.
  const active = document.activeElement;
  if (active instanceof HTMLIFrameElement && active.classList.contains("jx-canvas-iframe")) {
    return;
  }
  const key = e.key.toLowerCase();
  if (key === "b") {
    e.preventDefault();
    postApplyFormat({ command: "bold" });
  } else if (key === "i") {
    e.preventDefault();
    postApplyFormat({ command: "italic" });
  } else if (key === "`") {
    e.preventDefault();
    postApplyFormat({ command: "code" });
  } else if (key === "k") {
    e.preventDefault();
    openLinkPopoverFromShortcut();
  }
}

/** Pre-built icon templates for inline format buttons (avoids unsafeStatic) */
const formatIconMap = {
  "sp-icon-code": html`<sp-icon-code slot="icon"></sp-icon-code>`,
  "sp-icon-link": html`<sp-icon-link slot="icon"></sp-icon-link>`,
  "sp-icon-text-bold": html`<sp-icon-text-bold slot="icon"></sp-icon-text-bold>`,
  "sp-icon-text-italic": html`<sp-icon-text-italic slot="icon"></sp-icon-text-italic>`,
  "sp-icon-text-strikethrough": html`<sp-icon-text-strikethrough
    slot="icon"
  ></sp-icon-text-strikethrough>`,
  "sp-icon-text-subscript": html`<sp-icon-text-subscript slot="icon"></sp-icon-text-subscript>`,
  "sp-icon-text-superscript": html`<sp-icon-text-superscript
    slot="icon"
  ></sp-icon-text-superscript>`,
  "sp-icon-text-underline": html`<sp-icon-text-underline slot="icon"></sp-icon-text-underline>`,
} as Record<string, TemplateResult>;

/**
 * Prevent the bar from stealing focus from contenteditable
 *
 * @param {MouseEvent} e
 */
function onBarMousedown(e: MouseEvent) {
  if ((e.target as HTMLElement).closest("sp-textfield")) {
    return;
  }
  if ((e.target as HTMLElement).closest(".bar-drag-handle")) {
    return;
  }
  if ((e.target as HTMLElement).closest(".bar-tag--interactive")) {
    return;
  }
  e.preventDefault();
}

/**
 * @param {MouseEvent} e
 * @param {import("../editor/convert-targets.js").SlashCommand[]} targets
 * @param {JxPath} selection
 */
function onTagBadgeClick(e: MouseEvent, targets: SlashCommand[], selection: JxPath) {
  e.stopPropagation();
  const anchorEl = e.currentTarget as HTMLElement;
  showSlashMenu(anchorEl, "", {
    commands: targets,
    onSelect: (cmd) => {
      transactDoc(activeTab.value, (t) => {
        mutateUpdateProperty(t, selection, "tagName", cmd.tag);
      });
    },
    showFilter: targets.length > 6,
  });
}

/**
 * Handle a format-button click. The iframe owns the Selection — link opens the parent popover;
 * every other command posts an `applyFormat` intent across the bridge.
 *
 * @param {MouseEvent} e
 * @param {InlineAction} action
 */
function onFormatClick(e: MouseEvent, action: InlineAction) {
  e.stopPropagation();
  if (action.command === "link") {
    showLinkPopover((e.target as HTMLElement).closest("sp-action-button") as HTMLElement);
  } else if (action.command) {
    postApplyFormat({ command: action.command as FormatCommand });
  }
}

function renderParentSelector() {
  const tab = activeTab.value;
  if (!tab?.session.selection) {
    return nothing;
  }
  const pPath = parentElementPath(tab.session.selection);
  if (!pPath) {
    return nothing;
  }
  const parentNode = getNodeAtPath(tab.doc.document, pPath);
  return html`
    <sp-action-button
      size="xs"
      quiet
      title="Select parent: ${nodeLabel(parentNode)}"
      @click=${(e: MouseEvent) => {
        e.stopPropagation();
        activeTab.value!.session.selection = pPath;
      }}
    >
      <sp-icon-back slot="icon"></sp-icon-back>
    </sp-action-button>
  `;
}

function renderMoveArrows() {
  const tab = activeTab.value;
  if (!tab?.session.selection) {
    return nothing;
  }
  const sel = tab.session.selection;
  const idx = childIndex(sel) as number;
  const pPath = parentElementPath(sel);
  const parentNode = pPath ? getNodeAtPath(tab.doc.document, pPath) : null;
  const siblings = parentNode ? childList(parentNode) : null;
  return html`
    <sp-action-button
      size="xs"
      quiet
      title="Move up"
      ?disabled=${idx <= 0}
      @click=${(e: MouseEvent) => {
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
      @click=${(e: MouseEvent) => {
        e.stopPropagation();
        moveSelectionDown();
      }}
    >
      <sp-icon-arrow-down slot="icon"></sp-icon-arrow-down>
    </sp-action-button>
  `;
}

/**
 * Open the merge-tag menu — a searchable list of `${…}` template tokens for the data available in
 * the current state. Reuses the shared slash-menu popover (filter + keyboard nav + dismiss).
 * Selecting a token posts an `insertData` intent the iframe applies at its caret.
 *
 * @param {MouseEvent} e
 */
function onMergeTagClick(e: MouseEvent) {
  e.stopPropagation();
  const anchorEl = e.currentTarget as HTMLElement;
  const tab = activeTab.value;
  const state = (tab?.doc.document.state ?? {}) as Record<string, unknown>;
  // The live resolved scope lives inside the iframe realm and is not threaded out, so the parent
  // Offers only top-level `state.*` tokens (buildMergeTags tolerates the null scopes).
  const tags = buildMergeTags(state, null, null);

  // When the caret sits inside a repeater, offer its local scope (item/index + item fields). There is
  // No live `$map` in edit mode — the perimeter renders one glyph template — so fields resolve
  // Parent-side from schema, keyed off the selected element's doc path (which carries a `map` segment).
  const selPath = getEditSnapshot().snapshot?.path ?? tab?.session.selection;
  const arrayNode = tab && selPath ? findEnclosingRepeater(tab.doc.document, selPath) : null;
  if (arrayNode) {
    const tokens = resolveRepeaterItemFields(
      arrayNode,
      tab!.doc.document.state as Record<string, unknown>,
      projectState?.projectConfig,
    );
    tags.push(...buildRepeaterTagsFromFields(tokens));
  }

  const commands = tags.map((t) => ({
    description: t.hint,
    label: t.label,
    tag: t.token,
  }));

  showSlashMenu(anchorEl, "", {
    commands,
    onSelect: (cmd) => postApplyFormat({ command: "insertData", token: cmd.tag }),
    showFilter: true,
  });
}

/** Dismiss the link popover if open. */
export function dismissLinkPopover() {
  _linkPopoverOpen = false;
  const host = getLayerSlot("popover", "link-popover");
  litRender(nothing, host);
}

/** Dismiss the block action bar. */
export function dismissBlockActionBar() {
  if (view.blockActionBarEl) {
    litRender(nothing, view.blockActionBarEl);
  }
}

/**
 * Whether the link popover is open. A snapshot-driven {@link renderBlockActionBar} must NOT
 * re-render (and so re-mount) the open popover — typing the URL would re-create the field and lose
 * focus/caret. Guarded around the toolbar re-render.
 */
let _linkPopoverOpen = false;

/** True while the link URL popover is open (so the toolbar refresh skips a disruptive re-render). */
export function isLinkPopoverOpen(): boolean {
  return _linkPopoverOpen;
}

/**
 * Whether `target` sits inside the edit-session chrome — the block action bar, its link popover, or
 * the slash menu. The parent's pointerdown commit-guard must NOT end the inline-edit session for
 * clicks on these (they operate ON the session); any other parent-chrome press commits it. This
 * module owns those popover roots, hence the helper lives here.
 *
 * @param {EventTarget | null} target
 */
export function isEditChromeTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Node)) {
    return false;
  }
  const roots = [
    view.blockActionBarEl,
    getLayerSlot("popover", "link-popover"),
    getLayerSlot("popover", "slash-menu"),
  ];
  return roots.some((root) => root != null && root.contains(target));
}

/**
 * Show the link URL popover. The iframe owns the Selection, so the existing-link state comes from
 * the latest selection snapshot; Apply/Remove post `applyFormat` link intents the iframe applies.
 *
 * @param {HTMLElement} anchorBtn
 */
function showLinkPopover(anchorBtn: HTMLElement) {
  const host = getLayerSlot("popover", "link-popover");
  litRender(nothing, host);

  const link = getEditSnapshot().snapshot?.link ?? { active: false, href: null };
  const existing = link.active;

  const rect = rectOf(anchorBtn);

  let _linkField: HTMLInputElement | null = null;

  const close = () => {
    _linkPopoverOpen = false;
    litRender(nothing, host);
  };

  const onApply = () => {
    const url = _linkField?.value || "";
    // Apply then let the popover close itself (do not steal focus back into the iframe here).
    postApplyFormat({ command: "link", href: url || "" });
    close();
  };

  const onRemove = () => {
    postApplyFormat({ command: "link", href: null });
    close();
  };

  const onKeydown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      onApply();
    } else if (e.key === "Escape") {
      close();
    }
  };

  _linkPopoverOpen = true;
  litRender(
    html`
      <sp-popover
        class="link-popover"
        open
        style=${styleMap({
          left: `${rect.left}px`,
          position: "fixed",
          top: `${rect.bottom + 4}px`,
          zIndex: "30",
        })}
      >
        <sp-textfield
          placeholder="https://..."
          size="s"
          style="width:200px"
          value=${link.href || ""}
          @keydown=${onKeydown}
          ${ref((el) => {
            _linkField = (el as HTMLInputElement | null) || null;
            if (el) {
              requestAnimationFrame(() => (el as HTMLElement).focus());
            }
          })}
        ></sp-textfield>
        <sp-action-button size="xs" @click=${onApply}>
          ${existing ? "Update" : "Apply"}
        </sp-action-button>
        ${existing
          ? html` <sp-action-button size="xs" @click=${onRemove}>Remove</sp-action-button> `
          : nothing}
      </sp-popover>
    `,
    host,
  );
}

/**
 * Open the link popover from the Ctrl/Cmd+K shortcut (anchored to the toolbar's Link button if it
 * is on screen, else the bar itself). Used by the parent-focus format-shortcut handler.
 */
export function openLinkPopoverFromShortcut(): void {
  const bar = view.blockActionBarEl?.querySelector(".block-action-bar") as HTMLElement | null;
  const linkBtn =
    (bar?.querySelector('sp-action-button[title^="Link"]') as HTMLElement | null) ?? bar;
  if (linkBtn) {
    showLinkPopover(linkBtn);
  }
}

/** Move the selected node up (swap with previous sibling). */
function moveSelectionUp() {
  const tab = activeTab.value;
  if (!tab?.session.selection || tab.session.selection.length < 2) {
    return;
  }
  const sel = tab.session.selection;
  const idx = childIndex(sel) as number;
  if (idx <= 0) {
    return;
  }
  const pPath = parentElementPath(sel) as JxPath;
  transactDoc(tab, (t) => mutateMoveNode(t, sel, pPath, idx - 1));
  tab.session.selection = [...pPath, "children", idx - 1];
}

/** Move the selected node down (swap with next sibling). */
function moveSelectionDown() {
  const tab = activeTab.value;
  if (!tab?.session.selection || tab.session.selection.length < 2) {
    return;
  }
  const sel = tab.session.selection;
  const idx = childIndex(sel) as number;
  const pPath = parentElementPath(sel) as JxPath;
  const parentNode = getNodeAtPath(tab.doc.document, pPath);
  const siblings = childList(parentNode);
  if (idx >= siblings.length - 1) {
    return;
  }
  transactDoc(tab, (t) => mutateMoveNode(t, sel, pPath, idx + 2));
  tab.session.selection = [...pPath, "children", idx + 1];
}

/** Render the unified block action bar above the selected element. */
export function renderBlockActionBar() {
  if (!_ctx) {
    return;
  }
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

  // A snapshot-driven refresh must not re-mount an open link popover (it would re-create the URL
  // Field and lose the caret) — preserve it by skipping this render pass.
  if (_linkPopoverOpen) {
    return;
  }

  const { selection } = tab.session;
  const node = getNodeAtPath(tab.doc.document, selection);
  if (!node) {
    litRender(nothing, view.blockActionBarEl);
    return;
  }

  // Position from the iframe-host's viewport-space anchor (the bar is position:fixed). The parent
  // Never reads the iframe DOM, so geometry crosses the bridge as the selection snapshot's rect.
  const anchor = getEditBarAnchorRect();
  const pos = anchor ? barPosition(anchor) : null;
  if (!pos) {
    litRender(nothing, view.blockActionBarEl);
    return;
  }

  const tag = (node.tagName ?? "div").toLowerCase();

  // Inline format state, sourced from the iframe's selection snapshot.
  const { editingProp, snapshot } = getEditSnapshot();
  const actions = getInlineActions(tag) || [];
  // ONE bar, one shape. The format group used to appear only during an "inline edit session", so
  // The toolbar rearranged itself under the author's cursor the moment they started typing. With a
  // Document-wide caret there is no session to be in or out of: the group is shown whenever the
  // Selected block can carry inline markup, and the buttons enable when there is a range to apply
  // Them to.
  //
  // A prop-bound block still suppresses it — it edits a single plain string (belt and braces:
  // Component tags have no $inlineActions, so `actions` is empty there anyway).
  const showFormat = !editingProp && actions.length > 0;
  const activeValues =
    showFormat && snapshot
      ? actions.filter((a) => snapshot.activeTags.includes(a.tag)).map((a) => a.tag)
      : [];
  // Formatting applies to a RANGE: disabled for a collapsed caret, and for a block selected without
  // One at all (from the layers panel, or by a structural edit moving the selection).
  const formatDisabled = snapshot?.collapsed ?? true;

  // Conversion targets for badge click
  const isComponent =
    node.tagName?.includes("-") &&
    componentRegistry.some((/** @type {{ tagName: string }} */ c) => c.tagName === node.tagName);
  const children = childList(node);
  const isEmpty =
    !node.textContent &&
    (children.length === 0 ||
      (children.length === 1 && typeof children[0] === "object" && children[0]?.tagName === "br"));
  // Repeater ($prototype:"Array") pseudo-elements have no tagName — show the "Repeater → items" label
  // (not a bare "div") and don't offer tag-conversion targets, which are meaningless for a repeater.
  const isRepeater = node.$prototype === "Array";
  const convertTargets = !isComponent && !isRepeater ? getConvertTargets(tag, isEmpty) : [];
  const badgeInteractive = convertTargets.length > 0;

  litRender(
    html`
      <div
        class="block-action-bar"
        style=${styleMap({ left: `${pos.left}px`, top: `${pos.top}px` })}
        @mousedown=${onBarMousedown}
      >
        ${selection.length >= 2 ? renderParentSelector() : nothing}

        <span
          class="bar-tag${badgeInteractive ? " bar-tag--interactive" : ""}"
          @click=${badgeInteractive
            ? (e: MouseEvent) => onTagBadgeClick(e, convertTargets, selection)
            : nothing}
          >${isRepeater ? nodeLabel(node) : node.$id || (node.tagName ?? "div")}${editingProp
            ? ` · ${editingProp}`
            : ""}</span
        >

        ${selection.length >= 2
          ? html`<span
              class="bar-drag-handle"
              title="Drag to reorder"
              ${ref((handleEl) => {
                if (!handleEl) {
                  return;
                }
                if (view.selDragCleanup) {
                  view.selDragCleanup();
                  view.selDragCleanup = null;
                }
                view.selDragCleanup = draggable({
                  element: handleEl as HTMLElement,
                  getInitialData: () => ({
                    // Snapshot the selection: the live array is a Vue reactive proxy, which
                    // Structured clone rejects when the src crosses postMessage (DataCloneError
                    // Killed the whole handle drag), and a live reference would also mutate the
                    // Retained srcData if the selection changed mid-drag.
                    path: [...(activeTab.value?.session.selection ?? [])],
                    type: "tree-node",
                  }),
                  onGenerateDragPreview: ({
                    nativeSetDragImage,
                  }: {
                    nativeSetDragImage: ((image: Element, x: number, y: number) => void) | null;
                  }) => {
                    // Suppress the native drag image; the cross-frame ghost is the drag affordance.
                    disableNativeDragPreview({ nativeSetDragImage });
                  },
                });
              })}
              >⠿</span
            >`
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
                  @click=${() => _ctx?.navigateToComponent(comp?.path as string)}
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
                selected=${activeValues.length > 0 ? JSON.stringify(activeValues) : nothing}
              >
                ${actions.map(
                  (action) => html`
                    <sp-action-button
                      size="xs"
                      value=${action.tag}
                      title="${action.label}${action.shortcut ? ` (${action.shortcut})` : ""}"
                      ?disabled=${formatDisabled && action.command !== "link"}
                      @mousedown=${(e: MouseEvent) => e.preventDefault()}
                      @click=${(e: MouseEvent) => onFormatClick(e, action)}
                    >
                      ${action.icon ? (formatIconMap[action.icon] ?? nothing) : nothing}
                    </sp-action-button>
                  `,
                )}
              </sp-action-group>
              <sp-action-button
                size="xs"
                quiet
                title="Insert data"
                @mousedown=${(e: MouseEvent) => e.preventDefault()}
                @click=${onMergeTagClick}
              >
                <sp-icon-data slot="icon"></sp-icon-data>
              </sp-action-button>
            `
          : nothing}
      </div>
    `,
    view.blockActionBarEl,
  );

  // Post-render side effects
  requestAnimationFrame(() => {
    const bar = view.blockActionBarEl?.firstElementChild as HTMLElement | null;
    if (!bar) {
      return;
    }
    clampBarToWindow(bar);
  });
}
