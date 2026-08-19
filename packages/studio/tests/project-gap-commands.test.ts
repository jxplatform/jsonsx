/**
 * The project-level verbs the screenshot manifest names: grids, Settings, the Library, New Project.
 *
 * The interesting one is `settings.open`. It replaces THREE manifest verbs (`openSettings`,
 * `openSettings {section}` and the refused `settings.setSection`, whose press-shim mirrored the
 * section registry's LABELS), and its validation has to be asynchronous because extension-
 * contributed sections register a tick after the document opens. A synchronous refusal would reject
 * `connections`, `data` and `content` — all real; no refusal at all is what lets `css-variables`
 * (the key is `cssVars`) render an empty pane and call it a screenshot.
 */
import { flush, installMockPlatform, resetStudioState } from "./harness";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createCommandRegistry } from "../src/commands/registry";
import { makeContext } from "../src/commands/context";
import { checkPlacements } from "../src/commands/levels";
import { initLayers } from "../src/ui/layers";
import { closeAllTabs, workspace } from "../src/workspace/workspace";
import type { CommandContext } from "../src/commands/context";
import type { AnyCommand, CommandRegistry } from "../src/commands/registry";

// ─── Seams ────────────────────────────────────────────────────────────────────

void mock.module("../src/files/files.js", () => ({
  createFileIn: () => Promise.resolve(null),
  initProjectRepo: () => Promise.resolve(),
  openFileInTab: () => Promise.resolve(),
}));
void mock.module("../src/settings/extension-sections.js", () => ({
  deriveSettingsSection: () => null,
  extensionSectionsReady: () => Promise.resolve(),
  syncExtensionSettingsSections: () =>
    import("../src/settings/section-registry").then(({ registerSettingsSection }) => {
      // Stand in for @jxsuite/parser and the connector extension: two contributed sections that
      // Only exist AFTER the async sync, which is exactly the race `settings.open` has to survive.
      registerSettingsSection({
        key: "content",
        label: "Content Types",
        order: 50,
        render: () => {},
      });
      registerSettingsSection({
        key: "connections",
        label: "Connections",
        order: 70,
        render: () => {},
      });
    }),
}));

const { gridCommands, registerGridCommands } = await import("../src/grid/grid-open");
const { registerSettingsCommands, settingsCommands } =
  await import("../src/settings/settings-document");
const { resetSettingsDocumentState, settingsDocumentSection, settingsSectionKeys } =
  await import("../src/settings/section-registry");
const { libraryCommands, registerLibraryCommands } = await import("../src/browse/library-commands");
const { NEW_PROJECT_TABS, newProjectCommands, registerNewProjectCommands } =
  await import("../src/new-project/new-project-modal");

for (const id of ["layer-popover", "layer-modal", "layer-dialog"]) {
  if (!document.querySelector(`#${id}`)) {
    const el = document.createElement("div");
    el.id = id;
    document.body.append(el);
  }
}
initLayers();

globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
  setTimeout(() => cb(0), 0);
  return 0;
}) as typeof requestAnimationFrame;

// ─── Context ──────────────────────────────────────────────────────────────────

let ctx: CommandContext = makeContext();
let registry: CommandRegistry;

function allRecords(): AnyCommand[] {
  return [...gridCommands(), ...settingsCommands(), ...libraryCommands(), ...newProjectCommands()];
}

