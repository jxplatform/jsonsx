/// <reference lib="dom" />
/**
 * Iframe-realm slash-menu bridge — the inline-edit engine detects "/" and drives a DI'd
 * {@link SlashController}; the real lit/Spectrum menu can't render in the slim iframe bundle, so
 * this controller proxies it across the postMessage bridge. It posts `slashShow` (with the edited
 * element's IFRAME-VIEWPORT rect + the typed filter) / `slashDismiss`; the host shows the parent
 * menu and posts back `slashSelect` / `slashDismissed`.
 *
 * While the menu is open, the four navigation keys are intercepted here CAPTURE-PHASE — before the
 * engine's element-level keydown — and posted as `slashNav` for the parent menu's key handler. That
 * restores the legacy "shared slash menu captures Enter" contract (the engine's own Enter handler
 * defers when `slash.isOpen()`), and keeps Escape from ending the edit session while the menu is
 * up.
 */

import { setSlashController } from "../editor/inline-edit";
import { rectOf } from "../utils/geometry";
import type { SlashCommand, SlashController } from "../editor/inline-edit";
import type { IframeChannel } from "./iframe-channel";
import type { IframeToParent, ParentToIframe } from "./iframe-protocol";

type SlashNavKey = Extract<IframeToParent, { kind: "slashNav" }>["key"];

const NAV_KEYS = new Set(["ArrowUp", "ArrowDown", "Enter", "Escape"]);

/**
 * Register the bridge SlashController for this iframe realm and wire its keyboard/dismissal
 * listeners. Returns a teardown function (restores a no-op controller).
 */
export function startIframeSlashBridge(
  channel: IframeChannel<IframeToParent, ParentToIframe>,
  doc: Document,
): () => void {
  let open = false;
  // Kept across `slashDismissed`: the parent's select() dismisses the menu BEFORE it fires
  // OnSelect, so a slashSelect legitimately arrives after the dismissal notification.
  let onSelect: ((cmd: SlashCommand) => void) | null = null;
  let lastPostedFilter: string | null = null;

  const controller: SlashController = {
    dismiss: () => {
      if (!open) {
        return;
      }
      open = false;
      lastPostedFilter = null;
      channel.post({ kind: "slashDismiss" });
    },
    isOpen: () => open,
    show: (anchorEl, filter, cbs) => {
      ({ onSelect } = cbs);
      if (open && filter === lastPostedFilter) {
        return;
      }
      open = true;
      lastPostedFilter = filter;
      const r = rectOf(anchorEl);
      channel.post({
        filter,
        kind: "slashShow",
        rect: { height: r.height, width: r.width, x: r.left, y: r.top },
        /* Carried, because the parent draws the menu and only the FRAME knows why it opened. A
           menu opened by name has no "/…" run in the document to filter with, so it needs its own
           field; the "/" gesture needs none, because the author types into the block. This option
           was dropped at this boundary and the loss was invisible — the menu still appeared, just
           with no way past fifteen items but scrolling. */
        ...(cbs.showFilter === true ? { showFilter: true } : {}),
      });
    },
  };
  setSlashController(controller);

  const onKeyDown = (e: KeyboardEvent) => {
    if (!open || !NAV_KEYS.has(e.key)) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    channel.post({ key: e.key as SlashNavKey, kind: "slashNav" });
  };
  const onMouseDown = () => {
    // The parent menu's outside-click listener can't see iframe clicks — any in-iframe press while
    // The menu is open dismisses it (legacy parity: the popover is never inside this document). The
    // Engine's click-away commit is gated on slash.isOpen(), so the dismissal wins and the edit
    // Session survives the click.
    if (open) {
      controller.dismiss();
    }
  };
  doc.addEventListener("keydown", onKeyDown, true);
  doc.addEventListener("mousedown", onMouseDown, true);

  const off = channel.onMessage((msg) => {
    if (msg.kind === "slashSelect") {
      open = false;
      lastPostedFilter = null;
      onSelect?.({ ...msg.cmd });
      return;
    }
    if (msg.kind === "slashDismissed") {
      open = false;
      lastPostedFilter = null;
    }
  });

  return () => {
    doc.removeEventListener("keydown", onKeyDown, true);
    doc.removeEventListener("mousedown", onMouseDown, true);
    off();
    setSlashController({
      dismiss: () => {
        // Bridge torn down — no menu in this realm.
      },
      isOpen: () => false,
      show: () => {
        // Bridge torn down — no menu in this realm.
      },
    });
  };
}
