/// <reference lib="dom" />
/**
 * Site-style stylesheet builder — `project.json`'s `style` as a real stylesheet.
 *
 * A host emits the project's `style` as a stylesheet rather than as inline properties on the root
 * element: inline custom properties would defeat the forced-scheme override selectors
 * (`:root[data-color-scheme]`, spec §9.5), and object-valued `@--name` blocks used to be dropped
 * entirely. Scheme-query blocks dual-emit through the runtime's schemeSelectors so a host honors
 * both the OS preference and its own forced-scheme toggle.
 *
 * Two hosts share it, which is why it is here rather than in either of them: the studio canvas,
 * which passes a transposer rewriting viewport units to container units, and the live preview
 * origin, which passes identity because a browser tab IS the viewport.
 *
 * The nesting inside a block is NOT this module's own recursion any more: it delegates to
 * `buildStyleRules`, which the runtime and the compiler also use, so all three agree about what an
 * `@media` inside a selector inside an `@supports` means.
 */

import {
  buildStyleRules,
  isDeclarationAtRule,
  isNestedSelectorKey,
  pureSchemeOf,
} from "@jxsuite/runtime/css";
import type { JxStyle } from "@jxsuite/schema/types";

/** Id of the injected site-style tag (replace-in-place, never accumulate). */
export const SITE_STYLE_ID = "jx-site-style";

/**
 * Build the site-style sheet text: custom properties on `:root`, plain properties on `body`,
 * conditional `@`-blocks resolved against `mediaQueries` (scheme queries dual-emitted per the
 * forced-scheme contract), and `color-scheme: light dark` declared when a scheme query exists.
 *
 * The `:root` / `body` split is the one decision this builder owns; everything after it is handed
 * to `buildStyleRules`, which is the single definition of what a Jx style object means as CSS. That
 * is what makes a nested selector inside a conditional block compose rather than flatten to one
 * level, and what makes a host and the compiled page agree about a `@supports` block.
 *
 * @param {Record<string, unknown>} siteStyle
 * @param {Record<string, string>} mediaQueries
 * @param {(value: string) => string} transpose - Unit transposer (canvas vh→cqh etc.)
 * @returns {string}
 */
export function buildSiteStyleCSS(
  siteStyle: Record<string, unknown>,
  mediaQueries: Record<string, string>,
  transpose: (value: string) => string,
): string {
  const rules: string[] = [];
  const push = (style: JxStyle, selector: string | null) => {
    for (const rule of buildStyleRules(style, {
      mediaQueries,
      scope: selector,
      transposeValue: transpose,
    })) {
      rules.push(rule.text);
    }
  };

  const rootProps: JxStyle = {};
  const bodyProps: JxStyle = {};
  const condBlocks: [string, JxStyle][] = [];

  for (const [key, value] of Object.entries(siteStyle)) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      if (key.startsWith("@")) {
        condBlocks.push([key, value as JxStyle]);
      }
      // Non-@ objects (nested element selectors) are page-content styling — the resolved doc's
      // Own style pass covers those; the site sheet handles tokens + conditional overrides.
      continue;
    }
    if (isNestedSelectorKey(key) || key.startsWith("@")) {
      continue;
    }
    if (key.startsWith("--")) {
      rootProps[key] = value as string;
    } else {
      bodyProps[key] = value as string;
    }
  }

  push(rootProps, ":root");
  push(bodyProps, "body");

  for (const [atKey, block] of condBlocks) {
    /* A declaration-body at-rule has no selector to split across, and the name it declares is
       document-global — one block, not one per target. */
    if (isDeclarationAtRule(atKey)) {
      push({ [atKey]: block }, null);
      continue;
    }
    const condRoot: JxStyle = {};
    const condBody: JxStyle = {};
    const condSubs: [string, JxStyle][] = [];
    for (const [k, v] of Object.entries(block)) {
      if (v !== null && typeof v === "object" && !Array.isArray(v)) {
        if (!k.startsWith("@")) {
          condSubs.push([k, v as JxStyle]);
        }
        continue;
      }
      if (k.startsWith("--")) {
        condRoot[k] = v;
      } else {
        condBody[k] = v;
      }
    }
    push({ [atKey]: condRoot }, ":root");
    push({ [atKey]: condBody }, "body");
    for (const [sel, sub] of condSubs) {
      push({ [atKey]: sub }, sel);
    }
  }

  if (Object.values(mediaQueries).some((q) => pureSchemeOf(q) !== null)) {
    rules.push(":root { color-scheme: light dark }");
  }

  return rules.join("\n");
}
