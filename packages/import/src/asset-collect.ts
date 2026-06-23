/**
 * In-browser asset URL discovery — runs inside page.evaluate().
 *
 * Finds images, background images, fonts (from @font-face), favicons, and srcset entries. Inline
 * SVGs are kept as-is (no download needed). Returns absolute URLs for downloading.
 */

import type { Page } from "puppeteer-core";

export interface DiscoveredAsset {
  /** Absolute URL of the asset. */
  url: string;
  /** How it was found — guides download priority and rewrite strategy. */
  source:
    | "img-src"
    | "img-srcset"
    | "source-srcset"
    | "picture-source"
    | "video-poster"
    | "css-background"
    | "css-url"
    | "font-face"
    | "favicon"
    | "og-image";
}

export interface AssetCollectionResult {
  assets: DiscoveredAsset[];
  /** Inline SVGs found (kept inline, not downloaded). */
  inlineSvgCount: number;
}

/**
 * Collect all asset URLs from the live page DOM and stylesheets. Runs entirely in-browser via
 * page.evaluate() — no per-element round-trips.
 */
export async function collectAssets(page: Page): Promise<AssetCollectionResult> {
  return page.evaluate(() => {
    const assets: { url: string; source: string }[] = [];
    const seen = new Set<string>();
    let inlineSvgCount = 0;

    function add(url: string, source: string) {
      if (!url || seen.has(url)) {
        return;
      }
      try {
        const abs = new URL(url, location.href).href;
        // oxlint-disable-next-line no-script-url -- detection, not usage
        if (abs.startsWith("data:") || abs.startsWith("blob:") || abs.startsWith("javascript:")) {
          return;
        }
        if (seen.has(abs)) {
          return;
        }
        seen.add(abs);
        assets.push({ url: abs, source });
      } catch {
        // Invalid URL — skip
      }
    }

    function parseSrcset(srcset: string): string[] {
      return srcset
        .split(",")
        .map((entry) => {
          const [first] = entry.trim().split(/\s+/);
          return first;
        })
        .filter(Boolean);
    }

    function extractCssUrls(cssText: string): string[] {
      const urls: string[] = [];
      const re = /url\(\s*(['"]?)(.+?)\1\s*\)/g;
      let m;
      while ((m = re.exec(cssText)) !== null) {
        const u = m.at(2);
        if (u && !u.startsWith("data:")) {
          urls.push(u);
        }
      }
      return urls;
    }

    // Img[src]
    for (const el of document.querySelectorAll("img[src]")) {
      add((el as HTMLImageElement).src, "img-src");
    }

    // Img[srcset] and source[srcset]
    for (const el of document.querySelectorAll("img[srcset], source[srcset]")) {
      const srcset = el.getAttribute("srcset") ?? "";
      const source = el.tagName.toLowerCase() === "img" ? "img-srcset" : "source-srcset";
      for (const u of parseSrcset(srcset)) {
        add(u, source);
      }
    }

    // Picture > source (type-based, not just srcset)
    for (const el of document.querySelectorAll("picture > source[src]")) {
      add((el as HTMLSourceElement).src, "picture-source");
    }

    // Video[poster]
    for (const el of document.querySelectorAll("video[poster]")) {
      add((el as HTMLVideoElement).poster, "video-poster");
    }

    // Inline style url() on any element
    for (const el of document.querySelectorAll("[style]")) {
      const style = el.getAttribute("style") ?? "";
      for (const u of extractCssUrls(style)) {
        add(u, "css-url");
      }
    }

    // Computed background-image on all elements (catches CSS-applied bg images)
    for (const el of document.querySelectorAll("*")) {
      const cs = window.getComputedStyle(el);
      const bg = cs.getPropertyValue("background-image");
      if (bg && bg !== "none") {
        for (const u of extractCssUrls(bg)) {
          add(u, "css-background");
        }
      }
    }

    // @font-face from stylesheets
    for (const sheet of document.styleSheets) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      for (const rule of rules) {
        if (rule instanceof CSSFontFaceRule) {
          const src = rule.style.getPropertyValue("src");
          if (src) {
            for (const u of extractCssUrls(src)) {
              add(u, "font-face");
            }
          }
        }
      }
    }

    // Favicon and other link icons
    for (const el of document.querySelectorAll(
      'link[rel~="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]',
    )) {
      const { href } = el as HTMLLinkElement;
      if (href) {
        add(href, "favicon");
      }
    }

    // Open Graph images
    for (const el of document.querySelectorAll('meta[property="og:image"]')) {
      const { content } = el as HTMLMetaElement;
      if (content) {
        add(content, "og-image");
      }
    }

    // Count inline SVGs (kept inline, not downloaded)
    inlineSvgCount = document.querySelectorAll("svg").length;

    return { assets, inlineSvgCount } as {
      assets: { url: string; source: string }[];
      inlineSvgCount: number;
    };
  }) as Promise<AssetCollectionResult>;
}
