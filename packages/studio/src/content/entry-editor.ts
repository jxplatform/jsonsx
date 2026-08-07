/// <reference lib="dom" />
/**
 * The **Entry editor** — a content entry's fields, as a form, in a pane (§7.4, plan §9.2).
 *
 * Until now a markdown entry could be edited two ways and neither was its schema: the canvas edited
 * its BODY, and the Document Header card drew a field list from `panels/frontmatter-fields.ts`'s
 * own type→widget ladder, which is a second implementation of `ui/schema-form.ts` with no reference
 * branch, no validation and no value-source ladder. A JSON entry (`authors/ada.json`) had no field
 * editor at all — it opened as a component tree, so `bio` was a node's property and `links` was a
 * child array.
 *
 * This is one editor over `renderForm`, so every improvement to the engine reaches content entries,
 * settings and the inspector at once — and the `reference` control in particular arrives here for
 * free, which is what makes `author: { "$ref": "#/content/authors" }` a picker instead of a text
 * field you have to type an id into.
 *
 * **It is an editor of the same tab, not a second document.** Like `settings/settings-document.ts`,
 * it unshifts its mode onto the tab the file already has, so ⌘S, the dirty flag, the transaction
 * log and undo are the ordinary document verbs. Every field commits through
 * {@link mutateEntryField}, so an edit made here is undone by ⌘Z and replayed by a collaborator
 * exactly as one made in the Document Header card.
 *
 * **One editor, two storage shapes.** A markdown entry keeps its fields in frontmatter; a JSON
 * entry IS its fields. `content/entry-fields.ts` owns that single question, and this file never
 * touches `content.frontmatter` directly — reading it unconditionally is what made a JSON entry's
 * form blank, its valid required fields look absent, and every edit vanish at save time.
 *
 * **The mode is registered in all three tables.** `commands/context.ts` holds the one map from mode
 * to editor kind; a mode missing from it does not fail, it silently answers `"canvas"`, and that is
 * how ⌘V once inserted an element node into `project.json`. `entry` → `entry` → "Entry" is added to
 * `EDITOR_KIND_BY_MODE`, `EditorKind` and `EDITOR_KIND_LABELS` in the same change as this file.
 *
 * @docs studio/projects/content-types
 */

import { html, nothing, render as litRender } from "lit-html";
import { activeRegistry } from "../commands/active-registry";
import { effect, effectScope } from "../reactivity";
import { projectState } from "../store";
import { resolveContextPointer } from "../services/context-resolver";
import { transactDoc } from "../tabs/transact";
import { renderForm } from "../ui/schema-form";
import { paneRegion } from "../ui/regions";
import { activateTab, workspace } from "../workspace/workspace";
import { commitEntryFields, entryFields, mutateEntryField } from "./entry-fields";
import { DRAFT_FIELD, DRAFT_MEANING, hasDraftAxis, isDraftEntry } from "./draft-state";
import { collectionOfPath, missingRequired } from "./entry-model";
import type { EntryCollection } from "./entry-model";
import type { JsonSchema, SchemaFormContext } from "../ui/schema-form";
import type { Tab } from "../tabs/tab";
import type { CanvasSurface } from "../canvas/canvas-surface";
import type { JsonValue } from "../types";

/** The `canvasMode` the entry form draws under. */
export const ENTRY_MODE = "entry";

/** What an entry tab's mode list becomes when the Entry editor opens it: the form leads. */
const ENTRY_TAB_MODES = [ENTRY_MODE];

// ─── Mounting ────────────────────────────────────────────────────────────────

interface ActiveEntryPane {
  /** The pane whose stage this form is drawn on. */
  paneId: string;
  tabId: string;
  wrap: HTMLElement;
  scope: { stop: () => void; run: <T>(fn: () => T) => T | undefined };
}

/**
 * The entry form mounted in each pane, keyed by pane id.
 *
 * `entry` is one of the kinds the side pane may host, so this singleton was reachable from two
 * panes at once the day the grid drew a second cell: pane B's mount stopped pane A's effect scope,
 * leaving a form on screen that no longer tracked its own frontmatter.
 */
const _active = new Map<string, ActiveEntryPane>();

/** The form mounted in a pane, or null. */
function activeIn(paneId: string): ActiveEntryPane | null {
  return _active.get(paneId) ?? null;
}