/** Run a command that is expected to refuse, and return the message it refused with. */
async function refusal(id: string, args?: Record<string, unknown>): Promise<string> {
  try {
    await Promise.resolve(registry.run(id, args));
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error(`command "${id}" did not refuse`);
}

beforeEach(() => {
  installMockPlatform();
  closeAllTabs();
  resetSettingsDocumentState();
  resetStudioState({
    projectConfig: {
      content: { comments: { source: "./content/comments" }, posts: { source: "./content/posts" } },
    },
    projectDirs: ["pages"],
  });
  ctx = makeContext({
    capability: { dataRows: true },
    project: { isSite: true, open: true },
  });
  registry = createCommandRegistry({ getContext: () => ctx });
  registerGridCommands(registry);
  registerSettingsCommands(registry);
  registerLibraryCommands(registry);
  registerNewProjectCommands(registry);
});

describe("the records themselves", () => {
  test("satisfy the level × placement matrix", () => {
    expect(checkPlacements(allRecords())).toEqual([]);
  });

  test("register under the ids the manifest names", () => {
    expect(registry.list().map((c) => c.id)).toEqual([
      "collection.editInGrid",
      "data.openGrid",
      "settings.open",
      "library.open",
      "library.setCategory",
      "library.setLayout",
      "library.setSearch",
      "library.setLocale",
      "library.refresh",
      "library.newEntry",
      "project.new",
    ]);
  });

  test("none of them lands in the primary Command Bar — that cluster is capped at five", () => {
    for (const command of registry.list()) {
      expect(command.menus).not.toContain("commandbar/primary");
    }
  });
});

describe("collection.editInGrid", () => {
  test("opens the collection's grid tab", () => {
    void registry.run("collection.editInGrid", { name: "posts" });
    expect([...workspace.tabs.keys()].some((id) => id.includes("posts"))).toBe(true);
  });

  test("is idempotent — a second run activates the same tab", () => {
    void registry.run("collection.editInGrid", { name: "posts" });
    const first = workspace.tabs.size;
    void registry.run("collection.editInGrid", { name: "posts" });
    expect(workspace.tabs.size).toBe(first);
  });

  test("refuses a collection the project does not declare, listing the ones it does", () => {
    expect(() => registry.run("collection.editInGrid", { name: "authors" })).toThrow(
      'command "collection.editInGrid" argument "name": "authors" is not a content collection ' +
        "this project declares — it declares: comments, posts",
    );
  });

  test("a project with no collections says so", () => {
    resetStudioState({ projectConfig: {} });
    expect(() => registry.run("collection.editInGrid", { name: "posts" })).toThrow(
      "it declares: none",
    );
  });

  test("is hidden with no project open", () => {
    ctx = makeContext();
    expect(registry.isVisible("collection.editInGrid")).toBe(false);
  });
});

describe("data.openGrid", () => {
  test("opens a connector table", () => {
    void registry.run("data.openGrid", { connection: "main", table: "comments" });
    expect([...workspace.tabs.keys()].some((id) => id.includes("comments"))).toBe(true);
  });

  test("defaults the connection", () => {
    void registry.run("data.openGrid", { table: "comments" });
    expect([...workspace.tabs.keys()].some((id) => id.includes("default"))).toBe(true);
  });

  test("refuses a missing table", () => {
    expect(() => registry.run("data.openGrid", {})).toThrow("expected a non-empty string");
  });

  test("is disabled without the platform's data routes, with a reason", () => {
    ctx = makeContext({ project: { open: true } });
    expect(registry.isEnabled("data.openGrid")).toBe(false);
    expect(registry.disabledReason("data.openGrid")).toBe("a platform that serves the data routes");
  });
});

describe("settings.open", () => {
  test("opens on Overview with no argument", async () => {
    await registry.run("settings.open");
    expect(settingsDocumentSection()).toBe("overview");
    expect(workspace.tabs.get("project.json")).toBeDefined();
  });

  test("opens on a built-in section", async () => {
    await registry.run("settings.open", { section: "cssVars" });
    expect(settingsDocumentSection()).toBe("cssVars");
  });

  test("RETARGETS an already-open document — the predecessor was open-once-then-inert", async () => {
    await registry.run("settings.open", { section: "cssVars" });
    await registry.run("settings.open", { section: "head" });
    expect(settingsDocumentSection()).toBe("head");
  });

  test("accepts a section that only exists after the extension sync", async () => {
    await registry.run("settings.open", { section: "content" });
    expect(settingsDocumentSection()).toBe("content");
    expect(settingsSectionKeys()).toContain("connections");
  });

  test("accepts an entry of a contributed section, and refuses one it has not got", async () => {
    await registry.run("settings.open", { entry: "posts", section: "content" });
    expect(settingsDocumentSection()).toBe("content");
    expect(await refusal("settings.open", { entry: "drafts", section: "content" })).toContain(
      'is not an entry of settings section "content" — entries: comments, posts',
    );
  });

  test("refuses an entry with no section to name it in", async () => {
    expect(await refusal("settings.open", { entry: "posts" })).toContain(
      'argument "entry" needs a "section"',
    );
  });

  test('refuses a key nothing registers — "css-variables" is not "cssVars"', async () => {
    expect(await refusal("settings.open", { section: "css-variables" })).toContain(
      'command "settings.open" argument "section": "css-variables" is not a registered settings ' +
        "section — registered:",
    );
  });

  test("the refusal lists every registered key, contributed ones included", async () => {
    expect(await refusal("settings.open", { section: "nope" })).toContain("connections");
  });

  test("refuses a non-string section", async () => {
    expect(await refusal("settings.open", { section: 3 })).toContain("expected a non-empty string");
  });

  test("is hidden with no project open", () => {
    ctx = makeContext();
    expect(registry.isVisible("settings.open")).toBe(false);
  });
});

describe("library.open", () => {
  test("opens the Library tab, and is idempotent", async () => {
    void registry.run("library.open");
    await flush();
    expect(workspace.tabs.has("grid://library")).toBe(true);
    const before = workspace.tabs.size;
    void registry.run("library.open");
    await flush();
    expect(workspace.tabs.size).toBe(before);
  });

  test("the Library tab draws the library editor kind, not the canvas", async () => {
    void registry.run("library.open");
    await flush();
    expect(workspace.tabs.get("grid://library")?.capabilities.modes).toEqual(["manage"]);
  });

  test("is hidden with no project open", () => {
    ctx = makeContext();
    expect(registry.isVisible("library.open")).toBe(false);
  });
});

describe("the Library's state setters", () => {
  test("refuse a category the Library does not declare, naming what it does", async () => {
    expect(await refusal("library.setCategory", { category: "widgets" })).toContain(
      "declared: all, pages, layouts, components, content, media",
    );
  });

  test("refuse a layout that is not one of the five", async () => {
    expect(await refusal("library.setLayout", { layout: "gallery" })).toContain(
      "declared: table, cards, media, calendar, board",
    );
  });

  test("refuse a new-entry kind the project does not declare, listing what it does", async () => {
    expect(await refusal("library.newEntry", { type: "widget" })).toContain("collection:comments");
  });

  test("none of them is a toggle — every one names the state it reaches", () => {
    for (const command of libraryCommands()) {
      expect(command.id).not.toMatch(/\.toggle[A-Z]/);
    }
  });
});

describe("project.new", () => {
  test("opens the wizard with no argument", async () => {
    void registry.run("project.new");
    await flush();
    expect(
      document.querySelector(".new-project-modal, .np-modal, sp-dialog-wrapper"),
    ).not.toBeNull();
  });

  test("accepts a declared source tab", () => {
    expect(() => registry.run("project.new", { tab: "import" })).not.toThrow();
  });

  test("refuses an undeclared source tab, naming the three", () => {
    expect(() => registry.run("project.new", { tab: "template" })).toThrow(
      `declared: ${NEW_PROJECT_TABS.join(", ")}`,
    );
  });

  test("is available with no project open — it is how you get one", () => {
    ctx = makeContext();
    expect(registry.isVisible("project.new")).toBe(true);
  });
});
