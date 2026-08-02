/**
 * Chord normalisation, platform-correct formatting, scope-stack resolution, and the conflict that
 * must fail loudly at registration (UX-REDESIGN-PLAN §5.3).
 *
 * `mac` is injected everywhere so the assertions hold on any CI runner.
 */
import { describe, expect, test } from "bun:test";
import {
  chordFromEvent,
  createKeymap,
  formatChord,
  isMacPlatform,
  KeybindingConflictError,
  normalizeChord,
  parseChord,
  serializeChord,
} from "../src/commands/keymap";

/** A KeyboardEvent-shaped literal — the keymap only reads these five fields. */
function keyEvent(
  key: string,
  mods: { meta?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean } = {},
) {
  return {
    key,
    metaKey: mods.meta ?? false,
    ctrlKey: mods.ctrl ?? false,
    altKey: mods.alt ?? false,
    shiftKey: mods.shift ?? false,
  };
}

describe("chord normalisation", () => {
  test("every spelling of one chord collapses to one string", () => {
    for (const spelling of ["Cmd+Shift+P", "meta+shift+p", "MOD+SHIFT+P", "Command + Shift + P"]) {
      expect(normalizeChord(spelling)).toBe("mod+shift+p");
    }
  });

  test("modifiers are emitted in a fixed order regardless of how they were written", () => {
    expect(normalizeChord("shift+alt+ctrl+mod+k")).toBe("mod+ctrl+alt+shift+k");
  });

  test("normalisation is idempotent — the storage form parses back to itself", () => {
    expect(normalizeChord(normalizeChord("Opt+Cmd+ArrowUp"))).toBe("mod+alt+arrowup");
  });

  test("key aliases resolve", () => {
    expect(normalizeChord("up")).toBe("arrowup");
    expect(normalizeChord("Esc")).toBe("escape");
    expect(normalizeChord("mod+Space")).toBe("mod+ ");
    expect(normalizeChord("Del")).toBe("delete");
  });

  test("punctuation keys survive", () => {
    expect(normalizeChord("mod+\\")).toBe("mod+\\");
    expect(normalizeChord("mod+,")).toBe("mod+,");
    expect(normalizeChord("mod+.")).toBe("mod+.");
  });

  test("a literal + is a key, not a separator", () => {
    expect(normalizeChord("mod++")).toBe("mod++");
  });

  test("a modifier-only chord is rejected", () => {
    expect(() => parseChord("mod+shift")).toThrow(/has no key/);
    expect(() => parseChord("")).toThrow(/has no key/);
  });

  test("parse and serialize round-trip", () => {
    const parsed = parseChord("Ctrl+Alt+Delete");
    expect(parsed).toEqual({ mod: false, ctrl: true, alt: true, shift: false, key: "delete" });
    expect(serializeChord(parsed)).toBe("ctrl+alt+delete");
  });
});

describe("chordFromEvent", () => {
  test("mod is ⌘ on mac and Ctrl elsewhere", () => {
    expect(chordFromEvent(keyEvent("s", { meta: true }), true)).toBe("mod+s");
    expect(chordFromEvent(keyEvent("s", { ctrl: true }), false)).toBe("mod+s");
  });

  test("on mac, Ctrl is its own modifier and ⌘ is not implied", () => {
    expect(chordFromEvent(keyEvent("s", { ctrl: true }), true)).toBe("ctrl+s");
  });

  test("on Windows/Linux, Ctrl is mod and never also ctrl", () => {
    expect(chordFromEvent(keyEvent("s", { ctrl: true, meta: true }), false)).toBe("mod+s");
  });

  test("shift comes from the flag, not from the uppercased key", () => {
    // With ⇧ held `e.key` is "Z" for ⌘⇧Z — matching on the key alone is how redo drifts.
    expect(chordFromEvent(keyEvent("Z", { meta: true, shift: true }), true)).toBe("mod+shift+z");
  });

  test("named keys lowercase and alias", () => {
    expect(chordFromEvent(keyEvent("ArrowUp", { alt: true }), true)).toBe("alt+arrowup");
    expect(chordFromEvent(keyEvent("Escape"), true)).toBe("escape");
  });
});

