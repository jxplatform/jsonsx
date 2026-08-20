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

import { canonicalizeLocale, localeUrlPrefix, resolveI18n } from "@jxsuite/schema/locale";
import { entryUrl, jxTreeToText, normalizeSearchConfig, splitSections } from "./shared.ts";
import type { NormalizedSearchConfig } from "./shared.ts";
import type { ContentLoaderEntry, JxElement, ProjectConfig } from "@jxsuite/schema/types";

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
  /**
   * The entry's language, present only for a collection spread over one directory per locale
   * (site-architecture.md §13.3). Absent means "every language" — an unlocalized collection is not
   * in one language, it is outside the question.
   */
  locale?: string;
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
    /*
     * A localized entry lives at a locale-prefixed URL, and the index is the only place that knew
     * the entry without knowing the prefix: every French post was indexed at the English post's
     * URL, so a reader who searched in French was sent to the English page. The prefix is the
     * routing rule, read from the same resolver the build reads.
     */
    const { i18n } = resolveI18n((ctx.projectConfig ?? {}) as ProjectConfig);

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
        /*
         * Only when the project declares locales. An entry cannot carry one otherwise — the loader
         * stamps it while expanding `{locale}`, which needs a list to expand over — and a stray tag
         * would make the client filter results away for a language the site does not have.
         */
        const locale =
          i18n === null ? undefined : (canonicalizeLocale(entry._meta?.locale) ?? undefined);
        const url = entryUrl(
          `${localeUrlPrefix(locale, i18n)}${collection.basePath}`,
          entry.id,
          trailingSlash,
        );
        const title = typeof data.title === "string" ? data.title : entry.id;
        const description = typeof data.description === "string" ? data.description : "";
        const children = entry.$children as (JxElement | string)[] | undefined;
        /*
         * Two translations of one post share an id (§13.3), so the document id has to carry the
         * locale as well — without it the French entry and the English one are one document and
         * whichever is indexed second wins.
         */
        const documentId =
          locale === undefined ? `${name}:${entry.id}` : `${name}:${locale}:${entry.id}`;

        documents.push({
          id: documentId,
          collection: name,
          slug: entry.id,
          url,
          title,
          description,
          heading: "",
          text: jxTreeToText(children),
          ...(locale === undefined ? {} : { locale }),
        });

        if (collection.sections) {
          for (const section of splitSections(children, collection.sectionDepth)) {
            documents.push({
              id: `${documentId}#${section.anchor}`,
              collection: name,
              slug: entry.id,
              url: `${url}#${section.anchor}`,
              title,
              description,
              heading: section.heading,
              text: section.text,
              ...(locale === undefined ? {} : { locale }),
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
