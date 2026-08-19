/**
 * The `i18n:` family — the four verbs that are NOT a rendering context.
 *
 * Jx has no message catalogue. A translation is a different file in a different directory
 * (`specs/site-architecture.md` §13.3), so "show this page in French" is two unrelated jobs, and
 * conflating them is how a language control comes to change a chip and nothing else:
 *
 * | id                       | job                                                         |
 * | ------------------------ | ----------------------------------------------------------- |
 * | `i18n.openTranslation`   | NAVIGATION — open the sibling file for a locale             |
 * | `i18n.createTranslation` | create that sibling, seeded from the document it translates |
 * | `i18n.showParity`        | reveal the Languages panel                                  |
 * | `i18n.addLocale`         | declare a language in `project.json`                        |
 *
 * `i18n.switchLocale` is the fifth verb and lives in `canvas/canvas-utils.ts` with the per-tab UI
 * state it writes: it changes how the artboard RENDERS — `lang`, `dir` and the injected `$locale` —
 * while the text on screen stays whatever file is open. These four change which file that is, or
 * which languages exist.
 *
 * **`i18n.addLocale` is the one that is not gated on `isMultilingual`.** Gating it would make the
 * first language of a project unreachable by every door except a text editor, which is the state
 * this family exists to end.
 *
 * The locale enums are GETTERS. A command record is built at module scope — `commands/
 * app-commands.ts` builds the whole set before a project is open — so `enumProperty(locales(), …)`
 * would freeze the list at `[]` for the lifetime of the window, a defect this repo has already
 * shipped once (`content/entry-commands.ts` carries the post-mortem).
 */

import { getPlatform } from "../platform";
import { getEffectiveLocales } from "../site-context";
import { localeLabel, translationPathFor } from "@jxsuite/schema/locale";
import { notify } from "../services/notify";
import { setActivityTab } from "../shell";
import { tabOfPane } from "../canvas/canvas-surface";
import { activeTab } from "../workspace/workspace";
import { addProjectLocale } from "../settings/locales-section";
import { argsSchema, optionalStringArg, stringArg, stringProperty } from "../commands/command-args";
import type { CommandArgValues } from "../commands/command-args";
import type { AnyCommand, CommandRegistry } from "../commands/registry";
import type { Tab } from "../tabs/tab";

/** The tags a translation verb may be asked for — the project's declared locales, read live. */
function declaredLocales(): string[] {
  return getEffectiveLocales()?.locales ?? [];
}

/**
 * An enum property whose values are derived WHEN THE SCHEMA IS READ, not when the record is built.
 *
 * The getter is the whole difference from `command-args.ts`'s `enumProperty`, and it is invisible
 * in a unit test that builds the record with a project already open — see this module's header.
 */
function derivedEnumProperty(declared: () => readonly string[], description: string): object {
  return {
    description,
    get enum() {
      return [...declared()];
    },
    type: "string",
  };
}

/**
 * The document a translation verb acts on: the named pane's, or the focused one's.
 *
 * `pane` is optional because the palette addresses the focus and the pane's own context bar
 * addresses itself. Refusing by name rather than falling back to the active tab is deliberate: a
 * caller that named a pane meant that pane, and quietly translating a different document is worse
 * than doing nothing.
 *
 * A tab with no `documentPath` is refused here too. Every one of these verbs is a statement about
 * where a file LIVES, and a document that has never been written has no locale directory to be
 * beside.
 */
function addressedTab(commandId: string, args: CommandArgValues): Tab & { documentPath: string } {
  const paneId = optionalStringArg(commandId, args, "pane");
  const tab = paneId === undefined ? (activeTab.value as Tab | null) : tabOfPane(paneId);
  if (!tab) {
    throw new RangeError(
      paneId === undefined
        ? `command "${commandId}" needs a document open`
        : `command "${commandId}" argument "pane": no document is open in pane "${paneId}"`,
    );
  }
  if (tab.documentPath === null) {
    throw new RangeError(`command "${commandId}" needs a document that has been saved to a file`);
  }
  return tab as Tab & { documentPath: string };
}

