/**
 * In-iframe keyboard forwarding, now that the frame resolves against the host's own chord table.
 *
 * **These tests were rewritten because the ones they replace asserted the wrong thing
 * confidently.** The old file had a case named "the inline-formatting chords stay with the editing
 * engine", asserting that ⌘B is not forwarded — true of the code, and the premise was false: no
 * engine handled it (`editor/inline-edit.ts`'s keydown listener is attached to the BLOCK while the
 * editing host is the canvas container, and `canvas/editable-actions.ts` rejects the browser's
 * native `formatBold`), so Bold in the canvas did nothing. Another case asserted ⌘A forwards, which
 * it did — into a host that binds nothing to it, after a `preventDefault` that had already killed
 * the browser's own select-all. A test that encodes a list can only ever confirm the list.
 *
 * So the last describe here is the one that matters: it builds the table from the REAL registry and
 * asserts the frame's decision agrees with the host's dispatch for every chord in it. That is a
 * parity test, in the family of `tests/_rpc-parity.ts` and `tests/app-commands-composition.test.ts`
 * — two authorities that must agree, compared.
 */
import "./with-dom.js";
import { describe, expect, test } from "bun:test";
import {
  FRAME_KEY_SCOPES,
  NO_TABLE,
  frameScopeStack,
  serializeKey,
  shouldForwardKey,
  startKeyForwarding,
} from "../src/canvas/iframe-keys";
import { appCommandSet } from "../src/commands/app-commands";
import { createCommandRegistry } from "../src/commands/registry";
import { chordsInScopes } from "../src/commands/keymap";
import { emptyContext } from "../src/commands/context";
import type { ForwardTable } from "../src/canvas/iframe-keys";
import type { IframeToParent } from "../src/canvas/iframe-protocol";

function key(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
}

/** A table with the given chords, on a non-mac platform (so `ctrl` is `mod`). */
function table(...chords: { chord: string; scope: "caret" | "canvas" | "global" }[]): ForwardTable {
  return { chords, mac: false };
}

describe("shouldForwardKey", () => {
  test("forwards a chord the parent binds in a live scope", () => {
    const t = table({ chord: "mod+s", scope: "global" });
    expect(shouldForwardKey(key({ ctrlKey: true, key: "s" }), t)).toBe(true);
  });

  test("does not forward a chord nothing binds", () => {
    const t = table({ chord: "mod+s", scope: "global" });
    expect(shouldForwardKey(key({ ctrlKey: true, key: "j" }), t)).toBe(false);
  });

  test("an empty table forwards nothing — the honest cold start", () => {
    // Before the host's first `keymap` message the frame has no authority, and a frame that
    // Guessed would `preventDefault` keys it cannot name. Called with NO arguments beyond the
    // Event as well as with `NO_TABLE`, because the defaults ARE the cold start: a caller that
    // Forgets to thread the table must get "forward nothing", not "forward everything".
    expect(shouldForwardKey(key({ ctrlKey: true, key: "s" }), NO_TABLE)).toBe(false);
    expect(shouldForwardKey(key({ ctrlKey: true, key: "s" }))).toBe(false);
  });

  test("a bare modifier is not a chord", () => {
    const t = table({ chord: "mod+s", scope: "global" });
    expect(shouldForwardKey(key({ ctrlKey: true, key: "Control" }), t)).toBe(false);
  });

  test("a text field in the RENDERED PAGE keeps every key", () => {
    // Backspace and Enter are canvas-bound, so a table-only answer would preventDefault them inside
    // A form the author's own page renders.
    const input = document.createElement("input");
    document.body.append(input);
    const e = key({ key: "Backspace" });
    input.dispatchEvent(e);
    expect(shouldForwardKey(e, table({ chord: "backspace", scope: "canvas" }))).toBe(false);
    input.remove();
  });
});

