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
 */

import { camelToKebab, pureSchemeOf, resolveAtQuery, schemeSelectors } from "@jxsuite/runtime/css";

/** Id of the injected site-style tag (replace-in-place, never accumulate). */
export const SITE_STYLE_ID = "jx-site-style";

/** Serialize scalar declarations, kebab-casing property names and transposing values. */
function toDecls(props: Record<string, unknown>, transpose: (value: string) => string): string {
  return Object.entries(props)
    .map(([key, value]) => `${camelToKebab(key)}: ${transpose(String(value))}`)
    .join("; ");
}

/**
 * Build the site-style sheet text: custom properties on `:root`, plain properties on `body`,
 * conditional `@`-blocks resolved against `mediaQueries` (scheme queries dual-emitted per the
 * forced-scheme contract), and `color-scheme: light dark` declared when a scheme query exists.
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
  const rootProps: Record<string, unknown> = {};
  const bodyProps: Record<string, unknown> = {};
  const condBlocks: [string, Record<string, unknown>][] = [];

  for (const [key, value] of Object.entries(siteStyle)) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      if (key.startsWith("@")) {
        condBlocks.push([key, value as Record<string, unknown>]);
      }
      // Non-@ objects (nested element selectors) are page-content styling — the resolved doc's
      // Own style pass covers those; the site sheet handles tokens + conditional overrides.
      continue;
    }
    if (key.startsWith(":") || key.startsWith(".") || key.startsWith("[") || key.startsWith("@")) {
      continue;
    }
    if (key.startsWith("--")) {
      rootProps[key] = value;
    } else {
      bodyProps[key] = value;
    }
  }

  const rootCSS = toDecls(rootProps, transpose);
  if (rootCSS) {
    rules.push(`:root { ${rootCSS} }`);
  }
  const bodyCSS = toDecls(bodyProps, transpose);
  if (bodyCSS) {
    rules.push(`body { ${bodyCSS} }`);
  }

  for (const [atKey, block] of condBlocks) {
    const query = resolveAtQuery(atKey, mediaQueries);
    if (query === null) {
      continue;
    }
    const scheme = pureSchemeOf(query);
    const emit = (selector: string, props: string) => {
      if (!props) {
        return;
      }
      if (scheme) {
        const { auto, forced } = schemeSelectors(selector, scheme);
        rules.push(`@media ${query} { ${auto} { ${props} } }`, `${forced} { ${props} }`);
      } else {
        rules.push(`@media ${query} { ${selector} { ${props} } }`);
      }
    };
    const condRoot: Record<string, unknown> = {};
    const condBody: Record<string, unknown> = {};
    const condSubs: [string, Record<string, unknown>][] = [];
    for (const [k, v] of Object.entries(block)) {
      if (v !== null && typeof v === "object" && !Array.isArray(v)) {
        if (!k.startsWith("@")) {
          condSubs.push([k, v as Record<string, unknown>]);
        }
        continue;
      }
      if (k.startsWith("--")) {
        condRoot[k] = v;
      } else {
        condBody[k] = v;
      }
    }
    emit(":root", toDecls(condRoot, transpose));
    emit("body", toDecls(condBody, transpose));
    for (const [sel, sub] of condSubs) {
      emit(sel, toDecls(sub, transpose));
    }
  }

  if (Object.values(mediaQueries).some((q) => pureSchemeOf(q) !== null)) {
    rules.push(":root { color-scheme: light dark }");
  }

  return rules.join("\n");
}
