export interface HeadMergeContext {
  title?: string;
  siteName?: string;
  lang?: string;
  charset?: string;
  url?: string;
  siteUrl?: string;
  pageUrl?: string;
}

export interface SiteRoute {
  urlPattern: string;
  sourcePath?: string;
  _pathParams?: Record<string, string>;
  [key: string]: unknown;
}
