/**
 * In-browser style capture — runs inside page.evaluate().
 *
 * Walks the live DOM depth-first and records getComputedStyle for each element, keyed by a stable
 * tree path (array of child-element indices) that matches the htmlToJx walk order. Also collects
 * UA-default baselines per unique tagName by rendering throwaway elements.
 */

import type { Page } from "puppeteer-core";

export interface CapturedStyle {
  /** Depth-first element-index path from <body>, e.g. [0, 2, 1]. */
  path: number[];
  tagName: string;
  styles: Record<string, string>;
}

export interface StyleCaptureResult {
  /** Per-element captured styles (allowlisted props only). */
  elements: CapturedStyle[];
  /** UA-default baselines per tagName. */
  uaDefaults: Record<string, Record<string, string>>;
  /** Media queries discovered in the page's stylesheets. */
  mediaQueries: string[];
}

/** Visually meaningful CSS properties worth capturing. */
const STYLE_ALLOWLIST: string[] = [
  // Layout
  "display",
  "position",
  "top",
  "right",
  "bottom",
  "left",
  "float",
  "clear",
  "z-index",
  "overflow",
  "overflow-x",
  "overflow-y",
  "box-sizing",
  "vertical-align",
  // Flex
  "flex-direction",
  "flex-wrap",
  "justify-content",
  "align-items",
  "align-content",
  "align-self",
  "flex",
  "flex-grow",
  "flex-shrink",
  "flex-basis",
  "gap",
  "row-gap",
  "column-gap",
  "order",
  // Grid
  "grid-template-columns",
  "grid-template-rows",
  "grid-column",
  "grid-row",
  "grid-area",
  "grid-auto-flow",
  "grid-auto-columns",
  "grid-auto-rows",
  // Box model
  "width",
  "height",
  "min-width",
  "min-height",
  "max-width",
  "max-height",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  // Border
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
  "border-top-style",
  "border-right-style",
  "border-bottom-style",
  "border-left-style",
  "border-top-color",
  "border-right-color",
  "border-bottom-color",
  "border-left-color",
  "border-top-left-radius",
  "border-top-right-radius",
  "border-bottom-right-radius",
  "border-bottom-left-radius",
  // Background
  "background-color",
  "background-image",
  "background-size",
  "background-position",
  "background-repeat",
  "background-clip",
  // Typography
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "font-variant",
  "line-height",
  "letter-spacing",
  "word-spacing",
  "text-align",
  "text-decoration",
  "text-decoration-line",
  "text-decoration-color",
  "text-decoration-style",
  "text-transform",
  "text-indent",
  "text-overflow",
  "text-shadow",
  "white-space",
  "word-break",
  "overflow-wrap",
  "color",
  // Visual
  "opacity",
  "visibility",
  "box-shadow",
  "transform",
  "transition",
  "cursor",
  "outline-style",
  "outline-width",
  "outline-color",
  "outline-offset",
  // List
  "list-style-type",
  "list-style-position",
  // Table
  "table-layout",
  "border-collapse",
  "border-spacing",
  // Content
  "content",
  "object-fit",
  "object-position",
  // Appearance
  "appearance",
  "pointer-events",
  "user-select",
  "resize",
];

/**
 * Run the style capture in a puppeteer page. Executes entirely in-browser via page.evaluate() — no
 * round-trips per element.
 */
export async function captureStyles(page: Page): Promise<StyleCaptureResult> {
  return page.evaluate((allowlist: string[]) => {
    const elements: { path: number[]; tagName: string; styles: Record<string, string> }[] = [];
    const tagsSeen = new Set<string>();

    // Depth-first walk matching htmlToJx traversal order (element children only,
    // Skipping text/comment nodes — same as hast element indexing).
    function walk(el: Element, path: number[]) {
      const tag = el.tagName.toLowerCase();
      tagsSeen.add(tag);

      const cs = window.getComputedStyle(el);
      const styles: Record<string, string> = {};
      for (const prop of allowlist) {
        const val = cs.getPropertyValue(prop);
        if (val) {
          styles[prop] = val;
        }
      }
      elements.push({ path: [...path], tagName: tag, styles });

      let childIdx = 0;
      for (const child of el.children) {
        walk(child, [...path, childIdx]);
        childIdx += 1;
      }
    }

    // Walk from <body>'s children (htmlToJx receives body.innerHTML, not body itself)
    let bodyChildIdx = 0;
    for (const child of document.body.children) {
      walk(child, [bodyChildIdx]);
      bodyChildIdx += 1;
    }

    // Build UA-default baselines per unique tagName
    const uaDefaults: Record<string, Record<string, string>> = {};
    const sandbox = document.createElement("div");
    sandbox.style.cssText =
      "position:fixed;top:-9999px;left:-9999px;visibility:hidden;pointer-events:none;";
    document.body.append(sandbox);

    for (const tag of tagsSeen) {
      try {
        const probe = document.createElement(tag);
        sandbox.append(probe);
        const cs = window.getComputedStyle(probe);
        const defaults: Record<string, string> = {};
        for (const prop of allowlist) {
          const val = cs.getPropertyValue(prop);
          if (val) {
            defaults[prop] = val;
          }
        }
        uaDefaults[tag] = defaults;
        probe.remove();
      } catch {
        // Skip exotic elements
      }
    }
    sandbox.remove();

    // Discover @media queries from stylesheets
    const mediaQueries: string[] = [];
    const mediaSeen = new Set<string>();
    for (const sheet of document.styleSheets) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      for (const rule of rules) {
        if (rule instanceof CSSMediaRule) {
          const q = rule.conditionText;
          if (!mediaSeen.has(q)) {
            mediaSeen.add(q);
            mediaQueries.push(q);
          }
        }
      }
    }

    return { elements, uaDefaults, mediaQueries };
  }, STYLE_ALLOWLIST);
}

/**
 * Re-capture computed styles at a different viewport width (for $media extraction). Returns only
 * the per-element styles — no UA defaults or media queries (reuse from base).
 */
export async function captureStylesAtWidth(page: Page, width: number): Promise<CapturedStyle[]> {
  await page.setViewport({ width, height: 900 });
  // Let layout reflow settle
  await page.evaluate(
    () =>
      new Promise<void>((r) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            r();
          });
        });
      }),
  );

  return page.evaluate((allowlist: string[]) => {
    const elements: { path: number[]; tagName: string; styles: Record<string, string> }[] = [];

    function walk(el: Element, path: number[]) {
      const tag = el.tagName.toLowerCase();
      const cs = window.getComputedStyle(el);
      const styles: Record<string, string> = {};
      for (const prop of allowlist) {
        const val = cs.getPropertyValue(prop);
        if (val) {
          styles[prop] = val;
        }
      }
      elements.push({ path: [...path], tagName: tag, styles });

      let childIdx = 0;
      for (const child of el.children) {
        walk(child, [...path, childIdx]);
        childIdx += 1;
      }
    }

    let bodyChildIdx = 0;
    for (const child of document.body.children) {
      walk(child, [bodyChildIdx]);
      bodyChildIdx += 1;
    }

    return elements;
  }, STYLE_ALLOWLIST);
}

export { STYLE_ALLOWLIST };
