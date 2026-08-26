/**
 * The rail foot's ⚙ Settings menu — `src/panels/settings-menu.ts`.
 *
 * A SYNTHETIC registry throughout, holding the three ids by hand. That is the idiom
 * `tests/activity-bar.test.ts` states outright, and here it does a second job: importing the real
 * `app.preferences` record would pull `preferences-dialog.ts`'s graph (ai-models, github-auth,
 * cf-settings, the settings kernel) into a file that is about a popover. What the REAL records
 * declare is proved in `tests/app-commands.test.ts`, where the whole set is already loaded.
 *
 * `sp-menu-item` is an undefined custom element here — `ui/spectrum.ts` is imported by `studio.ts`
 * and two dedicated suites and by nothing else — so every assertion below is about light-DOM
 * markup, attributes and handlers. The chevron's grid area, real overlay stacking and the focus
 * ring belong to the browser lane.
 */
import { flush, mountOverlayLayers, pointer, stubRect } from "./harness";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { CommandContext } from "../src/commands/context";
import type { CommandRegistry } from "../src/commands/registry";

const overlayHost = document.createElement("div");
document.body.append(overlayHost);
mountOverlayLayers(overlayHost);

const { initLayers } = await import("../src/ui/layers");
const { createCommandRegistry } = await import("../src/commands/registry");
const { emptyContext } = await import("../src/commands/context");
const { setActiveRegistry } = await import("../src/commands/active-registry");
const {
  registerSettingsSection,
  resetSettingsDocumentState,
  unregisterSettingsSection,
  notifySettingsDocument,
} = await import("../src/settings/section-registry");
const { PREFERENCES_SECTIONS } = await import("../src/settings/preferences-sections");
const { problems, resetNotifications, toasts } = await import("../src/services/notify");
const { dismissSettingsMenu, isSettingsMenuOpen, openSettingsMenu, SETTINGS_MENU_PLACEMENT } =
  await import("../src/panels/settings-menu");

initLayers();

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** Every argument every run in a case received, in order. */
let ran: { id: string; args: unknown }[] = [];

interface RegistryOpts {
  /** Whether a project is open — the gate both project records read. */
  project?: boolean;
  /** Give `app.preferences` an `enablement` that refuses, to exercise the disabled shape. */
  refusePreferences?: boolean;
  /** Make a run reject asynchronously. */
  reject?: boolean;
}

function installRegistry(opts: RegistryOpts = {}): CommandRegistry {
  const project = opts.project ?? true;
  const registry = createCommandRegistry({
    getContext: () => ({
      ...emptyContext(),
      project: { ...emptyContext().project, open: project },
    }),
    mac: true,
  });
  const record = (id: string, title: string, level: "application" | "project", extra = {}) => ({
    id,
    title,
    category: "Project" as const,
    level,
    menus: [SETTINGS_MENU_PLACEMENT, "palette"] as const,
    run: (_ctx: CommandContext, args: unknown) => {
      ran.push({ args, id });
      return opts.reject ? Promise.reject(new RangeError(`no such section for ${id}`)) : undefined;
    },
    ...extra,
  });
  registry.registerAll([
    record("app.preferences", "Preferences…", "application", {
      category: "View",
      keybinding: "mod+,",
      group: "7_settings",
      ...(opts.refusePreferences
        ? { enablement: () => false, requires: "a reason of its own" }
        : {}),
    }),
    record("settings.open", "Open Project Settings", "project", {
      keybinding: "mod+shift+,",
      group: "7_settings",
      requires: "an open project",
      enablement: (ctx: CommandContext) => ctx.project.open,
    }),
    record("styles.open", "Open Project Styles", "project", {
      group: "7_settings_styles",
      requires: "an open project",
      enablement: (ctx: CommandContext) => ctx.project.open,
    }),
  ] as never);
  setActiveRegistry(registry);
  return registry;
}

