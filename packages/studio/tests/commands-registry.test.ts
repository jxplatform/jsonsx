/**
 * The command record and its registry (UX-REDESIGN-PLAN §5.1).
 *
 * The registry takes its context by injection, so these tests build the exact state they assert
 * against with `makeContext()` — no app, no DOM, no state modules.
 */
import { describe, expect, test } from "bun:test";
import { CommandUnavailableError, createCommandRegistry } from "../src/commands/registry";
import type { AnyCommand, Command, CommandRegistry } from "../src/commands/registry";
import { emptyContext, makeContext } from "../src/commands/context";
import type { CommandContext } from "../src/commands/context";
import { KeybindingConflictError } from "../src/commands/keymap";

/** A registry over a mutable context the test can move underneath it. */
function harness(initial: CommandContext = emptyContext()) {
  let ctx = initial;
  const registry = createCommandRegistry({ getContext: () => ctx, mac: true });
  return {
    registry,
    setContext(next: CommandContext) {
      ctx = next;
    },
  };
}

const noop = () => {};

function command(over: Partial<Command> & Pick<Command, "id">): AnyCommand {
  return {
    title: "Test Command",
    category: "Edit",
    level: "application",
    run: noop,
    ...over,
  } as AnyCommand;
}

describe("registration", () => {
  test("a registered command is retrievable and listed in registration order", () => {
    const { registry } = harness();
    registry.registerAll([command({ id: "a.one" }), command({ id: "b.two" })]);
    expect(registry.list().map((c) => c.id)).toEqual(["a.one", "b.two"]);
    expect(registry.get("a.one")?.title).toBe("Test Command");
    expect(registry.get("nope.missing")).toBeUndefined();
  });

  test("a duplicate id is rejected — one capability, one definition site", () => {
    const { registry } = harness();
    registry.register(command({ id: "selection.duplicate" }));
    expect(() => registry.register(command({ id: "selection.duplicate" }))).toThrow(
      /duplicate command id "selection\.duplicate"/,
    );
    expect(registry.list()).toHaveLength(1);
  });

  test("an id that is not <namespace>.<verb> is rejected", () => {
    const { registry } = harness();
    expect(() => registry.register(command({ id: "duplicate" }))).toThrow(/invalid command id/);
    expect(() => registry.register(command({ id: "Selection.duplicate" }))).toThrow(
      /invalid command id/,
    );
    // A third segment is fine: view.toggleDock.right is one action, not two.
    expect(() => registry.register(command({ id: "view.toggleDock.right" }))).not.toThrow();
  });

  test("a command with no title is rejected — the record is where actions are named", () => {
    const { registry } = harness();
    expect(() => registry.register(command({ id: "a.one", title: "" }))).toThrow(/has no title/);
  });

  test("a placement the matrix does not admit is rejected at registration", () => {
    const { registry } = harness();
    expect(() =>
      registry.register(
        command({ id: "selection.duplicate", level: "selection", menus: ["commandbar/primary"] }),
      ),
    ).toThrow(/admits only application, document/);
    expect(registry.list()).toHaveLength(0);
  });

  test("a conflicting chord is rejected at registration, not discovered at runtime", () => {
    // This is the ⌘W bug made impossible: two owners of one chord cannot both exist.
    const { registry } = harness();
    registry.register(command({ id: "document.close", keybinding: "mod+w" }));
    expect(() => registry.register(command({ id: "window.close", keybinding: "mod+w" }))).toThrow(
      KeybindingConflictError,
    );
    expect(registry.list()).toHaveLength(1);
  });

  test("a rejected command leaves the registry and the keymap untouched", () => {
    const { registry } = harness();
    registry.register(command({ id: "document.close", keybinding: "mod+w" }));
    expect(() =>
      registry.register(
        command({
          id: "selection.duplicate",
          level: "selection",
          menus: ["commandbar/primary"],
          keybinding: "mod+d",
        }),
      ),
    ).toThrow();
    // The placement check runs before the keymap, so the chord was never claimed.
    expect(registry.keymap.resolveChord("mod+d", ["global"])).toBeUndefined();
    expect(registry.get("selection.duplicate")).toBeUndefined();
  });

  test("registerAll stops at the offending record", () => {
    const { registry } = harness();
    expect(() =>
      registry.registerAll([
        command({ id: "a.one" }),
        command({ id: "bad" }),
        command({ id: "c.three" }),
      ]),
    ).toThrow(/invalid command id/);
    expect(registry.list().map((c) => c.id)).toEqual(["a.one"]);
  });
});

