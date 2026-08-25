/**
 * The user's keyboard layer — src/settings/preferences-keymap.ts.
 *
 * Two properties are worth defending here, and both are about what a rebinding must NOT do.
 *
 * It must not edit the registry: `specs/studio.md` §15 rule 2 makes the Keyboard sheet a projection
 * of the command records, and a rebinding that wrote into one would put the app's shortcut sheet
 * and `docs/studio/interface/shortcuts.md` back into the drift the projection exists to end. So
 * every assertion about a changed chord is paired with one about `declaredFor` still answering the
 * default.
 *
 * And it must not silently win or silently lose. A chord already claimed in the same scope is the
 * condition `keymap.add` THROWS on at registration; from a preferences sheet the same condition has
 * to come back as a refusal that names the command holding it.
 *
 * The same-scope case is the easy half. The one these tests exist for is the CROSS-scope theft: a
 * canvas command taking ⌘S does not share it with Save, it shadows Save for as long as the canvas
 * has focus, and a check that only looked in the rebound command's own scope let that through in
 * silence. The refusal must catch every scope that can be live at the same instant
 * (`keymap.overlappingScopes`) and no more — `caret` and `grid` never are, and forbidding them one
 * chord between them would forbid the shadowing ladder its whole purpose.
 */
import { clearSeededSettings, seedSettings } from "./harness";
import "./with-dom.js";
import { beforeEach, describe, expect, test } from "bun:test";
import {
  applyKeybindingOverrides,
  isBindableChord,
  KEYBINDINGS_STORAGE_KEY,
  loadKeybindingOverrides,
  rebindCommand,
  resetKeybinding,
} from "../src/settings/preferences-keymap";
import { createCommandRegistry } from "../src/commands/registry";
import { emptyContext } from "../src/commands/context";
import type { AnyCommand, CommandRegistry } from "../src/commands/registry";

const RECORDS: AnyCommand[] = [
  {
    id: "file.save",
    title: "Save",
    category: "File",
    level: "document",
    keybinding: "mod+s",
    run: () => {},
  },
  {
    id: "edit.redo",
    title: "Redo",
    category: "Edit",
    level: "document",
    keybinding: ["mod+shift+z", "mod+y"],
    run: () => {},
  },
  {
    id: "selection.delete",
    title: "Delete",
    category: "Selection",
    level: "selection",
    keyScope: "canvas",
    keybinding: "backspace",
    run: () => {},
  },
  // Three narrower scopes, because the interesting refusals are all cross-scope: `caret` and `grid`
  // Are never live together, and `palette` is never live with anything.
  {
    id: "caret.italic",
    title: "Italic",
    category: "Edit",
    level: "selection",
    keyScope: "caret",
    keybinding: "mod+i",
    run: () => {},
  },
  {
    id: "grid.fillDown",
    title: "Fill Down",
    category: "Edit",
    level: "document",
    keyScope: "grid",
    keybinding: "mod+alt+d",
    run: () => {},
  },
  {
    id: "palette.accept",
    title: "Accept",
    category: "View",
    level: "application",
    keyScope: "palette",
    keybinding: "mod+enter",
    run: () => {},
  },
];

function registry(): CommandRegistry {
  const built = createCommandRegistry({ getContext: emptyContext, mac: true });
  built.registerAll(RECORDS);
  return built;
}

function record(id: string): AnyCommand {
  return RECORDS.find((candidate) => candidate.id === id)!;
}

function stored(): unknown {
  const raw = localStorage.getItem(KEYBINDINGS_STORAGE_KEY);
  return raw === null ? null : JSON.parse(raw);
}

beforeEach(() => {
  /* The kernel owns these values now, so clearing its cache alone would leave the previous test's
     layer in memory. */
  clearSeededSettings();
  localStorage.clear();
});