/** A stand-in for the rail's gear, measured at the foot of a 56px rail. */
function gear(): HTMLElement {
  const button = document.createElement("button");
  document.body.append(button);
  stubRect(button, { height: 44, left: 0, top: 700, width: 56 });
  return button;
}

const rootItems = () => [
  ...document.querySelectorAll<HTMLElement>("#layer-popover sp-menu-item[data-command-id]"),
];
const subItems = () => [
  ...document.querySelectorAll<HTMLElement>("#layer-popover sp-menu-item[data-section-key]"),
];
const rootIds = () => rootItems().map((el) => el.dataset.commandId);
const subKeys = () => subItems().map((el) => el.dataset.sectionKey);
const rowFor = (id: string) => rootItems().find((el) => el.dataset.commandId === id)!;
/** Direct text only — the chord, the chevron and the reason are children. */
const titleOf = (el: HTMLElement) =>
  [...el.childNodes]
    .filter((n) => n.nodeType === 3)
    .map((n) => n.textContent?.trim())
    .join("");

/** The menu's listener is capture-phase, ON DOCUMENT. */
function menuKey(key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key });
  document.dispatchEvent(event);
  return event;
}

const focusedKey = () => (document.activeElement as HTMLElement | null)?.dataset;

let anchor: HTMLElement;

beforeEach(() => {
  ran = [];
  resetNotifications();
  resetSettingsDocumentState();
  for (const key of ["overview", "contexts", "cssVars"]) {
    unregisterSettingsSection(key);
  }
  registerSettingsSection({ key: "overview", label: "Overview", order: 10, render: () => {} });
  registerSettingsSection({ key: "contexts", label: "Contexts", order: 15, render: () => {} });
  registerSettingsSection({ key: "cssVars", label: "CSS Variables", order: 30, render: () => {} });
  anchor = gear();
});

afterEach(() => {
  dismissSettingsMenu();
  anchor.remove();
  setActiveRegistry(null);
  resetNotifications();
});

// ─── Rendering ────────────────────────────────────────────────────────────────