describe("when hides, enablement disables", () => {
  const build = () => {
    const h = harness();
    h.registry.register(
      command({
        id: "edit.undo",
        level: "document",
        when: (ctx) => ctx.document.open,
        enablement: (ctx) => ctx.document.canUndo,
        requires: "a change to undo",
      }),
    );
    return h;
  };

  test("when false: invisible, and therefore also disabled", () => {
    const { registry } = build();
    expect(registry.isVisible("edit.undo")).toBe(false);
    expect(registry.isEnabled("edit.undo")).toBe(false);
    expect(registry.visible()).toHaveLength(0);
  });

  test("when true, enablement false: visible, disabled, with the reason", () => {
    const { registry, setContext } = build();
    setContext(makeContext({ document: { open: true } }));
    expect(registry.isVisible("edit.undo")).toBe(true);
    expect(registry.isEnabled("edit.undo")).toBe(false);
    expect(registry.disabledReason("edit.undo")).toBe("a change to undo");
    expect(registry.visible().map((c) => c.id)).toEqual(["edit.undo"]);
  });

  test("both true: enabled, and no reason to show", () => {
    const { registry, setContext } = build();
    setContext(makeContext({ document: { open: true, canUndo: true } }));
    expect(registry.isEnabled("edit.undo")).toBe(true);
    expect(registry.disabledReason("edit.undo")).toBeUndefined();
    expect(registry.refusalMessage("edit.undo")).toBeUndefined();
  });

  test("the predicates are re-read per query — a reactive context needs no invalidation", () => {
    const { registry, setContext } = build();
    expect(registry.isVisible("edit.undo")).toBe(false);
    setContext(makeContext({ document: { open: true, canUndo: true } }));
    expect(registry.isEnabled("edit.undo")).toBe(true);
  });

  test("enablement defaults to when", () => {
    const { registry, setContext } = harness();
    registry.register(
      command({ id: "file.save", level: "document", when: (ctx) => ctx.document.open }),
    );
    expect(registry.isEnabled("file.save")).toBe(false);
    setContext(makeContext({ document: { open: true } }));
    expect(registry.isEnabled("file.save")).toBe(true);
  });

  test("a command with neither predicate is always available", () => {
    const { registry } = harness();
    registry.register(command({ id: "palette.open" }));
    expect(registry.isVisible("palette.open")).toBe(true);
    expect(registry.isEnabled("palette.open")).toBe(true);
  });

  test("querying an unknown id throws rather than reporting a confident false", () => {
    const { registry } = harness();
    expect(() => registry.isVisible("nope.missing")).toThrow(/unknown command/);
    expect(() => registry.isEnabled("nope.missing")).toThrow(/unknown command/);
  });
});

describe("requires — one string, three consumers", () => {
  test("the same sentence reaches the tooltip, the palette subtitle and the agent", () => {
    const { registry } = harness();
    registry.register(
      command({
        id: "selection.duplicate",
        level: "selection",
        when: (ctx) => ctx.selection.count > 0,
        requires: "an element selection",
      }),
    );
    expect(registry.disabledReason("selection.duplicate")).toBe("an element selection");
    expect(registry.refusalMessage("selection.duplicate")).toBe(
      'Command "selection.duplicate" is not available right now — it requires an element selection.',
    );
    // The thrown error carries the identical wording, so a refusal never reads differently
    // Depending on whether a human or the agent triggered it.
    expect(() => registry.run("selection.duplicate")).toThrow(
      'Command "selection.duplicate" is not available right now — it requires an element selection.',
    );
  });

  test("a record with no requires still refuses with a sentence", () => {
    const { registry } = harness();
    registry.register(command({ id: "a.one", when: () => false }));
    expect(registry.disabledReason("a.one")).toBe("a different studio state");
    expect(registry.refusalMessage("a.one")).toContain("a different studio state");
  });
});

describe("run", () => {
  test("passes the live context and the args through", () => {
    const seen: { ctx: CommandContext | null; args: unknown } = { ctx: null, args: null };
    const { registry, setContext } = harness();
    registry.register({
      id: "grid.setCell",
      title: "Set Cell",
      category: "Edit",
      level: "document",
      run: (ctx, args: { value: string }) => {
        seen.ctx = ctx;
        seen.args = args;
      },
    });
    setContext(makeContext({ document: { open: true } }));
    void registry.run("grid.setCell", { value: "x" });
    expect(seen.args).toEqual({ value: "x" });
    expect(seen.ctx?.document.open).toBe(true);
  });

  test("defaults args to an empty object so a no-arg command needs no call-site ceremony", () => {
    let received: unknown = "unset";
    const { registry } = harness();
    registry.register(command({ id: "a.one", run: (_ctx, args) => void (received = args) }));
    void registry.run("a.one");
    expect(received).toEqual({});
  });

  test("an unknown id throws — a silently-skipped command is a wrong screenshot", () => {
    const { registry } = harness();
    expect(() => registry.run("nope.missing")).toThrow('unknown command "nope.missing"');
  });

  test("a refused command throws CommandUnavailableError carrying its reason", () => {
    const { registry } = harness();
    registry.register(command({ id: "a.one", when: () => false, requires: "an open project" }));
    let thrown: unknown;
    try {
      void registry.run("a.one");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CommandUnavailableError);
    expect((thrown as CommandUnavailableError).commandId).toBe("a.one");
    expect((thrown as CommandUnavailableError).requires).toBe("an open project");
  });

  test("an async run is returned, not swallowed", async () => {
    const { registry } = harness();
    let done = false;
    registry.register(
      command({
        id: "a.one",
        run: async () => {
          await Promise.resolve();
          done = true;
        },
      }),
    );
    await registry.run("a.one");
    expect(done).toBe(true);
  });
});

