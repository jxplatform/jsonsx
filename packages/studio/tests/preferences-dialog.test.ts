/**
 * Preferences (⌘,) — src/settings/preferences-dialog.ts.
 *
 * The surface Studio did not have. Four sections, and one assertion each for the hole it closes:
 * Appearance renders the theme nothing else rendered; Assistant hosts the provider form that used
 * to be locked inside the assistant panel; Accounts can revoke a credential nothing could revoke;
 * and Keyboard is GENERATED from the registry's own `shortcutReference()`, so it cannot drift from
 * the app or from `docs/studio/interface/shortcuts.md`.
 *
 * §13.5 forbids a screenshot of generated content, so the keyboard sheet's guarantee is checked
 * here instead: the rows come from the registry, and a record registered after this file was
 * written appears without this file knowing about it.
 */
import { flush, installMockPlatform, key, pointer, seedSettings } from "./harness";
import { beforeEach, describe, expect, mock, test } from "bun:test";

// Keep the credentials gate deterministic: no managed proxy, no probe fetch.
void mock.module("../src/services/ai-models", () => ({
  aiConnection: () => ({ apiKey: "", baseUrl: "" }),
  cachedModels: () => null,
  preferredModel: () => "gpt-4o",
  ensureProxyProbe: () => {},
  fetchAvailableModels: async () => [],
  getProxyDefaultModel: () => "",
  hasAiCredentials: () => Boolean(globalThis.localStorage.getItem("jx.ai.openaiKey")),
  resetModelCache: () => {},
  isManagedProxy: () => false,
  isProxyConfigured: () => false,
  // Every named export ai-managed-connect.ts imports must be here: a partial mock.module() of a
  // Module someone else imports is a SyntaxError at link time, not a missing stub at call time.
  proxyStateCode: () => {},
}));

installMockPlatform();

const {
  closePreferences,
  DEFAULT_PREFERENCES_SECTION,
  isPreferencesOpen,
  isPreferencesSection,
  openPreferences,
  preferencesCommands,
  preferencesSection,
  PREFERENCES_SECTIONS,
  registerPreferencesCommands,
} = await import("../src/settings/preferences-dialog");
const { initLayers } = await import("../src/ui/layers");
const { createCommandRegistry } = await import("../src/commands/registry");
const { emptyContext } = await import("../src/commands/context");
const { setActiveRegistry } = await import("../src/commands/active-registry");
const { checkPlacements } = await import("../src/commands/levels");
const { shell } = await import("../src/shell");

function d<T extends Element = HTMLElement>(sel: string): T | null {
  return document.querySelector(`#layer-dialog ${sel}`) as T | null;
}

function dAll(sel: string): HTMLElement[] {
  return [...document.querySelectorAll(`#layer-dialog ${sel}`)] as HTMLElement[];
}

function navItem(title: string): HTMLElement {
  return dAll(".prefs-nav-item").find((el) => el.textContent?.trim() === title)!;
}

/** A registry with two bound records, as the Keyboard sheet reads it. */
function registryWithChords() {
  const registry = createCommandRegistry({ getContext: emptyContext });
  registry.registerAll([
    {
      id: "test.save",
      title: "Save Everything",
      category: "File",
      level: "document",
      keybinding: "mod+shift+alt+s",
      menus: ["palette"],
      run: () => {},
    },
    {
      id: "test.silent",
      title: "No Chord At All",
      category: "File",
      level: "document",
      menus: ["palette"],
      run: () => {},
    },
  ]);
  return registry;
}

/** A registry with a conflict available in it, and one binding outside the global scope. */
function editorRegistry() {
  const registry = createCommandRegistry({ getContext: emptyContext, mac: true });
  registry.registerAll([
    {
      id: "file.save",
      title: "Save",
      category: "File",
      level: "document",
      keybinding: "mod+s",
      menus: ["palette"],
      run: () => {},
    },
    {
      id: "edit.redo",
      title: "Redo",
      category: "Edit",
      level: "document",
      keybinding: "mod+y",
      menus: ["palette"],
      run: () => {},
    },
    {
      id: "selection.delete",
      title: "Delete",
      category: "Selection",
      level: "selection",
      keyScope: "canvas",
      keybinding: "backspace",
      menus: ["palette"],
      run: () => {},
    },
  ]);
  return registry;
}

