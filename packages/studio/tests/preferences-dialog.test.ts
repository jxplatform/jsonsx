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
import { flush, installMockPlatform, pointer } from "./harness";
import { beforeEach, describe, expect, mock, test } from "bun:test";

// Keep the credentials gate deterministic: no managed proxy, no probe fetch.
void mock.module("../src/services/ai-models", () => ({
  ensureProxyProbe: () => {},
  fetchAvailableModels: async () => [],
  getProxyDefaultModel: () => "",
  hasAiCredentials: () => Boolean(globalThis.localStorage.getItem("jx.ai.openaiKey")),
  invalidateModelCache: () => {},
  isManagedProxy: () => false,
  isProxyConfigured: () => false,
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

  test("refuses a section it does not declare, naming the ones it does", () => {
    const registry = createCommandRegistry({ getContext: emptyContext });
    registerPreferencesCommands(registry);
    expect(() => registry.run("app.preferences", { section: "updates" })).toThrow(
      'command "app.preferences" argument "section": "updates" is not a Preferences section — ' +
        "declared: appearance, assistant, accounts, keyboard",
    );
  });
});
