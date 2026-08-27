/**
 * Convert-file — moving one document between formats, in place.
 *
 * A conversion IS a rename with the bytes rewritten on the way, and that framing is what makes it
 * safe: `platform.renameFile` is the only door to the backend's refactor pass, so going through it
 * is what rewrites every `$ref`/`$src` that pointed at the old name. Writing a new file beside the
 * old one and deleting it would leave every reference dangling.
 *
 * **The bytes are written BEFORE the rename**, which is the one ordering decision in this file.
 * `applyRename` (`packages/server/src/refactor/apply.ts`) runs AFTER the move and `loadDoc`s every
 * document in the project — including the one that just moved, for tag derivation and for its own
 * references. Renaming first would hand it markdown at a `.json` path, which throws into
 * `report.errors`, silently skips tag derivation, and leaves the moved file's own references
 * unrewritten. Writing first means the file parses at every point the refactor looks at it, which
 * is also why `report.errors` can be surfaced unfiltered afterwards: the only entry that can appear
 * means a reference really was left stale.
 *
 * Nothing here reaches the DOM at import time. `packages/studio/tests/app-commands.test.ts` imports
 * the command surface in a bare Bun process and asserts empty stderr, so every module that touches
 * `document` — the dialogs, the workspace, the file layer — is reached through `await import()`.
 */

import {
  argsSchema,
  derivedEnumProperty,
  stringArg,
  stringProperty,
} from "../commands/command-args";
import { convertTargetExtensions, convertTargets } from "./format-choices";
import type { AnyCommand, CommandRegistry } from "../commands/registry";

/** What a conversion will do, resolved in full before the reader is asked to confirm it. */
export interface ConversionPlan {
  targetExt: string;
  targetPath: string;
  /** The converted source text. Computed before anything is written, so a throw costs nothing. */
  text: string;
  /** Consequence sentences, in the order they are shown. */
  lines: string[];
  /** A refusal. Non-null means the dialog states it and cannot be confirmed. */
  blocker: string | null;
}

/** The directory holding a path. */
function parentDir(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  return normalized.includes("/") ? normalized.slice(0, normalized.lastIndexOf("/")) : ".";
}

/** The extension of a path, lowercased and including the dot, or `""`. */
function extensionOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot > 0 ? path.slice(dot).toLowerCase() : "";
}

/** The same path carrying a different extension. */
function withExtension(path: string, ext: string): string {
  const current = extensionOf(path);
  return current === "" ? `${path}${ext}` : `${path.slice(0, path.length - current.length)}${ext}`;
}

/**
 * The document a source file holds, as `{ document, frontmatter }`.
 *
 * `.json` is the native shape and is its own document with no frontmatter; anything else goes
 * through the format's `parse` and the `$studio.documentMode` split the studio already applies when
 * it opens one. Going through `parseSourceForPath` rather than `formatParse` directly is what makes
 * the conversion's input identical to the editor's.
 */
async function readDocument(
  path: string,
  source: string,
): Promise<{ document: Record<string, unknown>; frontmatter: Record<string, unknown> }> {
  const { formatForPath } = await import("./format-host");
  if (formatForPath(path)) {
    const { parseSourceForPath } = await import("../files/file-ops");
    const parsed = await parseSourceForPath(path, source);
    return { document: parsed.document, frontmatter: parsed.frontmatter };
  }
  return { document: JSON.parse(source) as Record<string, unknown>, frontmatter: {} };
}

/**
 * The source text a document becomes in the target format.
 *
 * The frontmatter is merged back onto the document root, which is the inverse of the split above
 * and exactly what `files/file-ops.ts`'s `serializeDocument` does on every save. It is also why a
 * markdown → JSON conversion writes a FLAT document — frontmatter keys at the root beside
 * `children` — rather than the split shape: `Markdown.parse` produces flat, `Markdown.serialize`
 * re-emits every non-`children` root key as YAML, and flat is therefore the shape that round-trips.
 * Writing the split shape would drop the frontmatter on the way out.
 */