describe("rendering", () => {
  test("the rows are the placement, ordered level-first with one divider at the boundary", () => {
    installRegistry();
    openSettingsMenu(anchor);
    expect(rootIds()).toEqual(["app.preferences", "settings.open", "styles.open"]);
    // The divider IS the level boundary — the same thing the rail's own panel groups draw, and
    // The reason a menu may hold two levels where a pinned slot may not.
    const dividers = [...document.querySelectorAll("#layer-popover sp-menu-divider")];
    expect(dividers).toHaveLength(1);
    expect((dividers[0]!.nextElementSibling as HTMLElement | null)?.dataset.commandId).toBe(
      "settings.open",
    );
  });

  test("every row prints its own title and its own chord, from the record", () => {
    installRegistry();
    openSettingsMenu(anchor);
    expect(titleOf(rowFor("app.preferences"))).toBe("Preferences…");
    expect(rowFor("app.preferences").querySelector("kbd")?.textContent).toBe("⌘,");
    expect(rowFor("settings.open").querySelector("kbd")?.textContent).toBe("⌘⇧,");
    // No chord declared, so none printed — not an empty one.
    expect(rowFor("styles.open").querySelector("kbd")).toBeNull();
  });

  test("a chord that merely restates the row's own name is not printed", () => {
    const registry = createCommandRegistry({ getContext: () => emptyContext(), mac: true });
    registry.register({
      id: "app.preferences",
      title: "Delete",
      category: "View",
      level: "application",
      keybinding: "delete",
      menus: [SETTINGS_MENU_PLACEMENT],
      run: () => {},
    } as never);
    setActiveRegistry(registry);
    openSettingsMenu(anchor);
    expect(rowFor("app.preferences").querySelector("kbd")).toBeNull();
  });

  test("only rows whose command takes a section advertise a submenu", () => {
    installRegistry();
    openSettingsMenu(anchor);
    for (const id of ["app.preferences", "settings.open"]) {
      expect(rowFor(id).getAttribute("aria-haspopup")).toBe("menu");
      expect(rowFor(id).getAttribute("aria-expanded")).toBe("false");
      expect(rowFor(id).querySelector("sp-icon-chevron-right")).not.toBeNull();
    }
    // `styles.open` has no `section` argument, so lit removes the attributes rather than
    // Emitting aria-haspopup="false" — an announced popup that does not exist is worse than none.
    expect(rowFor("styles.open").hasAttribute("aria-haspopup")).toBe(false);
    expect(rowFor("styles.open").hasAttribute("aria-expanded")).toBe(false);
    expect(rowFor("styles.open").querySelector("sp-icon-chevron-right")).toBeNull();
  });

  test("with no project open the two project rows are DISABLED, not absent", () => {
    /* The welcome screen. They used to be hidden — `forPlacement` filters by `when` — which left
       the gear holding a single row and saying nothing about the two things most people open it
       looking for. §12.3: a control that cannot act renders disabled with its reason. The divider
       stays, because the level boundary is still there. */
    installRegistry({ project: false });
    openSettingsMenu(anchor);
    expect(rootIds()).toEqual(["app.preferences", "settings.open", "styles.open"]);
    expect(rowFor("app.preferences").hasAttribute("disabled")).toBe(false);
    for (const id of ["settings.open", "styles.open"]) {
      expect(rowFor(id).hasAttribute("disabled")).toBe(true);
      expect(rowFor(id).getAttribute("aria-disabled")).toBe("true");
      expect(rowFor(id).querySelector("[slot='description']")?.textContent).toContain(
        "an open project",
      );
    }
    // A row that cannot run advertises no submenu: every one of its rows runs that same refusal.
    expect(rowFor("settings.open").hasAttribute("aria-haspopup")).toBe(false);
    expect(document.querySelectorAll("#layer-popover sp-menu-divider")).toHaveLength(1);
  });

  test("a disabled project row does nothing when clicked, and the menu stays up", () => {
    installRegistry({ project: false });
    openSettingsMenu(anchor);
    pointer(rowFor("settings.open"), "click");
    expect(ran).toEqual([]);
    expect(isSettingsMenuOpen()).toBe(true);
  });

  test("a record refused by `enablement` renders disabled, with its reason, and offers no sections", () => {
    // §12.3: a control that cannot act explains itself rather than vanishing. And a row that cannot
    // Run offers no submenu, because every one of its rows would run that same refusal.
    installRegistry({ refusePreferences: true });
    openSettingsMenu(anchor);
    const row = rowFor("app.preferences");
    expect(row.hasAttribute("disabled")).toBe(true);
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(row.querySelector("[slot='description']")?.textContent).toContain("a reason of its own");
    expect(row.hasAttribute("aria-haspopup")).toBe(false);
  });
});

// ─── Activation ───────────────────────────────────────────────────────────────