/** Whether this tab's entry form is already mounted in this pane and still in the document. */
export function entryPaneMounted(paneId: string, tab: Tab): boolean {
  const panel = activeIn(paneId);
  return panel !== null && panel.tabId === tab.id && panel.wrap.isConnected;
}

/** Tear one pane's entry form down (mode change, tab switch, project close). Idempotent. */
export function detachEntryPane(paneId: string): void {
  const panel = _active.get(paneId);
  if (!panel) {
    return;
  }
  panel.scope.stop();
  _active.delete(paneId);
}

// ─── Drafts ──────────────────────────────────────────────────────────────────

/**
 * Set this entry's draft flag. A setter, never a toggle — the pill, the command and the assistant
 * all reach the same state whatever it was before.
 *
 * `draft: false` is written rather than removed. The absence of the key and the value `false` mean
 * the same thing to a reader, but only one of them survives a glance at the file, and an author who
 * has explicitly published something should be able to see that they did.
 */
export function setEntryDraft(tab: Tab, draft: boolean): void {
  transactDoc(tab, (t) => mutateEntryField(t, DRAFT_FIELD, draft as JsonValue));
}

/**
 * The draft pill for a tab, or `nothing`.
 *
 * Drawn on the pane's tab chip (`panels/tab-strip.ts`) rather than only inside the editor, because
 * the failure this exists to prevent is publishing something you thought was private — and that
 * mistake is made while looking at a tab, not while looking at a form. It renders for any entry
 * whose collection declares the field, so "Published" is as visible as "Draft"; a collection with
 * no draft workflow shows neither.
 */
export function entryDraftPill(tab: Tab) {
  const collection = collectionOfPath(tab.documentPath);
  const fields = entryFields(tab);
  if (!collection || !hasDraftAxis(collection.schema, fields)) {
    return nothing;
  }
  const draft = isDraftEntry(fields);
  return html`<span
    class=${draft ? "entry-pill entry-pill--draft" : "entry-pill"}
    title=${draft ? DRAFT_MEANING : "Not marked a draft."}
    >${draft ? "Draft" : "Published"}</span
  >`;
}

// ─── The form ────────────────────────────────────────────────────────────────

/** The form's host context: enum pointers resolve against this project's configuration. */
function formContext(tab: Tab): SchemaFormContext {
  return {
    fieldKeyPrefix: `entry:${tab.id}`,
    resolvePointer: (pointer, scope) =>
      resolveContextPointer(pointer, {
        projectConfig: (projectState?.projectConfig ?? {}) as Record<string, unknown>,
        scope,
      }),
  };
}

/**
 * Required fields this entry does not have.
 *
 * Deliberately keyed on ABSENCE, not emptiness. A seeded entry's `title: ""` is present and the
 * author has not done anything wrong yet, so §7.1 says not to paint it red; a required key that is
 * missing from the file is a fact about the document, and saying so is the whole reason the form
 * knows the schema.
 */
function absentRequiredErrors(
  collection: EntryCollection,
  fields: Record<string, unknown>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of missingRequired(collection.schema, fields)) {
    errors[field] = "Required — this entry does not have one.";
  }
  return errors;
}

/** The header: what this is, and whether it is a draft. */
function headerTpl(tab: Tab, collection: EntryCollection) {
  const fields = entryFields(tab);
  const draftAxis = hasDraftAxis(collection.schema, fields);
  const draft = isDraftEntry(fields);
  return html`
    <div class="entry-editor-header">
      <h3>${tab.documentPath?.split("/").pop() ?? "Untitled"}</h3>
      <span class="entry-editor-collection">${collection.name}</span>
      ${
        draftAxis
          ? html`
              <sp-switch
                size="s"
                class="entry-draft-switch"
                ?checked=${draft}
                title=${DRAFT_MEANING}
                @change=${(e: Event) => setEntryDraft(tab, (e.target as HTMLInputElement).checked)}
                >Draft</sp-switch
              >
            `
          : nothing
      }
    </div>
    ${draft ? html`<p class="entry-editor-note">${DRAFT_MEANING}</p>` : nothing}
  `;
}

