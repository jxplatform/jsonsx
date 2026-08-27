/**
 * The content-entry verbs: create one, open one as a form, mark one a draft, and choose whether
 * drafts are listed at all.
 *
 * Each is a record in its owning module, so the palette row, the assistant's tool, the automation
 * step and (for the two that declare one) the context-menu item are renderings of the same
 * declaration. Two of them are **setters and not toggles** — `content.setDraft {draft}` and
 * `content.setIncludeDrafts {include}` name the state they reach, because "toggle the draft flag"
 * run twice by a script leaves the entry exactly where it started and run once against an unknown
 * default publishes something private.
 */

import {
  argsSchema,
  booleanArg,
  booleanProperty,
  derivedEnumProperty,
  enumArg,
  stringArg,
  stringProperty,
} from "../commands/command-args";
import {
  defaultContentFormat,
  formatByName,
  formatForPath,
  formatSerialize,
  loadFormats,
} from "../format/format-host";
import { notify } from "../services/notify";
import { activeTab } from "../workspace/workspace";
import { invalidateReferenceEntries } from "../ui/form-controls";
import { reloadDraftAwareGrids } from "../grid/sources/content-source";
import { setIncludeDrafts } from "./draft-state";
import { collectionOfPath, entryCollection, entryCollections, seedEntry } from "./entry-model";
import { LOCALE_PLACEHOLDER, collectionForDirectory } from "./collection-match";
import { openEntryEditor, setEntryDraft } from "./entry-editor";
import { errorMessage } from "@jxsuite/schema/parse";
import type { EntryCollection } from "./entry-model";
import type { AnyCommand, CommandRegistry } from "../commands/registry";
import type { Tab } from "../tabs/tab";

/** Collection names a New Entry can be created in — the `enum` behind `content.newEntry`. */
function creatableCollections(): string[] {
  return entryCollections().map((collection) => collection.name);
}

/**
 * The source text a new entry starts as.
 *
 * A `json` collection is serialized here rather than through the format registry, because JSON is
 * the one native collection shape (site-architecture.md §6.2) and has no format class to ask.
 *
 * `collectionInfo` derives `.json` exactly when no format class claimed the collection — the
 * extension and the serializer name come off the same three lookups in the same order — so "the
 * extension is .json" and "no format can write this" are one condition, and the second is not a
 * separate failure to report. Writing JSON into a `.md` file is therefore not a state this can
 * reach.
 */
async function seedText(collection: EntryCollection): Promise<string> {
  const seed = seedEntry(collection.schema);
  const formatName =
    (collection.def.format ? formatByName(collection.def.format)?.name : undefined) ??
    formatForPath(`untitled${collection.ext}`)?.name ??
    defaultContentFormat()?.name;
  if (collection.ext === ".json" || formatName === undefined) {
    return JSON.stringify(seed, null, 2);
  }
  return formatSerialize(
    formatName,
    { ...seed, children: [] },
    { frontmatter: Object.keys(seed).length > 0, mode: "roundtrip" },
  );
}

/**
 * Create an entry in a collection and open it in its form editor.
 *
 * The file goes through `files/files.ts`'s single creation flow — the same name field, the same
 * "already exists" refusal, the same Problem on failure as the Files tree and the Library — with
 * two things this caller supplies that a generic "New File" cannot: the collection's **extension**,
 * so the field asks for a display name and the file is actually matched by the collection it was
 * created in, and a **body seeded from the schema**, so the entry is valid the moment it exists
 * instead of being a pile of absent required fields.
 *
 * `opts.dir` names a directory INSIDE the collection — the Files tree creating in a subdirectory of
 * the source root. It is checked by MEMBERSHIP (`collectionForDirectory` must answer with this same
 * collection) rather than by string prefix, because `collection.dir` may still carry a `{locale}`
 * placeholder, and a prefix test against a template rejects every real directory it stands for.
 *
 * @returns The created path, or null when the author cancelled or the write failed.
 */
export async function createEntry(
  collectionName: string,
  opts: { dir?: string } = {},
): Promise<string | null> {
  const collection = entryCollection(collectionName);
  if (!collection) {
    notify.error(`No content collection named "${collectionName}" to create an entry in.`, {
      detail:
        "A collection needs a `content` entry in project.json whose `source` is a directory. A " +
        "collection whose source names a single file (a CSV catalogue) has rows, not entry files.",
      source: "Content",
    });
    return null;
  }
  await loadFormats().catch(() => {
    /* An unreachable format registry is not a reason to refuse: `seedText` falls back to the
       native JSON shape, and the serializer's own failure is reported below with the path. */
  });
  let content: string;
  try {
    content = await seedText(collection);
  } catch (error) {
    notify.error(`Could not prepare a new ${collection.name} entry.`, {
      detail: errorMessage(error),
      path: collection.dir,
      source: "Content",
    });
    return null;
  }

  /*
   * Where the entry lands.
   *
   * A localized collection's `dir` is `content/exhibitions/{locale}` — a path nobody has. Creating
   * there makes a directory literally named `{locale}`, which is what `content.newEntry` from the
   * palette and the `new_content_entry` tool have been doing. There is no default locale to pick on
   * the author's behalf (choosing one silently files the entry under a language), so this refuses
   * and names the gesture that works.
   */
  const requested = opts.dir;
  const destination =
    requested !== undefined && collectionForDirectory(requested)?.name === collection.name
      ? requested
      : collection.dir;
  if (destination.includes(LOCALE_PLACEHOLDER)) {
    notify.error(`"${collection.name}" is a localized collection.`, {
      detail:
        `Its entries live in one directory per language (${collection.dir}). Open the folder for ` +
        "the language you are writing in and create the entry there.",
      path: collection.dir,
      source: "Content",
    });
    return null;
  }

  const { createFileIn } = await import("../files/files");
  const created = await createFileIn({
    content,
    dir: destination,
    format: { ext: collection.ext, kind: "fixed" },
    source: "Content",
    suggestedName: "untitled",
    title: `New ${collection.name} entry`,
  });
  if (created === null) {
    return null;
  }
  // The picker's choices just changed; a cached list would keep offering the old set.
  invalidateReferenceEntries(collection.name);
  await openEntryEditor(created);
  return created;
}

