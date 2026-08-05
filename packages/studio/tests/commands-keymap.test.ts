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
  overlappingScopes,
  parseChord,
  serializeChord,
} from "../src/commands/keymap";
import { keyScopeStack, makeContext } from "../src/commands/context";
import { KEY_SCOPES } from "../src/commands/levels";
import type { KeyScope } from "../src/commands/levels";

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

/**
 * `overlappingScopes` is the second half of the shadowing rule, and it exists because the rebinding
 * sheet has to ask a question dispatch never asks: not "who answers this chord HERE", but "who
 * could be made to stop answering it anywhere". Getting it wrong in either direction is a real
 * defect — too narrow and a rebinding steals ⌘S from Save the moment the canvas has focus; too wide
 * and Bold and Fill Down can never share ⌘B though they are never live in the same breath.
 *
 * So the table is asserted BOTH ways against the stacks `keyScopeStack` actually returns. It is the
 * only thing keeping two definition sites — the ladder in `context.ts` and this projection of it —
 * from drifting the way the app's two ⌘W handlers once did.
 */
describe("which scopes can be live at once", () => {
  /** Every stack the dispatcher can be in, taken from the function that chooses them. */
  const STACKS: readonly (readonly KeyScope[])[] = [
    keyScopeStack(makeContext({ modal: { open: true } })),
    keyScopeStack(makeContext({ caret: { active: true } })),
    keyScopeStack(makeContext({ focus: { region: "navigator" } })),
    keyScopeStack(makeContext({ editor: { kind: "grid" } })),
    keyScopeStack(makeContext({ editor: { kind: "code" } })),
    keyScopeStack(makeContext({ editor: { kind: "canvas" } })),
    keyScopeStack(makeContext({ editor: { kind: "canvas" }, canvas: { view: "preview" } })),
    keyScopeStack(makeContext()),
  ];

  test("every scope the app declares is reachable from some stack", () => {
    // A scope no stack contains would be a keyboard scope nothing can ever dispatch in — and this
    // Table would be describing a fiction.
    for (const scope of KEY_SCOPES) {
      expect(STACKS.some((stack) => stack.includes(scope))).toBe(true);
    }
  });

  test("a scope overlaps itself, and the relation is symmetric", () => {
    for (const scope of KEY_SCOPES) {
      expect(overlappingScopes(scope)).toContain(scope);
      for (const other of overlappingScopes(scope)) {
        expect(overlappingScopes(other)).toContain(scope);
      }
    }
  });

  test("everything that shares a stack is reported as overlapping", () => {
    for (const stack of STACKS) {
      for (const a of stack) {
        for (const b of stack) {
          expect(overlappingScopes(a)).toContain(b);
        }
      }
    }
  });

  test("nothing is reported as overlapping that no stack puts together", () => {
    for (const a of KEY_SCOPES) {
      for (const b of overlappingScopes(a)) {
        expect(STACKS.some((stack) => stack.includes(a) && stack.includes(b))).toBe(true);
      }
    }
  });

  test("global overlaps every engine scope, and the engines overlap only global", () => {
    expect(overlappingScopes("global")).toEqual([
      "global",
      "canvas",
      "caret",
      "grid",
      "code",
      "dock",
    ]);
    expect(overlappingScopes("caret")).toEqual(["caret", "global"]);
    expect(overlappingScopes("grid")).toEqual(["grid", "global"]);
    // Named first, so `resolveChord` over the list reports the most direct holder.
    expect(overlappingScopes("canvas")[0]).toBe("canvas");
  });

  test("an overlay owns the keyboard outright, so palette overlaps nothing else", () => {
    expect(overlappingScopes("palette")).toEqual(["palette"]);
    expect(overlappingScopes("global")).not.toContain("palette");
  });
});

