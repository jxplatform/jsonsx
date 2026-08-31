/// <reference lib="dom" />
/**
 * Project Settings — a **document**, not a modal.
 *
 * Its predecessor (`settings-modal.ts`) was an `inset: 40px` overlay with a scrim, which meant that
 * while you tuned a design token that pushes live to the canvas, the canvas was behind the thing
 * you were tuning it in, ⌘S/⌘Z/⌘P were suspended, and "Open Data Grid" opened a tab you could not
 * see. Plan §9.3 replaces it with a document in the pane whose sections are INNER NAV: Overview ·
 * Contexts · Site head · CSS Variables · Definitions · Content types · Packages · Extensions ·
 * Deploy · Raw JSON.
 *
 * **The document is the `project.json` tab.** P6.1 made `project.json` a real Tab under the
 * transaction log with one write chokepoint (`tabs/project-config.ts`); this module opens that same
 * tab — same id, same document object — in the `settings` canvas mode. So the settings form, the
 * Project Styles catalogue and the raw JSON are three editors over ONE document, and undo, the
 * dirty flag and ⌘S are the ordinary document verbs rather than three bespoke ones. That is the
 * whole of P6.1's disclosed residual ("⌘Z reaches config history only when the `project.json` tab
 * is focused"): the settings surface now IS that tab.
 *
 * **`settings.open` did not change what it means.** §13.7 makes this phase's deliverable a
 * near-zero manifest diff: the command still means "reach project settings, optionally at a named
 * section", its args schema still declares `section`, and every shot step that names it is
 * untouched. What changed is the `run` — a Tab instead of a modal — and the frame the seven region
 * crops are taken in.
 *
 * @docs studio/projects/settings
 */

import { errorMessage } from "@jxsuite/schema/parse";
import { optionalStringArg, stringProperty } from "../commands/command-args";
import { notify } from "../services/notify";
import { requireProjectState } from "../state";
import { PROJECT_CONFIG_PATH } from "../tabs/tab";
import { activeTab, focusPane, openTab, workspace } from "../workspace/workspace";
import {
  notifySettingsDocument,
  registerSettingsSection,
  settingsDocumentSection,
  setSettingsSection,
  settingsSectionKeys,
} from "./section-registry";
import { renderContextsSection } from "./contexts-section";
import { renderCssVarsEditor } from "./css-vars-editor";
import { renderDefsEditor } from "./defs-editor";
import { renderDependenciesEditor } from "./dependencies-editor";
import { renderExtensionsSection } from "./extensions-section";
import { renderDeploySection, renderRawJsonSection } from "./project-sections";
import { renderGeneralSettings } from "./general-settings";
import { renderHeadEditor } from "./head-editor";
import { renderLocalesSection } from "./locales-section";
import { selectContributedEntry } from "./contributed-section";
// The NAME and the wire value, kept apart by that module on purpose — see its docstring.
import { PROJECT_STYLES_TITLE, PROJECT_STYLES_VIEW } from "../style/project-styles";
import type { Tab } from "../tabs/tab";
import type { AnyCommand, CommandRegistry } from "../commands/registry";

/**
 * The canvas mode the settings editor draws under.
 *
 * `project.json` already declared `["stylebook", "source"]` (`tabs/tab.ts`'s `inferModes`); this is
 * the third editor over the same document and it leads, because reaching configuration through a
 * form is what "Settings" means to everyone who is not reading the file.
 */
export const SETTINGS_MODE = "settings";

/** The tab's mode list when Project Settings opens it. Settings first, so it is the initial mode. */
const SETTINGS_TAB_MODES = [SETTINGS_MODE, "stylebook", "source"];

// ─── Built-in sections ────────────────────────────────────────────────────────
/* Orders leave gaps so a contribution can land between two built-ins. Content Types is NOT here —
   the parser extension contributes it (order 50) through its Content class descriptor's
   `$studio.settings` block, registered via ./extension-sections, which is the same path any
   extension's section takes. */

registerSettingsSection({
  icon: "sp-icon-properties",
  key: "overview",
  label: "Overview",
  order: 10,
  render: renderGeneralSettings,
});
/*
 * Contexts sits directly under Overview because it is the project's second identity: Overview says
 * what the site IS, Contexts says what it is rendered UNDER. It is a definition site only — the
 * pane context bar selects among what is defined here, and its "Manage contexts…" footer names this
 * key (plan §4.2, §2 principle 5). P6.3 is a RE-HOST: the section shipped in P4 through this same
 * registry and moves into the document's inner nav without its renderer being touched.
 */