describe("formatChord", () => {
  test("mac glyphs, no separators", () => {
    expect(formatChord("mod+shift+p", true)).toBe("⌘⇧P");
    expect(formatChord("mod+ctrl+alt+shift+k", true)).toBe("⌘⌃⌥⇧K");
  });

  test("Ctrl+… everywhere else — the thing toolbar.ts:301 gets wrong today", () => {
    expect(formatChord("mod+shift+p", false)).toBe("Ctrl+Shift+P");
    expect(formatChord("mod+p", false)).toBe("Ctrl+P");
  });

  test("named keys print their label, not their token", () => {
    expect(formatChord("alt+arrowup", true)).toBe("⌥↑");
    expect(formatChord("escape", false)).toBe("Esc");
    expect(formatChord("mod+ ", true)).toBe("⌘Space");
    expect(formatChord("delete", false)).toBe("Delete");
  });

  test("a bare punctuation key prints as itself", () => {
    expect(formatChord("mod+.", true)).toBe("⌘.");
  });
});

describe("isMacPlatform", () => {
  test("reads navigator.platform, then userAgent", () => {
    expect(isMacPlatform({ platform: "MacIntel" })).toBe(true);
    expect(isMacPlatform({ platform: "Win32" })).toBe(false);
    expect(isMacPlatform({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X)" })).toBe(true);
    expect(isMacPlatform({})).toBe(false);
  });

  test("defaults to the ambient navigator without throwing", () => {
    expect(typeof isMacPlatform()).toBe("boolean");
  });
});

describe("the index", () => {
  test("records without a binding are indexed but bind nothing", () => {
    const keymap = createKeymap({ mac: true });
    keymap.add({ id: "view.zen" });
    expect(keymap.bindingsFor("view.zen")).toEqual([]);
    expect(keymap.formatBinding("view.zen")).toBeUndefined();
    expect(keymap.entries()).toEqual([]);
  });

  test("a binding list is stored in declaration order and formatted from the first", () => {
    const keymap = createKeymap({ mac: true });
    keymap.add({ id: "edit.redo", keybinding: ["Mod+Shift+Z", "mod+y"] });
    expect(keymap.bindingsFor("edit.redo")).toEqual(["mod+shift+z", "mod+y"]);
    expect(keymap.formatBinding("edit.redo")).toBe("⌘⇧Z");
  });

  test("formatBinding follows the platform the keymap was built for", () => {
    const pc = createKeymap({ mac: false });
    pc.add({ id: "file.save", keybinding: "mod+s" });
    expect(pc.formatBinding("file.save")).toBe("Ctrl+S");
  });

  test("createKeymap with no options detects the platform instead of throwing", () => {
    const keymap = createKeymap();
    keymap.add({ id: "file.save", keybinding: "mod+s" });
    expect(keymap.formatBinding("file.save")).toMatch(/S$/);
  });

  test("remove drops every chord of an id", () => {
    const keymap = createKeymap({ mac: true });
    keymap.add({ id: "edit.redo", keybinding: ["mod+shift+z", "mod+y"] });
    keymap.remove("edit.redo");
    expect(keymap.bindingsFor("edit.redo")).toEqual([]);
    expect(keymap.resolveChord("mod+y", ["global"])).toBeUndefined();
    // And the chord is claimable again.
    keymap.add({ id: "edit.repeat", keybinding: "mod+y" });
    expect(keymap.resolveChord("mod+y", ["global"])?.commandId).toBe("edit.repeat");
  });

  test("entries lists every (scope, chord, id) triple for the generated sheet", () => {
    const keymap = createKeymap({ mac: true });
    keymap.add({ id: "file.save", keybinding: "mod+s" });
    keymap.add({ id: "selection.duplicate", keybinding: "mod+d", keyScope: "canvas" });
    expect(keymap.entries().toSorted((a, b) => a.chord.localeCompare(b.chord))).toEqual([
      { chord: "mod+d", commandId: "selection.duplicate", scope: "canvas" },
      { chord: "mod+s", commandId: "file.save", scope: "global" },
    ]);
  });
});

describe("conflicts", () => {
  test("two commands claiming one chord in one scope throws, naming both", () => {
    const keymap = createKeymap({ mac: true });
    keymap.add({ id: "document.close", keybinding: "mod+w" });
    let thrown: unknown;
    try {
      keymap.add({ id: "window.close", keybinding: "Cmd+W" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(KeybindingConflictError);
    const conflict = thrown as KeybindingConflictError;
    expect(conflict.chord).toBe("mod+w");
    expect(conflict.scope).toBe("global");
    expect(conflict.existingId).toBe("document.close");
    expect(conflict.incomingId).toBe("window.close");
    expect(conflict.message).toContain('already bound to "document.close"');
  });

  test("a rejected record leaves nothing behind", () => {
    const keymap = createKeymap({ mac: true });
    keymap.add({ id: "document.close", keybinding: "mod+w" });
    expect(() => keymap.add({ id: "window.close", keybinding: ["mod+q", "mod+w"] })).toThrow(
      KeybindingConflictError,
    );
    // Mod+q was listed BEFORE the conflicting chord and must not have been claimed.
    expect(keymap.resolveChord("mod+q", ["global"])).toBeUndefined();
    expect(keymap.bindingsFor("window.close")).toEqual([]);
  });

  test("the same chord in a different scope is not a conflict — that is the shadowing rule", () => {
    const keymap = createKeymap({ mac: true });
    keymap.add({ id: "selection.delete", keybinding: "backspace", keyScope: "canvas" });
    expect(() =>
      keymap.add({ id: "grid.deleteRow", keybinding: "backspace", keyScope: "grid" }),
    ).not.toThrow();
  });

  test("re-adding the same id to the same chord is idempotent", () => {
    const keymap = createKeymap({ mac: true });
    keymap.add({ id: "file.save", keybinding: "mod+s" });
    expect(() => keymap.add({ id: "file.save", keybinding: "mod+s" })).not.toThrow();
  });
});

describe("resolution through the scope stack", () => {
  const build = () => {
    const keymap = createKeymap({ mac: true });
    keymap.add({ id: "file.save", keybinding: "mod+s" });
    keymap.add({ id: "selection.delete", keybinding: "backspace", keyScope: "canvas" });
    keymap.add({ id: "caret.deleteChar", keybinding: "backspace", keyScope: "caret" });
    keymap.add({ id: "grid.clearCell", keybinding: "backspace", keyScope: "grid" });
    return keymap;
  };

  test("the narrowest scope in the stack wins", () => {
    const keymap = build();
    // The stack IS the precedence order: caret > engine > dock > global.
    expect(keymap.resolveChord("backspace", ["caret", "canvas", "global"])?.commandId).toBe(
      "caret.deleteChar",
    );
    expect(keymap.resolveChord("backspace", ["canvas", "global"])?.commandId).toBe(
      "selection.delete",
    );
    expect(keymap.resolveChord("backspace", ["grid", "global"])?.commandId).toBe("grid.clearCell");
  });

  test("a chord bound only globally still resolves from a narrow stack", () => {
    const keymap = build();
    const match = keymap.resolveChord("mod+s", ["caret", "canvas", "global"]);
    expect(match).toEqual({ chord: "mod+s", commandId: "file.save", scope: "global" });
  });

  test("a scope outside the stack does not resolve", () => {
    // This is what makes ⌘C stop being stolen from a writer: the caret stack simply omits canvas.
    expect(build().resolveChord("backspace", ["caret"])?.commandId).toBe("caret.deleteChar");
    expect(build().resolveChord("backspace", ["global"])).toBeUndefined();
  });

  test("an unbound chord resolves to nothing", () => {
    expect(build().resolveChord("mod+shift+f9", ["canvas", "global"])).toBeUndefined();
  });

  test("resolveEvent normalises the event through the same path", () => {
    const keymap = build();
    expect(keymap.resolveEvent(keyEvent("s", { meta: true }), ["canvas", "global"])).toEqual({
      chord: "mod+s",
      commandId: "file.save",
      scope: "global",
    });
    // On a mac keymap a raw Ctrl+S is a different chord and must not fire Save.
    expect(keymap.resolveEvent(keyEvent("s", { ctrl: true }), ["global"])).toBeUndefined();
  });
});
