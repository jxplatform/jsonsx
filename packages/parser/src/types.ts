import type { JxElement } from "@jxsuite/schema/types";

export interface MarkdownFileResult {
  slug: string;
  path: string;
  frontmatter: Record<string, unknown>;
  $children: (JxElement | string)[];
  $excerpt?: string;
  $toc?: TocEntry[];
  $readingTime?: number;
  $wordCount?: number;
  [key: string]: unknown;
}

export interface TocEntry {
  depth: number;
  text: string;
  id: string;
}

export type ContentEntry = MarkdownFileResult & Record<string, unknown>;

export interface ContentLoaderEntry {
  id: string;
  data: Record<string, unknown>;
  body: string | null;
  $children?: (JxElement | string)[];
  _meta?: {
    excerpt?: string;
    toc?: TocEntry[];
    readingTime?: number;
    wordCount?: number;
  };
}

export interface MdastNode {
  type: string;
  children?: MdastNode[];
  value?: string;
  data?: unknown;
  position?: unknown;
  depth?: number;
  ordered?: boolean | null;
  start?: number | null;
  spread?: boolean;
  isHeader?: boolean;
  name?: string;
  attributes?: Record<string, string>;
  url?: string;
  alt?: string;
  title?: string | null;
  lang?: string | null;
  meta?: string | null;
  align?: (string | null)[] | null;
}

export interface HastNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  value?: string;
}