registerSettingsSection({
  icon: "sp-icon-device-desktop",
  key: "contexts",
  label: "Contexts",
  order: 15,
  render: renderContextsSection,
});
registerSettingsSection({
  icon: "sp-icon-file-single-web-page",
  key: "head",
  label: "Site head",
  order: 20,
  render: renderHeadEditor,
});
/*
 * Locales sits under Site head because both are facts about the whole site's HEAD rather than about
 * one page: `<html lang>` and `<html dir>` are what a locale decides, and the routing choice below
 * them decides what a page's URL looks like. It is also the definition site the pane's language
 * control, the Languages panel and `i18n.addLocale` all read — there is one `i18n.locales` and this
 * is the form over it.
 */
registerSettingsSection({
  icon: "sp-icon-globe",
  key: "locales",
  label: "Locales",
  order: 25,
  render: renderLocalesSection,
});
/*
 * CSS Variables is the one section §12 P6.2 does not list, and it stays until P6.4 lands the
 * Project Styles document that is to absorb it. Deleting it here would take the project's design
 * tokens off every surface for the length of one phase — and `css-variables-shot` addresses this
 * key by name.
 */
registerSettingsSection({
  icon: "sp-icon-brush",
  key: "cssVars",
  label: "CSS Variables",
  order: 30,
  render: renderCssVarsEditor,
});
registerSettingsSection({
  icon: "sp-icon-data",
  key: "definitions",
  label: "Data Shapes",
  order: 40,
  render: renderDefsEditor,
});
registerSettingsSection({
  icon: "sp-icon-box",
  key: "dependencies",
  label: "Packages",
  order: 60,
  render: renderDependenciesEditor,
});
registerSettingsSection({
  icon: "sp-icon-plug",
  key: "extensions",
  label: "Extensions",
  order: 70,
  render: renderExtensionsSection,
});
registerSettingsSection({
  icon: "sp-icon-publish-check",
  key: "deploy",
  label: "Deploy",
  order: 80,
  render: renderDeploySection,
});
registerSettingsSection({
  icon: "sp-icon-code",
  key: "rawJson",
  label: "Raw JSON",
  order: 900,
  render: renderRawJsonSection,
});

// ─── Where the settings editor is ────────────────────────────────────────────

/**
 * Which section the settings document is showing, or `null` when it is not the active editor.
 *
 * @returns {string | null}
 */
export function activeSettingsSection(): string | null {
  return settingsDocumentOpen() ? settingsDocumentSection() : null;
}

/** Whether the active tab is the configuration document in its settings editor. */
export function settingsDocumentOpen(): boolean {
  const tab = activeTab.value as Tab | null;
  return tab?.documentPath === PROJECT_CONFIG_PATH && tab.session.ui.canvasMode === SETTINGS_MODE;
}

// ─── The document ─────────────────────────────────────────────────────────────

/**
 * Open (or reveal) the configuration document in its settings editor.
 *
 * The tab is keyed by `project.json` on purpose: opening the file from the Files tree and opening
 * Settings reach the same tab, the same history and the same dirty flag. When it is already open
 * this only switches the editor, so an author who was reading the raw JSON keeps their undo stack.
 *
 * @returns {Tab | null} The tab, or null when no project is open
 */
export function showSettingsDocument(mode: string = SETTINGS_MODE): Tab | null {
  const state = requireProjectState();
  if (!state) {
    return null;
  }
  const existing = workspace.tabs.get(PROJECT_CONFIG_PATH);
  if (existing) {
    for (const candidate of SETTINGS_TAB_MODES) {
      if (!existing.capabilities.modes.includes(candidate)) {
        existing.capabilities.modes.unshift(candidate);
      }
    }
    existing.session.ui.canvasMode = mode;
    existing.session.ui.preview = false;
    return revealTab(existing as unknown as Tab);
  }
  const tab = openTab({
    capabilities: { modes: [...SETTINGS_TAB_MODES] },
    document: (state.projectConfig ?? {}) as unknown as Record<string, unknown>,
    documentPath: PROJECT_CONFIG_PATH,
    id: PROJECT_CONFIG_PATH,
  });
  /* The mode is written here rather than left to the capability list, because `createTab` seeds
     `session.ui.canvasMode` from `resolvedModes.find(m => m !== "preview")` (`tabs/tab.ts`) — i.e.
     from `SETTINGS_TAB_MODES[0]`, which is `settings`. A second door over the same document has to
     SAY which editor it is, or `styles.open` from a cold workspace opens the settings form. The
     capability list stays in its declared order for the same reason it always had one: the tab's
     Editor control offers the modes in that order. */
  tab.session.ui.canvasMode = mode;
  tab.session.ui.preview = false;
  return tab;
}