/** The active tab, when it is a content entry — the subject of the document-level verbs. */
function activeEntryTab(): Tab | null {
  const tab = activeTab.value as Tab | null;
  return tab && collectionOfPath(tab.documentPath) ? tab : null;
}

/** The content-entry command records. */
export function contentCommands(): AnyCommand[] {
  return [
    {
      args: argsSchema({
        collection: derivedEnumProperty(
          creatableCollections,
          "The content collection the entry is created in.",
        ),
      }),
      category: "File",
      id: "content.newEntry",
      level: "project",
      menus: ["palette"],
      group: "1_file",
      requires: "a project with a directory-backed content collection",
      when: (ctx) => ctx.project.open,
      enablement: () => creatableCollections().length > 0,
      undo: "project",
      aiTool: {
        description:
          "Create a content entry in one of the project's collections, seeded from that " +
          "collection's schema defaults, and open it in the entry form.",
        name: "new_content_entry",
      },
      run: async (_ctx, args) => {
        const names = creatableCollections();
        await createEntry(enumArg("content.newEntry", args, "collection", names));
      },
      title: "New Entry",
    },
    {
      args: argsSchema({
        path: stringProperty("Project-relative path of the entry file to open."),
      }),
      category: "File",
      id: "content.openEntry",
      level: "project",
      menus: ["context/file", "palette"],
      group: "1_file",
      requires: "an open project",
      when: (ctx) => ctx.project.open,
      aiTool: {
        description:
          "Open a content entry as a schema-driven form — its collection's fields, with a picker " +
          "for every reference to another collection.",
        name: "open_entry_form",
      },
      run: async (_ctx, args) => {
        await openEntryEditor(stringArg("content.openEntry", args, "path"));
      },
      title: "Open Entry Form",
    },
    {
      args: argsSchema({
        draft: booleanProperty(
          "True marks the open entry a draft; false marks it published. Written as a `draft` " +
            "field on the entry.",
        ),
      }),
      category: "Document",
      id: "content.setDraft",
      level: "document",
      menus: ["context/tab", "palette"],
      group: "3_document",
      requires: "a content entry open",
      when: (ctx) => ctx.document.open,
      enablement: () => activeEntryTab() !== null,
      undo: "document",
      aiTool: {
        description:
          "Mark the open content entry a draft, or published. Studio filters drafts out of its " +
          "own lists; the build does not exclude them yet.",
        name: "set_entry_draft",
      },
      run: (_ctx, args) => {
        const tab = activeEntryTab();
        if (!tab) {
          throw new Error("content.setDraft: the active document is not a content entry");
        }
        setEntryDraft(tab, booleanArg("content.setDraft", args, "draft"));
      },
      title: "Set Draft",
    },
    {
      args: argsSchema({
        include: booleanProperty("True lists entries marked `draft: true` alongside the rest."),
      }),
      category: "View",
      id: "content.setIncludeDrafts",
      level: "project",
      menus: ["palette"],
      group: "2_view",
      requires: "an open project",
      when: (ctx) => ctx.project.open,
      aiTool: {
        description: "Choose whether draft entries appear in Studio's content listings.",
        name: "set_including_drafts",
      },
      /*
       * Set the flag, then repaint what reads it.
       *
       * The second half is the wiring, and without it this command sets a value nobody looks at
       * again: a collection grid holds the rows it loaded once, so an author who asks to see their
       * drafts watches an unchanged table. `draft-state.ts` cannot do it — it is imported BY the
       * listings and reaching back into the workspace from there is the cycle. The command can,
       * because a command is exactly the place where "the state changed" becomes "the app changed".
       */
      run: async (_ctx, args) => {
        setIncludeDrafts(booleanArg("content.setIncludeDrafts", args, "include"));
        await reloadDraftAwareGrids();
      },
      title: "Include Drafts",
    },
  ];
}

/** Register the content-entry verbs. */
export function registerContentCommands(registry: CommandRegistry): void {
  registry.registerAll(contentCommands());
}
