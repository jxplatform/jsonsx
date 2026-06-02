/// <reference lib="dom" />
/**
 * Panel events — extracted from studio.js (Phase 4m). Unified event handler system for canvas
 * panels: click-to-select, double-click inline edit, context menu, hover tracking, insertion
 * helper.
 */

import {
  updateUi,
  elToPath,
  pathsEqual,
  parentElementPath,
  childIndex,
  getNodeAtPath,
  renderOnly,
} from "../store";
import { activeTab } from "../workspace/workspace";
import { view } from "../view";
import { stopEditing, isEditing, isEditableBlock } from "../editor/inline-edit";
import { showContextMenu } from "../editor/context-menu";
import * as insertionHelper from "../editor/insertion-helper";
import { defaultDef } from "../panels/shared";
import { bubbleInlinePath, findCanvasElement, effectiveZoom } from "../canvas/canvas-helpers";
import { layoutElements, activeLayoutPath } from "../canvas/canvas-live-render";
import type { CanvasPanel } from "./canvas-dnd";
import type { JxPath } from "../state";

interface PanelEventsCtx {
  getCanvasMode: () => string;
  enterInlineEdit: (el: HTMLElement, path: JxPath) => void;
  navigateToComponent: (path: string) => void;
}

let _ctx: PanelEventsCtx | null = null;

/**
 * Initialize the panel events module.
 *
 * @param {PanelEventsCtx} ctx
 */
export function initPanelEvents(ctx: PanelEventsCtx) {
  _ctx = ctx;
}

