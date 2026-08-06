/**
 * The Library's verbs.
 *
 * Every piece of Library state a person can reach is reachable here, which is the difference
 * between this and the Manage view it replaces. That view's category filter, its search box and its
 * grid/table switch existed ONLY as buttons inside a modal, so `scripts/screenshots/automation.ts`
 * carried a hand-maintained `BROWSE_CATEGORY_LABELS` table and pressed the buttons through an XPath
 * matched on their rendered text — plan §13's exact complaint. `library.setCategory` is the same
 * action the button runs, and the button is now a rendering of the record.
 *
 * Every setter is idempotent and names the STATE it reaches, never a delta: there is no
 * `library.toggleLayout`, because a toggle against unstated state is what silently inverted
 * eighteen manifest steps when a default flipped.
 */

import {
  argsSchema,
  enumArg,
  enumProperty,
  optionalStringArg,
  stringProperty,
} from "../commands/command-args";
import { openLibraryTab } from "../grid/grid-open";
import { LIBRARY_CATEGORY_KEYS, LIBRARY_LAYOUTS, LIBRARY_LAYOUT_LABELS } from "./library-model";
import {
  createLibraryEntry,
  libraryNewEntries,
  refreshLibrary,
  setLibraryCategory,
  setLibraryLayout,
  setLibrarySearch,
} from "./library-pane";
import type { LibraryLayout } from "./library-model";
import type { AnyCommand, CommandRegistry } from "../commands/registry";

/** The Library's command records. */
export function libraryCommands(): AnyCommand[] {
  return [
    {
      category: "Project",
      id: "library.open",
      level: "project",
      menus: ["commandbar/overflow", "palette"],
      group: "1_file",
      requires: "an open project",
      when: (ctx) => ctx.project.open,
      aiTool: {
        description:
          "Open the Library — every page, layout, component, content entry and media file in " +
          "the project, as a browsable tab.",
        name: "open_library",
      },
      run: () => {
        openLibraryTab();
      },
      title: "Open Library",
    },
    {
      args: argsSchema({
        category: enumProperty(
          LIBRARY_CATEGORY_KEYS,
          'Which category the Library lists. "all" clears the category filter.',
        ),
      }),
      category: "Project",
      id: "library.setCategory",
      level: "project",
      menus: ["palette"],
      group: "1_file",
      requires: "an open project",
      when: (ctx) => ctx.project.open,
      aiTool: {
        description: "Filter the Library to one category of project file.",
        name: "set_library_category",
      },
      run: (_ctx, args) => {
        const key = enumArg("library.setCategory", args, "category", LIBRARY_CATEGORY_KEYS);
        setLibraryCategory(key);
      },
      title: "Library: Show Category",
    },
    {
      args: argsSchema({
        layout: enumProperty(
          LIBRARY_LAYOUTS,
          `How the Library arranges its items — ${LIBRARY_LAYOUTS.map(
            (layout) => LIBRARY_LAYOUT_LABELS[layout],
          ).join(", ")}.`,
        ),
      }),
      category: "Project",
      id: "library.setLayout",
      level: "project",
      menus: ["palette"],
      group: "1_file",
      requires: "an open project",
      when: (ctx) => ctx.project.open,
      aiTool: {
        description: "Choose the Library's layout: table, cards, media, calendar or board.",
        name: "set_library_layout",
      },
      run: (_ctx, args) => {
        const layout = enumArg<LibraryLayout>("library.setLayout", args, "layout", LIBRARY_LAYOUTS);
        setLibraryLayout(layout);
      },
      title: "Library: Set Layout",
    },
    {
      args: {
        additionalProperties: false,
        properties: {
          query: stringProperty("Text matched against each file's name and path. Empty clears it."),
        },
        type: "object",
      },
      category: "Project",
      id: "library.setSearch",
      level: "project",
      menus: ["palette"],
      group: "1_file",
      requires: "an open project",
      when: (ctx) => ctx.project.open,
      aiTool: {
        description: "Filter the Library's items by a text query over name and path.",
        name: "set_library_search",
      },
      run: (_ctx, args) => {
        setLibrarySearch(optionalStringArg("library.setSearch", args, "query") ?? "");
      },
      title: "Library: Filter Files",
    },
    {
      category: "Project",
      id: "library.refresh",
      level: "project",
      menus: ["palette"],
      group: "1_file",
      requires: "an open project",
      when: (ctx) => ctx.project.open,
      aiTool: {
        description: "Re-scan the project's files and rebuild the Library's listing.",
        name: "refresh_library",
      },
      run: () => refreshLibrary(),
      title: "Library: Rescan Files",
    },
    {
      args: {
        additionalProperties: false,
        properties: {
          type: stringProperty(
            'What to create: "page", "layout", "component", or "collection:<name>" for a ' +
              "content collection this project declares.",
          ),
        },
        required: ["type"],
        type: "object",
      },
      category: "Project",
      id: "library.newEntry",
      level: "project",
      menus: ["palette"],
      group: "1_file",
      requires: "an open project",
      when: (ctx) => ctx.project.open,
      undo: "project",
      aiTool: {
        description:
          "Create a page, layout, component or content entry in the directory its kind belongs " +
          "to, then open it.",
        name: "new_library_entry",
      },
      run: async (_ctx, args) => {
        const declared = libraryNewEntries().map((entry) => entry.key);
        const key = enumArg("library.newEntry", args, "type", declared);
        await createLibraryEntry(key);
      },
      title: "Library: New Entry",
    },
  ];
}

/** Register the Library's verbs. */
export function registerLibraryCommands(registry: CommandRegistry): void {
  registry.registerAll(libraryCommands());
}
