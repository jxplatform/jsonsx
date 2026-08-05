/**
 * The registry, projected into the two generated documentation pages (plan §12 P3).
 *
 * The properties worth defending are DETERMINISM and TOTALITY: a generated page that reorders
 * itself between runs is a CI diff nobody can review, and a page that quietly omits a command is
 * the drift the generation exists to end. Both are asserted against the real `appCommandSet()`, not
 * against a fixture, because the point of the projection is that it covers whatever the app holds.
 */
import { describe, expect, test } from "bun:test";
import {
  commandReference,
  commandsMarkdown,
  SCOPE_LABELS,
  shortcutReference,
  shortcutsMarkdown,
} from "../src/commands/reference";
import { appCommandSet } from "../src/commands/app-commands";
import { KEY_SCOPES } from "../src/commands/levels";
import type { AnyCommand } from "../src/commands/registry";

const FIXTURE: AnyCommand[] = [
  {
    id: "edit.redo",
    title: "Redo",
    category: "Edit",
    level: "document",
    keybinding: ["mod+shift+z", "mod+y"],
    requires: "a change to redo",
    run: () => {},
  },
  {
    id: "selection.delete",
    title: "Delete | Remove",
    category: "Selection",
    level: "selection",
    keyScope: "canvas",
    keybinding: "delete",
    destructive: true,
    menus: ["blockbar", "palette"],
    aiTool: { name: "delete_node", description: "…" },
    run: () => {},
  },
  {
    id: "view.zen",
    title: "Zen Mode",
    category: "View",
    level: "application",
    run: () => {},
  },
];

describe("commandReference", () => {
  test("every command becomes exactly one row, with both platforms' chords", () => {
    const rows = commandReference(FIXTURE);
    expect(rows).toHaveLength(3);
    const redo = rows.find((row) => row.id === "edit.redo")!;
    expect(redo.chords).toEqual(["mod+shift+z", "mod+y"]);
    expect(redo.mac).toEqual(["⌘⇧Z", "⌘Y"]);
    expect(redo.pc).toEqual(["Ctrl+Shift+Z", "Ctrl+Y"]);
    expect(redo.requires).toBe("a change to redo");
  });

  test("an undeclared `menus` reads as the palette default, and flags carry through", () => {
    const rows = commandReference(FIXTURE);
    expect(rows.find((row) => row.id === "view.zen")!.menus).toEqual(["palette"]);
    expect(rows.find((row) => row.id === "view.zen")!.aiTool).toBe("");
    const remove = rows.find((row) => row.id === "selection.delete")!;
    expect(remove.menus).toEqual(["blockbar", "palette"]);
    expect(remove.destructive).toBe(true);
    expect(remove.aiTool).toBe("delete_node");
  });

  test("rows sort by category order then title, not alphabetically by category", () => {
    // `levels.ts` declares categories in TASK order (File, Edit, Selection, …), which is the order
    // The palette groups by; a reader who learned the app there finds the page laid out the same.
    expect(commandReference(FIXTURE).map((row) => row.category)).toEqual([
      "Edit",
      "Selection",
      "View",
    ]);
  });

  test("the projection is total over the running app's set, and stable across calls", () => {
    const app = appCommandSet();
    const first = commandReference(app);
    expect(first).toHaveLength(app.length);
    expect(new Set(first.map((row) => row.id)).size).toBe(app.length);
    expect(commandReference(app)).toEqual(first);
  });
});