/**
 * What the editor says when the document is not an entry.
 *
 * The mode is reachable from the palette and from `__jxAutomation` on any tab, so this state is
 * real and must name the reason and the fix rather than drawing an empty form — "no fields" and
 * "this file belongs to no collection" are different sentences, and only one of them is true here.
 */
function notAnEntryTpl(tab: Tab) {
  return html`
    <div class="entry-editor-empty">
      <p>
        ${tab.documentPath ?? "This document"} is not an entry of any content collection, so there
        is no schema to draw a form from.
      </p>
      <p class="entry-editor-note">
        A collection is a <code>content</code> entry in <code>project.json</code> whose
        <code>source</code> directory contains this file and which declares a <code>schema</code>.
      </p>
      <sp-action-button
        size="s"
        @click=${() => void activeRegistry()?.run("settings.open", { section: "content" })}
        >Content types…</sp-action-button
      >
    </div>
  `;
}

/**
 * Mount the entry form into the pane.
 *
 * The same non-iframe-editor pattern as the grid, the Library and Project Settings: this owns its
 * own effect scope from here, so a field commit repaints the form and nothing else — repainting
 * through the canvas pipeline would remount the document's iframe on every keystroke.
 */
export function renderEntryMode(surface: CanvasSurface, tab: Tab): void {
  const { paneId, wrap: canvasWrap } = surface;
  if (entryPaneMounted(paneId, tab)) {
    return;
  }
  detachEntryPane(paneId);

  const scope = effectScope();
  const panel: ActiveEntryPane = { paneId, scope, tabId: tab.id, wrap: canvasWrap };
  _active.set(paneId, panel);

  const rerender = () => {
    if (activeIn(paneId) === panel) {
      draw();
    }
  };

  const draw = () => {
    const collection = collectionOfPath(tab.documentPath);
    if (!collection) {
      litRender(
        html`<div class="entry-editor" data-jx-region=${paneRegion(paneId, "entry")}>
          ${notAnEntryTpl(tab)}
        </div>`,
        canvasWrap,
      );
      return;
    }
    const fields = entryFields(tab);
    litRender(
      html`
        <div class="entry-editor" data-jx-region=${paneRegion(paneId, "entry")}>
          ${headerTpl(tab, collection)}
          <div class="entry-editor-fields" data-jx-region=${paneRegion(paneId, "entry/fields")}>
            ${renderForm(collection.schema as JsonSchema, fields, {
              context: formContext(tab),
              errors: absentRequiredErrors(collection, fields),
              onChange: (patch) => commitEntryFields(tab, patch),
              rerender,
            })}
          </div>
        </div>
      `,
      canvasWrap,
    );
  };

  scope.run(() => {
    effect(() => {
      if (activeIn(paneId) !== panel) {
        return;
      }
      // Everything the form draws from: the entry's own fields, and the schema that types them.
      // BOTH stores are read, because which one holds the fields is `entry-fields.ts`'s answer,
      // Never this effect's guess. `tab.doc.document` is also the reference every transaction
      // Replaces, so it is how an undo reaches the form whichever store the edit was in.
      void tab.doc.document;
      void tab.doc.content?.frontmatter;
      void projectState?.projectConfig?.content;
      draw();
    });
  });
}

// ─── Opening ─────────────────────────────────────────────────────────────────

/**
 * Open a content entry in its form editor.
 *
 * Reveals the tab the file already has rather than building a second one — same id, same history,
 * same dirty flag — and only then switches the editor, so an author who was editing the body keeps
 * their undo stack. Returns null when the file could not be opened at all.
 */
export async function openEntryEditor(path: string): Promise<Tab | null> {
  /* Dynamic: `files/files.ts` reaches the platform, the format registry and the packages layer, and
     a static edge from here would drag all of it into every importer of the content model. */
  const { openFileInTab } = await import("../files/files");
  await openFileInTab(path);
  for (const [id, tab] of workspace.tabs.entries()) {
    if (tab.documentPath !== path) {
      continue;
    }
    for (const mode of ENTRY_TAB_MODES) {
      if (!tab.capabilities.modes.includes(mode)) {
        tab.capabilities.modes.unshift(mode);
      }
    }
    tab.session.ui.canvasMode = ENTRY_MODE;
    tab.session.ui.preview = false;
    activateTab(id);
    return tab as Tab;
  }
  return null;
}
