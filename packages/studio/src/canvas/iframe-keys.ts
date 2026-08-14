/// <reference lib="dom" />
/**
 * In-iframe keyboard forwarding — one authority, synced from the host's keymap.
 *
 * Studio's chords are dispatched against the EDITOR document, so once focus moves into the canvas
 * iframe (a click selects a node there) nothing the parent binds fires. This captures the
 * keystrokes the parent actually wants, prevents their default, and posts a flattened event the
 * host re-dispatches into its own registry.
 *
 * **Which keystrokes those are is no longer written down here.** It used to be, in three
 * hand-maintained lists — eight bare keys, four "the editor owns these" chords, three "the browser
 * owns these" chords — kept beside a registry that already knew the answer, and they disagreed with
 * it in both directions:
 *
 * - **⌘A was forwarded AND prevented.** No record binds it, so the host claimed nothing and select-
 *   all did nothing — while the `preventDefault` had already suppressed the browser's own, so a
 *   writer mid-sentence could not select their paragraph either. Two ways of doing nothing.
 * - **⌘B was withheld**, on the list's stated assumption that "the editing engine implements it
 *   itself". It does not: `editor/inline-edit.ts`'s keydown listener is attached to the BLOCK while
 *   the editing host is the canvas container, so it never fires, and `canvas/editable-actions.ts`
 *   rejects the browser's native `formatBold` because Jx owns its own markup. Bold in the canvas
 *   did nothing at all, under a toolbar advertising ⌘B.
 *
 * So the frame is told the table instead ({@link ParentToIframe} `keymap`), and answers the
 * question by RESOLVING: pick the scope stack the host would pick, and forward iff some scope in it
 * claims the chord. Everything the three lists encoded falls out of that, without being encoded:
 *
 * - The clipboard trio is bound at `canvas` scope only (`editor/context-menu.ts`), so with a caret
 *   session live the stack is `["caret", "global"]`, nothing claims ⌘C/⌘X/⌘V, and the browser's own
 *   copy of the selected TEXT happens — the old `CLIPBOARD_CHORDS` contract, derived rather than
 *   listed.
 * - The bare editing keys (Backspace, Enter, the arrows) are `canvas`-scoped for the same reason and
 *   behave the same way.
 * - `format.*` is `caret`-scoped, so ⌘B forwards exactly while a caret exists and the host posts
 *   `applyFormat` back — the path the toolbar's own buttons have always taken.
 *
 * The remaining local rule is a real one: a genuine `INPUT` / `TEXTAREA` / `SELECT` inside the
 * rendered page (an author's own form) keeps every keystroke, because Backspace and Enter are
 * canvas-bound and a resolved table would happily prevent them mid-field.
 */

import { chordFromEvent } from "../commands/keymap";

import type { KeyScope } from "../commands/levels";

import type { IframeChannel } from "./iframe-channel";
import type { IframeToParent, ParentToIframe, SerializedKey, SyncedChord } from "./iframe-protocol";

/**
 * The three scopes a canvas frame can ever be dispatching under.
 *
 * The host projects exactly these out of the keymap ({@link import("../commands/keymap").
 * chordsInScopes}) — narrower than "every scope", because the grid and code engines, the focused
 * dock and the palette are other surfaces entirely and their chords must not make a canvas swallow
 * a keystroke.
 */
export const FRAME_KEY_SCOPES = ["caret", "canvas", "global"] as const;

/** The scope stack a caret session is in — app chords still fire, element-level ones do not. */
const CARET_STACK = ["caret", "global"] as const;
/** The stack with a selection but no caret: structural verbs are live. */
const CANVAS_STACK = ["canvas", "global"] as const;
/** Preview draws no overlays and posts no hits, so element-level chords have nothing to aim at. */
const GLOBAL_STACK = ["global"] as const;

/** The synced table, plus the platform the chords were computed for. */
export interface ForwardTable {
  mac: boolean;
  chords: readonly SyncedChord[];
}

/** An empty table — what the frame knows before the host's first `keymap` message arrives. */
export const NO_TABLE: ForwardTable = { chords: [], mac: false };

/** Whether `el` is a text-entry control in the RENDERED PAGE whose keystrokes are its own. */
function isPageTextEntry(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) {
    return false;
  }
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
}

/**
 * The scope stack this keystroke would be dispatched under, host-side.
 *
 * The same ladder as `commands/context.ts`'s `keyScopeStack`, minus the branches the frame cannot
 * be in: there is no modal and no focused dock inside the canvas, and the grid and code engines are
 * other editors entirely. Keeping the two in step is what makes the forwarding decision and the
 * dispatch decision the same decision.
 */
export function frameScopeStack(sessionLive: boolean, mode: string): readonly KeyScope[] {
  if (sessionLive) {
    return CARET_STACK;
  }
  return mode === "preview" ? GLOBAL_STACK : CANVAS_STACK;
}

/**
 * Whether the parent's registry claims this keystroke.
 *
 * `""` from {@link chordFromEvent} means a bare modifier — the start of every chord — and is never
 * forwarded.
 */
export function shouldForwardKey(
  e: KeyboardEvent,
  table: ForwardTable = NO_TABLE,
  sessionLive = false,
  mode = "design",
): boolean {
  if (isPageTextEntry(e.target)) {
    return false;
  }
  const chord = chordFromEvent(e, table.mac);
  if (!chord) {
    return false;
  }
  const stack = frameScopeStack(sessionLive, mode);
  return table.chords.some((entry) => entry.chord === chord && stack.includes(entry.scope));
}

/** Flatten a KeyboardEvent to the structured-cloneable subset the bridge carries. */
export function serializeKey(e: KeyboardEvent): SerializedKey {
  return {
    altKey: e.altKey,
    code: e.code,
    ctrlKey: e.ctrlKey,
    key: e.key,
    metaKey: e.metaKey,
    shiftKey: e.shiftKey,
  };
}

/**
 * Listen for the parent's chords on the iframe document, prevent their default, and forward them.
 * Returns a teardown function.
 *
 * All three accessors are read PER KEYSTROKE, never captured: the table is replaced whenever the
 * author rebinds a key, the session comes and goes under the same listener, and the mode changes
 * without one.
 */
export function startKeyForwarding(
  channel: IframeChannel<IframeToParent, ParentToIframe>,
  doc: Document = document,
  isSessionLive: () => boolean = () => false,
  getTable: () => ForwardTable = () => NO_TABLE,
  getMode: () => string = () => "design",
): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (!shouldForwardKey(e, getTable(), isSessionLive(), getMode())) {
      return;
    }
    e.preventDefault();
    channel.post({ event: serializeKey(e), kind: "forwardKey" });
  };
  doc.addEventListener("keydown", onKey, true);
  return () => doc.removeEventListener("keydown", onKey, true);
}
