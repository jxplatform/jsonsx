/**
 * Base-path.ts — re-rooting a build's output onto the path the site is deployed under.
 *
 * A site at `https://example.pages.dev/m/my-site/` is served from `/m/my-site/`, and every
 * absolute-path reference the build emits — `/assets/vue-reactivity.js`,
 * `/components/site-counter.js`, `/images/hero.jpg` — resolves against `example.pages.dev/`
 * instead, where nothing is. The page renders blank rather than merely wrong, because the runtime
 * assets 404 first (issue 235).
 *
 * **The base is not a new option.** `project.json`'s `url` is the base URI every emitted reference
 * is resolved against (RFC 3986 §5), and the compiler was resolving against its ORIGIN and
 * discarding its path. `siteBasePath` in `@jxsuite/schema/asset-paths` reads the path back; a
 * second `build.base` key would be a second writer on the one fact the canonical links and the
 * sitemap are already built from, free to disagree with them.
 *
 * **The rewrite happens on finished HTML, and that is the point.** The alternative is to thread a
 * prefix through the twelve emitters that can put a URL on a page — the import map and its
 * modulepreloads, three page-template tiers that each write their own map, component scripts,
 * island modules, sidecar and npm bundles, image `srcset`, `$head` entries, and whatever a page
 * author wrote by hand. That list is exactly the kind that is complete until the next emitter is
 * added, and #227 was already one emitter's map disagreeing with another's. One pass over the bytes
 * that ship cannot drift from them.
 *
 * Outputs that are not HTML keep their own handling, because each has a syntax and none of them can
 * be found by looking at a tag: `_headers`, `_redirects`, the service worker's precache list and
 * scope, `manifest.webmanifest`, and the absolute URLs in `sitemap.xml` and `robots.txt`.
 *
 * Everything here is idempotent (see `withBase`), so a value an emitter already prefixed survives
 * this pass unchanged.
 *
 * @docs framework/site/deployment
 */

import { formatSrcset, parseSrcset, withBase } from "@jxsuite/schema/asset-paths";

/**
 * Attributes whose value is a single URL.
 *
 * `href` and `src` are most of the traffic; the rest are the ones a Jx page can actually emit —
 * `<form action>`, `<button formaction>`, `<video poster>`, `<object data>`. Anything not listed is
 * left alone, which is the safe direction: a missed URL 404s visibly on a subpath deployment, while
 * a rewritten non-URL corrupts a page that was working.
 */
const URL_ATTRS = new Set(["href", "src", "poster", "action", "formaction", "data"]);

/** Attributes whose value is a `srcset` candidate list rather than one URL. */
const SRCSET_ATTRS = new Set(["srcset", "imagesrcset"]);

/**
 * One HTML tag: the name, then attributes with quoted values consumed whole.
 *
 * Consuming quotes matters — a `>` inside an attribute value would otherwise end the tag early and
 * leave the rest of its attributes as text this pass never looks at.
 */