/**
 * Make an already-open tab the active one without rebuilding it.
 *
 * `openTab` recreates the tab from scratch, which would discard the configuration document's
 * history — the one thing this phase exists to give it.
 *
 * @param {Tab} tab
 * @returns {Tab}
 */
function revealTab(tab: Tab): Tab {
  for (const pane of workspace.panes) {
    if (pane.tabOrder.includes(tab.id)) {
      pane.activeTabId = tab.id;
      /* `focusPane`, not `workspace.activePaneId = pane.id`. Moving the keyboard is four
         operations, and the assignment is one of them: the other three are `resetTabCycle` (so
         Ctrl-Tab cycles from where you now are, not from the pane you left), `promoteMru` (so the
         MRU order agrees with what is on screen) and `syncTreeSelection` (so the file tree points
         at the document you are looking at). Reopening Project Settings into the side pane left
         all three describing the pane it had come from. */
      focusPane(pane.id);
      break;
    }
  }
  return tab;
}

/**
 * Reach Project Settings, optionally at a named section.
 *
 * Awaits the contributed-section sync before returning, so a caller that then asks whether a
 * section exists is asking the complete registry. The sync is COALESCED (`extension-sections.ts`),
 * which is the second half of the deep-link fix: `refreshExtensionUi` fires the same function on
 * project activation and after every `project.json` write, and the modal started a second,
 * interleaved run whose unregister pass could take the caller's section down between the promise
 * resolving and the frame being drawn.
 *
 * @param {string} [section]
 */
export async function openProjectSettings(section?: string): Promise<void> {
  if (section !== undefined) {
    setSettingsSection(section);
  }
  showSettingsDocument();
  notifySettingsDocument();
  try {
    const { syncExtensionSettingsSections } = await import("./extension-sections");
    await syncExtensionSettingsSections();
  } catch (error) {
    /* Contributed sections are optional — the built-ins render regardless — but a contribution that
       will not load is a broken extension, and §7.2 says a thing that must be fixed and is about a
       named file is a Problem rather than a toast that erases itself. */
    notify.warn(`Could not load extension settings sections — ${errorMessage(error)}`, {
      key: "settings:sections",
      path: PROJECT_CONFIG_PATH,
      source: "Settings",
      tier: "problem",
    });
  }
  notifySettingsDocument();
}

/** Await the contributed-section sync — the readiness `probe.idle()` and the command both need. */
export async function settingsSectionsReady(): Promise<void> {
  const { extensionSectionsReady } = await import("./extension-sections");
  await extensionSectionsReady();
}

// ─── Commands ─────────────────────────────────────────────────────────────────

/**
 * Open Project Settings — optionally on a named section, optionally at a named entry.
 *
 * **This one record replaces four manifest verbs**: `openSettings`, `openSettings {section}`,
 * `settings.setSection` and the five `input: type` steps that clicked an entry row by region id.
 * The third was refused outright by plan §13.3 because its press-shim mirrored the section
 * registry's LABELS in a hand-kept map; the fourth was raw input standing in for a verb that did
 * not exist ("`settings.selectEntry` has no command record", `until: "P6.2"`). Sections have KEYS
 * and map-layout sections have ENTRY keys; this names both, so the manifest's input-step budget
 * falls by five and its unstable budget by five without one `settings.open` step changing.
 *
 * The validation is deliberately asynchronous. Extension-contributed sections (`connections`,
 * `data`, `content`) register a tick after the document opens, so refusing synchronously would
 * reject three legitimate section ids; the command opens, awaits the sync, and only then decides
 * whether the caller named something real. A wrong key therefore fails the step instead of
 * rendering an empty content pane — which is exactly what `css-variables` (the key is `cssVars`)
 * has been doing.
 *
 * @returns {AnyCommand[]}
 */
