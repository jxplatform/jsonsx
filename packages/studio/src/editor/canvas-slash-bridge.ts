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
  // No filter input: the author keeps typing in the iframe contenteditable and the engine re-posts
  // SlashShow with the updated filter.
  show: ({ rect, filter, onSelect, onDismiss }) =>
    showSlashMenuAtRect(rect, filter, { onDismiss, onSelect }),
};