/** The command ids the sheet is currently showing, in sheet order. */
function boundIds(): string[] {
  return dAll(".prefs-key").map((el) => el.dataset.command!);
}

function keyRow(id: string): HTMLElement {
  return d(`.prefs-key[data-command="${id}"]`)!;
}

function rowButtons(id: string): string[] {
  return [...keyRow(id).querySelectorAll("sp-action-button")].map(
    (el) => el.textContent?.trim() ?? "",
  );
}

function rowButton(id: string, label: string): HTMLElement {
  return [...keyRow(id).querySelectorAll("sp-action-button")].find(
    (el) => el.textContent?.trim() === label,
  ) as HTMLElement;
}

/** The "search by keystroke" toggle — the only action button outside a row. */
function keystrokeButton(): HTMLElement {
  return d(".prefs-keys .prefs-field sp-action-button")!;
}

async function search(value: string): Promise<void> {
  const field = d<HTMLInputElement>("sp-search")!;
  field.value = value;
  field.dispatchEvent(new Event("input", { bubbles: true }));
  await flush(3);
}

beforeEach(() => {
  closePreferences();
  localStorage.clear();
  document.body.innerHTML = `
    <sp-theme color="dark"></sp-theme>
    <div id="layer-popover"></div><div id="layer-modal"></div><div id="layer-dialog"></div>
  `;
  initLayers();
  setActiveRegistry(null);
  shell.theme = "dark";
});

describe("the section list", () => {
  test("four sections, each with a title and a blurb, opening on Appearance", () => {
    expect(PREFERENCES_SECTIONS.map((section) => section.id)).toEqual([
      "appearance",
      "assistant",
      "accounts",
      "keyboard",
    ]);
    for (const section of PREFERENCES_SECTIONS) {
      expect(section.title).toBeTruthy();
      expect(section.blurb).toBeTruthy();
    }
    expect(DEFAULT_PREFERENCES_SECTION).toBe("appearance");
    expect(isPreferencesSection("keyboard")).toBe(true);
    expect(isPreferencesSection("updates")).toBe(false);
  });
});

describe("opening and closing", () => {
  test("opens as a focus-managed dialog, not an inset blackout", async () => {
    void openPreferences();
    await flush(3);
    expect(isPreferencesOpen()).toBe(true);
    expect(d("sp-dialog-wrapper")!.getAttribute("headline")).toBe("Preferences");
    expect(d(".prefs-sheet")).not.toBeNull();
    expect(d(".prefs-title")!.textContent).toBe("Appearance");
    closePreferences();
    await flush(2);
    expect(d(".prefs-sheet")).toBeNull();
    expect(isPreferencesOpen()).toBe(false);
  });

  test("resolves when dismissed, and Escape's `close` event is the dismissal", async () => {
    const done = openPreferences("accounts");
    await flush(3);
    d("sp-dialog-wrapper")!.dispatchEvent(new Event("close", { bubbles: true }));
    expect(await done).toBeNull();
    expect(d(".prefs-sheet")).toBeNull();
  });

  test("`cancel` dismisses too — the Close button fires it", async () => {
    const done = openPreferences();
    await flush(3);
    d("sp-dialog-wrapper")!.dispatchEvent(new Event("cancel", { bubbles: true }));
    expect(await done).toBeNull();
  });

  test("an unknown section falls back to Appearance rather than a blank pane", async () => {
    void openPreferences("updates");
    await flush(3);
    expect(preferencesSection()).toBe("appearance");
    expect(d(".prefs-title")!.textContent).toBe("Appearance");
  });

  test("re-opening while up SELECTS the section instead of stacking a second sheet", async () => {
    void openPreferences("appearance");
    await flush(3);
    void openPreferences("accounts");
    await flush(3);
    expect(dAll("sp-dialog-wrapper")).toHaveLength(1);
    expect(d(".prefs-title")!.textContent).toBe("Accounts");
  });

  test("the nav switches sections in place", async () => {
    void openPreferences();
    await flush(3);
    pointer(navItem("Accounts"), "click");
    await flush(3);
    expect(preferencesSection()).toBe("accounts");
    expect(navItem("Accounts").classList.contains("active")).toBe(true);
    expect(navItem("Accounts").getAttribute("aria-current")).toBe("true");
    expect(navItem("Appearance").getAttribute("aria-current")).toBe("false");
  });

  test("closing when nothing is open is inert", () => {
    expect(() => closePreferences()).not.toThrow();
  });
});

