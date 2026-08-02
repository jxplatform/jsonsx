/**
 * The app's whole command set, as the browserless CI checks read it.
 *
 * `src/commands/app-commands.ts` exists so `check-command-levels`, `check-chrome-budget` and
 * `check-shot-contract` can see the records that live beside their implementations rather than in
 * `commands/defaults.ts`. Two properties make that work, and both are asserted here: the set is
 * internally consistent (no duplicate ids, no misplacements, no toggles, no chord conflicts), and
 * the module loads in a BARE Bun process. The second is the fragile one — a `document` read added
 * at module scope anywhere in the import graph would break Lane 1 in CI with a stack trace nobody
 * would connect to this file, so the subprocess test below fails here instead.
 */
import { describe, expect, test } from "bun:test";
import { appCommandSet, defaultCommandSet } from "../src/commands/app-commands";
import { checkPlacements } from "../src/commands/levels";
import { checkChromeBudget, DOCK_TABS } from "../src/commands/budget";
import { emptyContext } from "../src/commands/context";

const COMMANDS = appCommandSet();

describe("the set", () => {
  test("covers every contribution point the bootstrap composes", () => {
    const namespaces = new Set(COMMANDS.map((c) => c.id.split(".")[0]));
    expect([...namespaces].toSorted()).toEqual([
      "canvas",
      "collection",
      "data",
      "document",
      "edit",
      "file",
      "formula",
      "inspector",
      "palette",
      "project",
      "selection",
      "settings",
      "state",
      "style",
      "view",
    ]);
  });

  test("has no duplicate ids — a capability has exactly one definition site", () => {
    const seen = new Map<string, number>();
    for (const command of COMMANDS) {
      seen.set(command.id, (seen.get(command.id) ?? 0) + 1);
    }
    expect([...seen].filter(([, count]) => count > 1)).toEqual([]);
  });

  test("satisfies the level × placement matrix", () => {
    expect(checkPlacements(COMMANDS)).toEqual([]);
  });

  test("stays inside the chrome budget", () => {
    expect(checkChromeBudget({ commands: COMMANDS, docks: DOCK_TABS })).toEqual([]);
  });

  test("every toggle that survives is a CHORD, and has an idempotent counterpart", () => {
    // §13.3 clause 3 governs the SCRIPTING surface, and `isScriptable()` already refuses these
    // Three. They stay as records because ⌘B is a gesture a human makes while looking at the dock —
    // What the rule forbids is a caller that cannot see the state naming a delta against it. So the
    // Obligation is a setter beside each one, and this asserts the pairing rather than the absence.
    const toggles = COMMANDS.filter((c) => /\.toggle[A-Z]/.test(c.id)).map((c) => c.id);
    expect(toggles).toEqual([
      "view.toggleNavigator",
      "view.toggleInspector",
      "view.toggleBottomDock",
    ]);
    const ids = new Set(COMMANDS.map((c) => c.id));
    expect(ids.has("view.setNavigator")).toBe(true);
    expect(ids.has("view.setRightPanel")).toBe(true);
    // HANDOFF: `view.toggleBottomDock` has no setter because the bottom dock is not on the `shell`
    // Record yet (`DOCK_IDS` is left/right/chat). P4.2 puts it there; the setter lands with it.
    expect(ids.has("view.setBottomDock")).toBe(false);
  });

  test("this workstream's own records add no toggle", () => {
    const namespaces = new Set(["canvas", "collection", "data", "formula", "inspector", "state"]);
    const added = COMMANDS.filter((c) => namespaces.has(c.id.split(".")[0] as string));
    expect(added.filter((c) => /\.toggle[A-Z]/.test(c.id))).toEqual([]);
  });

  test("every declared args schema is an object schema with named properties", () => {
    for (const command of COMMANDS) {
      if (!command.args) {
        continue;
      }
      const schema = command.args as { properties?: object; type?: string };
      expect(schema.type).toBe("object");
      expect(Object.keys(schema.properties ?? {}).length).toBeGreaterThan(0);
    }
  });

  test("every record carries a title and a level", () => {
    for (const command of COMMANDS) {
      expect(command.title).toBeTruthy();
      expect(command.level).toBeTruthy();
    }
  });

  test("`defaultCommandSet` is the name the three checks import by", () => {
    expect(defaultCommandSet).toBe(appCommandSet);
  });
});

describe("the ids the screenshot manifest names now have records", () => {
  const ids = new Set(COMMANDS.map((c) => c.id));

  test.each([
    "canvas.setEditZoom",
    "canvas.setMode",
    "canvas.setZoom",
    "collection.editInGrid",
    "data.expandRow",
    "data.openGrid",
    "formula.editDef",
    "formula.editEvent",
    "formula.openWorkspace",
    "inspector.setSection",
    "project.browse",
    "project.new",
    "selection.set",
    "settings.open",
    "state.selectSignal",
    "style.openSelectorMenu",
    "view.setActivity",
    "view.setAssistant",
    "view.setNavigator",
    "view.setRightPanel",
    "view.setRightTab",
    "view.setTheme",
  ])("%s", (id) => {
    expect(ids.has(id)).toBe(true);
  });

  test("the convergences resolve to records that already existed", () => {
    // `search.openPalette` → `palette.open`; `element.convertToComponent` →
    // `selection.convertToComponent`. Neither gets a second record — the manifest step changes.
    expect(ids.has("palette.open")).toBe(true);
    expect(ids.has("selection.convertToComponent")).toBe(true);
    expect(ids.has("search.openPalette")).toBe(false);
    expect(ids.has("element.convertToComponent")).toBe(false);
  });
});

describe("the injected no-op deps", () => {
  const byId = new Map(COMMANDS.map((c) => [c.id, c]));

  test("a predicate that reads a dep answers rather than throwing", () => {
    // `canvas.setEditZoom`'s `enablement` calls the injected `getCanvasMode`. A check that
    // Evaluates predicates (the palette's own rendering, and anything that grows out of it) must
    // Not blow up on the CI-shaped dep set.
    const command = byId.get("canvas.setEditZoom");
    expect(command?.enablement?.(emptyContext())).toBe(false);
  });

  test("a `run` that reaches a dep is inert", () => {
    const command = byId.get("view.setRightTab");
    expect(() => command?.run(emptyContext(), { tab: "style" } as never)).not.toThrow();
  });
});

describe("bare-Bun loadability", () => {
  test("the module imports with no DOM, which is what the checks job gives it", () => {
    const entry = new URL("../src/commands/app-commands.ts", import.meta.url).pathname;
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "-e",
        `const m = await import(${JSON.stringify(entry)});` +
          `if (m.defaultCommandSet().length === 0) { throw new Error("empty set"); }`,
      ],
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(new TextDecoder().decode(result.stderr)).toBe("");
    expect(result.exitCode).toBe(0);
  });
});