describe("activation", () => {
  /*
   * THE LOAD-BEARING CASE, and the deliberate APG deviation.
   *
   * The pattern gives a parent `menuitem` no action of its own, and Spectrum's stock
   * `slot="submenu"` enforces exactly that: `Menu.handlePointerBasedSelection` bails on
   * `hasSubmenu`, so a parent emits no `change` at all. Here the heading opens Project Settings on
   * its default section and the submenu is a second way in. It is why the submenu is hand-rolled.
   */
  test("clicking a parent runs its OWN command, with no arguments, and dismisses", () => {
    installRegistry();
    openSettingsMenu(anchor);
    pointer(rowFor("settings.open"), "click");
    expect(ran).toEqual([{ args: {}, id: "settings.open" }]);
    expect(isSettingsMenuOpen()).toBe(false);
  });

  test("Enter on a parent runs it rather than opening its submenu", () => {
    installRegistry();
    openSettingsMenu(anchor);
    menuKey("ArrowDown");
    expect(menuKey("Enter").defaultPrevented).toBe(true);
    expect(ran).toEqual([{ args: {}, id: "settings.open" }]);
  });

  test("clicking a disabled row does nothing and leaves the menu up", () => {
    installRegistry({ refusePreferences: true });
    openSettingsMenu(anchor);
    pointer(rowFor("app.preferences"), "click");
    expect(ran).toEqual([]);
    expect(isSettingsMenuOpen()).toBe(true);
  });

  test("a run that throws SYNCHRONOUSLY reaches notify too", () => {
    // `registry.run` throws `CommandUnavailableError` for a record whose gate has turned false
    // Between the render and the click — a real race with the section-registry repaint.
    const registry = installRegistry();
    openSettingsMenu(anchor);
    registry.run = (() => {
      throw new RangeError("gate closed under the pointer");
    }) as typeof registry.run;
    pointer(rowFor("settings.open"), "click");
    expect([...toasts, ...problems].map((n) => n.message)).toContain(
      "gate closed under the pointer",
    );
  });

  test("a rejected async run reaches notify rather than an unhandled rejection", async () => {
    // `settings.open` throws AFTER awaiting the contributed-section sync, and `registry.run` does
    // Not catch — so a bare `void result` would strand it.
    installRegistry({ reject: true });
    openSettingsMenu(anchor);
    pointer(rowFor("settings.open"), "click");
    await flush();
    expect([...toasts, ...problems].map((n) => n.message)).toContain(
      "no such section for settings.open",
    );
  });
});

// ─── The submenu ──────────────────────────────────────────────────────────────

describe("the submenu", () => {
  test("hovering a parent opens its sections, named and ordered by the registry", () => {
    installRegistry();
    openSettingsMenu(anchor);
    rowFor("settings.open").dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    expect(subKeys()).toEqual(["overview", "contexts", "cssVars"]);
    expect(subItems().map((el) => el.textContent?.trim())).toEqual([
      "Overview",
      "Contexts",
      "CSS Variables",
    ]);
    expect(rowFor("settings.open").getAttribute("aria-expanded")).toBe("true");
    // Derived, so no surface renames anything.
    expect(
      document
        .querySelector("#layer-popover .settings-submenu sp-menu")
        ?.getAttribute("aria-label"),
    ).toBe("Sections of Open Project Settings");
  });

  test("the Preferences submenu is that command's own four sections", () => {
    installRegistry();
    openSettingsMenu(anchor);
    rowFor("app.preferences").dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    expect(subItems().map((el) => el.textContent?.trim())).toEqual(
      PREFERENCES_SECTIONS.map((section) => section.title),
    );
  });

  test("a submenu row runs the PARENT's command with the section it names", () => {
    installRegistry();
    openSettingsMenu(anchor);
    rowFor("settings.open").dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    pointer(
      subItems().find((el) => el.dataset.sectionKey === "cssVars")!,
      "click",
    );
    expect(ran).toEqual([{ args: { section: "cssVars" }, id: "settings.open" }]);
    expect(isSettingsMenuOpen()).toBe(false);
    expect(subItems()).toHaveLength(0);
  });

  test("hovering a sibling closes the open submenu", () => {
    installRegistry();
    openSettingsMenu(anchor);
    rowFor("settings.open").dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    expect(subItems().length).toBeGreaterThan(0);
    rowFor("styles.open").dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    expect(subItems()).toHaveLength(0);
    expect(rowFor("settings.open").getAttribute("aria-expanded")).toBe("false");
  });

  test("a section registered while the submenu is open appears in it", () => {
    /* Six of Project Settings' sections are contributed by extensions and register a tick after the
       built-ins. A submenu opened in that window would otherwise be permanently short. */
    installRegistry();
    openSettingsMenu(anchor);
    rowFor("settings.open").dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    expect(subKeys()).not.toContain("locales");
    registerSettingsSection({ key: "locales", label: "Locales", order: 25, render: () => {} });
    expect(subKeys()).toEqual(["overview", "contexts", "locales", "cssVars"]);
    unregisterSettingsSection("locales");
  });

  test("a section going away while it is open removes its row and clamps the caret", () => {
    // Driven by KEYBOARD, not hover: hovering opens a submenu without moving the roving caret (the
    // Pointer and the caret are separate), so ArrowRight would open whichever row the caret is on.
    installRegistry();
    openSettingsMenu(anchor);
    menuKey("ArrowDown"); // → settings.open
    menuKey("ArrowRight"); // → its submenu, caret on row 0
    menuKey("End"); // → CSS Variables, the row about to go
    expect(focusedKey()?.sectionKey).toBe("cssVars");
    unregisterSettingsSection("cssVars");
    expect(subKeys()).toEqual(["overview", "contexts"]);
    // The caret cannot point past the end of what is left.
    expect(subItems()).toHaveLength(2);
    expect(subItems()[1]?.hasAttribute("focused")).toBe(true);
  });

  test("closing the submenu unsubscribes — a later registration does not repaint it", () => {
    installRegistry();
    openSettingsMenu(anchor);
    rowFor("settings.open").dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    rowFor("styles.open").dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    registerSettingsSection({ key: "locales", label: "Locales", order: 25, render: () => {} });
    notifySettingsDocument();
    expect(subItems()).toHaveLength(0);
    unregisterSettingsSection("locales");
  });
});