describe("the three deleted lists, derived instead of listed", () => {
  const t = table(
    { chord: "mod+c", scope: "canvas" },
    { chord: "backspace", scope: "canvas" },
    { chord: "mod+a", scope: "canvas" },
    { chord: "mod+b", scope: "caret" },
    { chord: "mod+s", scope: "global" },
  );

  test("the clipboard belongs to the BROWSER while a caret session is live", () => {
    // `CLIPBOARD_CHORDS` used to say this. Now it falls out: ⌘C is bound at `canvas` scope, the
    // Caret stack is ["caret","global"], so nothing claims it and the frame neither forwards nor
    // Prevents — the browser copies the selected TEXT.
    expect(shouldForwardKey(key({ ctrlKey: true, key: "c" }), t, true)).toBe(false);
    expect(shouldForwardKey(key({ ctrlKey: true, key: "c" }), t, false)).toBe(true);
  });

  test("the bare editing keys belong to the caret, and to structure without one", () => {
    // `BARE_FORWARD_KEYS` used to say this, for the same reason and by the same derivation.
    expect(shouldForwardKey(key({ key: "Backspace" }), t, true)).toBe(false);
    expect(shouldForwardKey(key({ key: "Backspace" }), t, false)).toBe(true);
  });

  test("⌘B forwards WITH a caret and not without — the opposite of the old list", () => {
    // `EDITOR_OWNED_CHORDS` withheld ⌘B always, for an engine that never handled it. The record is
    // `keyScope: "caret"`, so the chord is live exactly where a caret is, and the host posts
    // `applyFormat` back across the same bridge the toolbar's buttons use.
    expect(shouldForwardKey(key({ ctrlKey: true, key: "b" }), t, true)).toBe(true);
    expect(shouldForwardKey(key({ ctrlKey: true, key: "b" }), t, false)).toBe(false);
  });

  test("⌘A is structural, and never eaten from a sentence", () => {
    // The defect this whole change exists to close: ⌘A was forwarded AND prevented, with nothing
    // Bound to it. Now it is `canvas`-scoped, so with a caret live the frame passes it to the
    // Browser and select-all means the paragraph.
    expect(shouldForwardKey(key({ ctrlKey: true, key: "a" }), t, true)).toBe(false);
    expect(shouldForwardKey(key({ ctrlKey: true, key: "a" }), t, false)).toBe(true);
  });

  test("app chords still forward from inside a sentence", () => {
    expect(shouldForwardKey(key({ ctrlKey: true, key: "s" }), t, true)).toBe(true);
  });

  test("preview drops the canvas scope — no overlays, nothing to aim at", () => {
    expect(shouldForwardKey(key({ ctrlKey: true, key: "c" }), t, false, "preview")).toBe(false);
    expect(shouldForwardKey(key({ ctrlKey: true, key: "s" }), t, false, "preview")).toBe(true);
  });

  test("frameScopeStack is the host's ladder, minus the branches a frame cannot be in", () => {
    expect(frameScopeStack(true, "edit")).toEqual(["caret", "global"]);
    expect(frameScopeStack(false, "design")).toEqual(["canvas", "global"]);
    expect(frameScopeStack(false, "preview")).toEqual(["global"]);
  });
});

describe("serializeKey", () => {
  test("flattens the modifier + key fields", () => {
    expect(serializeKey(key({ code: "KeyZ", ctrlKey: true, key: "z", shiftKey: true }))).toEqual({
      altKey: false,
      code: "KeyZ",
      ctrlKey: true,
      key: "z",
      metaKey: false,
      shiftKey: true,
    });
  });
});