describe("Appearance", () => {
  test("renders the theme the shell record holds, and writing it paints <sp-theme>", async () => {
    void openPreferences("appearance");
    await flush(3);
    const buttons = dAll("sp-action-button");
    expect(buttons.map((el) => el.getAttribute("value"))).toEqual(["light", "dark"]);
    expect(buttons[1]!.hasAttribute("selected")).toBe(true);

    pointer(buttons[0]!, "click");
    await flush(3);
    expect(shell.theme).toBe("light");
    expect(localStorage.getItem("jx-studio-theme")).toBe("light");
    // And the sheet repaints so the pressed state is not a lie.
    expect(dAll("sp-action-button")[0]!.hasAttribute("selected")).toBe(true);
  });
});

describe("Assistant", () => {
  test("hosts the provider form that used to be locked inside the assistant panel", async () => {
    void openPreferences("assistant");
    await flush(3);
    expect(d(".prefs-assistant")).not.toBeNull();
    expect(d(".ai-creds-form")).not.toBeNull();
    // Spectrum controls, not raw inputs with inline styles.
    expect(dAll("sp-textfield").length).toBeGreaterThan(0);
  });

  test("saving a key lands in the store and repaints the Accounts row", async () => {
    void openPreferences("assistant");
    await flush(3);
    const field = d<HTMLInputElement>("sp-textfield")!;
    field.value = "sk-from-preferences";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    const save = dAll("sp-button").find((el) => el.textContent?.includes("Save"))!;
    pointer(save, "click");
    await flush(3);
    expect(localStorage.getItem("jx.ai.openaiKey")).toBe("sk-from-preferences");
    // The sheet stays up — Preferences is a place, not a wizard step.
    expect(d(".prefs-assistant")).not.toBeNull();

    pointer(navItem("Accounts"), "click");
    await flush(3);
    expect(d('.prefs-account[data-account="ai"]')!.textContent).toContain("Key stored");
  });
});

describe("Accounts", () => {
  test("lists all three, offering Disconnect only for the connected ones", async () => {
    localStorage.setItem("jx_github_token", "gho_x");
    void openPreferences("accounts");
    await flush(3);
    expect(dAll(".prefs-account").map((el) => el.dataset.account)).toEqual([
      "github",
      "ai",
      "cloudflare",
    ]);
    expect(d('.prefs-account[data-account="github"] sp-button')).not.toBeNull();
    expect(d('.prefs-account[data-account="cloudflare"] sp-button')).toBeNull();
  });

  test("Disconnect forgets the credential — the call `clearGithubToken` never had", async () => {
    localStorage.setItem("jx_github_token", "gho_x");
    void openPreferences("accounts");
    await flush(3);
    pointer(d('.prefs-account[data-account="github"] sp-button')!, "click");
    await flush(3);
    expect(localStorage.getItem("jx_github_token")).toBeNull();
    expect(d('.prefs-account[data-account="github"] sp-button')).toBeNull();
    expect(d('.prefs-account[data-account="github"]')!.textContent).toContain("Not signed in");
  });
});

describe("Keyboard", () => {
  test("is generated from the running registry, grouped by scope", async () => {
    setActiveRegistry(registryWithChords());
    void openPreferences("keyboard");
    await flush(3);
    expect(d(".prefs-keys")).not.toBeNull();
    expect(dAll(".prefs-keys-scope").map((el) => el.textContent)).toEqual(["Anywhere"]);
    const rows = dAll(".prefs-key");
    // One row per BINDING: the chordless record is not listed, because there is nothing to press.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain("Save Everything");
    expect(d(".prefs-key-chord")!.textContent).toBeTruthy();
  });

  test("with no registry composed it says so rather than rendering an empty table", async () => {
    setActiveRegistry(null);
    void openPreferences("keyboard");
    await flush(3);
    expect(d(".prefs-empty")!.textContent).toContain("No commands are registered");
  });
});

