/**
 * Tests for the Project Settings **document** — `src/settings/settings-document.ts`,
 * `src/settings/section-registry.ts` and its pane host `src/panels/settings-pane.ts`.
 *
 * These replace `settings-modal.test.ts`, `settings-registry.test.ts` and
 * `settings-modal-import-failure.test.ts`. What is asserted is deliberately the same list — nav
 * order, contributed sections landing at their declared order, section switching, a failing
 * contribution import — because P6.2 changed the HOST, not the IA. What is new is the pair of
 * regressions the modal could not have had: the deep link surviving a section being refreshed, and
 * `settings.open` reaching the `project.json` tab rather than a layer.
 */
import { flush, installMockPlatform, pointer, resetStudioState, surfaceOf } from "./harness";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { html, render } from "lit-html";
import {
  SETTINGS_MODE,
  activeSettingsSection,
  openProjectSettings,
  settingsCommands,
  settingsSectionsReady,
  showSettingsDocument,
} from "../src/settings/settings-document";
import {
  DEFAULT_SETTINGS_SECTION,
  onSettingsDocumentChanged,
  registerSettingsSection,
  resetSettingsDocumentState,
  setSettingsSection,
  settingsDocumentSection,
  settingsSectionKeys,
  unregisterSettingsSection,
} from "../src/settings/section-registry";
import {
  detachSettingsPane,
  renderSettingsPane,
  settingsPaneMounted,
} from "../src/panels/settings-pane";
import { resetExtensionSettingsSections } from "../src/settings/extension-sections";
import { refreshFormats, setExtensionCatalog, setExtensions } from "../src/format/format-host";
import { closeAllTabs, activeTab, workspace } from "../src/workspace/workspace";
import "../src/ui/form-controls";
import type { AnyCommand } from "../src/commands/registry";
import type { CommandContext } from "../src/commands/context";
import type { ExtensionsInfo } from "../src/types";

// ─── Environment ─────────────────────────────────────────────────────────────

let host: HTMLElement;

/** One of this module's records, BY ID — never by index: a factory grows. */
function commandById(id: string): AnyCommand {
  const command = settingsCommands().find((candidate) => candidate.id === id);
  if (!command) {
    throw new Error(`settingsCommands() no longer holds "${id}"`);
  }
  return command;
}

/** The document-opening command. */
function openCommand(): AnyCommand {
  return commandById("settings.open");
}

