export interface HeadMergeContext {
  title?: string;
  siteName?: string;
  lang?: string;
  charset?: string;
  url?: string;
  siteUrl?: string;
  pageUrl?: string;
  /** `rel="alternate"` links for this page's translations (site-architecture.md §13.5). */
  alternates?: readonly { hreflang: string; href: string }[];
}

export interface SiteRoute {
  urlPattern: string;
  sourcePath?: string;
  _pathParams?: Record<string, string>;
  [key: string]: unknown;
}
