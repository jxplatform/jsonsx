/**
 * The CSS-authoring rules that are not the DOM.
 *
 * `@jxsuite/runtime` renders a document in a browser, and every consumer of its root export pays
 * for that: the element registry, the reactive scope, `@vue/reactivity`. These exports need none of
 * it. They are pure string and regex math over what a `style` block MEANS — how a property name is
 * spelled in CSS, which media query an `@`-key resolves to, and which selector pair a
 * scheme-conditional rule dual-emits as.
 *
 * The rule builder joined them for the same reason: it is what a style object MEANS as a list of
 * CSS rules, and three emitters used to answer that question three different ways. Its only import
 * is `@jxsuite/schema/guards`, which imports nothing but types.
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

import { isRef, isTemplateString } from "@jxsuite/schema/guards";
import type { JxRef, JxStyle } from "@jxsuite/schema/types";

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

/**
 * At-rules whose body is a list of DECLARATIONS rather than a list of rules.
 *
 * Every other `@`-key in a `style` object wraps selectors — `@media`, `@supports`,
 * `@starting-style` — so both emitters assume a selector child and write `@key { <selector> { … }
 * }`. These four have no selector: `@position-try --flip { inset-block-start: auto }` IS the body,
 * and wrapping it in one produces a block the parser discards without a word.
 *
 * That is why an anchored dropdown had no custom fallback to declare. `position-try-fallbacks` can
 * name `flip-block` and friends without this, but a bespoke fallback position — the thing you need
 * when the built-in flips do not fit — could not be expressed at all.
 *
 * The name is part of the key (`@position-try --flip`), so this is a PREFIX match. `@keyframes` is
 * deliberately absent: its body is neither declarations nor selectors but percentage stops, which
 * is a third shape and a separate design.
 *
 * @param {string} atKey - An `@`-prefixed style key
 * @returns {boolean} True when the block is emitted verbatim, with no selector inside
 * @docs framework/concepts/styling
 */
export function isDeclarationAtRule(atKey: string): boolean {
  return (
    atKey.startsWith("@position-try") ||
    atKey.startsWith("@property") ||
    atKey.startsWith("@font-face") ||
    atKey.startsWith("@counter-style")
  );
}

/**
 * Resolve one nested style key against its parent selector.
 *
 * `&` splices, `:`/`.`/`[` concatenate, anything else is a descendant. Extracted because the same
 * four-branch decision was written THREE times in `applyStyle` — the top-level nested loop,
 * `emitNested`'s recursion and `emitMediaNested` — and three copies of one decision is three
 * chances for a selector to mean different things depending on how deeply it was nested.
 *
 * @param {string} scope - The parent selector
 * @param {string} key - The nested key, e.g. `":hover"`, `"& > li"`, `".child"`
 * @returns {string} The resolved selector
 */
export function resolveNestedSelector(scope: string, key: string): string {
  if (key.startsWith("&")) {
    return key.replace("&", scope);
  }
  if (key.startsWith("[") || key.startsWith(":") || key.startsWith(".")) {
    return `${scope}${key}`;
  }
  return `${scope} ${key}`;
}

/**
 * Studio-canvas popover selector transposition — the style half of `setCanvasDelinkPopovers`.
 *
 * The canvas renames `popover` to `data-jx-popover` so an open panel leaves the TOP LAYER and
 * becomes an ordinary positioned element the editor can measure, select and grow the artboard for.
 * The moment it does, `:popover-open` matches nothing — so an authored open state would simply not
 * apply, and the author would be styling a rule they could never see.
 *
 * `[data-jx-popover-open]` is the stand-in, and the substitution is exact in the way that matters:
 * a pseudo-class and an attribute selector are both specificity (0,1,0), so a `:popover-open` block
 * still wins and loses against the same neighbours it does on the shipped page.
 *
 * `null` means "do not emit this rule at all", and `::backdrop` is the one thing it is returned
 * for. There is no backdrop pseudo-element outside the top layer; synthesising one would paint a
 * full-canvas scrim over the document being edited, and emitting an inert rule would mark the
 * selector as "styled" in the Style panel while doing nothing. Preview renders it natively.
 *
 * @param {string} selector - A fully resolved selector, canvas-side
 * @returns {string | null} The selector to emit, or null to emit nothing
 * @docs framework/concepts/overlays
 */