/** Run `settings.open` and return the message it refused with. */
async function refusal(args: Record<string, unknown>): Promise<string> {
  try {
    await runOpen(args);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("settings.open did not refuse");
}

/** Run `settings.open` the way the registry does. */
function runOpen(args: Record<string, unknown> = {}): Promise<void> {
  const run = openCommand().run as (ctx: CommandContext, args: unknown) => void | Promise<void>;
  return Promise.resolve(run({} as unknown as CommandContext, args));
}

function navLabels(): (string | undefined)[] {
  return [...host.querySelectorAll(".settings-nav-item")].map((b) => b.textContent?.trim());
}

function navButton(label: string): HTMLElement {
  const button = [...host.querySelectorAll(".settings-nav-item")].find(
    (b) => b.textContent?.trim() === label,
  );
  if (!button) {
    throw new Error(`no nav item "${label}" — have ${navLabels().join(", ")}`);
  }
  return button as HTMLElement;
}

function body(): HTMLElement {
  return host.querySelector(".settings-doc-content") as HTMLElement;
}

/** Mount the editor and let its deferred section render land. */
async function mount(): Promise<void> {
  renderSettingsPane(surfaceOf(host));
  await flush();
}

/** A parser-like extensions payload contributing the Content Types section (order 50). */
const parserExtensions: ExtensionsInfo[] = [
  {
    contributions: [
      {
        className: "Content",
        entrySchema: {
          additionalProperties: {
            properties: {
              format: { type: "string" },
              schema: { type: "object" },
              source: { type: "string" },
            },
            type: "object",
          },
          type: "object",
        },
        project: { key: "content", title: "Content Types" },
        studio: {
          settings: {
            entry: {
              newEntry: { schema: { properties: {}, required: [], type: "object" } },
              ui: { schema: { control: "schema-builder" } },
            },
            icon: "sp-icon-view-grid",
            label: "Content Types",
            layout: "map",
            order: 50,
          },
        },
      },
    ],
    name: "@jxsuite/parser",
    specifier: "@jxsuite/parser",
    title: "Content & Markdown",
  },
];

/** The built-in inner nav, in display order. Content Types is contributed, not built in. */
const BUILTIN_LABELS = [
  "Overview",
  "Contexts",
  "Site head",
  "Locales",
  "CSS Variables",
  "Data Shapes",
  "Packages",
  "Extensions",
  "Deploy",
  "Raw JSON",
];

beforeEach(() => {
  resetExtensionSettingsSections();
  refreshFormats();
  setExtensions([]);
  setExtensionCatalog([]);
  installMockPlatform();
  closeAllTabs();
  resetSettingsDocumentState();
  resetStudioState({
    projectConfig: {
      $defs: { Author: { properties: {}, required: [], type: "object" } },
      $media: { "--": "1280px", "--sm": "(max-width: 600px)" },
      content: {},
      extensions: [],
      style: { "--color-primary": "#007acc" },
    } as unknown,
  });
  host = document.createElement("div");
  document.body.append(host);
});

afterEach(async () => {
  detachSettingsPane("primary");
  host.remove();
  closeAllTabs();
  await flush();
});

// ─── The inner nav ───────────────────────────────────────────────────────────

describe("the settings document", () => {
  test("renders its sections as inner nav, Overview first and active", async () => {
    await mount();
    expect(navLabels()).toEqual(BUILTIN_LABELS);
    expect(navButton("Overview").classList.contains("active")).toBe(true);
    expect(navButton("Overview").getAttribute("aria-current")).toBe("page");
    expect(body().querySelector(".settings-section-title")?.textContent).toBe("Overview");
  });

  test("the host says whether it is mounted, and stops saying so once detached", async () => {
    const other = document.createElement("div");
    expect(settingsPaneMounted(surfaceOf(host))).toBe(false);
    await mount();
    expect(settingsPaneMounted(surfaceOf(host))).toBe(true);
    expect(settingsPaneMounted(surfaceOf(other))).toBe(false);
    detachSettingsPane("primary");
    expect(settingsPaneMounted(surfaceOf(host))).toBe(false);
    // A change notification with nothing mounted must be a no-op rather than a null dereference.
    setSettingsSection("contexts");
    expect(host.querySelector(".settings-doc")).not.toBeNull();
  });

  test("the Extensions section renders the backend's catalogue through the document", async () => {
    // The section is reached the way a reader reaches it — through the settings document's inner
    // Nav — rather than by calling its renderer, so the registration is covered too.
    setExtensionCatalog([
      {
        description: "File-based content collections",
        installed: false,
        name: "@jxsuite/parser",
        sections: [{ key: "content", title: "Content Types" }],
        source: "first-party",
        title: "Content & Markdown",
      },
    ]);
    await mount();
    setSettingsSection("extensions");
    await flush(3);
    expect(body().querySelector(".settings-section-title")?.textContent).toBe("Extensions");
    expect(body().querySelector(".settings-toggle-package")?.textContent).toBe("@jxsuite/parser");
    expect(body().querySelector("sp-switch")).not.toBeNull();
  });

  test("mounting twice on the same host does not rebuild the section body", async () => {
    await mount();
    const first = body().querySelector(".settings-section");
    await mount();
    expect(body().querySelector(".settings-section")).toBe(first!);
  });

  test("a nav click switches the section", async () => {
    await mount();
    pointer(navButton("Data Shapes"), "click");
    await flush();
    expect(navButton("Data Shapes").classList.contains("active")).toBe(true);
    expect(navButton("Overview").classList.contains("active")).toBe(false);
    const labels = [...body().querySelectorAll(".settings-list-panel sp-action-button")].map((b) =>
      b.textContent?.trim(),
    );
    expect(labels).toContain("Author");
  });

  test("the CSS Variables section survives P6.2 and renders the project's vars", async () => {
    await mount();
    pointer(navButton("CSS Variables"), "click");
    await flush();
    expect(body().querySelector(".settings-section-title")?.textContent).toBe("CSS Variables");
    expect(body().querySelectorAll(".css-var-row").length).toBe(1);
  });

  test("a $studio.settings contribution lands at its declared order", async () => {
    setExtensions(parserExtensions);
    await openProjectSettings();
    await mount();
    expect(navLabels()).toEqual([
      "Overview",
      "Contexts",
      "Site head",
      "Locales",
      "CSS Variables",
      "Data Shapes",
      "Content Types",
      "Packages",
      "Extensions",
      "Deploy",
      "Raw JSON",
    ]);
    pointer(navButton("Content Types"), "click");
    await flush();
    expect(body().querySelector(".settings-section-title")?.textContent).toBe("Content Types");
  });

  test("a custom section registering while mounted redraws the nav with no re-mount", async () => {
    await mount();
    registerSettingsSection({
      key: "customSection",
      label: "Custom",
      order: 35,
      render: (container) => {
        render(html`<div class="custom-section-body">Hello custom</div>`, container);
      },
    });
    await flush();
    expect(navLabels()).toContain("Custom");
    pointer(navButton("Custom"), "click");
    await flush();
    expect(host.querySelector(".custom-section-body")?.textContent).toBe("Hello custom");
    unregisterSettingsSection("customSection");
  });

  test("re-registering a key replaces the section instead of duplicating it", async () => {
    registerSettingsSection({
      key: "customSection",
      label: "Custom v1",
      order: 70,
      render: () => {},
    });
    registerSettingsSection({
      key: "customSection",
      label: "Custom v2",
      order: 70,
      render: (container) => {
        render(html`<div class="custom-v2">v2</div>`, container);
      },
    });
    await mount();
    expect(navLabels().filter((label) => label?.startsWith("Custom"))).toEqual(["Custom v2"]);
    unregisterSettingsSection("customSection");
  });
});

// ─── The deep link ───────────────────────────────────────────────────────────

describe("deep links", () => {
  test("a request for a section that has not registered yet is honoured when it does", () => {
    setSettingsSection("connections");
    // Nothing by that key exists, so the document keeps drawing what it was drawing…
    expect(settingsDocumentSection()).toBe(DEFAULT_SETTINGS_SECTION);
    registerSettingsSection({
      key: "connections",
      label: "Connections",
      order: 90,
      render: () => {},
    });
    // …and adopts the request the moment it can, with nobody re-asking.
    expect(settingsDocumentSection()).toBe("connections");
    unregisterSettingsSection("connections");
  });

  test("REGRESSION: a section being refreshed does not throw the deep link back to the default", async () => {
    registerSettingsSection({
      key: "connections",
      label: "Connections",
      order: 90,
      render: (container) => {
        render(html`<div class="connections-body">conn</div>`, container);
      },
    });
    setSettingsSection("connections");
    await mount();
    expect(body().querySelector(".connections-body")).not.toBeNull();

    /* This is exactly what `syncExtensionSettingsSections` does on every project activation and
       after every `project.json` write: unregister the stale key, then register the fresh one. The
       modal's `unregisterSettingsSection` reset its one active-section variable to "general" here,
       so the author's section silently became General. */
    unregisterSettingsSection("connections");
    registerSettingsSection({
      key: "connections",
      label: "Connections",
      order: 90,
      render: (container) => {
        render(html`<div class="connections-body">conn</div>`, container);
      },
    });
    await flush();

    expect(settingsDocumentSection()).toBe("connections");
    expect(navButton("Connections").classList.contains("active")).toBe(true);
    unregisterSettingsSection("connections");
  });

  test("a section that goes away for good falls back to a section that exists", async () => {
    registerSettingsSection({ key: "ephemeral", label: "Ephemeral", order: 55, render: () => {} });
    setSettingsSection("ephemeral");
    expect(settingsDocumentSection()).toBe("ephemeral");
    unregisterSettingsSection("ephemeral");
    expect(settingsDocumentSection()).toBe(DEFAULT_SETTINGS_SECTION);
    await flush();
  });

  test("openProjectSettings awaits the contributed sync before it returns", async () => {
    setExtensions(parserExtensions);
    await openProjectSettings("content");
    expect(settingsSectionKeys()).toContain("content");
    expect(settingsDocumentSection()).toBe("content");
    // And readiness is a fact about the registry, so asking again is immediate.
    await settingsSectionsReady();
  });
});

// ─── The tab ─────────────────────────────────────────────────────────────────

describe("the configuration tab", () => {
  test("showSettingsDocument opens project.json in the settings editor", () => {
    const tab = showSettingsDocument();
    expect(tab?.documentPath).toBe("project.json");
    expect(tab?.id).toBe("project.json");
    expect(tab?.session.ui.canvasMode).toBe(SETTINGS_MODE);
    expect(tab?.capabilities.modes).toEqual([SETTINGS_MODE, "stylebook", "source"]);
  });

  test("the tab's document IS the live project config, so the chokepoint binds it", () => {
    const tab = showSettingsDocument();
    expect(tab?.doc.document).toMatchObject({ content: {} });
  });

  test("a second open reuses the tab rather than rebuilding it (history survives)", () => {
    const first = showSettingsDocument()!;
    first.doc.dirty = true;
    first.session.ui.canvasMode = "source";
    const second = showSettingsDocument()!;
    expect(second.id).toBe(first.id);
    expect(second.doc.dirty).toBe(true);
    expect(second.session.ui.canvasMode).toBe(SETTINGS_MODE);
  });

  /*
   * THE COLD-WORKSPACE CASE, and the reason `showSettingsDocument` writes the mode itself.
   *
   * `createTab` seeds `session.ui.canvasMode` from `resolvedModes.find(m => m !== "preview")`
   * (`tabs/tab.ts`) — i.e. from `SETTINGS_TAB_MODES[0]`, which is `settings`. Parameterising only
   * the already-open branch would therefore leave `styles.open` opening the settings FORM whenever
   * the configuration tab happened to be closed, which is the ordinary case. Every assertion above
   * drives the settings door and so cannot see it.
   */
  test("a mode opens a FRESH tab in that editor, not in the first declared one", () => {
    expect(workspace.tabs.get("project.json")).toBeUndefined();
    const tab = showSettingsDocument("stylebook")!;
    expect(tab.session.ui.canvasMode).toBe("stylebook");
    expect(tab.session.ui.preview).toBe(false);
    // The capability list keeps its declared order regardless — the Editor control offers them in it.
    expect(tab.capabilities.modes).toEqual([SETTINGS_MODE, "stylebook", "source"]);
  });

  test("a mode switches an already-open tab's editor and keeps its history", () => {
    const first = showSettingsDocument()!;
    first.doc.dirty = true;
    const second = showSettingsDocument("stylebook")!;
    expect(second.id).toBe(first.id);
    expect(second.doc.dirty).toBe(true);
    expect(second.session.ui.canvasMode).toBe("stylebook");
  });

  test("an already-open project.json tab gains the settings editor without losing its modes", () => {
    const tab = showSettingsDocument()!;
    tab.capabilities.modes = ["stylebook", "source"];
    showSettingsDocument();
    expect(tab.capabilities.modes).toEqual([SETTINGS_MODE, "stylebook", "source"]);
  });

  /*
   * Revealing the configuration tab MOVES THE FOCUS, and moving the focus is four operations.
   *
   * `revealTab` did one of them — `workspace.activePaneId = pane.id` — which is the assignment
   * `focusPane` makes after `resetTabCycle`, `promoteMru` and `syncTreeSelection`. So reopening
   * Project Settings into the side pane left ⌃Tab cycling from the pane the author had left, the
   * MRU order disagreeing with what was on screen, and the file tree still pointing at the previous
   * pane's document. Rule 5 of `scripts/check-pane-singletons.ts` is the guard.
   */
  test("revealing it in the side pane moves the focus the way `focusPane` does", async () => {
    const { activateTab, focusPane, openTab, splitRight, PRIMARY_PANE, SECONDARY_PANE } =
      await import("../src/workspace/workspace");
    const { projectState } = await import("../src/store");
    const settings = showSettingsDocument()!;
    expect(splitRight()?.id).toBe(SECONDARY_PANE);
    focusPane(PRIMARY_PANE);
    // Opened AFTER the focus came back, so it lands in the primary — `openTab` opens where the
    // Keyboard is, which is the whole point of the arrangement.
    const other = openTab({
      document: { children: [], tagName: "div" },
      documentPath: "pages/other.json",
      id: "pages/other.json",
    });
    activateTab(other.id);
    expect(workspace.activePaneId).toBe(PRIMARY_PANE);
    expect(workspace.mruOrder[0]).toBe(other.id);

    showSettingsDocument();

    console.log(
      `[settings] reopened into the side pane: focus=${workspace.activePaneId} ` +
        `mru[0]=${workspace.mruOrder[0]} tree=${projectState?.selectedPath}`,
    );
    expect(workspace.activePaneId).toBe(SECONDARY_PANE);
    // The three `focusPane` does that a bare assignment does not.
    expect(workspace.mruOrder[0]).toBe(settings.id);
    expect(projectState?.selectedPath).toBe("project.json");
  });

  test("a tab that is in no pane is still returned rather than lost", () => {
    const tab = showSettingsDocument()!;
    for (const pane of workspace.panes) {
      pane.tabOrder = pane.tabOrder.filter((id) => id !== tab.id);
    }
    expect(showSettingsDocument()?.id).toBe(tab.id);
  });

  test("with no project open there is no document to show", async () => {
    const { setProjectState } = await import("../src/state");
    setProjectState(null as unknown as Parameters<typeof setProjectState>[0]);
    expect(showSettingsDocument()).toBeNull();
  });

  test("activeSettingsSection is null until the settings editor is the active one", () => {
    expect(activeSettingsSection()).toBeNull();
    showSettingsDocument();
    expect(activeSettingsSection()).toBe(DEFAULT_SETTINGS_SECTION);
    (activeTab.value as { session: { ui: { canvasMode: string } } }).session.ui.canvasMode =
      "source";
    expect(activeSettingsSection()).toBeNull();
  });
});

// ─── The command ─────────────────────────────────────────────────────────────

describe("settings.open", () => {
  test("still declares one record, at project level, with section and entry", () => {
    const command = openCommand();
    expect(command.id).toBe("settings.open");
    expect(command.level).toBe("project");
    // It joined the rail foot's gear menu without leaving the ⬢ menu or the palette: a placement
    // Chooses WHETHER a record renders somewhere, never what it is or where else it appears.
    expect(command.menus).toEqual(["commandbar/overflow", "settings/menu", "palette"]);
    expect(Object.keys((command.args as { properties: object }).properties).toSorted()).toEqual([
      "entry",
      "section",
    ]);
  });

  test("with no arguments it opens the document on its default section", async () => {
    await runOpen();
    expect(workspace.tabs.get("project.json")).toBeDefined();
    expect(settingsDocumentSection()).toBe(DEFAULT_SETTINGS_SECTION);
  });

  test("a section it does not have is refused, naming what it does have", async () => {
    expect(await refusal({ section: "css-variables" })).toContain(
      '"css-variables" is not a registered settings section',
    );
  });

  test("an entry without a section is refused", async () => {
    expect(await refusal({ entry: "posts" })).toContain('argument "entry" needs a "section"');
  });

  test("a section and an entry select that entry of the contributed section", async () => {
    setExtensions(parserExtensions);
    resetStudioState({
      projectConfig: { content: { pages: {}, posts: { format: "md" } } } as unknown,
    });
    await runOpen({ entry: "posts", section: "content" });
    await mount();
    expect(settingsDocumentSection()).toBe("content");
    const editor = host.querySelector('[data-jx-region="pane.primary/editor"]');
    expect(editor).not.toBeNull();
    expect(host.querySelector('[data-jx-region="pane.primary/entry:posts"]')).not.toBeNull();
  });

  test("an entry the section does not have is refused, naming the entries it does", async () => {
    setExtensions(parserExtensions);
    resetStudioState({ projectConfig: { content: { posts: {} } } as unknown });
    expect(await refusal({ entry: "drafts", section: "content" })).toContain(
      '"drafts" is not an entry of settings section "content" — entries: posts',
    );
  });
});

// ─── The subscription ────────────────────────────────────────────────────────

describe("onSettingsDocumentChanged", () => {
  test("fires for a section change and for a registration, and stops on unsubscribe", () => {
    let count = 0;
    const off = onSettingsDocumentChanged(() => {
      count += 1;
    });
    setSettingsSection("contexts");
    registerSettingsSection({ key: "tmp", label: "Tmp", order: 999, render: () => {} });
    expect(count).toBe(2);
    off();
    unregisterSettingsSection("tmp");
    setSettingsSection("overview");
    expect(count).toBe(2);
  });
});

/*
 * Last, and in this order deliberately: `mock.module` cannot be undone for the rest of a file, and
 * emptying the registry empties it for every test after. Both belong where nothing follows them.
 */

describe("the ends of the document", () => {
  test("a contribution import that fails leaves the built-ins rendering, and files a Problem", async () => {
    const warn = mock(() => {});
    void mock.module("../src/services/notify", () => ({ notify: { warn } }));
    void mock.module("../src/settings/extension-sections", () => ({
      extensionSectionsReady: () => Promise.resolve(),
      syncExtensionSettingsSections: () => Promise.reject(new Error("boom")),
    }));
    const { openProjectSettings: open } = await import("../src/settings/settings-document");
    await open("overview");
    await mount();
    expect(navLabels()).toContain("Overview");
    expect(warn).toHaveBeenCalled();
    expect((warn.mock.calls[0] as unknown[])[1]).toMatchObject({ tier: "problem" });
  });
  test("with no sections at all it says so rather than going blank", async () => {
    await mount();
    // Reverse order, so Overview is the last to go: unregistering it first would walk the document
    // Through every other section on the way down, including one that loads asynchronously.
    for (const key of settingsSectionKeys().toReversed()) {
      unregisterSettingsSection(key);
    }
    await flush();
    expect(navLabels()).toEqual([]);
    expect(body().textContent).toContain("No settings sections");
  });
});

// ─── The second door over the same document ──────────────────────────────────

describe("styles.open", () => {
  /** The Project Styles command. */
  function stylesCommand(): AnyCommand {
    return commandById("styles.open");
  }

  test("is a project-level record in the gear menu and the palette, and nowhere else", () => {
    const command = stylesCommand();
    expect(command.level).toBe("project");
    expect(command.menus).toEqual(["settings/menu", "palette"]);
    expect(command.group).toBe("7_settings_styles");
    // No chord: ⌥⌘, and ⌃⌘, are free, so this is a choice — the gear and the palette are both
    // Permanent doors and a third settings chord earns little. Rebinding is Preferences › Keyboard.
    expect(command.keybinding).toBeUndefined();
    // No arguments, so no submenu and nothing for the args-schema check to reject.
    expect(command.args).toBeUndefined();
  });

  test("it is NAMED, never spelled from the wire value", () => {
    // `stylebook` is shared with `dist/iframe-entry.js` and may never be renamed, so nothing a
    // Reader sees may be derived from it — `style/project-styles.ts` states the rule.
    const { title } = stylesCommand();
    expect(title).toBe("Open Project Styles");
    expect(title.toLowerCase()).not.toContain("stylebook");
  });

  test("two verbs over one document declare ONE availability rule", () => {
    // §12.4: the family is defined by what `run` WRITES, and both write this tab's editor.
    const styles = stylesCommand();
    const open = openCommand();
    expect(styles.requires).toBe(open.requires);
    for (const project of [{ open: true }, { open: false }]) {
      const ctx = { project } as unknown as CommandContext;
      expect(styles.when?.(ctx)).toBe(open.when?.(ctx));
    }
  });

  test("it opens the configuration document in the Project Styles editor", () => {
    void stylesCommand().run({} as CommandContext, undefined as never);
    const tab = workspace.tabs.get("project.json");
    expect(tab?.session.ui.canvasMode).toBe("stylebook");
    expect(activeTab.value?.id).toBe("project.json");
  });
});
