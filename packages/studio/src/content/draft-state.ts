/**
 * The draft axis (§7.6) — what a draft IS, and whether drafts are listed. One place, every list.
 *
 * It is deliberately its own module rather than a field on a pane's state and rather than a section
 * of `entry-model.ts`. Two reasons, and the second is why the definitions live here beside the
 * flag:
 *
 * 1. **The perspective is a fact about the AUTHOR, not the surface.** A draft filter that belonged to
 *    the Library would answer for the Library only, and the same author would then be shown their
 *    draft in the collection grid, in the pages grid and in Quick Open a second later.
 * 2. **Every list that must obey it has to be able to import it.** `entry-model.ts` asks
 *    `grid/sources/content-source.ts` where a collection's entries live, so the grid source cannot
 *    ask `entry-model.ts` back what a draft is — `import/no-cycle` is an error in this repo, and
 *    the cycle would be real. This module has ONE runtime dependency (`reactivity`), so the flag
 *    and the predicate are importable from a data module, a panel and a command alike. That is the
 *    property that lets the surfaces actually share them, instead of each carrying its own `draft
 *    === true`.
 */

import { reactive } from "../reactivity";
import type { ContentTypeSchema } from "@jxsuite/schema/types";

/** The conventional boolean frontmatter field that marks an entry a draft (§7.6). */
export const DRAFT_FIELD = "draft";

/**
 * What a draft IS, in one sentence, for every surface that shows the pill.
 *
 * Deliberately does not say "excluded from production builds" — the spec's §7.6 bullet describes an
 * intent the build does not implement yet (`packages/compiler`'s `site/site-build.ts` says so
 * beside `$sitemap`), and a badge that promises a file will not ship when it will is the exact
 * class of confident-wrong statement §16 exists to end. When the compiler learns to drop drafts,
 * this constant changes and every surface changes with it.
 */
export const DRAFT_MEANING =
  "Marked a draft. Studio filters drafts out of its own lists; the build does not exclude them yet.";

// ─── What a draft is ─────────────────────────────────────────────────────────

/**
 * Whether this record is marked a draft. Only the literal `true` counts — never a truthy string.
 *
 * Takes the entry's FIELDS, whichever record they live in — `content/entry-fields.ts` answers that,
 * because a JSON collection's entry has no frontmatter and its `draft` key is on the document.
 */
export function isDraftEntry(fields: Record<string, unknown> | null | undefined): boolean {
  return fields?.[DRAFT_FIELD] === true;
}

/** Whether this collection's schema declares the draft field as a boolean. */
export function schemaDeclaresDraft(schema: ContentTypeSchema | null | undefined): boolean {
  return schema?.properties?.[DRAFT_FIELD]?.type === "boolean";
}

/**
 * Whether a surface should show a draft affordance for this entry at all.
 *
 * A collection that does not declare `draft` has no draft workflow, and painting a "Published" pill
 * on its entries — or a Draft column over its grid — would be inventing a state the project never
 * defined. An entry that carries `draft: true` anyway — because someone typed it — DOES show,
 * because the fact is on disk.
 */
export function hasDraftAxis(
  schema: ContentTypeSchema | null | undefined,
  fields?: Record<string, unknown> | null,
): boolean {
  return schemaDeclaresDraft(schema) || isDraftEntry(fields);
}

// ─── The perspective ─────────────────────────────────────────────────────────

/** The perspective. `includeDrafts` false — the default — hides entries marked `draft: true`. */
export const draftView = reactive({ includeDrafts: false });

/** Whether draft entries are currently listed. */
export function includingDrafts(): boolean {
  return draftView.includeDrafts;
}

/**
 * Set the perspective.
 *
 * A setter, never a toggle: `content.setIncludeDrafts` names the STATE it reaches, so a manifest
 * step, an assistant call and a checkbox all land on the same value however many times they run
 * (plan §13.1, and the rule `tests/app-commands.test.ts` enforces).
 *
 * Setting the flag is all this does. Repainting the lists that read it belongs to the command — see
 * `content/entry-commands.ts` — because a data module may not reach into the workspace.
 */
export function setIncludeDrafts(include: boolean): void {
  draftView.includeDrafts = include;
}

/**
 * Apply the "including drafts" perspective to a list.
 *
 * `includeDrafts` true returns the input array unchanged — identity, not a copy — so a caller can
 * cheaply tell that nothing was filtered.
 */
export function applyDraftFilter<T>(
  items: readonly T[],
  fieldsOf: (item: T) => Record<string, unknown> | null | undefined,
  includeDrafts: boolean,
): readonly T[] {
  return includeDrafts ? items : items.filter((item) => !isDraftEntry(fieldsOf(item)));
}