/**
 * Where this document's copy in `locale` belongs, or null with the reason already notified.
 *
 * `translationPathFor` answers null for three different situations and the author needs to know
 * which: an undeclared tag, a project with no locales at all, and a path that cannot carry a locale
 * segment (a component, a layout, a file at the project root).
 */
function siblingPath(tab: Tab & { documentPath: string }, locale: string): string | null {
  const i18n = getEffectiveLocales();
  const path = translationPathFor(tab.documentPath, locale, i18n);
  if (path !== null) {
    return path;
  }
  if (i18n === null || !i18n.locales.includes(locale)) {
    notify.error(`This project does not declare ${localeLabel(locale)}.`, {
      action: "settings.open",
      detail: "Add it in Settings › Locales, or with the Add Language command.",
      source: "Languages",
    });
    return null;
  }
  notify.error(`${tab.documentPath} cannot have a translation.`, {
    detail:
      "A translation is the same file under a locale directory, so only files that live under a " +
      "routed directory — pages and content entries — have one. A layout, a component or a file " +
      "at the project root is shared by every language.",
    path: tab.documentPath,
    source: "Languages",
  });
  return null;
}

/** Whether a path is on disk. The platform has no `exists`, and a read is the honest probe. */
async function fileExists(path: string): Promise<boolean> {
  try {
    await getPlatform().readFile(path);
    return true;
  } catch {
    // A read that fails is the answer, not an error to report: "no such file" is the whole question
    // And an unreadable file is one the caller cannot open either.
    return false;
  }
}

