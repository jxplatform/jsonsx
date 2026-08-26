/**
 * `HeadMergeContext` moved to `@jxsuite/schema/head-merger` with the merger itself — a browser
 * bundle and a Worker both assemble the same `<head>`, and neither can import this package.
 */
export type { HeadMergeContext } from "@jxsuite/schema/head-merger";

export interface SiteRoute {
  urlPattern: string;
  sourcePath?: string;
  _pathParams?: Record<string, string>;
  [key: string]: unknown;
}