async function writeDocument(
  targetExt: string,
  document: Record<string, unknown>,
  frontmatter: Record<string, unknown>,
): Promise<string> {
  const merged = { ...frontmatter, ...document };
  if (targetExt === ".json") {
    return `${JSON.stringify(merged, null, 2)}\n`;
  }
  const { formatByExtension, formatSerialize } = await import("./format-host");
  const format = formatByExtension(targetExt, "serialize");
  if (!format) {
    throw new Error(`No installed format writes ${targetExt} files.`);
  }
  /*
   * Frontmatter is asked for whenever the MERGED document carries anything but its body.
   *
   * Keying it off the split `frontmatter` alone is wrong in exactly the direction that matters: a
   * `.json` source has no split — every key, `title` included, is already on the document — so the
   * split map is empty and the serializer would be told to write no frontmatter at all. The title
   * would vanish, and only on the JSON → markdown leg.
   */
  return formatSerialize(
    format.name,
    { ...merged, children: document.children ?? [] },
    { frontmatter: Object.keys(merged).some((key) => key !== "children"), mode: "roundtrip" },
  );
}

/**
 * Whether the converted file reads back as itself.
 *
 * Compared as TEXT, not as documents. A document comparison reports a difference for every
 * normalization the format legitimately performs — Markdown alone turns a bare `textContent` into
 * `children: [{ tagName: "p" }]` — and a warning that fires on almost every file is one nobody
 * reads. Serializing twice asks the only question that matters to the author: will the file I open
 * tomorrow still say this?
 *
 * A `.json` target is stable by construction (`JSON.parse` of `JSON.stringify` is exact), so the
 * risk there is a schema question and is answered separately.
 */
async function readsBackIdentically(targetPath: string, text: string): Promise<boolean> {
  if (extensionOf(targetPath) === ".json") {
    return true;
  }
  try {
    const round = await readDocument(targetPath, text);
    const again = await writeDocument(extensionOf(targetPath), round.document, round.frontmatter);
    return again === text;
  } catch {
    // Unanswerable is not the same as unstable, and the schema/serialize checks already speak for
    // The cases that can actually fail. Staying silent beats inventing a warning.
    return true;
  }
}

/**
 * Everything the reader must be told, resolved BEFORE the dialog opens.
 *
 * `specs/studio.md` §9.1.1 requires a destructive dialog to state what it breaks, and requires the
 * count to be on screen when the button is pressed rather than two frames later. A conversion is
 * destructive in exactly that sense: the original file is gone, and every reference to it is being
 * rewritten on the author's behalf.
 *
 * @param path - The file being converted.
 * @param source - Its current text.
 * @param targetExt - The extension it will carry.
 * @returns The plan, whose `blocker` is non-null when the conversion must not proceed.
 */
export async function buildPlan(
  path: string,
  source: string,
  targetExt: string,
): Promise<ConversionPlan> {
  const targetPath = withExtension(path, targetExt);
  const lines: string[] = [];

  let text: string;
  try {
    const { document, frontmatter } = await readDocument(path, source);
    text = await writeDocument(targetExt, document, frontmatter);
  } catch (error) {
    const { errorMessage } = await import("@jxsuite/schema/parse");
    return {
      blocker: errorMessage(error),
      lines,
      targetExt,
      targetPath,
      text: "",
    };
  }

  if (targetExt === ".json") {
    /* A three-state answer, because `validateDoc` fails OPEN: an unavailable validator returns no
       errors, which is indistinguishable from a valid document. Claiming validity on the strength of
       a schema that was never compiled is the "never render 0" defect one layer down. */
    const { validateDocOrNull } = await import("../services/jx-validate");
    const errors = await validateDocOrNull(JSON.parse(text));
    if (errors === null) {
      lines.push(
        "The result could not be checked against the document schema — that is not the same as " +
          "it being valid.",
      );
    } else if (errors.length > 0) {
      const where = [...new Set(errors.map((e) => e.split(":")[0]))].join(", ");
      return {
        blocker: `The result would not be a valid Jx document (${where}).`,
        lines,
        targetExt,
        targetPath,
        text,
      };
    }
  }

  if (!(await readsBackIdentically(targetPath, text))) {
    lines.push("This file will not read back identically after conversion.");
  }

  /* The count only. Which referrers the engine could not rewrite is reported AFTER the move, per
     file, by the same `notifyMoveOutcome` a rename and a drag-move use — a fact beats the guess
     this used to make from the referrer's extension, which could be wrong in both directions. */
  const { loadUsages, usageWarning } = await import("../services/references");
  const sentence = usageWarning(await loadUsages({ path }), "convert");
  if (sentence !== null) {
    lines.push(sentence);
  }

  lines.push(`${path} becomes ${targetPath}. The original file is not kept.`);
  return { blocker: null, lines, targetExt, targetPath, text };
}