/** The four records. */
export function i18nCommands(): AnyCommand[] {
  return [
    {
      args: argsSchema(
        {
          locale: derivedEnumProperty(
            declaredLocales,
            "The language to open this document's translation in.",
          ),
          pane: stringProperty("Pane whose document to translate. Defaults to the focused one."),
        },
        ["locale"],
      ),
      category: "File",
      id: "i18n.openTranslation",
      level: "document",
      /* `context/tab`, not `context/file`: the subject is the document a tab holds, and
         `commands/levels.ts` admits only `project` verbs onto a file row — a `document`-level
         record declared there is a level × placement violation `check-command-levels.ts` fails on.
         The brief's `context/file` was written against the file row this verb does not act on. */
      menus: ["context/tab", "palette"],
      group: "2_navigate",
      requires: "a document open in a project that declares more than one language",
      when: (ctx) => ctx.project.isMultilingual && ctx.document.open,
      aiTool: {
        description:
          "Open this document's translation in another language — the sibling file under that " +
          "locale's directory. Does not create one; use create_translation for that.",
        name: "open_translation",
      },
      run: async (_ctx, args) => {
        const tab = addressedTab("i18n.openTranslation", args);
        const locale = stringArg("i18n.openTranslation", args, "locale");
        const path = siblingPath(tab, locale);
        if (path === null) {
          return;
        }
        if (path === tab.documentPath) {
          notify.info(`${tab.documentPath} is already the ${localeLabel(locale)} copy.`, {
            source: "Languages",
          });
          return;
        }
        if (!(await fileExists(path))) {
          notify.warn(`There is no ${localeLabel(locale)} translation of this document yet.`, {
            action: "i18n.createTranslation",
            detail: `Create Translation writes ${path}, seeded from the document you are on.`,
            path,
            source: "Languages",
          });
          return;
        }
        const { openFileInTab } = await import("../files/files");
        await openFileInTab(path);
      },
      title: "Open Translation",
    },
    {
      args: argsSchema({
        locale: derivedEnumProperty(
          declaredLocales,
          "The language to create this document's translation in.",
        ),
      }),
      category: "File",
      id: "i18n.createTranslation",
      level: "document",
      menus: ["palette"],
      group: "2_navigate",
      requires: "a document open in a project that declares more than one language",
      when: (ctx) => ctx.project.isMultilingual && ctx.document.open,
      /* The document history cannot hold this: the change is a file that did not exist, and
         `undo: "project"` would claim `project.json` moved, which it did not. */
      undo: "none",
      aiTool: {
        description:
          "Create the missing translation of this document in another language, seeded with a " +
          "copy of the document being translated, and open it.",
        name: "create_translation",
      },
      run: async (_ctx, args) => {
        const tab = addressedTab("i18n.createTranslation", args);
        const locale = stringArg("i18n.createTranslation", args, "locale");
        const path = siblingPath(tab, locale);
        if (path === null) {
          return;
        }
        if (await fileExists(path)) {
          notify.info(`The ${localeLabel(locale)} translation already exists.`, {
            action: "i18n.openTranslation",
            path,
            source: "Languages",
          });
          return;
        }
        /* SEEDED FROM DISK, not from the open document. What is on screen may hold unsaved edits
           and an in-memory tree would have to be re-serialized by whichever format owns the file —
           a second serializer for the same bytes. The file the author is translating is the file
           they saved. */
        let content: string;
        try {
          content = await getPlatform().readFile(tab.documentPath);
        } catch {
          // An unreadable source is not a translation that can be seeded, and the path says which.
          notify.error(`Could not read ${tab.documentPath} to copy it.`, {
            path: tab.documentPath,
            source: "Languages",
          });
          return;
        }
        const cut = path.lastIndexOf("/");
        const { createFileIn, openFileInTab } = await import("../files/files");
        const created = await createFileIn({
          content,
          dir: cut === -1 ? "." : path.slice(0, cut),
          source: "Languages",
          suggestedName: path.slice(cut + 1),
          title: `New ${localeLabel(locale)} translation`,
        });
        if (created !== null) {
          await openFileInTab(created);
        }
      },
      title: "Create Translation",
    },
    {
      category: "View",
      id: "i18n.showParity",
      level: "project",
      menus: ["commandbar/overflow", "palette"],
      group: "2_view",
      requires: "a project that declares more than one language",
      when: (ctx) => ctx.project.isMultilingual,
      aiTool: {
        description:
          "Show the Languages panel — every page in the project against every declared language, " +
          "and which translations are missing or older than their source.",
        name: "show_translation_parity",
      },
      /* The panel is off the rail — it spends no rail slot and shifts no ⌘1-8 chord — so this
         command and the generated `panel.focus.i18n` are its only two doors, and both open the
         same one. The TITLES must differ even though the behaviour does not: the palette is a flat
         searchable list where "View: Show Languages" twice is two rows a reader cannot choose
         between. This one is named for what the panel SAYS (which pages are translated and which
         are stale); `panel.focus.i18n` is named for the panel. */
      run: () => {
        setActivityTab("i18n");
      },
      title: "Show Translation Parity",
    },
    {
      args: argsSchema({
        locale: stringProperty(
          "A BCP 47 language tag to declare — `fr`, `pt-BR`, `zh-Hant`. Canonicalized on the way " +
            "in; a malformed tag is refused rather than written.",
        ),
      }),
      category: "Project",
      id: "i18n.addLocale",
      level: "project",
      menus: ["palette"],
      group: "7_settings",
      /* THE ONE RECORD HERE THAT IS NOT GATED ON `isMultilingual`, and the reason the gate is
         spelled out at each record rather than applied to the family: a project declaring zero or
         one language is exactly the project that needs this verb. */
      requires: "an open project",
      when: (ctx) => ctx.project.open,
      undo: "project",
      aiTool: {
        description:
          "Declare a language for this project, adding it to project.json's i18n.locales. Every " +
          "other language surface reads that list.",
        name: "add_project_locale",
      },
      run: async (_ctx, args) => {
        await addProjectLocale(stringArg("i18n.addLocale", args, "locale"));
      },
      title: "Add Language",
    },
  ];
}

/** Register the `i18n:` family. */
export function registerI18nCommands(registry: CommandRegistry): void {
  registry.registerAll(i18nCommands());
}
