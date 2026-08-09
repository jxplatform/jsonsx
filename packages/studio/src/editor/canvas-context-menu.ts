/// <reference lib="dom" />
/**
 * Parent-realm adapter for canvas right-clicks: the iframe suppresses the browser menu and posts
 * `contextMenu` with the nearest element path + iframe-viewport coords; the host converts to
 * parent-viewport coords and calls this handler, which shows the Jx element context menu. Replaces
 * the legacy panel-events canvas contextmenu handler that died with the in-parent <div> canvas.
 *
 * The canvas menu IS the `context/element` placement — this adapter contributes coordinates and the
 * component-navigation hook, and never a list of verbs. Which rows appear, what they are called,
 * whether they are enabled and what chord they teach all come from the registry
 * (`context-menu.ts`).
 */

import { dismissContextMenu, showContextMenu } from "./context-menu";
import { bubbleInlinePath } from "../canvas/canvas-helpers";
import { activeTab } from "../workspace/workspace";
import type { CanvasContextMenuHandler } from "../canvas/iframe-host";
import type { JxPath } from "../state";

/**
 * Build the handler with its studio-owned dependency (component navigation), mirroring the other
 * host DI factories.
 */
export function makeCanvasContextMenuHandler(deps: {
  navigateToComponent: (path: string) => void | Promise<void>;
}): CanvasContextMenuHandler {
  return {
    dismiss: () => dismissContextMenu(),
    show: ({ path, clientX, clientY }) => {
      if (!path) {
        return;
      }
      // Lift inline-element paths (a <strong> inside a <p>) to their block parent — right-clicking
      // Formatted text should act on the block, matching the legacy handler.
      const bubbled = bubbleInlinePath(activeTab.value?.doc.document, path as JxPath);
      // ShowContextMenu reads only preventDefault/clientX/clientY from the event, so a synthetic
      // MouseEvent carries the converted coords safely.
      const evt = new MouseEvent("contextmenu", { clientX, clientY });
      showContextMenu(evt, bubbled, {
        onEditComponent: (p) => {
          void deps.navigateToComponent(p);
        },
      });
    },
  };
}