describe("Keyboard — finding a shortcut", () => {
  test("by name, over the title, the id and the printed chord alike", async () => {
    setActiveRegistry(editorRegistry());
    void openPreferences("keyboard");
    await flush(3);
    expect(dAll(".prefs-key")).toHaveLength(3);

    await search("redo");
    expect(boundIds()).toEqual(["edit.redo"]);
    await search("selection.");
    expect(boundIds()).toEqual(["selection.delete"]);
    await search("⌘S");
    expect(boundIds()).toEqual(["file.save"]);
    await search("");
    expect(dAll(".prefs-key")).toHaveLength(3);
  });

  test("by pressing it — the question a list cannot answer by being read", async () => {
    setActiveRegistry(editorRegistry());
    void openPreferences("keyboard");
    await flush(3);
    pointer(keystrokeButton(), "click");
    await flush(3);
    expect(keystrokeButton().hasAttribute("selected")).toBe(true);

    key(keystrokeButton(), "s", { metaKey: true });
    await flush(3);
    expect(boundIds()).toEqual(["file.save"]);
    // One press answers and stops listening: the sheet is not a keylogger.
    expect(keystrokeButton().hasAttribute("selected")).toBe(false);
    expect(d<HTMLInputElement>("sp-search")!.value).toBe("⌘S");
  });

  test("a chord nothing is bound to says so, which is the honest answer", async () => {
    setActiveRegistry(editorRegistry());
    void openPreferences("keyboard");
    await flush(3);
    pointer(keystrokeButton(), "click");
    await flush(3);
    key(keystrokeButton(), "j", { metaKey: true, altKey: true });
    await flush(3);
    expect(dAll(".prefs-key")).toHaveLength(0);
    expect(d(".prefs-empty")!.textContent).toContain("Nothing is bound to ⌘⌥J");
  });

  test("a name that matches nothing does not pretend the keyboard is empty", async () => {
    setActiveRegistry(editorRegistry());
    void openPreferences("keyboard");
    await flush(3);
    await search("xyzzy");
    expect(d(".prefs-empty")!.textContent).toContain("No shortcut matches that");
  });
});

