/**
 * Walk a Jx tree and rewrite absolute asset URLs to local relative paths using a rewrite map.
 *
 * Handles: - attributes.src, attributes.href, attributes.poster, attributes.srcset -
 * style.backgroundImage (url() references) - $media nested style objects with backgroundImage
 */

import type { JxElement, JxStyle } from "@jxsuite/schema/types";
import { SRCSET_SEPARATOR } from "./srcset.ts";

/** Rewrite all asset URLs in a Jx tree in-place. Returns the count of rewrites performed. */
export function rewriteAssetUrls(
  root: JxElement,
  rewriteMap: Map<string, string>,
  sourceUrl?: string,
): number {
  let count = 0;

  function rewriteUrl(url: string): string | null {
    const rewritten = rewriteMap.get(url);
    if (rewritten) {
      return rewritten;
    }

    // Try without trailing slash
    const trimmed = url.endsWith("/") ? url.slice(0, -1) : `${url}/`;
    const alt = rewriteMap.get(trimmed);
    if (alt) {
      return alt;
    }

    // Resolve relative/protocol-relative URLs against the source page URL
    if (sourceUrl) {
      try {
        const resolved = new URL(url, sourceUrl).href;
        if (resolved !== url) {
          const fromResolved = rewriteMap.get(resolved);
          if (fromResolved) {
            return fromResolved;
          }
        }
      } catch {
        // Invalid URL — skip
      }
    }

    return null;
  }

  /*
   * Split by the same rule the collector downloads by (`SRCSET_SEPARATOR`). If the two disagreed,
   * the importer would fetch one set of URLs and rewrite another — the attribute would be
   * reassembled around fragments nothing had downloaded.
   */
  function rewriteSrcset(srcset: string): { srcset: string; collapsedTo: string | null } {
    const locals = new Set<string>();
    let unresolved = false;

    const rewritten = srcset
      .split(SRCSET_SEPARATOR)
      .map((entry) => {
        const parts = entry.trim().split(/\s+/);
        const [url = ""] = parts;
        const local = rewriteUrl(url);
        if (local) {
          count += 1;
          parts[0] = local;
          locals.add(local);
        } else {
          unresolved = true;
        }
        return parts.join(" ");
      })
      .join(", ");

    /* Every candidate now points at the ONE file the family kept, so the attribute has become a
       list of the same path repeated with different width descriptors — which lies to the browser
       about what it can choose. Collapse it, and let the compiler build a real `srcset` from the
       original it owns. A candidate that failed to resolve means the family is only partly local,
       so the attribute stays as it is rather than silently narrowing the set. */
    const collapsedTo = !unresolved && locals.size === 1 ? [...locals][0]! : null;
    return { collapsedTo, srcset: rewritten };
  }

  function rewriteCssUrls(value: string): string {
    return value.replaceAll(/url\(\s*(['"]?)(.+?)\1\s*\)/g, (_match, quote, url: string) => {
      const rewritten = rewriteUrl(url);
      if (rewritten) {
        count += 1;
        return `url(${quote}${rewritten}${quote})`;
      }
      return _match;
    });
  }

  function rewriteStyleObject(style: JxStyle): void {
    for (const [key, value] of Object.entries(style)) {
      if (typeof value === "string" && value.includes("url(")) {
        (style as Record<string, unknown>)[key] = rewriteCssUrls(value);
      } else if (typeof value === "object" && value !== null && key.startsWith("@")) {
        rewriteStyleObject(value as JxStyle);
      }
    }
  }

  function walk(node: JxElement): void {
    const attrs = node.attributes as Record<string, unknown> | undefined;

    if (attrs) {
      // Src attribute (img, video, audio, source, etc.)
      if (typeof attrs.src === "string") {
        const rewritten = rewriteUrl(attrs.src);
        if (rewritten) {
          attrs.src = rewritten;
          count += 1;
        }
      }

      // Href on non-anchor elements (could be link icon, etc.)
      if (typeof attrs.href === "string") {
        const tag = (typeof node.tagName === "string" ? node.tagName : "").toLowerCase();
        if (tag !== "a") {
          const rewritten = rewriteUrl(attrs.href);
          if (rewritten) {
            attrs.href = rewritten;
            count += 1;
          }
        }
      }

      // Poster attribute (video)
      if (typeof attrs.poster === "string") {
        const rewritten = rewriteUrl(attrs.poster);
        if (rewritten) {
          attrs.poster = rewritten;
          count += 1;
        }
      }

      // Srcset attribute
      if (typeof attrs.srcset === "string") {
        const result = rewriteSrcset(attrs.srcset);
        if (result.collapsedTo === null) {
          attrs.srcset = result.srcset;
        } else {
          delete attrs.srcset;
          /* `sizes` describes a layout that no longer exists once the candidate list is gone, and
             the compiler honours an author `sizes` over its own container measurement — so a stale
             one would misdescribe the imported layout rather than merely be redundant. */
          delete attrs.sizes;
          attrs.src = result.collapsedTo;
        }
      }
    }

    // Style object — background-image url() references
    if (node.style) {
      rewriteStyleObject(node.style);
    }

    // Recurse
    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        if (typeof child !== "string") {
          walk(child);
        }
      }
    }
  }

  walk(root);
  return count;
}