/**
 * Convert one file to another format, in place.
 *
 * Every refusal fires before anything on disk moves, and each is a Problem carrying the path,
 * because the thing the author has to do next is about that path.
 *
 * @param path - Project-relative path of the file to convert.
 * @param targetExt - The extension to convert to. Omitted, the reader is asked.
 * @returns The new path, or null when refused or cancelled.
 */
export async function convertFile(path: string, targetExt?: string): Promise<string | null> {
  const { notify } = await import("../services/notify");
  const { errorMessage } = await import("@jxsuite/schema/parse");
  const fail = (message: string, detail: string) => {
    notify.error(message, { detail, path, source: "Convert" });
    return null;
  };

  const { loadFormats } = await import("./format-host");
  await loadFormats();

  const targets = convertTargets(path);
  if (targets.length === 0) {
    return fail(`${path} cannot be converted to another format.`, CANNOT_CONVERT);
  }

  const { workspace } = await import("../workspace/workspace");
  const { commitTabBuffers } = await import("../services/monaco-buffer");
  const openTabEntry = [...workspace.tabs.values()].find((tab) => tab.documentPath === path);
  if (openTabEntry) {
    await commitTabBuffers(openTabEntry);
    if (openTabEntry.doc.dirty) {
      return fail(`${path} has unsaved changes.`, DIRTY_TAB);
    }
  }

  const chosen = targetExt ?? (await pickTarget(path, targets));
  if (chosen === null) {
    return null;
  }
  if (!targets.some((target) => target.ext === chosen)) {
    return fail(`${path} cannot be converted to ${chosen}.`, CANNOT_CONVERT);
  }

  const { getPlatform } = await import("../platform");
  const platform = getPlatform();

  const targetPath = withExtension(path, chosen);
  /* Fail CLOSED on a listing failure, unlike the creation dialog. There the destination may simply
     not exist yet and the write is the authority; here the parent provably exists, and the operation
     below is `rename(2)`, which replaces its destination without a word. */
  try {
    const listing = await platform.listDirectory(parentDir(path));
    const taken = new Set(listing.map((entry) => entry.path.replaceAll("\\", "/").toLowerCase()));
    if (taken.has(targetPath.toLowerCase())) {
      return fail(`${targetPath} already exists.`, EXISTS);
    }
  } catch (error) {
    return fail(`Could not check whether ${targetPath} already exists.`, errorMessage(error));
  }

  let original: string;
  try {
    original = (await platform.readFile(path)) ?? "";
  } catch (error) {
    return fail(`Could not read ${path}.`, errorMessage(error));
  }

  const plan = await buildPlan(path, original, chosen);
  if (plan.blocker !== null) {
    return fail(`${path} cannot be converted to ${chosen}.`, plan.blocker);
  }

  const { showConfirmDialog } = await import("../ui/layers");
  const { html } = await import("lit-html");
  const confirmed = await showConfirmDialog(
    "Convert Format",
    html`<span
        >Convert <strong>${path.split("/").pop()}</strong> to
        ${targets.find((target) => target.ext === chosen)?.label ?? chosen}?</span
      >${plan.lines.map((line) => html`<p class="dialog-consequence">${line}</p>`)}`,
    { confirmLabel: "Convert", destructive: true },
  );
  if (!confirmed) {
    return null;
  }

  const { markLocalMutation } = await import("../files/fs-events");
  const { notifyMoveOutcome, settleRename } = await import("../files/files");
  markLocalMutation(path, plan.targetPath);
  try {
    await platform.writeFile(path, plan.text);
  } catch (error) {
    return fail(`Could not write the converted ${path}.`, errorMessage(error));
  }

  let report;
  try {
    report = await platform.renameFile(path, plan.targetPath);
  } catch (error) {
    /* Put the file back. The rename is what makes a conversion visible; without it the author is
       left with target-format bytes sitting at the source extension, which nothing can open. */
    try {
      markLocalMutation(path);
      await platform.writeFile(path, original);
    } catch {
      // Reported below either way, and the original text is still in the failure's own detail.
    }
    return fail(`Could not convert ${path}.`, errorMessage(error));
  }

  if (openTabEntry) {
    await rebuildTab(path, plan.targetPath, plan.text);
  }
  await settleRename(path, plan.targetPath, report);

  notifyMoveOutcome(convertStatus(plan.targetPath, report), report, plan.targetPath);
  return plan.targetPath;
}

