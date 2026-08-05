/**
 * `window.__jxAutomation` — three members, and every one of them a projection.
 *
 * The surface this replaces had 25 bespoke methods, 16 of which resolved a CSS/XPath selector for
 * the runner to press, one of which staged the status bar, and one of which carried a compatibility
 * branch (`setRightTab`'s assistant redirect) that existed purely to keep a manifest verb alive.
 * These tests assert the deletions as hard as the additions.
 */
import { resetWorkspaceWithTab } from "./harness";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createCommandRegistry } from "../src/commands/registry";
import { makeContext } from "../src/commands/context";
import type { AnyCommand, CommandRegistry } from "../src/commands/registry";
import type { CommandContext } from "../src/commands/context";
import type { AutomationDeps } from "../src/services/automation";

const { happyDOM } = globalThis as unknown as { happyDOM: { setURL: (u: string) => void } };

void mock.module("../src/panels/stylebook-panel", () => ({
  renderComponentPreview: async () => document.createElement("div"),
}));

const {
  AUTOMATION_COMMANDS,
  AutomationRefusedError,
  createAutomationApi,
  installAutomationHook,
  isScriptable,
  scriptableCommands,
  setterFor,
  shouldInstallAutomation,
} = await import("../src/services/automation");
const { closeAllTabs } = await import("../src/workspace/workspace");
const { shell } = await import("../src/shell");