describe("the digit row, and the platform decision made once", () => {
  test("⌘⇧2 resolves by physical key, whatever glyph the layout produces", () => {
    // With ⇧ held, `key` is "@" on US, '"' on UK and "é" on FR. A chord table spelling
    // `mod+shift+2` would fire on none of them; `code` is "Digit2" on all three.
    const keymap = createKeymap({ mac: true });
    keymap.add({ id: "inspector.focus.style", keybinding: "mod+shift+2" });
    for (const glyph of ["@", '"', "é"]) {
      expect(
        keymap.resolveEvent({ ...keyEvent(glyph, { meta: true, shift: true }), code: "Digit2" }, [
          "global",
        ])?.commandId,
      ).toBe("inspector.focus.style");
    }
  });

  test("an unshifted digit resolves the same way with or without a code", () => {
    const keymap = createKeymap({ mac: true });
    keymap.add({ id: "panel.focus.files", keybinding: "mod+1" });
    expect(keymap.resolveEvent(keyEvent("1", { meta: true }), ["global"])?.commandId).toBe(
      "panel.focus.files",
    );
    expect(
      keymap.resolveEvent({ ...keyEvent("1", { meta: true }), code: "Digit1" }, ["global"])
        ?.commandId,
    ).toBe("panel.focus.files");
  });

  test("a non-digit code is ignored, so letters still resolve by key", () => {
    const keymap = createKeymap({ mac: true });
    keymap.add({ id: "file.save", keybinding: "mod+s" });
    expect(
      keymap.resolveEvent({ ...keyEvent("s", { meta: true }), code: "KeyS" }, ["global"])
        ?.commandId,
    ).toBe("file.save");
  });

  test("the keymap exposes its platform decision, and formats an arbitrary chord with it", () => {
    // ONE function styles a chord. Every surface that prints one asks here rather than re-detecting
    // — which is what killed the hardcoded ⌘P the old toolbar showed Windows and Linux users.
    const macKeymap = createKeymap({ mac: true });
    expect(macKeymap.mac).toBe(true);
    expect(macKeymap.format("mod+shift+p")).toBe("⌘⇧P");
    const pcKeymap = createKeymap({ mac: false });
    expect(pcKeymap.mac).toBe(false);
    expect(pcKeymap.format("mod+shift+p")).toBe("Ctrl+Shift+P");
    expect(pcKeymap.format("f6")).toBe("F6");
  });
});