// ─── Keyboard ─────────────────────────────────────────────────────────────────

describe("keyboard", () => {
  test("it opens with row 0 focused, and the roving tabindex says so", () => {
    installRegistry();
    openSettingsMenu(anchor);
    const [first, second] = rootItems();
    expect(first?.tabIndex).toBe(0);
    expect(first?.hasAttribute("focused")).toBe(true);
    expect(second?.tabIndex).toBe(-1);
  });

  test("Down/Up move and wrap; Home and End jump", () => {
    installRegistry();
    openSettingsMenu(anchor);
    menuKey("ArrowDown");
    expect(focusedKey()?.commandId).toBe("settings.open");
    menuKey("ArrowUp");
    expect(focusedKey()?.commandId).toBe("app.preferences");
    // Wrapping at both ends, so a list is a ring rather than a dead end.
    menuKey("ArrowUp");
    expect(focusedKey()?.commandId).toBe("styles.open");
    menuKey("Home");
    expect(focusedKey()?.commandId).toBe("app.preferences");
    menuKey("End");
    expect(focusedKey()?.commandId).toBe("styles.open");
  });

  test("ArrowRight opens a submenu and moves in; ArrowLeft closes it and hands focus back", () => {
    installRegistry();
    openSettingsMenu(anchor);
    menuKey("ArrowDown");
    expect(menuKey("ArrowRight").defaultPrevented).toBe(true);
    expect(focusedKey()?.sectionKey).toBe("overview");
    expect(menuKey("ArrowLeft").defaultPrevented).toBe(true);
    expect(subItems()).toHaveLength(0);
    expect(focusedKey()?.commandId).toBe("settings.open");
  });

  test("ArrowRight on a row with no sections is not swallowed", () => {
    installRegistry();
    openSettingsMenu(anchor);
    menuKey("End"); // Styles.open — the row with no `section` argument
    expect(menuKey("ArrowRight").defaultPrevented).toBe(false);
  });

  test("ArrowLeft on the root is not swallowed either", () => {
    installRegistry();
    openSettingsMenu(anchor);
    expect(menuKey("ArrowLeft").defaultPrevented).toBe(false);
  });

  test("Enter in the submenu runs the parent with that section", () => {
    installRegistry();
    openSettingsMenu(anchor);
    menuKey("ArrowDown");
    menuKey("ArrowRight");
    menuKey("ArrowDown");
    menuKey("Enter");
    expect(ran).toEqual([{ args: { section: "contexts" }, id: "settings.open" }]);
  });

  test("Escape closes ONE level at a time, and the last one returns focus to the gear", () => {
    installRegistry();
    openSettingsMenu(anchor);
    menuKey("ArrowDown");
    menuKey("ArrowRight");
    menuKey("Escape");
    expect(subItems()).toHaveLength(0);
    expect(isSettingsMenuOpen()).toBe(true);
    menuKey("Escape");
    expect(isSettingsMenuOpen()).toBe(false);
    expect(document.activeElement).toBe(anchor);
  });

  test("Tab dismisses, and the listener goes with it", () => {
    installRegistry();
    openSettingsMenu(anchor);
    expect(menuKey("Tab").defaultPrevented).toBe(true);
    expect(isSettingsMenuOpen()).toBe(false);
    // Nothing is left listening on `document` for a menu that is gone.
    expect(menuKey("ArrowDown").defaultPrevented).toBe(false);
  });

  test("a handled key is prevented and stopped; an unhandled one is neither", () => {
    installRegistry();
    openSettingsMenu(anchor);
    expect(menuKey("ArrowDown").defaultPrevented).toBe(true);
    // The app's own Escape walks the selection ladder and the canvas nudges on arrows — but only
    // The keys this menu actually handles may be taken from them.
    expect(menuKey("a").defaultPrevented).toBe(false);
  });
});

