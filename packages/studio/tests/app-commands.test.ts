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
import { checkChromeBudget, dockTabs } from "../src/commands/budget";
import { railDeclarations } from "../src/panels/panel-registry";
import { emptyContext } from "../src/commands/context";

const COMMANDS = appCommandSet();

describe("the set", () => {
  test("covers every contribution point the bootstrap composes", () => {
    const namespaces = new Set(COMMANDS.map((c) => c.id.split(".")[0]));
    expect([...namespaces].toSorted()).toEqual([
      // `app.preferences` — ⌘, the application-preferences sheet (Appearance · Assistant ·
      // Accounts · Keyboard). Application configuration, as distinct from `settings.*`, which
      // Configures a project.
      "app",
      "canvas",
      "collab",
      "collection",
      "data",
      "document",
      "edit",
      "file",
      "formula",
      "help",
      // `insert.data` — a `${…}` merge tag placed at the live caret. Its one definition site is
      // `canvas/canvas-render.ts`, beside `selection.set`: both name what the pane points at.
      "insert",
      "inspector",
      "palette",
      // `pane.toggleZoom` — the pane model (a parallel workstream).
      "pane",
      // One `panel.focus.<id>` per Navigator panel, generated from the panel registry's own roster.
      "panel",
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
    // The rail rows are OBSERVED from the panel registry, which `appCommandSet()` has already
    // Populated by generating the ⌘1–8 records from it.
    const docks = dockTabs(railDeclarations());
    expect(checkChromeBudget({ commands: COMMANDS, docks })).toEqual([]);
  });

  test("every toggle that survives is a CHORD, and has an idempotent counterpart", () => {
    // §13.3 clause 3 governs the SCRIPTING surface, and `isScriptable()` already refuses these
    // Three. They stay as records because ⌘B is a gesture a human makes while looking at the dock —
    // What the rule forbids is a caller that cannot see the state naming a delta against it. So the
    // Obligation is a setter beside each one, and this asserts the pairing rather than the absence.
    const toggles = COMMANDS.filter((c) => /\.toggle[A-Z]/.test(c.id)).map((c) => c.id);
    // `view.toggleBottomDock` sits last because it is `shell.ts`'s record now, composed after
    // `commands/defaults.ts`'s: P4.2 put the Bottom dock on the shell record, so its verbs are
    // Declared beside the state they write, like the other two docks' setters.
    expect(toggles).toEqual([
      "view.toggleNavigator",
      "view.toggleInspector",
      "document.togglePinned",
      "pane.toggleZoom",
      "view.toggleBottomDock",
    ]);
    const ids = new Set(COMMANDS.map((c) => c.id));
    expect(ids.has("view.setNavigator")).toBe(true);
    expect(ids.has("view.setRightPanel")).toBe(true);
    // Pin and pane-zoom are the same bargain: ⌘-chords a human presses while looking at the tab or
    // The grid, each paired with the setter a script uses because a script cannot see that state.
    expect(ids.has("document.setPinned")).toBe(true);
    expect(ids.has("pane.setZoomed")).toBe(true);
    // P4.2 discharged the handoff: the bottom dock is on the `shell` record, `DOCK_IDS` is
    // Left/right/bottom, and ⌘J's setter landed with it.
    expect(ids.has("view.setBottomDock")).toBe(true);
    expect(ids.has("view.setBottomTab")).toBe(true);
  });

  test("this workstream's own records add no toggle", () => {
    const namespaces = new Set(["canvas", "collection", "data", "formula", "inspector", "state"]);
    const added = COMMANDS.filter((c) => namespaces.has(c.id.split(".")[0] as string));
    expect(added.filter((c) => /\.toggle[A-Z]/.test(c.id))).toEqual([]);
  });

  test("the injected getters are real — closing the Assistant reads the tab it is closing", () => {
    // `appCommandSet()` supplies stand-in deps so the CI checks can read DECLARATIONS in a bare Bun
    // Process. They still have to be honest functions: `view.setAssistant {open:false}` only acts
    // When the Assistant is the tab on screen, so it calls the getter rather than assuming.
    const byId = new Map(COMMANDS.map((c) => [c.id, c]));
    const setAssistant = byId.get("view.setAssistant")!;
    expect(() => setAssistant.run(emptyContext(), { open: false } as never)).not.toThrow();
    expect(() => setAssistant.run(emptyContext(), { open: true } as never)).not.toThrow();
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