describe("the user's layer", () => {
  /** Two commands, one of them the one an author would want to move. */
  const bound = () => {
    const keymap = createKeymap({ mac: true });
    keymap.add({ id: "file.save", keybinding: "mod+s" });
    keymap.add({ id: "edit.redo", keybinding: ["mod+shift+z", "mod+y"] });
    return keymap;
  };

  test("an override replaces the declared chord without editing what was declared", () => {
    const keymap = bound();
    keymap.setOverrides(new Map([["file.save", ["Mod+Alt+S"]]]));
    // What is LIVE is the author's…
    expect(keymap.bindingsFor("file.save")).toEqual(["mod+alt+s"]);
    expect(keymap.formatBinding("file.save")).toBe("⌘⌥S");
    expect(keymap.resolveChord("mod+alt+s", ["global"])?.commandId).toBe("file.save");
    // …and the old chord stops resolving, because nothing holds it any more.
    expect(keymap.resolveChord("mod+s", ["global"])).toBeUndefined();
    // …while the registry's own record of the default is untouched, which is what a reset restores.
    expect(keymap.declaredFor("file.save")).toEqual(["mod+s"]);
  });

  test("dropping the entry restores the default — a reset is a removal, not a remembered value", () => {
    const keymap = bound();
    keymap.setOverrides(new Map([["file.save", ["mod+alt+s"]]]));
    keymap.setOverrides(new Map());
    expect(keymap.bindingsFor("file.save")).toEqual(["mod+s"]);
    expect(keymap.resolveChord("mod+s", ["global"])?.commandId).toBe("file.save");
    expect(keymap.overrides().size).toBe(0);
  });

  test("an entry with no chords is a command the author unbound", () => {
    const keymap = bound();
    keymap.setOverrides(new Map([["file.save", []]]));
    expect(keymap.bindingsFor("file.save")).toEqual([]);
    expect(keymap.formatBinding("file.save")).toBeUndefined();
    expect(keymap.resolveChord("mod+s", ["global"])).toBeUndefined();
    // And the chord is free for someone else to take.
    keymap.setOverrides(
      new Map([
        ["file.save", []],
        ["edit.redo", ["mod+s"]],
      ]),
    );
    expect(keymap.resolveChord("mod+s", ["global"])?.commandId).toBe("edit.redo");
  });

  test("an override evicts a default that already held the chord, whichever order they arrive", () => {
    const first = bound();
    first.setOverrides(new Map([["edit.redo", ["mod+s"]]]));
    expect(first.resolveChord("mod+s", ["global"])?.commandId).toBe("edit.redo");
    expect(first.bindingsFor("file.save")).toEqual([]);
    // The same outcome when the displaced command is registered AFTER the layer is applied — which
    // Is the order the bootstrap uses, and the reason the layer lives in the keymap.
    const second = createKeymap({ mac: true });
    second.setOverrides(new Map([["edit.redo", ["mod+s"]]]));
    second.add({ id: "edit.redo", keybinding: "mod+y" });
    expect(() => second.add({ id: "file.save", keybinding: "mod+s" })).not.toThrow();
    expect(second.resolveChord("mod+s", ["global"])?.commandId).toBe("edit.redo");
    expect(second.bindingsFor("file.save")).toEqual([]);
    // The displaced command still knows what it declared, so the sheet can say what it lost.
    expect(second.declaredFor("file.save")).toEqual(["mod+s"]);
  });

  test("a stale override cannot brick the bootstrap the way a default conflict must", () => {
    // Two DEFAULTS on one chord is a bug in the app and still throws at registration…
    const keymap = createKeymap({ mac: true });
    keymap.setOverrides(new Map([["view.zen", ["mod+alt+z"]]]));
    keymap.add({ id: "document.close", keybinding: "mod+w" });
    expect(() => keymap.add({ id: "window.close", keybinding: "mod+w" })).toThrow(
      KeybindingConflictError,
    );
    // …and the rejected record leaves nothing behind, override layer or not.
    expect(keymap.declaredFor("window.close")).toEqual([]);
  });

  test("the same chord in another scope is still not a conflict, override or not", () => {
    const keymap = createKeymap({ mac: true });
    keymap.add({ id: "selection.delete", keybinding: "backspace", keyScope: "canvas" });
    keymap.add({ id: "grid.clearCell", keybinding: "backspace", keyScope: "grid" });
    keymap.setOverrides(new Map([["selection.delete", ["mod+backspace"]]]));
    expect(keymap.resolveChord("backspace", ["grid"])?.commandId).toBe("grid.clearCell");
    expect(keymap.resolveChord("backspace", ["canvas"])).toBeUndefined();
  });

  test("removing a record hands its chord back to whatever it was displacing", () => {
    const keymap = bound();
    keymap.setOverrides(new Map([["edit.redo", ["mod+s"]]]));
    expect(keymap.bindingsFor("file.save")).toEqual([]);
    keymap.remove("edit.redo");
    expect(keymap.resolveChord("mod+s", ["global"])?.commandId).toBe("file.save");
    expect(keymap.declaredFor("edit.redo")).toEqual([]);
  });

  test("the layer is a copy in both directions — nobody edits it by holding a reference", () => {
    const keymap = bound();
    const applied = new Map([["file.save", ["mod+alt+s"]]]);
    keymap.setOverrides(applied);
    applied.set("edit.redo", ["mod+alt+y"]);
    expect(keymap.overrides().has("edit.redo")).toBe(false);
    (keymap.overrides() as Map<string, readonly string[]>).delete("file.save");
    expect(keymap.overrides().get("file.save")).toEqual(["mod+alt+s"]);
  });

  test("entries() reports what is LIVE, which is what the generated sheet must print", () => {
    const keymap = bound();
    keymap.setOverrides(new Map([["file.save", ["mod+alt+s"]]]));
    expect(keymap.entries().toSorted((a, b) => a.chord.localeCompare(b.chord))).toEqual([
      { chord: "mod+alt+s", commandId: "file.save", scope: "global" },
      { chord: "mod+shift+z", commandId: "edit.redo", scope: "global" },
      { chord: "mod+y", commandId: "edit.redo", scope: "global" },
    ]);
  });
});
