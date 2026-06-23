/**
 * Walk a Jx tree and rewrite absolute asset URLs to local relative paths using a rewrite map.
 *
 * Handles: - attributes.src, attributes.href, attributes.poster, attributes.srcset -
 * style.backgroundImage (url() references) - $media nested style objects with backgroundImage
 */

import type { JxElement, JxStyle } from "@jxsuite/schema/types";

/** Rewrite all asset URLs in a Jx tree in-place. Returns the count of rewrites performed. */
export function rewriteAssetUrls(root: JxElement, rewriteMap: Map<string, string>): number {
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

    return null;
  }

  function rewriteSrcset(srcset: string): string {
    return srcset
      .split(",")
      .map((entry) => {
        const parts = entry.trim().split(/\s+/);
        const [url] = parts;
        const rewritten = rewriteUrl(url);
        if (rewritten) {
          count += 1;
          parts[0] = rewritten;
        }
        return parts.join(" ");
      })
      .join(", ");
  }

  function rewriteCssUrls(value: string): string {
    return value.replaceAll(/url\(\s*(['"]?)(.+?)\1\s*\)/g, (_match, quote, url) => {
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
        const tag = (node.tagName ?? "").toLowerCase();
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
        attrs.srcset = rewriteSrcset(attrs.srcset);
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