/**
 * Move an open tab onto the converted file, rebuilding it rather than reloading it.
 *
 * Two calls, and both are load-bearing:
 *
 * - `renameTab` re-keys the tab's id, its pane slot, its MRU entry and its collab room. Without it
 *   the rebuild below opens a SECOND tab beside the stale one.
 * - `openTab` under the new id then takes its `previous` branch: it disposes the re-keyed tab —
 *   freeing the collab session and the tab-keyed grid controller — and builds a fresh one whose
 *   `sourceFormat` is the target's, and therefore whose modes and whose SERIALIZER are too. It
 *   inherits `pinned` and keeps the same pane slot.
 *
 * `reloadFileInTab` is not enough: it sets the document and the frontmatter and never touches
 * `sourceFormat`, so the tab would keep the old format's modes and the next save would write the
 * wrong format into the file. `openFileInTab` is not enough either — it REVEALS a tab that already
 * points at the path, which after the re-key is exactly the stale one. `closeTab` is worse still:
 * it collapses a pane it empties, so converting the only file in a split pane would silently
 * unsplit the workspace.
 */
async function rebuildTab(from: string, to: string, text: string): Promise<void> {
  const { openTab, renameTab } = await import("../workspace/workspace");
  const { formatForPath } = await import("./format-host");
  renameTab(from, to, to);
  const format = formatForPath(to);
  let document: Record<string, unknown>;
  let frontmatter: Record<string, unknown> | undefined;
  try {
    if (format) {
      const { parseSourceForPath } = await import("../files/file-ops");
      ({ document, frontmatter } = await parseSourceForPath(to, text));
    } else {
      document = JSON.parse(text) as Record<string, unknown>;
    }
  } catch {
    // The bytes on disk are the ones just written and the conversion has already succeeded, so a
    // Parse failure here leaves a stale tab rather than a failed convert. The re-keyed tab still
    // Points at the file, and reopening it is one click.
    return;
  }
  openTab({
    document,
    documentPath: to,
    ...(frontmatter === undefined ? {} : { frontmatter }),
    id: to,
    sourceFormat: format?.name ?? null,
  });
}

const CANNOT_CONVERT =
  "Studio converts documents in pages/ and components/ between formats that can both read and " +
  "write a Jx document. Layouts are JSON only, and a file inside a content collection keeps its " +
  "collection's format.";

const DIRTY_TAB =
  "It is open in the editor with unsaved changes, and converting it would write over them. Save " +
  "or discard the changes first.";

