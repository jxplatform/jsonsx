/**
 * The build's filesystem half of layout resolution.
 *
 * The rule — which layout a page uses, how its children land in the layout's slots, which
 * properties the page extends onto it — is `@jxsuite/site/layout`, because the studio's canvas and
 * the cloud's live preview have to reach the same answer and neither can import this package. What
 * is left here is the part that genuinely needs a disk: turning `./layouts/base.json` into bytes,
 * and saying which file was wrong when it is.
 */

import { existsSync, readFileSync } from "node:fs";
import { parseJxDocument } from "@jxsuite/schema/parse";
import { resolve } from "node:path";
import { resolveLayout as resolveLayoutWith } from "@jxsuite/site/layout";
import type { LayoutLoader } from "@jxsuite/site/layout";
import type { JxDocument } from "@jxsuite/schema/types";

/** A {@link LayoutLoader} over the project's own directory. */
export function nodeLayoutLoader(projectRoot: string): LayoutLoader {
  return (layoutRef: string) => {
    const layoutPath = resolve(projectRoot, layoutRef);
    if (!existsSync(layoutPath)) {
      throw new Error(`Layout not found: ${layoutRef} (resolved to ${layoutPath})`);
    }
    try {
      return parseJxDocument(readFileSync(layoutPath, "utf8"), layoutPath);
    } catch (error) {
      const err = error as Error;
      throw new Error(`Invalid layout JSON at ${layoutPath}: ${err.message}`, { cause: error });
    }
  };
}

/**
 * Resolve a page's layout against a project on disk.
 *
 * @param {JxDocument} pageDoc - The raw page document
 * @param {Record<string, unknown>} projectConfig - Site configuration (for defaults.layout)
 * @param {string} projectRoot - Project root directory
 * @returns {Promise<JxDocument>} The merged document (layout wrapping page content)
 */
export function resolveLayout(
  pageDoc: JxDocument,
  projectConfig: Record<string, unknown>,
  projectRoot: string,
): Promise<JxDocument> {
  return resolveLayoutWith(pageDoc, projectConfig, nodeLayoutLoader(projectRoot));
}