describe("what may be bound", () => {
  test("a printable key needs a modifier — a bare one would fire while you type", () => {
    expect(isBindableChord("s")).toBe(false);
    expect(isBindableChord("4")).toBe(false);
    expect(isBindableChord(",")).toBe(false);
    // Shift alone is not a modifier for this purpose: ⇧A is how a capital A is typed.
    expect(isBindableChord("shift+s")).toBe(false);
    expect(isBindableChord("mod+s")).toBe(true);
    expect(isBindableChord("alt+s")).toBe(true);
    expect(isBindableChord("ctrl+s")).toBe(true);
  });

  test("keys that type nothing may stand alone", () => {
    for (const chord of ["escape", "f6", "f12", "arrowup", "backspace", "delete", "pageup"]) {
      expect(isBindableChord(chord)).toBe(true);
    }
    // " " is Space, which types something.
    expect(isBindableChord(" ")).toBe(false);
    expect(isBindableChord("f25")).toBe(false);
  });

  test("a string that is not a chord at all is refused rather than thrown at the caller", () => {
    expect(isBindableChord("mod")).toBe(false);
    expect(isBindableChord("")).toBe(false);
  });
});

describe("rebinding", () => {
  test("moves the live chord and leaves the declared one alone", () => {
    const app = registry();
    expect(rebindCommand(app, record("file.save"), "Mod+Alt+S")).toEqual({ ok: true });
    expect(app.keymap.bindingsFor("file.save")).toEqual(["mod+alt+s"]);
    expect(app.keymap.declaredFor("file.save")).toEqual(["mod+s"]);
    expect(app.keymap.resolveChord("mod+s", ["global"])).toBeUndefined();
    expect(stored()).toEqual({ "file.save": ["mod+alt+s"] });
  });

  test("every surface that prints a chord follows, because they all read the keymap", () => {
    const app = registry();
    expect(app.keymap.formatBinding("file.save")).toBe("⌘S");
    rebindCommand(app, record("file.save"), "mod+alt+s");
    // `formatBinding` is what the Command Bar, the block action bar, the status bar, the palette and
    // The context menus all print. One layer, and the whole app agrees with the sheet.
    expect(app.keymap.formatBinding("file.save")).toBe("⌘⌥S");
  });

  test("a chord held in the same scope is refused, naming the command that holds it", () => {
    const app = registry();
    const result = rebindCommand(app, record("file.save"), "mod+y");
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({
      reason: "⌘Y is already Redo.",
      conflict: { chord: "mod+y", commandId: "edit.redo", scope: "global", title: "Redo" },
    });
    // And nothing moved: a refusal is not a partial application.
    expect(app.keymap.bindingsFor("file.save")).toEqual(["mod+s"]);
    expect(app.keymap.bindingsFor("edit.redo")).toEqual(["mod+shift+z", "mod+y"]);
    expect(stored()).toBeNull();
  });

  test("two scopes that are never live together may hold one chord — that is the ladder", () => {
    const app = registry();
    // Italic-in-a-caret and Fill-Down-in-the-grid are never on one dispatch stack, so ⌘⌥D may mean
    // Both. This is the case a conflict check must NOT refuse.
    expect(rebindCommand(app, record("caret.italic"), "mod+alt+d")).toEqual({ ok: true });
    expect(app.keymap.resolveChord("mod+alt+d", ["caret", "global"])?.commandId).toBe(
      "caret.italic",
    );
    expect(app.keymap.resolveChord("mod+alt+d", ["grid", "global"])?.commandId).toBe(
      "grid.fillDown",
    );
  });

  test("a chord held in an OVERLAPPING scope is refused, naming the holder and where it is live", () => {
    const app = registry();
    // The defect this test exists for: `selection.delete` is canvas-scoped and Save is global, and
    // The canvas stack is ["canvas", "global"]. Checking only the canvas table saw nothing, the
    // Rebinding won, and ⌘S stopped saving whenever the canvas had focus — with no refusal, no
    // Warning and no row in the sheet saying so.
    const result = rebindCommand(app, record("selection.delete"), "mod+s");
    expect(result).toMatchObject({
      ok: false,
      reason: "⌘S is already Save, which is live everywhere.",
      conflict: { chord: "mod+s", commandId: "file.save", scope: "global", title: "Save" },
    });
    // Save still answers ⌘S on the canvas, and the refusal moved nothing.
    expect(app.keymap.resolveChord("mod+s", ["canvas", "global"])?.commandId).toBe("file.save");
    expect(app.keymap.bindingsFor("selection.delete")).toEqual(["backspace"]);
    expect(stored()).toBeNull();
  });

  test("and in the other direction, where it is the newcomer that would go quiet", () => {
    const app = registry();
    // A global command taking a chord the grid holds is not theft in the same direction — the grid
    // Keeps answering — but the binding the author just made is dead in the grid, which is just as
    // Unexplainable. One rule covers both: overlapping scopes cannot share a chord.
    expect(rebindCommand(app, record("file.save"), "mod+alt+d")).toMatchObject({
      ok: false,
      reason: "⌘⌥D is already Fill Down, which is live in the data grid.",
      conflict: { commandId: "grid.fillDown", scope: "grid", title: "Fill Down" },
    });
    expect(app.keymap.bindingsFor("file.save")).toEqual(["mod+s"]);
  });

  test("an overlay owns the keyboard outright, so a palette command may take a global chord", () => {
    const app = registry();
    expect(rebindCommand(app, record("palette.accept"), "mod+s")).toEqual({ ok: true });
    expect(app.keymap.resolveChord("mod+s", ["palette"])?.commandId).toBe("palette.accept");
    // While no overlay is up, nothing resolves in `palette` and Save is untouched.
    expect(app.keymap.resolveChord("mod+s", ["global"])?.commandId).toBe("file.save");
  });

  test("a bare printable key is refused with what to do about it", () => {
    const app = registry();
    const result = rebindCommand(app, record("file.save"), "k");
    expect(result).toEqual({
      ok: false,
      reason: "K would fire while you type. Add ⌘, Ctrl or Alt, or use a key that types nothing.",
    });
    expect(stored()).toBeNull();
  });

  test("a string that is not a chord is refused rather than stored", () => {
    const app = registry();
    expect(rebindCommand(app, record("file.save"), "mod+shift")).toEqual({
      ok: false,
      reason: "That is not a shortcut — hold a key as well as the modifiers.",
    });
    expect(stored()).toBeNull();
  });

  test("rebinding to its own declared chord clears the override instead of pinning it", () => {
    const app = registry();
    rebindCommand(app, record("file.save"), "mod+alt+s");
    expect(rebindCommand(app, record("file.save"), "Cmd+S")).toEqual({ ok: true });
    expect(app.keymap.overrides().size).toBe(0);
    expect(app.keymap.bindingsFor("file.save")).toEqual(["mod+s"]);
    // The store is emptied too, not left holding a redundant entry.
    expect(localStorage.getItem(KEYBINDINGS_STORAGE_KEY)).toBeNull();
  });

  test("a command with two chords keeps the one the author asked for, and Reset brings both back", () => {
    const app = registry();
    rebindCommand(app, record("edit.redo"), "mod+alt+y");
    expect(app.keymap.bindingsFor("edit.redo")).toEqual(["mod+alt+y"]);
    expect(resetKeybinding(app, "edit.redo")).toBe(true);
    expect(app.keymap.bindingsFor("edit.redo")).toEqual(["mod+shift+z", "mod+y"]);
    expect(localStorage.getItem(KEYBINDINGS_STORAGE_KEY)).toBeNull();
  });

  test("resetting a command nobody rebound says so rather than repainting over nothing", () => {
    const app = registry();
    expect(resetKeybinding(app, "file.save")).toBe(false);
  });

  test("one rebinding never disturbs another", () => {
    const app = registry();
    rebindCommand(app, record("file.save"), "mod+alt+s");
    rebindCommand(app, record("edit.redo"), "mod+alt+y");
    resetKeybinding(app, "file.save");
    expect(app.keymap.bindingsFor("file.save")).toEqual(["mod+s"]);
    expect(app.keymap.bindingsFor("edit.redo")).toEqual(["mod+alt+y"]);
    expect(stored()).toEqual({ "edit.redo": ["mod+alt+y"] });
  });

  test("a conflict whose holder is not a registered record still names something", () => {
    // Reachable when the layer moved a command onto a chord and that command was then removed from
    // The registry — the sheet must still be able to print a refusal.
    const app = registry();
    app.keymap.setOverrides(new Map([["ghost.gone", ["mod+g"]]]));
    app.keymap.add({ id: "ghost.gone", keybinding: "mod+g" });
    const result = rebindCommand(app, record("file.save"), "mod+g");
    expect(result).toMatchObject({ reason: "⌘G is already ghost.gone." });
  });
});

