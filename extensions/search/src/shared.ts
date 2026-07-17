/**
 * Shared — search section normalization and content-tree text extraction.
 *
 * Pure helpers used by the build-time emitter (search-index.ts) and tests. Browser-safe.
 *
 * @docs extending/extensions/search
 */

import type { JxElement } from "@jxsuite/schema/types";

/** One collection's index configuration inside the `search` project section. */
export interface SearchCollectionConfig {
  /** URL prefix mapping entry ids to routes, e.g. `"/docs/"`. */
  basePath: string;
  /** Document fields the index searches. */
  fields?: string[];
  /** Per-field score boosts. */
  boost?: Record<string, number>;
  /** Also index one document per heading section. */
  sections?: boolean;
  /** Deepest heading level that starts its own section document. */
  sectionDepth?: number;
}

/** The raw `search` project section (schemas/project.fragment.schema.json). */
export interface SearchSection {
  engine?: "minisearch";
  output?: string;
  collections?: Record<string, SearchCollectionConfig>;
}

/** A fully-defaulted collection config. */
export type NormalizedCollectionConfig = Required<SearchCollectionConfig>;

/** The normalized section, as stored in `_project.search` and consumed by `emit`. */
export interface NormalizedSearchConfig {
  engine: "minisearch";
  output: string;
  collections: Record<string, NormalizedCollectionConfig>;
}

export const DEFAULT_OUTPUT = "/search-index.json";
export const DEFAULT_FIELDS = ["title", "heading", "text"];
export const DEFAULT_SECTION_DEPTH = 3;

/** Apply schema defaults to a raw `search` section value. */
export function normalizeSearchConfig(sectionValue?: unknown): NormalizedSearchConfig {
  const section = (sectionValue ?? {}) as SearchSection;
  const collections: Record<string, NormalizedCollectionConfig> = {};
  for (const [name, raw] of Object.entries(section.collections ?? {})) {
    collections[name] = {
      basePath: normalizeBasePath(raw.basePath ?? "/"),
      boost: raw.boost ?? {},
      fields: raw.fields ?? DEFAULT_FIELDS,
      sectionDepth: raw.sectionDepth ?? DEFAULT_SECTION_DEPTH,
      sections: raw.sections ?? true,
    };
  }
  return {
    engine: section.engine ?? "minisearch",
    output: section.output ?? DEFAULT_OUTPUT,
    collections,
  };
}

/** Ensure a basePath starts and ends with `/`. */
function normalizeBasePath(basePath: string): string {
  let path = basePath.startsWith("/") ? basePath : `/${basePath}`;
  if (!path.endsWith("/")) {
    path = `${path}/`;
  }
  return path;
}

/** Route URL of a content entry: basePath + id, honoring the site's trailingSlash setting. */
export function entryUrl(basePath: string, id: string, trailingSlash: string): string {
  const base = `${basePath}${id.replace(/^\//, "")}`;
  return trailingSlash === "never" ? base : `${base}/`;
}

/** Concatenated visible text of a Jx node tree, whitespace-collapsed. */
export function jxTreeToText(children?: (JxElement | string)[]): string {
  return collectText(children).join(" ").replaceAll(/\s+/g, " ").trim();
}

function collectText(children: (JxElement | string)[] | undefined): string[] {
  const parts: string[] = [];
  for (const node of children ?? []) {
    if (typeof node === "string") {
      parts.push(node);
      continue;
    }
    if (typeof node !== "object" || node === null) {
      continue;
    }
    if (typeof node.textContent === "string") {
      parts.push(node.textContent);
    }
    if (Array.isArray(node.children)) {
      parts.push(...collectText(node.children as (JxElement | string)[]));
    }
  }
  return parts;
}

/** One heading-delimited slice of a content entry. */
export interface ContentSection {
  heading: string;
  anchor: string;
  depth: number;
  text: string;
}

const HEADING_TAG = /^h([1-6])$/;

/**
 * Split a content entry's rendered tree into heading sections for section-level search documents. A
 * heading of depth ≤ `sectionDepth` (with an assigned `id` — see parser.md §3.2) starts a section;
 * its text runs until the next section-starting heading. Content before the first heading belongs
 * to no section (the page-level document already indexes the full text). Deeper headings' text
 * stays inside the enclosing section.
 */
export function splitSections(
  children: (JxElement | string)[] | undefined,
  sectionDepth: number,
): ContentSection[] {
  const sections: ContentSection[] = [];
  let current: (ContentSection & { parts: string[] }) | null = null;

  for (const node of children ?? []) {
    const heading = headingOf(node);
    if (heading && heading.depth <= sectionDepth && heading.anchor) {
      if (current) {
        sections.push(finishSection(current));
      }
      current = { ...heading, parts: [], text: "" };
      continue;
    }
    if (current && typeof node === "string") {
      current.parts.push(node);
    } else if (current && typeof node === "object" && node !== null) {
      current.parts.push(jxTreeToText([node]));
    }
  }
  if (current) {
    sections.push(finishSection(current));
  }
  return sections;
}

function finishSection(section: ContentSection & { parts: string[] }): ContentSection {
  const { heading, anchor, depth } = section;
  return { anchor, depth, heading, text: section.parts.join(" ").replaceAll(/\s+/g, " ").trim() };
}

function headingOf(
  node: JxElement | string,
): { heading: string; anchor: string; depth: number } | null {
  if (typeof node !== "object" || node === null || !node.tagName) {
    return null;
  }
  const match = HEADING_TAG.exec(node.tagName);
  if (!match) {
    return null;
  }
  return {
    anchor: typeof node.id === "string" ? node.id : "",
    depth: Number(match[1]),
    heading: jxTreeToText([node]),
  };
}