export function transposeCanvasPopoverSelector(selector: string): string | null {
  if (selector.includes("::backdrop")) {
    return null;
  }
  return selector.replaceAll(":popover-open", "[data-jx-popover-open]");
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

// ─── The Rule Builder ─────────────────────────────────────────────────────────

/**
 * Where a rule points, relative to the element the style object was authored on.
 *
 * The runtime needs this to decide what it is allowed to SHARE. A `self` rule can be interned and
 * pointed at by any number of elements, because everything it says applies to whichever element
 * carries the scope handle. A `descendant` rule cannot be shared the moment it reads a custom
 * property, because `var()` resolves from the nearest ancestor that set it and a shared handle has
 * more than one such ancestor. `unscoped` is a declaration-body at-rule — `@font-face`,
 * `@position-try` — whose name is document-global and which is therefore hoisted once rather than
 * emitted per element.
 */
export type CssRuleTarget = "self" | "descendant" | "unscoped";

/** One emitted CSS rule: its parts, its text, and a content hash of the two. */
export interface CssRule {
  /** The rule as one `insertRule` argument, or one line of a `<style>` element. */
  text: string;
  /** At-rule wrappers, outermost first. Empty for a top-level rule. */
  conditions: readonly string[];
  /** The resolved selector, or null for a declaration-body at-rule. */
  selector: string | null;
  /** Kebab-cased property/value pairs, in authored order. */
  declarations: readonly (readonly [string, string])[];
  /** See {@link CssRuleTarget}. */
  target: CssRuleTarget;
  /** FNV-1a base36 hash of `text` — the dedup key. */
  key: string;
}

/** Hooks that let one builder serve the DOM runtime, the compiler, the site builder and Studio. */
export interface CssBuildOptions {
  /**
   * The selector the style object hangs off. Every nested key resolves against it, so the runtime
   * passes a placeholder it substitutes afterwards and the compiler passes `#id` / `.jx-N` / a
   * tag.
   */
  scope?: string | null;
  /** The project's `$media` map, for resolving `@--name` keys. */
  mediaQueries?: Record<string, string>;
  /** Applied to every declaration value. The canvas passes `canvasStyleValue`; hosts pass identity. */
  transposeValue?: (value: string) => string;
  /**
   * Applied to every resolved selector. Returning null drops the rule entirely, which is how the
   * canvas refuses to synthesise a `::backdrop` outside the top layer.
   */
  transposeSelector?: (selector: string) => string | null;
  /**
   * Resolve a value the builder cannot serialize on its own: a `${…}` template or a `{ $ref }`.
   *
   * The runtime returns `var(--jx-rN)` and writes the real value into that custom property from an
   * effect, so the declaration lives in a rule where `:hover` can override it while the reactive
   * part stays inline. Hosts with no scope to evaluate against omit the hook, and the declaration
   * is dropped — which is what the compiler already did for template strings, and what the runtime
   * should always have done with a `$ref` it was instead reading as a nested selector.
   */
  resolveValue?: (property: string, value: string | JxRef) => string | null;
}

/** A style-object key that names a nested selector rather than a CSS property. */
export function isNestedSelectorKey(key: string): boolean {
  return key.startsWith(":") || key.startsWith(".") || key.startsWith("&") || key.startsWith("[");
}

/**
 * A style-object key as a CSS property name.
 *
 * Custom properties pass through untouched. They are case-SENSITIVE — `--fooBar` and `--foo-bar`
 * are two different properties — so kebab-casing one renames it, and the `var(--fooBar)` that reads
 * it finds nothing.
 *
 * @param {string} property
 * @returns {string}
 */
export function cssPropertyName(property: string): string {
  return property.startsWith("--") ? property : camelToKebab(property);
}

/**
 * FNV-1a (32-bit), base36. Not a cryptographic hash and does not need to be: it is a dedup key and
 * an SSR-stable replacement for `Math.random()`, and a collision costs two elements sharing a rule
 * set that says the same thing.
 *
 * @param {string} text
 * @returns {string}
 */
export function hashCss(text: string): string {
  /* oxlint-disable no-bitwise, unicorn/prefer-code-point -- FNV-1a IS bitwise arithmetic over
     16-bit code UNITS; `codePointAt` would consume a surrogate pair as one unit and change the
     hash of any string containing an astral character, for no benefit to a non-cryptographic
     content key. The final `>>> 0` is what keeps the result unsigned, and so base36-clean. */
  let h = 2_166_136_261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16_777_619);
  }
  return (h >>> 0).toString(36);
  /* oxlint-enable no-bitwise, unicorn/prefer-code-point */
}