// ─── Dismissal and lifecycle ──────────────────────────────────────────────────

describe("dismissal", () => {
  /** The capture-phase mousedown the module arms a frame after opening. */
  function mousedownOn(target: Node): void {
    const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    target.dispatchEvent(event);
  }

  test("an outside mousedown dismisses", async () => {
    installRegistry();
    openSettingsMenu(anchor);
    await flush(); // The handler is armed a frame late, so the opening click cannot close it
    mousedownOn(document.body);
    expect(isSettingsMenuOpen()).toBe(false);
  });

  /*
   * THE REGRESSION THE HAND-ROLLED HANDLER EXISTS TO PREVENT.
   *
   * `renderPopover`'s own `dismissOnOutsideClick` tests one slot, so with two popovers a mousedown
   * in the submenu is "outside" the root — and `dismiss()` REMOVES the node, so the submenu row's
   * own `click` would never arrive. Following a section would silently do nothing.
   */
  test("a mousedown inside the SUBMENU does not dismiss the root", async () => {
    installRegistry();
    openSettingsMenu(anchor);
    rowFor("settings.open").dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    await flush();
    mousedownOn(subItems()[0]!);
    expect(isSettingsMenuOpen()).toBe(true);
    expect(subItems().length).toBeGreaterThan(0);
  });

  test("a mousedown on the gear does not dismiss — its own click owns the toggle", async () => {
    installRegistry();
    openSettingsMenu(anchor);
    await flush();
    mousedownOn(anchor);
    expect(isSettingsMenuOpen()).toBe(true);
  });

  test("opening while open closes, and `isSettingsMenuOpen` tracks both edges", () => {
    installRegistry();
    expect(isSettingsMenuOpen()).toBe(false);
    openSettingsMenu(anchor);
    expect(isSettingsMenuOpen()).toBe(true);
    openSettingsMenu(anchor);
    expect(isSettingsMenuOpen()).toBe(false);
  });

  test("dismissing is idempotent", () => {
    installRegistry();
    openSettingsMenu(anchor);
    dismissSettingsMenu();
    dismissSettingsMenu();
    expect(isSettingsMenuOpen()).toBe(false);
  });

  test("with no registry, and with an empty placement, opening does nothing", () => {
    setActiveRegistry(null);
    openSettingsMenu(anchor);
    expect(isSettingsMenuOpen()).toBe(false);

    const registry = createCommandRegistry({ getContext: () => emptyContext(), mac: true });
    registry.register({
      id: "app.preferences",
      title: "Preferences…",
      category: "View",
      level: "application",
      menus: ["palette"],
      run: () => {},
    } as never);
    setActiveRegistry(registry);
    openSettingsMenu(anchor);
    expect(isSettingsMenuOpen()).toBe(false);
  });

  test("the rerender callback fires on open AND on dismiss", () => {
    // That is what keeps the trigger's `aria-expanded` a BINDING rather than an imperative write —
    // A stale one is a defect this app has shipped before.
    installRegistry();
    let calls = 0;
    openSettingsMenu(anchor, { rerender: () => (calls += 1) });
    expect(calls).toBe(1);
    dismissSettingsMenu();
    expect(calls).toBe(2);
  });
});

