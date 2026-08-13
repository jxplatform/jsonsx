/// <reference lib="dom" />
/**
 * Parent-realm adapter between the canvas iframe's slash-menu bridge and the real lit/Spectrum
 * menu. The iframe engine detects "/", its {@link file://../canvas/iframe-slash.ts} controller posts
 * `slashShow`/`slashNav`/`slashDismiss`, the host converts coordinates and calls this handler;
 * select/dismiss flow back over the same channel as `slashSelect`/`slashDismissed`. Registered via
 * {@link setCanvasSlashHandler} in studio.ts (DI keeps the host module free of the menu's lit
 * dependencies).
 */

import { dismissSlashMenu, handleSlashMenuKey, showSlashMenuAtRect } from "./slash-menu";
import type { CanvasSlashHandler } from "../canvas/iframe-host";

export const canvasSlashHandler: CanvasSlashHandler = {
  dismiss: () => dismissSlashMenu(),
  nav: (key) => handleSlashMenuKey(key),
  /* The filter field appears only when the frame asks for it, and only the frame knows why the menu
     opened. Typing "/" needs none — the author keeps typing into the iframe's contenteditable and
     the engine re-posts `slashShow` with the updated filter. A menu opened BY NAME
     (`insert.openSlashMenu`) has no "/…" run to type into, so without the field the only way past
     fifteen blocks is scrolling. */
  show: ({ rect, filter, showFilter, onSelect, onDismiss }) =>
    showSlashMenuAtRect(rect, filter, {
      onDismiss,
      onSelect,
      ...(showFilter === true ? { showFilter: true } : {}),
    }),
};