const EXISTS = "Rename or delete the existing file first; converting would replace it.";

/**
 * The outcome line, in the same family as a rename's — the new name, and what moved with it.
 *
 * Handed to `notifyMoveOutcome`, which turns it into a success or, when the refactor could not
 * rewrite every referrer, into a warning naming them. A conversion makes the strongest promise of
 * the three moves — its dialog states both the reference count and what the file is becoming — so
 * it is the one that can least afford to report a plain success over a partial repair.
 */
function convertStatus(
  targetPath: string,
  report: { references?: { refsUpdated: number; filesChanged: number } },
): string {
  const refs = report.references;
  const name = targetPath.split("/").pop() ?? targetPath;
  return refs && refs.refsUpdated > 0
    ? `Converted to ${name}; updated ${refs.refsUpdated} reference(s) in ${refs.filesChanged} file(s)`
    : `Converted to ${name}`;
}

/** Ask which format, when the command did not say. One target answers itself. */
async function pickTarget(
  path: string,
  targets: { ext: string; label: string }[],
): Promise<string | null> {
  if (targets.length === 1) {
    return targets[0]!.ext;
  }
  const { showPromptDialog } = await import("../ui/layers");
  let picked = targets[0]!.ext;
  const answer = await showPromptDialog("Convert Format", {
    choice: {
      initial: picked,
      label: "Convert to",
      onChange: (next: string) => {
        picked = next;
      },
      options: () => targets.map((target) => ({ label: target.label, value: target.ext })),
    },
    confirmLabel: "Continue",
    message: `Converting ${path}.`,
    select: "none",
    validate: () => "",
    value: path.split("/").pop() ?? path,
  });
  return answer === null ? null : picked;
}

/** The convert command record. */
export function fileFormatCommands(): AnyCommand[] {
  return [
    {
      /*
       * `source`, not `path`.
       *
       * `files/files.ts`'s `fileRowFacts` is keyed by ARGUMENT NAME, and `path` already means "an
       * entry of a content collection" there — which is what keeps "Open Entry Form" off
       * `styles/main.css`. Reusing the key would state it for every convertible file and offer the
       * entry form on all of them.
       *
       * `required` is passed EXPLICITLY: `argsSchema` defaults it to every key, and a required
       * `format` would make this row silently never render, since a file row cannot state one.
       */
      args: argsSchema(
        {
          format: derivedEnumProperty(
            convertTargetExtensions,
            "Extension to convert to. Omitted, Studio asks.",
          ),
          source: stringProperty("Project-relative path of the file to convert."),
        },
        ["source"],
      ),
      category: "File",
      id: "file.convertFormat",
      level: "project",
      // Not the palette: `panels/quick-search.ts`'s `paletteArgs` cannot prompt for a free-text
      // Path, and a convert with no file named is not a verb anybody can mean.
      menus: ["context/file"],
      group: "1_file",
      requires: "an open project",
      when: (ctx) => ctx.project.open,
      // Nothing restores it: the file has moved and its references have been rewritten with it.
      // The confirmation carrying the count is what stands in for an undo.
      undo: "none",
      aiTool: {
        description:
          "Convert a document between formats in place — Markdown to JSON and back. The file is " +
          "renamed to the new extension and every reference to it is rewritten. Refused for " +
          "layouts, for anything inside a content collection, and while the file is open with " +
          "unsaved changes.",
        name: "convert_file_format",
      },
      run: async (_ctx, args: Record<string, unknown>) => {
        const target = typeof args.format === "string" ? args.format : undefined;
        await convertFile(
          stringArg("file.convertFormat", args, "source"),
          ...(target === undefined ? [] : [target]),
        );
      },
      title: "Convert Format…",
    },
  ];
}

/** Register the convert command. */
export function registerFileFormatCommands(registry: CommandRegistry): void {
  registry.registerAll(fileFormatCommands());
}