// ─── The deferred passes ──────────────────────────────────────────────────────

/*
 * Everything this menu does after the browser has painted, which is where the two defects the unit
 * suite could NOT see both lived: the menu rendered off the bottom of the window because it clamped
 * against a not-yet-laid-out box, and ArrowRight opened a submenu the focus ring never reached
 * because `sp-menu-item.focus()` is a no-op until Spectrum has set the item up. Both were found by
 * driving a real browser; these are the regressions kept honest here.
 */
describe("after the frame", () => {
  /** One animation frame, the unit the module schedules its second passes on. */
  const frame = () =>
    new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });

  test("the caret is re-applied until the browser agrees where focus is", async () => {
    // In happy-dom the element is inert and the first, synchronous pass already lands — so the
    // Retry sees `document.activeElement === wanted` and stops. That it stops is the assertion:
    // The loop is bounded by agreement, not by burning its frame budget.
    installRegistry();
    openSettingsMenu(anchor);
    menuKey("ArrowDown");
    menuKey("ArrowRight");
    expect(focusedKey()?.sectionKey).toBe("overview");
    await frame();
    await frame();
    expect(focusedKey()?.sectionKey).toBe("overview");
    expect(subItems()[0]?.hasAttribute("focused")).toBe(true);
  });

  test("the caret is re-applied when the browser has not agreed yet", async () => {
    /* The browser case, forced: `sp-menu-item.focus()` is a no-op until Spectrum has set the item
       up, so the first pass moves nothing and the loop has to try again. Here focus is dragged
       elsewhere after the synchronous pass, which is the same state that pass leaves in a browser. */
    installRegistry();
    openSettingsMenu(anchor);
    menuKey("ArrowDown");
    menuKey("ArrowRight");
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    elsewhere.focus();
    expect(focusedKey()?.sectionKey).toBeUndefined();
    await frame();
    expect(focusedKey()?.sectionKey).toBe("overview");
    elsewhere.remove();
  });

  test("a pointer that moved on is not yanked back by a stale deferral", async () => {
    installRegistry();
    openSettingsMenu(anchor);
    menuKey("ArrowDown");
    menuKey("ArrowRight");
    // The submenu closes before the deferred pass runs: its guard must hold.
    menuKey("ArrowLeft");
    await frame();
    await frame();
    expect(subItems()).toHaveLength(0);
    expect(focusedKey()?.commandId).toBe("settings.open");
  });

  test("the placement runs again after layout, and clamping twice does not drift", async () => {
    /* The bug this pins: a popover measures 0×0 until layout runs, and layout does not run inside
       the call that rendered it — so the synchronous pass clamped against a zero-height box and
       parked the menu at the bottom edge of the window. The second pass is what fixes it, and it
       can only be safe because the clamp reads its own output. */
    installRegistry();
    openSettingsMenu(anchor);
    const popover = document.querySelector<HTMLElement>("#layer-popover sp-popover")!;
    stubRect(popover, { height: 400, width: 260 });
    await frame();
    const settled = popover.style.top;
    expect(settled).toBe(`${window.innerHeight - 400}px`);
    await frame();
    expect(popover.style.top).toBe(settled);
  });

  test("a deferred pass on a dismissed menu touches nothing", async () => {
    installRegistry();
    openSettingsMenu(anchor);
    dismissSettingsMenu();
    await frame();
    await frame();
    expect(isSettingsMenuOpen()).toBe(false);
    expect(rootItems()).toHaveLength(0);
  });
});

// ─── Geometry ─────────────────────────────────────────────────────────────────