describe("shortcutReference", () => {
  test("one row per CHORD, not per command", () => {
    const rows = shortcutReference(FIXTURE);
    // Redo declares two chords; a reader looking up ⌘Y has to find it.
    expect(rows.filter((row) => row.commandId === "edit.redo")).toHaveLength(2);
    // Zen declares none and therefore has no row on the keyboard sheet.
    expect(rows.some((row) => row.commandId === "view.zen")).toBe(false);
  });

  test("the scope is carried through, and every scope has a human label", () => {
    const rows = shortcutReference(FIXTURE);
    expect(rows.find((row) => row.commandId === "selection.delete")!.scope).toBe("canvas");
    expect(rows.find((row) => row.commandId === "edit.redo")!.scope).toBe("global");
    for (const scope of KEY_SCOPES) {
      expect(SCOPE_LABELS[scope]).toBeTruthy();
    }
  });

  test("sorted by scope then chord, so the sheet reads as 'what this key does, and where'", () => {
    const rows = shortcutReference(FIXTURE);
    expect(rows.map((row) => `${row.scope}:${row.chord}`)).toEqual([
      "canvas:delete",
      "global:mod+shift+z",
      "global:mod+y",
    ]);
  });

  test("stable across calls over the running app's set", () => {
    const app = appCommandSet();
    expect(shortcutReference(app)).toEqual(shortcutReference(app));
  });

  test("with no user layer every row is a default — which is what the docs page prints", () => {
    expect(shortcutReference(FIXTURE).every((row) => row.overridden)).toBe(false);
    expect(shortcutReference(appCommandSet()).some((row) => row.overridden)).toBe(false);
  });

  test("a user layer is projected by the SAME function, so the sheet cannot drift", () => {
    const rows = shortcutReference(FIXTURE, new Map([["edit.redo", ["Mod+Alt+Y"]]]));
    const redo = rows.filter((row) => row.commandId === "edit.redo");
    // Two declared chords collapse to the one the author asked for, canonicalised and marked.
    expect(redo).toHaveLength(1);
    expect(redo[0]!.chord).toBe("mod+alt+y");
    expect(redo[0]!.mac).toBe("\u2318\u2325Y");
    expect(redo[0]!.pc).toBe("Ctrl+Alt+Y");
    expect(redo[0]!.overridden).toBe(true);
    // An untouched command is untouched, and still says so.
    expect(rows.find((row) => row.commandId === "selection.delete")!.overridden).toBe(false);
  });

  test("an unbound command has no row, exactly like one that never declared a chord", () => {
    const rows = shortcutReference(FIXTURE, new Map([["edit.redo", []]]));
    expect(rows.some((row) => row.commandId === "edit.redo")).toBe(false);
  });

  test("a layer naming a command the registry does not have changes nothing", () => {
    const rows = shortcutReference(FIXTURE, new Map([["ghost.gone", ["mod+g"]]]));
    expect(rows).toEqual(shortcutReference(FIXTURE));
  });
});

describe("the generated markdown", () => {
  test("the shortcut sheet is one section per scope, both platforms side by side", () => {
    const markdown = shortcutsMarkdown(shortcutReference(FIXTURE));
    expect(markdown).toContain("## Canvas selection");
    expect(markdown).toContain("## Anywhere");
    expect(markdown).toContain("| macOS | Windows / Linux | Command | Id |");
    expect(markdown).toContain("| `⌘⇧Z` | `Ctrl+Shift+Z` | Redo | `edit.redo` |");
  });

  test("the command page is one section per category, with an em dash for the absent", () => {
    const markdown = commandsMarkdown(commandReference(FIXTURE));
    expect(markdown).toContain("## View");
    expect(markdown).toContain("| Zen Mode | `view.zen` | — | application | — |");
    expect(markdown).toContain(
      "| Redo | `edit.redo` | `⌘⇧Z` or `⌘Y` | document | a change to redo |",
    );
  });

  test("a pipe in a title cannot break out of its cell", () => {
    const markdown = commandsMarkdown(commandReference(FIXTURE));
    expect(markdown).toContain(String.raw`Delete \| Remove (destructive)`);
  });

  test("both pages render for the running app's whole set without throwing", () => {
    const app = appCommandSet();
    expect(commandsMarkdown(commandReference(app)).length).toBeGreaterThan(0);
    expect(shortcutsMarkdown(shortcutReference(app)).length).toBeGreaterThan(0);
  });
});
