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

export interface CapturedStylesheet {
  /** The stylesheet's href (null for inline <style> blocks). */
  href: string | null;
  /** Full cssText of the sheet. Null if cross-origin and cssRules threw. */
  cssText: string | null;
  /** Individual @font-face rule texts extracted from the sheet. */
  fontFaceRules: string[];
}

export interface AssetCollectionResult {
  assets: DiscoveredAsset[];
  /** Inline SVGs found (kept inline, not downloaded). */
  inlineSvgCount: number;
  /** Retained source stylesheets (F0 foundation — enables font emission, breakpoint reading, etc). */
  stylesheets: CapturedStylesheet[];
}

/**
 * Collect all asset URLs from the live page DOM and stylesheets. Runs entirely in-browser via
 * page.evaluate() — no per-element round-trips.
 */
export async function collectAssets(page: Page): Promise<AssetCollectionResult> {
  const result = await page.evaluate(() => {
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

    // @font-face from stylesheets + retain full source CSS (F0)
    const stylesheets: { href: string | null; cssText: string | null; fontFaceRules: string[] }[] =
      [];
    for (const sheet of document.styleSheets) {
      let rules: CSSRuleList | null = null;
      let fullCssText: string | null = null;
      const fontFaceRules: string[] = [];
      const { href } = sheet;

      try {
        rules = sheet.cssRules;
        // Build full cssText from all rules
        const parts: string[] = [];
        for (const rule of rules) {
          parts.push(rule.cssText);
          if (rule instanceof CSSFontFaceRule) {
            fontFaceRules.push(rule.cssText);
            const src = rule.style.getPropertyValue("src");
            if (src) {
              for (const u of extractCssUrls(src)) {
                add(u, "font-face");
              }
            }
          }
        }
        fullCssText = parts.join("\n");
      } catch {
        // Cross-origin sheet — cssRules inaccessible. Record href for browser-context refetch.
      }

      stylesheets.push({ href, cssText: fullCssText, fontFaceRules });
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

    return { assets, inlineSvgCount, stylesheets } as {
      assets: { url: string; source: string }[];
      inlineSvgCount: number;
      stylesheets: { href: string | null; cssText: string | null; fontFaceRules: string[] }[];
    };
  });

  // R2: For cross-origin sheets we couldn't access (cssText=null, has href), fetch them
  // In-browser to get @font-face rules (e.g. Google Fonts loaded via <link>)
  const inaccessibleSheets = result.stylesheets.filter((s) => s.cssText === null && s.href);
  if (inaccessibleSheets.length > 0) {
    const fetched = await page.evaluate(
      async (hrefs: string[]) => {
        const results: { href: string; cssText: string; fontFaceRules: string[] }[] = [];
        for (const href of hrefs) {
          try {
            const res = await fetch(href);
            if (res.ok) {
              const text = await res.text();
              // Parse @font-face rules from the raw CSS text
              const fontFaceRules: string[] = [];
              const re = /@font-face\s*\{[^}]*\}/g;
              let match;
              while ((match = re.exec(text)) !== null) {
                fontFaceRules.push(match[0]);
              }
              results.push({ href, cssText: text, fontFaceRules });
            }
          } catch {
            // Skip unreachable sheets
          }
        }
        return results;
      },
      inaccessibleSheets.map((s) => s.href!),
    );

    // Merge fetched data back and discover font URLs
    for (const fetched_sheet of fetched) {
      const existing = result.stylesheets.find((s) => s.href === fetched_sheet.href);
      if (existing) {
        existing.cssText = fetched_sheet.cssText;
        existing.fontFaceRules = fetched_sheet.fontFaceRules;
      }

      // Extract font URLs from the fetched @font-face rules
      const urlRe = /url\(\s*(['"]?)(.+?)\1\s*\)/g;
      for (const rule of fetched_sheet.fontFaceRules) {
        let m;
        while ((m = urlRe.exec(rule)) !== null) {
          const fontUrl = m.at(2);
          if (fontUrl && !fontUrl.startsWith("data:")) {
            const abs = new URL(fontUrl, fetched_sheet.href).href;
            if (!result.assets.some((a) => a.url === abs)) {
              result.assets.push({ url: abs, source: "font-face" });
            }
          }
        }
      }
    }
  }

  return result as AssetCollectionResult;
}