/** The rejection reason, as a value — `expect(...).rejects` is typed `void` here. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  return (await promise.catch((error: unknown) => error)) as Error;
}

interface Fixture {
  deps: AutomationDeps & {
    seedAssistantMessages: ReturnType<typeof mock>;
    seedPublishConnected: ReturnType<typeof mock>;
  };
  registry: CommandRegistry;
  ctx: CommandContext;
  ran: { id: string; args: unknown }[];
}

function makeFixture(patch: Partial<CommandContext> = {}): Fixture {
  const ctx = { ...makeContext(), ...patch };
  const ran: { id: string; args: unknown }[] = [];
  const registry = createCommandRegistry({ getContext: () => ctx });
  const record = (id: string, extra: Partial<AnyCommand> = {}): AnyCommand =>
    ({
      category: "View",
      id,
      level: "application",
      run: (_context, args) => {
        ran.push({ args, id });
      },
      title: id,
      ...extra,
    }) as AnyCommand;

  registry.registerAll([
    record("view.setColorScheme", {
      args: { properties: { scheme: { type: "string" } }, type: "object" },
    }),
    record("view.toggleZen"),
    record("selection.delete", {
      category: "Selection",
      enablement: (context: CommandContext) => context.selection.count > 0,
      level: "selection",
      menus: ["palette"],
      requires: "an element selection",
    }),
    record("project.hidden", { category: "Project", level: "project", when: () => false }),
  ]);

  const deps = {
    registry,
    seedAssistantMessages: mock(() => {}),
    seedPublishConnected: mock(() => {}),
  };
  return { ctx, deps, ran, registry };
}

beforeEach(() => {
  closeAllTabs();
  delete (globalThis as Record<string, unknown>).__jxAutomation;
});

describe("shouldInstallAutomation", () => {
  test("true only for automation=1", () => {
    expect(shouldInstallAutomation("?automation=1")).toBe(true);
    expect(shouldInstallAutomation("?project=/x&automation=1")).toBe(true);
    expect(shouldInstallAutomation("")).toBe(false);
    expect(shouldInstallAutomation("?automation=0")).toBe(false);
    expect(shouldInstallAutomation("?project=/x")).toBe(false);
  });
});

describe("installAutomationHook", () => {
  test("does not install without the flag", () => {
    happyDOM.setURL("http://localhost:3000/packages/studio/index.html");
    expect(installAutomationHook(makeFixture().deps)).toBe(false);
    expect((globalThis as Record<string, unknown>).__jxAutomation).toBeUndefined();
  });

  test("installs exactly three members with the flag", () => {
    happyDOM.setURL("http://localhost:3000/packages/studio/index.html?automation=1");
    expect(installAutomationHook(makeFixture().deps)).toBe(true);
    const api = (globalThis as Record<string, unknown>).__jxAutomation as Record<string, unknown>;
    expect(Object.keys(api).toSorted()).toEqual(["probe", "run", "seed"]);
  });
});

describe("run is registry.run", () => {
  test("a registered command runs with its arguments", async () => {
    const { deps, ran } = makeFixture();
    await createAutomationApi(deps).run("view.setColorScheme", { scheme: "dark" });
    expect(ran).toEqual([{ args: { scheme: "dark" }, id: "view.setColorScheme" }]);
  });

  test("args default to an empty object", async () => {
    const { deps, ran } = makeFixture();
    await createAutomationApi(deps).run("view.setColorScheme");
    expect(ran[0]!.args).toEqual({});
  });

  test("a refused command FAILS rather than silently capturing the wrong state", async () => {
    const { deps } = makeFixture();
    const api = createAutomationApi(deps);
    const error = await rejection(api.run("selection.delete"));
    expect(error.message).toBe(
      'Command "selection.delete" is not available right now — it requires an element selection.',
    );
  });

  test("a command whose `when` hides it is not runnable either", async () => {
    const { deps } = makeFixture();
    const error = await rejection(createAutomationApi(deps).run("project.hidden"));
    expect(error.message).toContain("is not available right now");
  });

  test("a toggle id is refused at runtime, naming the setter it should have been", async () => {
    // §13.5's idempotence rule. A delta against unstated state is what silently inverted 23
    // Manifest steps when the assistant's default flipped — and an agent calling it is guessing.
    const { deps, ran } = makeFixture();
    const api = createAutomationApi(deps);
    const refusal = await rejection(api.run("view.toggleZen"));
    expect(refusal).toBeInstanceOf(AutomationRefusedError);
    expect(refusal.message).toContain('call "view.setZen"');
    expect(ran).toEqual([]);
  });

  test("an id with a registry gap says which phase lands it", async () => {
    const { deps } = makeFixture();
    const error = await rejection(createAutomationApi(deps).run("media.browse"));
    expect(error.message).toContain("has no command record yet (P7.5 — media.browse)");
  });

  test("an id whose record has landed leaves the countdown entirely", async () => {
    // `element.insertData` was the P5 entry. It is now `insert.data` in `canvas/canvas-render.ts`,
    // So the old id is not a gap with a phase attached — it is simply not a command, and the
    // Countdown must not keep answering for ids that have been superseded.
    const { deps } = makeFixture();
    const error = await rejection(createAutomationApi(deps).run("element.insertData"));
    expect(error.message).toContain('unknown command "element.insertData"');
    expect(Object.keys(AUTOMATION_COMMANDS)).not.toContain("element.insertData");
  });

  test("an id §13.5 refuses says WHY, not 'unknown'", async () => {
    const { deps } = makeFixture();
    const api = createAutomationApi(deps);
    // `setStatus` was 53 manifest steps of staging the word "Ready" over the status bar.
    const staged = await rejection(api.run("view.setStatus", { text: "Ready" }));
    expect(staged.message).toContain("the status bar is not staged");
    // `layers.contextMenu` matched RENDERED TEXT, which R1 forbids outright.
    const byText = await rejection(api.run("layers.contextMenu", { label: "x" }));
    expect(byText.message).toContain("matched RENDERED TEXT");
  });

  test("a seed id is not runnable — it is seeded", async () => {
    const { deps } = makeFixture();
    const error = await rejection(createAutomationApi(deps).run("seed.collab"));
    expect(error.message).toContain('is a seed, not a command — call seed("seed.collab"');
  });

  test("an id nothing declares reports how many the registry does declare", async () => {
    const { deps } = makeFixture();
    const error = await rejection(createAutomationApi(deps).run("view.doesNotExist"));
    expect(error.message).toBe(
      'unknown command "view.doesNotExist" — the registry declares 3 scriptable id(s)',
    );
  });
});

describe("the scriptable projection", () => {
  test("every registry command except a toggle projects", () => {
    expect(isScriptable({ id: "view.setDock" } as AnyCommand)).toBe(true);
    expect(isScriptable({ id: "view.toggleAssistant" } as AnyCommand)).toBe(false);
    expect(setterFor("view.toggleAssistant")).toBe("view.setAssistant");
  });

  test("probe.commands() carries each command's gate and schema, already evaluated", () => {
    const { deps } = makeFixture();
    const commands = createAutomationApi(deps).probe.commands();
    expect(commands.map((c) => c.id)).toEqual(["view.setColorScheme", "selection.delete"]);
    expect(commands[0]).toEqual({
      args: { properties: { scheme: { type: "string" } }, type: "object" },
      enabled: true,
      id: "view.setColorScheme",
      title: "view.setColorScheme",
    });
    expect(commands[1]).toEqual({
      enabled: false,
      id: "selection.delete",
      requires: "an element selection",
      title: "selection.delete",
    });
  });

  test("the projection follows the context, with no second list to update", () => {
    const { deps, ctx, registry } = makeFixture();
    ctx.selection.count = 1;
    const enabled = scriptableCommands(registry).find((c) => c.id === "selection.delete");
    expect(enabled).toEqual({ enabled: true, id: "selection.delete", title: "selection.delete" });
    expect(createAutomationApi(deps).probe.commands()).toContainEqual(enabled!);
  });
});

describe("probe.state", () => {
  test("returns the full CommandContext, not four ad-hoc fields", () => {
    const { deps, ctx } = makeFixture();
    ctx.project.open = true;
    ctx.canvas.view = "preview";
    const state = createAutomationApi(deps).probe.state();
    expect(state).toBe(ctx);
    expect(state.project.open).toBe(true);
    expect(state.canvas.view).toBe("preview");
    expect(Object.keys(state).toSorted()).toEqual([
      "ai",
      "canvas",
      "capability",
      "caret",
      "collab",
      "document",
      "editor",
      "focus",
      "git",
      "modal",
      "pane",
      "project",
      "selection",
    ]);
  });
});

describe("the registry-gap declaration", () => {
  test("holds ids only — no handlers, no selectors, no rendered text", () => {
    for (const [id, entry] of Object.entries(AUTOMATION_COMMANDS)) {
      expect(Object.keys(entry).toSorted(), id).toEqual(["disposition", "note"]);
      expect(["command", "seed", "refused"], id).toContain(entry.disposition);
      expect(entry.note.length, id).toBeGreaterThan(0);
    }
  });

  test("names every refusal §13.5 makes normative", () => {
    const refused = Object.entries(AUTOMATION_COMMANDS)
      .filter(([, entry]) => entry.disposition === "refused")
      .map(([id]) => id);
    // The `refused` half is NOT a countdown — these are things the app will never provide, and
    // They stay so that reaching for one gets the reason rather than "unknown command".
    expect(refused).toContain("view.setStatus");
    expect(refused).toContain("layers.contextMenu");
    expect(refused).toContain("file.contextMenu");
    expect(refused).toContain("project.showWelcome");
    expect(refused).toContain("settings.setSection");
    // The three `toggle*` refusals left: `TOGGLE_ID` rejects them before this map is consulted, so
    // An entry for each was a second answer to a question already answered.
    for (const id of ["canvas.togglePreview", "inspector.toggleSection", "view.toggleActivity"]) {
      expect(Object.keys(AUTOMATION_COMMANDS)).not.toContain(id);
    }
  });

  test("no gap id is served by a handler of any kind", async () => {
    // The old table answered 39 ids. This one answers none: `run` projects the registry and only
    // Consults this map to EXPLAIN, so every entry here must reject.
    const { deps } = makeFixture();
    const api = createAutomationApi(deps);
    for (const id of Object.keys(AUTOMATION_COMMANDS)) {
      const error = await rejection(api.run(id));
      expect(error.message, id).toBeTruthy();
    }
  });
});

describe("no shell state is written behind the app's back", () => {
  test("running a command leaves the dock record to the command", async () => {
    resetWorkspaceWithTab();
    const before = shell.docks.right.collapsed;
    const { deps } = makeFixture();
    await createAutomationApi(deps).run("view.setColorScheme", { scheme: "light" });
    expect(shell.docks.right.collapsed).toBe(before);
  });
});
