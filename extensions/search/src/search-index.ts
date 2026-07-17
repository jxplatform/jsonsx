/**
 * Search-index — the `search` project-section owner.
 *
 * `projectData` normalizes the section into `_project.search`; `emit` (extensions.md §8.4) builds
 * the site's search index from the loaded content collections and returns it for the host to write
 * into the build output. Documents come in two granularities: one per content entry (full text)
 * and, when `sections` is on, one per heading section carrying a `#anchor` deep link (heading ids
 * are assigned by the parser — parser.md §3.2).
 *
 * @docs extending/extensions/search
 */

import { entryUrl, jxTreeToText, normalizeSearchConfig, splitSections } from "./shared.ts";
import type { NormalizedSearchConfig } from "./shared.ts";
import type { ContentLoaderEntry, JxElement } from "@jxsuite/schema/types";

/** One searchable document in the emitted index. */
export interface SearchDocument {
  /**
   * Unique id: `<collection>:<entry-id>` for pages, `<collection>:<entry-id>#<anchor>` for
   * sections.
   */
  id: string;
  collection: string;
  slug: string;
  url: string;
  title: string;
  description: string;
  /** Section heading text; empty for page-level documents. */
  heading: string;
  text: string;
}

/** The emitted index file: engine-tagged envelope around the document list. */
export interface SearchIndexEnvelope {
  version: 1;
  engine: "minisearch";
  /** Fields the client indexes (union across collections). */
  fields: string[];
  /** Per-field score boosts (merged across collections). */
  boost: Record<string, number>;
  documents: SearchDocument[];
}

/** Host context passed to `emit` (extensions.md §8.4). */
export interface EmitContext {
  projectConfig?: { build?: { trailingSlash?: string } } & Record<string, unknown>;
  root?: string;
  sections?: Record<string, unknown>;
  routes?: unknown[];
}

/**
 * The `SearchIndex` capability surface. The extension host dispatches capability methods on the
 * export named by the descriptor title (specs/extensions.md §6.1); a plain object serves the
 * static-dispatch contract exactly like a class with static methods.
 */
export const SearchIndex = {
  /** Normalize the `search` section into `_project.search` (defaults applied). */
  projectData(sectionValue: unknown): NormalizedSearchConfig {
    return normalizeSearchConfig(sectionValue);
  },

  /** Build the search index from the loaded content collections. */
  emit(sectionValue: unknown, ctx: EmitContext): { path: string; content: string }[] {
    const config = normalizeSearchConfig(sectionValue);
    const content = ctx.sections?.content as Map<string, ContentLoaderEntry[]> | undefined;
    const trailingSlash = ctx.projectConfig?.build?.trailingSlash ?? "always";

    const documents: SearchDocument[] = [];
    const fields = new Set<string>();
    const boost: Record<string, number> = {};

    for (const [name, collection] of Object.entries(config.collections)) {
      const entries = content?.get(name);
      if (!entries) {
        console.warn(
          `@jxsuite/search: collection "${name}" is not a loaded content collection — skipped`,
        );
        continue;
      }
      for (const field of collection.fields) {
        fields.add(field);
      }
      Object.assign(boost, collection.boost);

      for (const entry of entries) {
        const data = (entry.data ?? {}) as Record<string, unknown>;
        const url = entryUrl(collection.basePath, entry.id, trailingSlash);
        const title = typeof data.title === "string" ? data.title : entry.id;
        const description = typeof data.description === "string" ? data.description : "";
        const children = entry.$children as (JxElement | string)[] | undefined;

        documents.push({
          id: `${name}:${entry.id}`,
          collection: name,
          slug: entry.id,
          url,
          title,
          description,
          heading: "",
          text: jxTreeToText(children),
        });

        if (collection.sections) {
          for (const section of splitSections(children, collection.sectionDepth)) {
            documents.push({
              id: `${name}:${entry.id}#${section.anchor}`,
              collection: name,
              slug: entry.id,
              url: `${url}#${section.anchor}`,
              title,
              description,
              heading: section.heading,
              text: section.text,
            });
          }
        }
      }
    }

    const envelope: SearchIndexEnvelope = {
      version: 1,
      engine: config.engine,
      fields: [...fields],
      boost,
      documents,
    };
    return [{ path: config.output, content: JSON.stringify(envelope) }];
  },
};