describe("forPlacement", () => {
  function placed(): CommandRegistry {
    const { registry } = harness();
    registry.registerAll([
      command({ id: "a.zeta", title: "Zeta", menus: ["commandbar/overflow"], group: "1_first" }),
      command({ id: "b.alpha", title: "Alpha", menus: ["commandbar/overflow"], group: "1_first" }),
      command({ id: "c.later", title: "Later", menus: ["commandbar/overflow"], group: "9_last" }),
      command({ id: "d.elsewhere", title: "Elsewhere", menus: ["palette"] }),
      command({
        id: "e.hidden",
        title: "Hidden",
        menus: ["commandbar/overflow"],
        when: () => false,
      }),
    ]);
    return registry;
  }

  test("returns the visible commands of one placement, ordered by group then title", () => {
    expect(
      placed()
        .forPlacement("commandbar/overflow")
        .map((c) => c.title),
    ).toEqual(["Alpha", "Zeta", "Later"]);
  });

  test("a command with no menus defaults into the palette and nowhere else", () => {
    const { registry } = harness();
    registry.register(command({ id: "a.one", title: "One" }));
    expect(registry.forPlacement("palette").map((c) => c.id)).toEqual(["a.one"]);
    expect(registry.forPlacement("commandbar/overflow")).toEqual([]);
  });
});

describe("handleKeyEvent", () => {
  function bound() {
    const h = harness();
    h.registry.registerAll([
      command({ id: "file.save", level: "document", keybinding: "mod+s" }),
      command({
        id: "selection.delete",
        level: "selection",
        keyScope: "canvas",
        keybinding: "backspace",
        when: (ctx) => ctx.selection.count > 0,
        menus: ["blockbar"],
      }),
    ]);
    return h;
  }

  const press = (key: string, meta = false) => ({
    key,
    metaKey: meta,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
  });

  test("resolves through the scope stack and runs the hit", () => {
    let ran = "";
    const { registry, setContext } = harness();
    registry.register(
      command({
        id: "file.save",
        level: "document",
        keybinding: "mod+s",
        run: () => void (ran = "save"),
      }),
    );
    setContext(makeContext({ document: { open: true } }));
    expect(registry.handleKeyEvent(press("s", true), ["canvas", "global"])).toBe("file.save");
    expect(ran).toBe("save");
  });

  test("an unbound chord reports no hit so the key falls through to the browser", () => {
    expect(bound().registry.handleKeyEvent(press("q", true), ["global"])).toBeUndefined();
  });

  test("a chord bound only in a scope outside the stack is not a hit", () => {
    const { registry, setContext } = bound();
    setContext(makeContext({ selection: { count: 1 } }));
    expect(registry.handleKeyEvent(press("Backspace"), ["global"])).toBeUndefined();
    expect(registry.handleKeyEvent(press("Backspace"), ["canvas", "global"])).toBe(
      "selection.delete",
    );
  });

  test("a chord whose command is hidden is not swallowed", () => {
    // Selection.delete is bound but `when` is false with nothing selected: Backspace must reach
    // Whatever else would handle it rather than being eaten by an action that is not there.
    const { registry } = bound();
    expect(registry.handleKeyEvent(press("Backspace"), ["canvas", "global"])).toBeUndefined();
  });
});

describe("the registry's own seams", () => {
  test("context() hands surfaces the same snapshot the predicates read", () => {
    const { registry, setContext } = harness();
    setContext(makeContext({ project: { open: true } }));
    expect(registry.context().project.open).toBe(true);
  });

  test("the keymap is the registry's, and formatBinding prints from it", () => {
    const { registry } = harness();
    registry.register(command({ id: "file.save", level: "document", keybinding: "mod+s" }));
    expect(registry.keymap.formatBinding("file.save")).toBe("⌘S");
  });

  test("mac defaults to detection when the option is omitted", () => {
    const registry = createCommandRegistry({ getContext: emptyContext });
    registry.register(command({ id: "file.save", level: "document", keybinding: "mod+s" }));
    expect(registry.keymap.formatBinding("file.save")).toMatch(/S$/);
  });
});