describe("geometry", () => {
  /*
   * Happy-dom does no layout, so a popover measures 0×0 — and the clamp runs INSIDE the render
   * that creates the element, which is too early for a per-element `stubRect`. So the size is
   * stubbed on the prototype for the duration, which is the only way to be measurable at the
   * moment the code under test measures.
   */
  async function withPopoverSize<T>(
    size: { height: number; width: number },
    body: () => T | Promise<T>,
  ): Promise<T> {
    const original = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function getBoundingClientRect(this: Element) {
      if (this.tagName.toLowerCase() === "sp-popover") {
        return {
          ...size,
          bottom: size.height,
          left: 0,
          right: size.width,
          top: 0,
          x: 0,
          y: 0,
        } as DOMRect;
      }
      return original.call(this);
    };
    try {
      return await body();
    } finally {
      Element.prototype.getBoundingClientRect = original;
    }
  }

  const popoverStyle = () =>
    document.querySelector<HTMLElement>("#layer-popover sp-popover")!.style;

  test("the menu hangs off the trigger's right edge and ends flush with the floor", async () => {
    /* Not "below the trigger": the gear is the last control in a full-height rail, so a menu
       dropped below it would be off-screen. The BOTTOM edge is the anchored one and the menu grows
       upward from it — flush, with no inset, because the floor is a real edge (the status bar's
       top) rather than an arbitrary margin. */
    installRegistry();
    await withPopoverSize({ height: 200, width: 260 }, () => openSettingsMenu(anchor));
    // `x = anchorRect.right + 4` — the gear is 56px wide at left 0.
    expect(popoverStyle().left).toBe("60px");
    // No region ancestor in this fixture, so the floor is the viewport: 768 − 200.
    expect(popoverStyle().top).toBe(`${window.innerHeight - 200}px`);
  });

  test("it aligns to the REGION the trigger lives in, not to the trigger", async () => {
    /* The rail's foot carries 6px of padding, so the gear's own bottom floats clear of the status
       bar; the rail's bottom IS the status bar's top. Aligning to the region is what puts the menu
       flush with it — and it is the shell's own addressing grammar, so a menu button in another
       region would align to that one without this code learning about it. */
    const rail = document.createElement("div");
    rail.dataset.jxRegion = "rail";
    document.body.append(rail);
    rail.append(anchor);
    stubRect(rail, { height: 760, left: 0, top: 0, width: 56 });
    installRegistry();
    await withPopoverSize({ height: 200, width: 260 }, () => openSettingsMenu(anchor));
    // The RAIL's bottom is 760, not the gear's 744, so the menu sits 200 above it.
    expect(popoverStyle().top).toBe("560px");
    dismissSettingsMenu();
    document.body.append(anchor);
    rail.remove();
  });

  test("a popover taller than the viewport floors at 4 rather than going negative", async () => {
    /* Project Settings has ~16 sections once extensions have contributed theirs. Capping only the
       bottom edge would push `top` negative and take the FIRST rows off the top of the window,
       where nothing can reach them — which is why both axes are floored, not just capped. */
    installRegistry();
    await withPopoverSize({ height: window.innerHeight + 400, width: 260 }, () =>
      openSettingsMenu(anchor),
    );
    expect(popoverStyle().top).toBe("4px");
  });

  test("a submenu that would overflow the right edge flips to the menu's left", async () => {
    // The flip measures the popover, so like the placement it happens AFTER layout — an unlaid-out
    // Popover is 0 wide and would never appear to overflow anything.
    installRegistry();
    let sub!: HTMLElement;
    await withPopoverSize({ height: 120, width: window.innerWidth }, async () => {
      openSettingsMenu(anchor);
      rowFor("settings.open").dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
      sub = [...document.querySelectorAll<HTMLElement>("#layer-popover sp-popover")].at(-1)!;
    });
    // The unit comes off first: `Number("60px")` is NaN, and a silent NaN passes nothing.
    const left = Number(sub.style.left.replace("px", ""));
    // Flipped, then clamped — so it is on screen either way.
    expect(left).toBeGreaterThanOrEqual(4);
    expect(left).toBeLessThan(window.innerWidth);
  });
});