/**
 * Serialize one rule: declarations, wrapped in a selector unless there is none, wrapped in its
 * at-rule conditions from the inside out.
 *
 * @param {readonly string[]} conditions
 * @param {string | null} selector
 * @param {readonly (readonly [string, string])[]} declarations
 * @returns {string}
 */
export function cssRuleText(
  conditions: readonly string[],
  selector: string | null,
  declarations: readonly (readonly [string, string])[],
): string {
  const body = declarations.map(([property, value]) => `${property}: ${value}`).join("; ");
  let text = selector === null ? body : `${selector} { ${body} }`;
  for (let i = conditions.length - 1; i >= 0; i -= 1) {
    text = `${conditions[i]} { ${text} }`;
  }
  return text;
}

/**
 * Whether a nested key COMPOUNDS onto its scope rather than descending from it.
 *
 * `:hover`, `.wide`, `[open]` and their `&`-spliced spellings still match the element the style was
 * authored on; `> li` and `span` match something inside it. That distinction is the whole of
 * {@link CssRuleTarget}, so it is decided once, here.
 */
function compoundsOntoScope(key: string): boolean {
  const rest = key.startsWith("&") ? key.slice(1) : key;
  return rest === "" || rest.startsWith(":") || rest.startsWith(".") || rest.startsWith("[");
}

/**
 * Turn one authored `style` object into a flat list of CSS rules.
 *
 * This is the single answer to "what does a Jx style object MEAN as CSS", shared by the DOM
 * runtime, the compiler's static emitter and the site-style builder. Before it, three emitters each
 * walked the shape with their own recursion and each dropped a different combination: the runtime
 * lost `selector → @media`, the compiler lost `@media → selector → pseudo`, and neither composed
 * at-rules at all.
 *
 * The recursion carries `{ selector, conditions }` rather than special-casing depth, so nesting and
 * at-rules compose to any depth in either order by construction. A scheme-pure media query
 * dual-emits through {@link schemeSelectors} — a media-guarded copy for the OS preference and an
 * unconditional copy for the forced root attribute — and the forced copy keeps recursing, so an
 * `@--md` block inside a `@(prefers-color-scheme: dark)` block survives both branches.
 *
 * Nesting is FLATTENED, never handed to the browser as native CSS nesting: `&` is resolved here and
 * no `&` reaches the output. That is deliberate — Jx compounds `.child` onto its scope where CSS
 * Nesting would make it a descendant — and it is also what keeps the output parseable by the test
 * DOM, which has no native nesting.
 *
 * @param {JxStyle} style - The authored style object
 * @param {CssBuildOptions} [options]
 * @returns {CssRule[]} Rules in cascade order: a scope's own declarations before its nested blocks
 * @docs framework/concepts/styling
 */