export function settingsCommands(): AnyCommand[] {
  return [
    {
      args: {
        additionalProperties: false,
        properties: {
          entry: stringProperty(
            "An entry key inside the named section (map-layout sections only), e.g. a content " +
              "type or a data connection.",
          ),
          section: stringProperty(
            "The settings section key to show. Defaults to Overview on a fresh open.",
          ),
        },
        required: [],
        type: "object",
      },
      category: "Project",
      id: "settings.open",
      level: "project",
      // ⌘⇧, — the other half of §5.3's `⌘, / ⌘⇧,` pair. `app.preferences` shipped with its chord
      // And this one did not, so the two halves of "settings" were a keystroke and a palette search.
      keybinding: "mod+shift+,",
      menus: ["commandbar/overflow", "settings/menu", "palette"],
      group: "7_settings",
      requires: "an open project",
      /* `enablement`, not `when`: with no project open this row is DRAWN, greyed, carrying the
         sentence above — §12.3's rule that a control which cannot act explains itself rather than
         vanishing, and the reason the palette greys unavailable commands instead of hiding them.
         It used to be `when`, so the rail's Settings menu held one row on the welcome screen and
         said nothing about the other two; "why can't I" had no answer anywhere. The gate itself is
         unchanged — `enabledWith` still refuses, so `registry.run` and the assistant's tool still
         throw `CommandUnavailableError` exactly as before. */
      enablement: (ctx) => ctx.project.open,
      aiTool: {
        description:
          "Open the project's Settings, optionally on a named section (overview, contexts, head, " +
          "locales, cssVars, definitions, dependencies, extensions, deploy, rawJson, or a section " +
          "an extension contributes) and optionally at a named entry within it.",
        name: "open_settings",
      },
      run: async (_commandCtx, args) => {
        const section = optionalStringArg("settings.open", args, "section");
        const entry = optionalStringArg("settings.open", args, "entry");
        await openProjectSettings(section);
        if (section === undefined) {
          if (entry !== undefined) {
            throw new RangeError(
              'command "settings.open" argument "entry" needs a "section" to name an entry of',
            );
          }
          return;
        }
        const keys = settingsSectionKeys();
        if (!keys.includes(section)) {
          throw new RangeError(
            `command "settings.open" argument "section": "${section}" is not a registered ` +
              `settings section — registered: ${keys.join(", ")}`,
          );
        }
        if (entry === undefined) {
          return;
        }
        const entries = selectContributedEntry(section, entry);
        if (entries !== null) {
          throw new RangeError(
            `command "settings.open" argument "entry": "${entry}" is not an entry of settings ` +
              `section "${section}" — entries: ${entries.join(", ") || "none"}`,
          );
        }
        notifySettingsDocument();
      },
      title: "Open Project Settings",
    },
    /*
     * The SECOND door over the same document. `project.json` has three editors — the settings form,
     * Project Styles and the raw source — and until now only one of them had a name: Project Styles
     * was reached by the pane's Editor control (which can only re-mode a tab that is ALREADY open)
     * and by a hand-written `canvasMode` assignment inside Overview. `canvas.setMode` cannot stand
     * in for this: it is level `document` and requires an open one, so from a cold workspace there
     * is nothing to re-mode.
     *
     * It is a peer of `settings.open` and declares the same gate, byte for byte (§12.4: two verbs
     * over one document declare ONE availability rule). `styles.*` is the project-level plural of
     * the selection-level `style.*` verbs in `panels/style-panel.ts`; the ids are one letter apart
     * and the levels are the reason.
     */
    {
      category: "Project",
      id: "styles.open",
      level: "project",
      menus: ["settings/menu", "palette"],
      /* A distinct ordinal inside the settings family, so the gear reads Settings → Styles.
         §12.3's lever is `group`, never a per-menu sort; `styles.open` is not in the ⬢ menu, so
         nothing else sees this string. */
      group: "7_settings_styles",
      requires: "an open project",
      // §12.4: two verbs over ONE document declare ONE availability rule, byte-identical.
      enablement: (ctx) => ctx.project.open,
      aiTool: {
        description:
          "Open the project's configuration document in its Project Styles editor — the design " +
          "tokens and the default element styles that apply across every page.",
        name: "open_project_styles",
      },
      run: () => {
        showSettingsDocument(PROJECT_STYLES_VIEW);
      },
      // Named, never spelled from the wire value: `stylebook` is shared with `dist/iframe-entry.js`
      // And may never be renamed, so nothing a reader sees is derived from it (`style/project-styles`).
      title: `Open ${PROJECT_STYLES_TITLE}`,
    },
  ];
}

/**
 * Register the settings verb.
 *
 * @param {CommandRegistry} registry
 */
export function registerSettingsCommands(registry: CommandRegistry): void {
  registry.registerAll(settingsCommands());
}