describe("Keyboard — rebinding", () => {
  test("a rebinding is a LAYER: the live chord moves and the declared one does not", async () => {
    const registry = editorRegistry();
    setActiveRegistry(registry);
    void openPreferences("keyboard");
    await flush(3);
    pointer(rowButton("file.save", "Change"), "click");
    await flush(3);
    expect(keyRow("file.save").textContent).toContain("Press a shortcut…");

    key(rowButton("file.save", "Cancel"), "s", { metaKey: true, altKey: true });
    await flush(3);
    expect(registry.keymap.bindingsFor("file.save")).toEqual(["mod+alt+s"]);
    expect(registry.keymap.declaredFor("file.save")).toEqual(["mod+s"]);
    // The sheet is the projection, so it repainted from the same source the rest of the app reads.
    expect(keyRow("file.save").textContent).toContain("⌘⌥S");
    expect(keyRow("file.save").textContent).toContain("changed");
    expect(localStorage.getItem("jx.keybindings")).toBe('{"file.save":["mod+alt+s"]}');
  });

  test("capturing a chord never RUNS it — Preferences does not suspend the app", async () => {
    setActiveRegistry(editorRegistry());
    void openPreferences("keyboard");
    await flush(3);
    const seen: string[] = [];
    const listener = (event: Event) => seen.push((event as KeyboardEvent).key);
    document.addEventListener("keydown", listener);
    pointer(rowButton("file.save", "Change"), "click");
    await flush(3);
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "s",
      metaKey: true,
      altKey: true,
    });
    rowButton("file.save", "Cancel").dispatchEvent(event);
    document.removeEventListener("keydown", listener);
    // The app's dispatcher is a `document` keydown listener; ⌘S would have SAVED.
    expect(seen).toEqual([]);
    expect(event.defaultPrevented).toBe(true);
  });

  test("a modifier on its own is not a chord and does not end the capture", async () => {
    setActiveRegistry(editorRegistry());
    void openPreferences("keyboard");
    await flush(3);
    pointer(rowButton("file.save", "Change"), "click");
    await flush(3);
    key(keyRow("file.save"), "Meta", { metaKey: true });
    await flush(3);
    expect(keyRow("file.save").textContent).toContain("Press a shortcut…");
  });

  test("a chord that is taken is refused, naming who has it and offering to show them", async () => {
    const registry = editorRegistry();
    setActiveRegistry(registry);
    void openPreferences("keyboard");
    await flush(3);
    pointer(rowButton("file.save", "Change"), "click");
    await flush(3);
    key(keyRow("file.save"), "y", { metaKey: true });
    await flush(3);
    expect(d("sp-help-text")!.textContent).toContain("⌘Y is already Redo.");
    // Neither silently winning nor silently losing: nothing moved.
    expect(registry.keymap.bindingsFor("file.save")).toEqual(["mod+s"]);
    expect(registry.keymap.bindingsFor("edit.redo")).toEqual(["mod+y"]);
    expect(localStorage.getItem("jx.keybindings")).toBeNull();

    pointer(
      dAll("sp-button").find((el) => el.textContent?.includes("Show Redo"))!,
      "click",
    );
    await flush(3);
    expect(boundIds()).toEqual(["edit.redo"]);
    expect(d("sp-help-text")).toBeNull();
  });

  test("a bare printable key is refused with what to do instead", async () => {
    setActiveRegistry(editorRegistry());
    void openPreferences("keyboard");
    await flush(3);
    pointer(rowButton("file.save", "Change"), "click");
    await flush(3);
    key(keyRow("file.save"), "k");
    await flush(3);
    expect(d("sp-help-text")!.textContent).toContain("would fire while you type");
    // No conflict, so nothing to jump to.
    expect(dAll("sp-button").some((el) => el.textContent?.includes("Show"))).toBe(false);
  });

  test("Reset is offered only where there is something to reset, and restores every chord", async () => {
    const registry = editorRegistry();
    setActiveRegistry(registry);
    void openPreferences("keyboard");
    await flush(3);
    expect(rowButtons("edit.redo")).toEqual(["Change"]);

    pointer(rowButton("edit.redo", "Change"), "click");
    await flush(3);
    key(keyRow("edit.redo"), "y", { metaKey: true, altKey: true });
    await flush(3);
    expect(rowButtons("edit.redo")).toEqual(["Change", "Reset"]);

    pointer(rowButton("edit.redo", "Reset"), "click");
    await flush(3);
    expect(registry.keymap.bindingsFor("edit.redo")).toEqual(["mod+y"]);
    expect(rowButtons("edit.redo")).toEqual(["Change"]);
    expect(localStorage.getItem("jx.keybindings")).toBeNull();
  });

  test("Escape and the Cancel button both abandon a capture, and neither closes the sheet", async () => {
    setActiveRegistry(editorRegistry());
    void openPreferences("keyboard");
    await flush(3);
    pointer(rowButton("file.save", "Change"), "click");
    await flush(3);
    key(keyRow("file.save"), "Escape");
    await flush(3);
    expect(isPreferencesOpen()).toBe(true);
    expect(rowButtons("file.save")).toEqual(["Change"]);

    pointer(rowButton("file.save", "Change"), "click");
    await flush(3);
    pointer(rowButton("file.save", "Cancel"), "click");
    await flush(3);
    expect(keyRow("file.save").textContent).toContain("⌘S");
  });

  test("typing in the search box while a capture is armed disarms it", async () => {
    setActiveRegistry(editorRegistry());
    void openPreferences("keyboard");
    await flush(3);
    pointer(rowButton("file.save", "Change"), "click");
    await flush(3);
    await search("save");
    expect(rowButtons("file.save")).toEqual(["Change"]);
  });

  test("a keystroke with no registry composed cannot rebind anything", async () => {
    setActiveRegistry(editorRegistry());
    void openPreferences("keyboard");
    await flush(3);
    pointer(rowButton("file.save", "Change"), "click");
    await flush(3);
    // The window's registry goes away under the open sheet — the rendered handler is still live.
    setActiveRegistry(null);
    key(keyRow("file.save"), "s", { metaKey: true, altKey: true });
    await flush(3);
    expect(localStorage.getItem("jx.keybindings")).toBeNull();
    expect(d(".prefs-empty")!.textContent).toContain("No commands are registered");
  });

  test("leaving the section abandons the capture rather than arming the next visit", async () => {
    setActiveRegistry(editorRegistry());
    void openPreferences("keyboard");
    await flush(3);
    pointer(rowButton("file.save", "Change"), "click");
    await search("save");
    await flush(3);
    pointer(navItem("Accounts"), "click");
    await flush(3);
    pointer(navItem("Keyboard"), "click");
    await flush(3);
    expect(d<HTMLInputElement>("sp-search")!.value).toBe("");
    expect(rowButtons("file.save")).toEqual(["Change"]);
  });

  test("re-opening the sheet never resumes a capture", async () => {
    setActiveRegistry(editorRegistry());
    void openPreferences("keyboard");
    await flush(3);
    pointer(rowButton("file.save", "Change"), "click");
    await search("save");
    await flush(3);
    closePreferences();
    await flush(2);
    void openPreferences("keyboard");
    await flush(3);
    expect(d<HTMLInputElement>("sp-search")!.value).toBe("");
    expect(rowButtons("file.save")).toEqual(["Change"]);
  });
});