export function buildStyleRules(style: JxStyle, options: CssBuildOptions = {}): CssRule[] {
  const {
    scope = null,
    mediaQueries = {},
    transposeValue = (value: string) => value,
    transposeSelector = (selector: string) => selector,
    resolveValue,
  } = options;
  const rules: CssRule[] = [];

  const isBlock = (value: unknown): value is JxStyle =>
    value !== null && typeof value === "object" && !Array.isArray(value) && !isRef(value);

  const declarationValue = (property: string, value: unknown): string | null => {
    if (value === undefined || value === null) {
      return null;
    }
    /* Defect: a `{ $ref }` is a VALUE. Read as an object it looked like a nested selector, and the
       runtime emitted `[data-jx="…"] color { $ref: #/state/tint }` — a rule for an element named
       `color`, and a declaration whose property is `$ref`. */
    if (isRef(value)) {
      return resolveValue?.(property, value) ?? null;
    }
    if (typeof value === "object") {
      return null;
    }
    const raw = String(value);
    if (isTemplateString(raw)) {
      return resolveValue?.(property, raw) ?? null;
    }
    return transposeValue(raw);
  };

  const declarationsOf = (node: JxStyle, skipSelectorKeys: boolean): [string, string][] => {
    const declarations: [string, string][] = [];
    for (const [key, value] of Object.entries(node)) {
      if (isBlock(value)) {
        continue;
      }
      // A scalar under a selector or at-rule key is an invalid shape, not a declaration.
      if (skipSelectorKeys && (key.startsWith("@") || isNestedSelectorKey(key))) {
        continue;
      }
      const resolved = declarationValue(key, value);
      if (resolved !== null) {
        declarations.push([cssPropertyName(key), resolved]);
      }
    }
    return declarations;
  };

  const emit = (
    conditions: readonly string[],
    selector: string | null,
    declarations: readonly (readonly [string, string])[],
    target: CssRuleTarget,
  ) => {
    if (declarations.length === 0) {
      return;
    }
    let resolved = selector;
    if (resolved !== null) {
      const transposed = transposeSelector(resolved);
      if (transposed === null) {
        return;
      }
      resolved = transposed;
    }
    const text = cssRuleText(conditions, resolved, declarations);
    rules.push({
      text,
      conditions: [...conditions],
      selector: resolved,
      declarations,
      target,
      key: hashCss(text),
    });
  };

  const walkAt = (
    atKey: string,
    block: JxStyle,
    selector: string | null,
    conditions: readonly string[],
    target: CssRuleTarget,
  ) => {
    /* Not a query. `@--` is the canvas's base-width block — the value a breakpoint panel renders
       at when no named breakpoint applies — and resolving it would emit `@media --`. */
    if (atKey === "@--") {
      return;
    }
    if (isDeclarationAtRule(atKey)) {
      emit([...conditions, atKey], null, declarationsOf(block, false), "unscoped");
      return;
    }
    const query = resolveAtQuery(atKey, mediaQueries);
    const atRule = query === null ? atKey : `@media ${query}`;
    const scheme = query === null ? null : pureSchemeOf(query);
    if (scheme !== null && selector !== null) {
      const { auto, forced } = schemeSelectors(selector, scheme);
      walk(block, auto, [...conditions, atRule], target);
      walk(block, forced, conditions, target);
      return;
    }
    walk(block, selector, [...conditions, atRule], target);
  };

  function walk(
    node: JxStyle,
    selector: string | null,
    conditions: readonly string[],
    target: CssRuleTarget,
  ) {
    emit(conditions, selector, declarationsOf(node, true), target);
    for (const [key, value] of Object.entries(node)) {
      if (!isBlock(value)) {
        continue;
      }
      if (key.startsWith("@")) {
        walkAt(key, value, selector, conditions, target);
      } else if (selector !== null) {
        walk(
          value,
          resolveNestedSelector(selector, key),
          conditions,
          compoundsOntoScope(key) ? target : "descendant",
        );
      }
    }
  }

  walk(style, scope, [], "self");
  return rules;
}