/** @param {import("../canvas/canvas-render.js").CanvasPanel} panel */
export function registerPanelEvents(panel: CanvasPanel) {
  const ctx = _ctx as PanelEventsCtx;
  const canvas = panel.canvas as HTMLElement;
  const overlayClk = panel.overlayClk as HTMLElement;
  const { mediaName } = panel;
  const ac = new AbortController();
  const opts = { signal: ac.signal };
  view.canvasEventCleanups.push(() => ac.abort());

  /** @param {() => unknown} fn */
  function withPanelPointerEvents(fn: () => unknown) {
    const els = canvas.querySelectorAll("*") as NodeListOf<HTMLElement>;
    for (const el of els) el.style.pointerEvents = "auto";
    overlayClk.style.display = "none";
    const result = fn();
    overlayClk.style.display = "";
    for (const el of els) el.style.pointerEvents = "none";
    return result;
  }

  overlayClk.addEventListener(
    "click",
    (e: MouseEvent) => {
      const barInner = view.blockActionBarEl?.firstElementChild;
      if (barInner) {
        const r = barInner.getBoundingClientRect();
        if (
          e.clientX >= r.left &&
          e.clientX <= r.right &&
          e.clientY >= r.top &&
          e.clientY <= r.bottom
        )
          return;
      }
      if (isEditing()) {
        stopEditing();
      }

      const tab = activeTab.value;
      const canvasMode = ctx.getCanvasMode();

      const elements = withPanelPointerEvents(() =>
        document.elementsFromPoint(e.clientX, e.clientY),
      ) as Element[];

      if (!tab) return;

      for (const el of elements) {
        if (canvas.contains(el) && el !== canvas) {
          // Layout element clicked — show layout info instead of selecting in page doc
          if (layoutElements.has(el)) {
            view.layoutSelection = { el, layoutPath: activeLayoutPath };
            tab.session.selection = null;
            renderOnly("rightPanel");
            return;
          }
          view.layoutSelection = null;

          const originalPath = elToPath.get(el);
          if (originalPath) {
            let path = bubbleInlinePath(tab.doc.document, originalPath);
            const newMedia = mediaName === "base" ? null : (mediaName ?? null);

            const resolvedEl = (
              path === originalPath
                ? el
                : (findCanvasElement(path, canvas) as HTMLElement | null) || el
            ) as HTMLElement;

            if (
              pathsEqual(path, tab.session.selection) &&
              isEditableBlock(resolvedEl) &&
              (canvasMode === "edit" || tab.doc.mode === "content")
            ) {
              tab.session.ui.activeMedia = newMedia;
              ctx.enterInlineEdit(resolvedEl, path);
              return;
            }

            if (canvasMode === "design" && tab.doc.mode !== "content") {
              updateUi("pendingInlineEdit", { path, mediaName });
              tab.session.ui.activeMedia = newMedia;
              tab.session.selection = path;
              return;
            }

            tab.session.ui.activeMedia = newMedia;
            tab.session.selection = path;
            return;
          }
        }
      }
      tab.session.selection = null;
    },
    opts,
  );

  overlayClk.addEventListener(
    "dblclick",
    (e: MouseEvent) => {
      const barInner = view.blockActionBarEl?.firstElementChild;
      if (barInner) {
        const r = barInner.getBoundingClientRect();
        if (
          e.clientX >= r.left &&
          e.clientX <= r.right &&
          e.clientY >= r.top &&
          e.clientY <= r.bottom
        )
          return;
      }
      const canvasMode = ctx.getCanvasMode();
      if (canvasMode !== "edit" && canvasMode !== "design") return;

      const tab = activeTab.value;
      const elements = withPanelPointerEvents(() =>
        document.elementsFromPoint(e.clientX, e.clientY),
      ) as Element[];

      if (!tab) return;

      for (const el of elements) {
        if (canvas.contains(el) && el !== canvas) {
          const originalPath = elToPath.get(el);
          if (originalPath) {
            const path = bubbleInlinePath(tab.doc.document, originalPath);
            const resolvedEl = (
              path === originalPath
                ? el
                : (findCanvasElement(path, canvas) as HTMLElement | null) || el
            ) as HTMLElement;
            if (isEditableBlock(resolvedEl)) {
              const newMedia = mediaName === "base" ? null : (mediaName ?? null);
              tab.session.ui.activeMedia = newMedia;
              tab.session.selection = path;
              ctx.enterInlineEdit(resolvedEl, path);
              return;
            }
          }
        }
      }
    },
    opts,
  );

  overlayClk.addEventListener(
    "contextmenu",
    (e: MouseEvent) => {
      const barInner = view.blockActionBarEl?.firstElementChild;
      if (barInner) {
        const r = barInner.getBoundingClientRect();
        if (
          e.clientX >= r.left &&
          e.clientX <= r.right &&
          e.clientY >= r.top &&
          e.clientY <= r.bottom
        )
          return;
      }
      const tab = activeTab.value;
      const elements = withPanelPointerEvents(() =>
        document.elementsFromPoint(e.clientX, e.clientY),
      ) as Element[];
      for (const el of elements) {
        if (canvas.contains(el) && el !== canvas) {
          let path = elToPath.get(el);
          if (path) {
            path = bubbleInlinePath(tab?.doc.document, path);
            showContextMenu(e, path, { onEditComponent: ctx.navigateToComponent });
            return;
          }
        }
      }
      e.preventDefault();
    },
    opts,
  );

  overlayClk.addEventListener(
    "mousemove",
    (e: MouseEvent) => {
      const barInner = view.blockActionBarEl?.firstElementChild;
      if (barInner) {
        const r = barInner.getBoundingClientRect();
        if (
          e.clientX >= r.left &&
          e.clientX <= r.right &&
          e.clientY >= r.top &&
          e.clientY <= r.bottom
        )
          return;
      }
      const tab = activeTab.value;
      if (!tab) return;
      const el = withPanelPointerEvents(() =>
        document.elementFromPoint(e.clientX, e.clientY),
      ) as Element | null;
      if (el && canvas.contains(el) && el !== canvas) {
        let path = elToPath.get(el);
        if (path) {
          path = bubbleInlinePath(tab.doc.document, path);
          if (!pathsEqual(path, tab.session.hover)) {
            tab.session.hover = path;
            renderOnly("overlays");
          }
        }
      } else if (tab.session.hover) {
        tab.session.hover = null;
        renderOnly("overlays");
      }
    },
    opts,
  );

  overlayClk.addEventListener(
    "mouseleave",
    () => {
      if (activeTab.value?.session.hover) {
        activeTab.value.session.hover = null;
        renderOnly("overlays");
      }
    },
    opts,
  );

  insertionHelper.mount({
    getCanvasMode: ctx.getCanvasMode,
    withPanelPointerEvents,
    effectiveZoom: effectiveZoom,
    defaultDef,
    parentElementPath,
    childIndex,
    getNodeAtPath,
    elToPath,
    panel: panel as unknown as Parameters<typeof insertionHelper.mount>[0]["panel"],
  });
  view.canvasEventCleanups.push(() => insertionHelper.unmount());
}