describe("the app.preferences record", () => {
  test("is application level, ⌘,, and satisfies the placement matrix", () => {
    const [command] = preferencesCommands();
    expect(command!.id).toBe("app.preferences");
    expect(command!.level).toBe("application");
    expect(command!.keybinding).toBe("mod+,");
    expect(checkPlacements(preferencesCommands())).toEqual([]);
  });

  test("runs with no project open — the welcome screen is where a first run needs it", async () => {
    const registry = createCommandRegistry({ getContext: emptyContext });
    registerPreferencesCommands(registry);
    expect(registry.isVisible("app.preferences")).toBe(true);
    void registry.run("app.preferences", { section: "accounts" });
    await flush(3);
    expect(preferencesSection()).toBe("accounts");
  });

  test("opens on Appearance when no section is named", async () => {
    const registry = createCommandRegistry({ getContext: emptyContext });
    registerPreferencesCommands(registry);
    void registry.run("app.preferences", {});
    await flush(3);
    expect(preferencesSection()).toBe("appearance");
  });

  test("registering the verb also applies the keyboard this author already chose", () => {
    // The bootstrap's one contact point with Preferences, and the reason a rebinding survives a
    // Reload: the layer lives in the keymap, so records registered AFTER this call are indexed
    // Against it too (`tests/preferences-keymap.test.ts` pins that half).
    seedSettings({ "jx.keybindings": JSON.stringify({ "app.preferences": ["mod+alt+,"] }) });
    const registry = createCommandRegistry({ getContext: emptyContext, mac: true });
    registerPreferencesCommands(registry);
    expect(registry.keymap.bindingsFor("app.preferences")).toEqual(["mod+alt+,"]);
    expect(registry.keymap.declaredFor("app.preferences")).toEqual(["mod+,"]);
    expect(registry.keymap.resolveChord("mod+,", ["global"])).toBeUndefined();
  });

  test("refuses a section it does not declare, naming the ones it does", () => {
    const registry = createCommandRegistry({ getContext: emptyContext });
    registerPreferencesCommands(registry);
    expect(() => registry.run("app.preferences", { section: "updates" })).toThrow(
      'command "app.preferences" argument "section": "updates" is not a Preferences section — ' +
        "declared: appearance, assistant, accounts, keyboard",
    );
  });
});