describe("the store", () => {
  test("survives a reload: what was written is what is applied", () => {
    const first = registry();
    rebindCommand(first, record("file.save"), "mod+alt+s");
    // A new window, a new registry, the same machine.
    const second = registry();
    expect(second.keymap.bindingsFor("file.save")).toEqual(["mod+s"]);
    applyKeybindingOverrides(second);
    expect(second.keymap.bindingsFor("file.save")).toEqual(["mod+alt+s"]);
    expect(second.keymap.resolveChord("mod+alt+s", ["global"])?.commandId).toBe("file.save");
  });

  test("applying before the rest of the bootstrap registers still binds the later records", () => {
    seedSettings({ [KEYBINDINGS_STORAGE_KEY]: JSON.stringify({ "file.save": ["mod+alt+s"] }) });
    const app = createCommandRegistry({ getContext: emptyContext, mac: true });
    applyKeybindingOverrides(app);
    app.registerAll(RECORDS);
    expect(app.keymap.bindingsFor("file.save")).toEqual(["mod+alt+s"]);
  });

  test("nothing stored is no layer, not a crash", () => {
    expect(loadKeybindingOverrides().size).toBe(0);
  });

  test("a corrupt or hostile store degrades to the defaults, entry by entry", () => {
    for (const raw of ["{not json", '"a string"', "[1,2,3]", "null"]) {
      seedSettings({ [KEYBINDINGS_STORAGE_KEY]: raw });
      expect(loadKeybindingOverrides().size).toBe(0);
    }
    seedSettings({
      [KEYBINDINGS_STORAGE_KEY]: JSON.stringify({
        "file.save": ["mod+alt+s"],
        "a.notAnArray": "mod+x",
        "a.notStrings": [7],
        "a.notAChord": ["mod+"],
      }),
    });
    // The one valid entry survives; the other three are dropped, and their commands keep the chord
    // They declared — the only failure mode that leaves the app usable.
    expect([...loadKeybindingOverrides()]).toEqual([["file.save", ["mod+alt+s"]]]);
  });

  test("storage that throws is a keyboard with no layer, not a keyboard that throws", () => {
    // Private-mode Safari throws from `getItem`/`setItem` rather than returning null. Every command
    // Keeps the chord it declared, and a rebinding is live in this window without being remembered.
    const real = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const hostile = {
      getItem: () => {
        throw new Error("storage is unavailable");
      },
      setItem: () => {
        throw new Error("storage is unavailable");
      },
      removeItem: () => {
        throw new Error("storage is unavailable");
      },
    };
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: hostile });
    try {
      expect(() => hostile.getItem()).toThrow();
      expect(loadKeybindingOverrides().size).toBe(0);
      const app = registry();
      expect(rebindCommand(app, record("file.save"), "mod+alt+s")).toEqual({ ok: true });
      expect(app.keymap.bindingsFor("file.save")).toEqual(["mod+alt+s"]);
      expect(resetKeybinding(app, "file.save")).toBe(true);
      expect(app.keymap.bindingsFor("file.save")).toEqual(["mod+s"]);
    } finally {
      Object.defineProperty(globalThis, "localStorage", real!);
    }
  });

  test("stored chords are canonicalised on the way in, however they were spelled", () => {
    seedSettings({
      [KEYBINDINGS_STORAGE_KEY]: JSON.stringify({ "file.save": ["Cmd + Shift + S"] }),
    });
    expect(loadKeybindingOverrides().get("file.save")).toEqual(["mod+shift+s"]);
  });
});
