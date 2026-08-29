/**
 * The CSS-authoring rules that are not the DOM.
 *
 * `@jxsuite/runtime` renders a document in a browser, and every consumer of its root export pays
 * for that: the element registry, the reactive scope, `@vue/reactivity`. These six exports need
 * none of it. They are pure string and regex math over what a `style` block MEANS — how a property
 * name is spelled in CSS, which media query an `@`-key resolves to, and which selector pair a
 * scheme-conditional rule dual-emits as.
 *
 * They are a subpath of their own because of who else needs them. `@jxsuite/site/site-style` turns
 * `project.json`'s `style` into a stylesheet, and it runs in places the DOM runtime cannot go — a
 * static build, and a Cloudflare Worker serving a live preview. Importing the root export for
 * `camelToKebab` would put the whole renderer plus `@vue/reactivity` inside a Worker script for
 * four pure functions.
 *
 * `./runtime` re-exports all of these, so nothing that already imported them from the root export
 * has to change. This is a narrow door beside the wide one, not a replacement for it.
 */

/**
 * Convert camelCase to kebab-case.
 *
 * @param {string} s
 * @returns {string}
 */
export function camelToKebab(s: string) {
  return s.replaceAll(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

// ─── Style At-Rules ───────────────────────────────────────────────────────────

/**
 * The four CSS media types. A media _type_ is bare — `@media print` — while a media _feature_ is
 * parenthesised, so `@media (print)` reads as a boolean feature named `print`, which does not exist
 * and evaluates false.
 */
const MEDIA_TYPES = new Set(["all", "print", "screen", "speech"]);

/**
 * The media query an `@`-prefixed style key names, or null when the key is some other at-rule
 * (`@supports`, `@starting-style`) that is emitted verbatim.
 *
 * `@--name` resolves through the project's `$media` map. `@(…)` carries its own parentheses, so
 * they are stripped only when what they wrap is a bare media type: `@(print)` must become `@media
 * print`, while `@(min-width: 40rem)` keeps them.
 *
 * @param {string} atKey
 * @param {Record<string, string>} mediaQueries
 * @returns {string | null}
 * @docs framework/concepts/styling
 */
export function resolveAtQuery(atKey: string, mediaQueries: Record<string, string>): string | null {
  if (atKey.startsWith("@--")) {
    return mediaQueries[atKey.slice(1)] ?? atKey.slice(1);
  }
  if (atKey.startsWith("@(")) {
    const inner = atKey.slice(2, -1).trim();
    return MEDIA_TYPES.has(inner.toLowerCase()) ? inner : atKey.slice(1);
  }
  return null;
}

// ─── Color Schemes ────────────────────────────────────────────────────────────

/**
 * Attribute on the root element (`<html>`) that forces a color scheme. Absent = auto (follow the OS
 * `prefers-color-scheme`). Values: "light" | "dark".
 *
 * @docs framework/concepts/color-schemes
 */
export const COLOR_SCHEME_ATTR = "data-color-scheme";

/**
 * The localStorage key a site switcher persists the visitor's forced scheme under; read by the
 * compiler-injected pre-paint script. Values: "light" | "dark" (absent = auto).
 *
 * @docs framework/concepts/color-schemes
 */
export const COLOR_SCHEME_STORAGE_KEY = "jx-color-scheme";

/**
 * The scheme a _pure_ `prefers-color-scheme` media query targets. Compound queries (any other
 * conditions attached) return null — they are not eligible for forced-scheme dual emission.
 *
 * @param {string} query
 * @returns {"light" | "dark" | null}
 * @docs framework/concepts/color-schemes
 */
export function pureSchemeOf(query: string): "light" | "dark" | null {
  const m = /^\(\s*prefers-color-scheme\s*:\s*(light|dark)\s*\)$/.exec(query.trim());
  return (m?.[1] as "light" | "dark") ?? null;
}

/**
 * Selector pair for a scheme-conditional rule: `auto` applies inside the scheme's media query only
 * while no scheme is forced; `forced` applies unconditionally when the root attribute forces the
 * scheme. Guards are wrapped in `:where()` so specificity matches the unguarded selector and source
 * order decides the cascade.
 *
 * @param {string} selector
 * @param {"light" | "dark"} scheme
 * @returns {{ auto: string; forced: string }}
 * @docs framework/concepts/color-schemes
 */
export function schemeSelectors(
  selector: string,
  scheme: "light" | "dark",
): { auto: string; forced: string } {
  if (selector === ":root" || selector === "html") {
    return {
      auto: `${selector}:where(:not([${COLOR_SCHEME_ATTR}]))`,
      forced: `${selector}:where([${COLOR_SCHEME_ATTR}="${scheme}"])`,
    };
  }
  return {
    auto: `:where(:root:not([${COLOR_SCHEME_ATTR}])) ${selector}`,
    forced: `:where(:root[${COLOR_SCHEME_ATTR}="${scheme}"]) ${selector}`,
  };
}