describe("startKeyForwarding", () => {
  const t = table({ chord: "mod+z", scope: "global" });

  test("forwards a claimed chord and prevents its default", () => {
    const posts: IframeToParent[] = [];
    const stop = startKeyForwarding(
      { post: (m: IframeToParent) => posts.push(m) } as never,
      document,
      () => false,
      () => t,
    );
    const e = key({ ctrlKey: true, key: "z" });
    document.body.dispatchEvent(e);
    expect(posts).toHaveLength(1);
    expect(e.defaultPrevented).toBe(true);
    stop();
  });

  test("an unclaimed chord is neither forwarded NOR prevented", () => {
    // The half of the ⌘A defect that lived here: `preventDefault` ran before anyone asked whether
    // The host had anything to run.
    const posts: IframeToParent[] = [];
    const stop = startKeyForwarding(
      { post: (m: IframeToParent) => posts.push(m) } as never,
      document,
      () => false,
      () => t,
    );
    const e = key({ ctrlKey: true, key: "a" });
    document.body.dispatchEvent(e);
    expect(posts).toEqual([]);
    expect(e.defaultPrevented).toBe(false);
    stop();
  });

  test("the accessors are read per keystroke, so a rebinding takes effect live", () => {
    const posts: IframeToParent[] = [];
    let live: ForwardTable = NO_TABLE;
    const stop = startKeyForwarding(
      { post: (m: IframeToParent) => posts.push(m) } as never,
      document,
      () => false,
      () => live,
    );
    document.body.dispatchEvent(key({ ctrlKey: true, key: "z" }));
    expect(posts).toEqual([]);
    live = t;
    document.body.dispatchEvent(key({ ctrlKey: true, key: "z" }));
    expect(posts).toHaveLength(1);
    stop();
  });

  test("with no accessors at all it listens, and forwards nothing", () => {
    // The defaults, exercised: no session, no table, design mode. A frame wired up wrong is inert
    // Rather than eager — it must never `preventDefault` a key on a guess.
    const posts: IframeToParent[] = [];
    const stop = startKeyForwarding({ post: (m: IframeToParent) => posts.push(m) } as never);
    const e = key({ ctrlKey: true, key: "z" });
    document.body.dispatchEvent(e);
    expect(posts).toEqual([]);
    expect(e.defaultPrevented).toBe(false);
    stop();
  });

  test("teardown removes the listener", () => {
    const posts: IframeToParent[] = [];
    const stop = startKeyForwarding(
      { post: (m: IframeToParent) => posts.push(m) } as never,
      document,
      () => false,
      () => t,
    );
    stop();
    document.body.dispatchEvent(key({ ctrlKey: true, key: "z" }));
    expect(posts).toEqual([]);
  });
});

// ─── The parity test ──────────────────────────────────────────────────────────

describe("the frame's table is the app's keymap", () => {
  /** The registry the app builds, as `appCommandSet()` projects it. */
  const registry = createCommandRegistry({ getContext: emptyContext, mac: false });
  registry.registerAll(appCommandSet());
  const chords = chordsInScopes(registry.keymap, FRAME_KEY_SCOPES);
  const live: ForwardTable = { chords, mac: false };

  test("the projection is non-empty and covers the three frame scopes", () => {
    // A projection that silently resolved to nothing would make every assertion below vacuous —
    // And would also make the canvas swallow nothing, which reads as "fine".
    expect(chords.length).toBeGreaterThan(20);
    expect(new Set(chords.map((c) => c.scope))).toEqual(new Set(["caret", "canvas", "global"]));
  });

  test("every chord the frame prevents is one the registry binds in a stack it is in", () => {
    /* The guard that makes the two authorities one. For each chord in the table, in each of the
       three frame states, the frame's answer must equal "some scope on this stack binds it". A
       list-based filter cannot satisfy this by construction; a resolver satisfies it by being the
       same question. */
    for (const entry of chords) {
      for (const [sessionLive, mode] of [
        [true, "edit"],
        [false, "design"],
        [false, "preview"],
      ] as const) {
        const stack = frameScopeStack(sessionLive, mode);
        const claimed = registry.keymap.resolveChord(entry.chord, stack) !== undefined;
        const event = eventFor(entry.chord);
        if (!event) {
          continue;
        }
        expect(
          shouldForwardKey(event, live, sessionLive, mode),
          `${entry.chord} (${entry.scope}) with sessionLive=${sessionLive} mode=${mode}`,
        ).toBe(claimed);
      }
    }
  });

  test("the four format verbs with chords are caret-scoped, so a sentence keeps its clipboard", () => {
    const caretChords = chords.filter((c) => c.scope === "caret").map((c) => c.chord);
    expect(caretChords).toContain("mod+b");
    expect(caretChords).toContain("mod+i");
    expect(caretChords).toContain("mod+u");
    expect(caretChords).toContain("mod+k");
    // …and the clipboard is NOT among them, which is what keeps ⌘C native mid-sentence.
    expect(caretChords).not.toContain("mod+c");
    expect(caretChords).not.toContain("mod+x");
    expect(caretChords).not.toContain("mod+v");
  });
});

/**
 * A KeyboardEvent that produces `chord` on a non-mac platform, or `null` for chords this helper
 * cannot synthesise (a named key with no single-character `key` value it can invert).
 */
function eventFor(chord: string): KeyboardEvent | null {
  const parts = chord.split("+");
  const base = parts.at(-1);
  if (base === undefined || base === "") {
    return null;
  }
  return key({
    altKey: parts.includes("alt"),
    ctrlKey: parts.includes("mod") || parts.includes("ctrl"),
    key: base,
    shiftKey: parts.includes("shift"),
  });
}