const TAG_RE = /<([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;

/** One attribute inside a tag's attribute blob. */
const ATTR_RE = /([a-zA-Z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;

/** `url(...)` inside a CSS value, capturing the optional quote so it can be put back. */
const CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;

/** A JSON string literal holding an absolute-path reference — an import map's keys and values. */
const JSON_ABS_PATH_RE = /"(\/[^"/][^"]*)"/g;

/** `<script type="importmap">…</script>`, whose body is JSON rather than markup. */
const IMPORTMAP_RE = /(<script\b[^>]*\btype\s*=\s*["']importmap["'][^>]*>)([\s\S]*?)(<\/script>)/gi;

/** `<style>…</style>`, whose body is CSS rather than markup. */
const STYLE_BLOCK_RE = /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi;

/**
 * `<meta>` names whose `content` is a URL.
 *
 * `content` is the one attribute here that usually holds prose, so it is rewritten only when the
 * same tag says the value is a URL. OpenGraph and Twitter image/player metas are the cases a page
 * actually produces from an author-written `/hero.jpg`.
 */
const URL_META_RE =
  /\b(?:property|name)\s*=\s*["'](?:og:|twitter:)[\w:.-]*(?:image|url|video|audio|player)[\w:.-]*["']/i;

/**
 * A quote around a `url()` target that survived attribute escaping.
 *
 * In a `style` ATTRIBUTE the quotes inside `url("…")` are escaped, so the target arrives wrapped in
 * `&quot;` rather than in a character {@link CSS_URL_RE} would have treated as a delimiter. Left
 * alone the value no longer starts with `/` and is silently skipped — a background image that 404s
 * on a subpath deployment with nothing to show for it.
 */
const ENTITY_QUOTE_RE = /^(&quot;|&#34;|&apos;|&#39;)([\s\S]*)\1$/;

/** Rewrite every `url(...)` in a CSS fragment, in a `<style>` block or a `style` attribute. */
function rewriteCssUrls(css: string, base: string): string {
  return css.replaceAll(CSS_URL_RE, (match, quote: string, inner: string) => {
    const raw = inner.trim();
    const escaped = ENTITY_QUOTE_RE.exec(raw);
    const target = escaped ? escaped[2]! : raw;
    const out = withBase(base, target);
    if (out === target) {
      return match;
    }
    return `url(${quote}${escaped ? `${escaped[1]}${out}${escaped[1]}` : out}${quote})`;
  });
}

/** Rewrite one attribute value, or return it unchanged when the attribute carries no URL. */
function rewriteAttrValue(tag: string, attrs: string, name: string, value: string, base: string) {
  const lower = name.toLowerCase();
  if (URL_ATTRS.has(lower)) {
    return withBase(base, value);
  }
  if (SRCSET_ATTRS.has(lower)) {
    const candidates = parseSrcset(value);
    return candidates.length === 0
      ? value
      : formatSrcset(
          candidates.map((c) => ({ descriptor: c.descriptor, url: withBase(base, c.url) })),
        );
  }
  if (lower === "style") {
    return rewriteCssUrls(value, base);
  }
  if (lower === "content" && tag === "meta" && URL_META_RE.test(attrs)) {
    return withBase(base, value);
  }
  return value;
}

/**
 * Re-root every site-absolute URL in a page's HTML onto `base`.
 *
 * `base` of `""` is a site at an origin root, and the HTML is returned untouched — no allocation
 * and no risk for the deployment Jx documents.
 *
 * @param {string} html - A finished page
 * @param {string} base - From `siteBasePath`
 * @returns {string} The page as it should ship
 */
export function rewriteHtmlBase(html: string, base: string): string {
  if (base === "") {
    return html;
  }

  let out = html.replaceAll(IMPORTMAP_RE, (_match, open: string, body: string, close: string) => {
    /* The import map's KEYS are addressable too: a map may name a module by URL rather than by bare
       specifier, and a key left at the old root would resolve to a file the build did not write. */
    const rewritten = body.replaceAll(
      JSON_ABS_PATH_RE,
      (_literal, path: string) => `"${withBase(base, path)}"`,
    );
    return open + rewritten + close;
  });

  out = out.replaceAll(
    STYLE_BLOCK_RE,
    (_m, open: string, css: string, close: string) => open + rewriteCssUrls(css, base) + close,
  );

  return out.replaceAll(TAG_RE, (match, tagName: string, attrs: string) => {
    if (attrs === "") {
      return match;
    }
    const tag = tagName.toLowerCase();
    const rewrittenAttrs = attrs.replaceAll(
      ATTR_RE,
      (whole, name: string, _quoted: string, dq: string | undefined, sq: string | undefined) => {
        const quote = dq === undefined ? "'" : '"';
        const value = dq ?? sq ?? "";
        const next = rewriteAttrValue(tag, attrs, name, value, base);
        return next === value ? whole : `${name}=${quote}${next}${quote}`;
      },
    );
    return rewrittenAttrs === attrs ? match : `<${tagName}${rewrittenAttrs}>`;
  });
}
