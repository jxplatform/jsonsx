/**
 * Project Styles — the model behind the project's design tokens and element defaults.
 *
 * ## The name and the wire value are different things
 *
 * The surface a user reaches is called **Project Styles** (plan §9.4). The canvas view it opens is
 * the string `"stylebook"`, a member of `CANVAS_MODES` in
 * {@link file://../canvas/iframe-protocol.ts} and therefore half of a `ParentToIframe` union: the
 * studio bundle and `dist/iframe-entry.js` agree on it, and changing it means rebuilding both in
 * lockstep. So it is not a name and may never be renamed to follow one.
 * {@link PROJECT_STYLES_TITLE} is the name; {@link PROJECT_STYLES_VIEW} is the wire value; a
 * surface that needs one must not reach for the other.
 *
 * ## One vocabulary for the `@` blocks
 *
 * A token's value can differ per rendering context, and on disk every such override lives in the
 * same place — a `@<name>` block beside the token, keyed by a `$media` entry name. Breakpoints and
 * colour schemes are two _kinds_ of that one thing, and this module models them as one
 * {@link TokenContext} list so a surface cannot grow a second override path for the second kind (a
 * per-scheme writer and a per-media writer that disagreed about pruning an emptied block is exactly
 * what this replaces). Contexts are **defined** in Project Settings › Contexts and only selected or
 * overridden here — §2 principle 5.
 *
 * On-disk format is unchanged by anything in this module: it reads and writes the same
 * `style["--token"]` and `style["@--ctx"]["--token"]` shapes the compiler already consumes.
 */

import { parseMediaEntries, schemeOfQuery } from "../utils/canvas-media";
import { varDisplayName } from "../utils/studio-utils";

import type { JxStyle } from "@jxsuite/schema/types";
import type { CanvasMode } from "../canvas/iframe-protocol";

/** What the surface is called, everywhere a reader sees it. One definition site. */
export const PROJECT_STYLES_TITLE = "Project Styles";

/**
 * The canvas view Project Styles opens — a WIRE value, not a name. See the module doc: it is a
 * `CANVAS_MODES` member shared with the iframe bundle, and it stays `"stylebook"`.
 */
export const PROJECT_STYLES_VIEW: CanvasMode = "stylebook";

// ─── Token groups ────────────────────────────────────────────────────────────

/** The four buckets the token editor lists, in display order. */
export type TokenGroupId = "color" | "font" | "size" | "other";

export interface TokenGroup {
  id: TokenGroupId;
  /** The group heading. */
  title: string;
  /** The prefix a token added in this group is named under. */
  prefix: string;
}

/**
 * The groups, in order. `other` is rendered only when something lands in it — a bucket named
 * "Other" over an empty list teaches nothing (§2 principle 6).
 *
 * A group is a name and a prefix and nothing else. The example values an add row hints with are a
 * property of the FORM, not of the model, and they live beside the form that shows them.
 */
export const TOKEN_GROUPS: readonly TokenGroup[] = [
  { id: "color", prefix: "--color-", title: "Colors" },
  { id: "font", prefix: "--font-", title: "Fonts" },
  { id: "size", prefix: "--size-", title: "Sizes & Spacing" },
  { id: "other", prefix: "--", title: "Other" },
];

/**
 * Which group a custom property belongs to, by prefix.
 *
 * @param {string} name
 * @returns {TokenGroupId}
 */
export function groupIdOfToken(name: string): TokenGroupId {
  if (name.startsWith("--color")) {
    return "color";
  }
  if (name.startsWith("--font")) {
    return "font";
  }
  if (name.startsWith("--size") || name.startsWith("--spacing") || name.startsWith("--radius")) {
    return "size";
  }
  return "other";
}

/**
 * The label a reader sees for a token: the friendly name it was added under, recovered from the
 * variable name. `--color-primary-blue` → "Primary Blue".
 *
 * The `other` group keeps its raw name deliberately — a token there has no prefix to strip, so "Z
 * Index Modal" would be a guess at a name its author never typed.
 *
 * @param {string} name
 * @returns {string}
 */
export function tokenLabel(name: string): string {
  const group = groupIdOfToken(name);
  if (group === "other") {
    return name;
  }
  /*
   * `varDisplayName` falls back to stripping a bare `--` when the prefix does not match, which is
   * what turns `--spacing-lg` (group `size`, prefix `--size-`) into "Spacing Lg". The predecessor
   * chained three prefixes with `||` and never reached the second, because the first always
   * returns a truthy string.
   */
  const { prefix } = TOKEN_GROUPS.find((g) => g.id === group)!;
  return varDisplayName(name, prefix);
}

// ─── Tokens ──────────────────────────────────────────────────────────────────

/** One design token declared at the top level of a style block. */
export interface ProjectToken {
  /** The custom property, e.g. `--color-primary`. */
  name: string;
  group: TokenGroupId;
  /** What a reader sees — {@link tokenLabel}. */
  label: string;
  value: string | number;
}

/**
 * Every design token in a style block, in declaration order.
 *
 * Non-custom properties (`color: blue`) and object values are not tokens and are skipped — an
 * object under a `--` key is malformed, and every `@ctx` block is an object by construction.
 *
 * @param {JxStyle | null | undefined} style
 * @returns {ProjectToken[]}
 */
export function listTokens(style: JxStyle | null | undefined): ProjectToken[] {
  if (!style) {
    return [];
  }
  const out: ProjectToken[] = [];
  for (const [name, value] of Object.entries(style)) {
    if (!name.startsWith("--")) {
      continue;
    }
    if (typeof value !== "string" && typeof value !== "number") {
      continue;
    }
    out.push({ group: groupIdOfToken(name), label: tokenLabel(name), name, value });
  }
  return out;
}

/**
 * Group tokens for display: every group in {@link TOKEN_GROUPS} order, each with its members.
 *
 * @param {JxStyle | null | undefined} style
 * @returns {{ group: TokenGroup; tokens: ProjectToken[] }[]}
 */
export function groupTokens(
  style: JxStyle | null | undefined,
): { group: TokenGroup; tokens: ProjectToken[] }[] {
  const tokens = listTokens(style);
  return TOKEN_GROUPS.map((group) => ({
    group,
    tokens: tokens.filter((t) => t.group === group.id),
  }));
}

// ─── Rendering contexts ──────────────────────────────────────────────────────

/**
 * What a context IS, for a reader. `size` is a breakpoint, `scheme` is a colour scheme, `feature`
 * is any other feature query. The distinction decides only how the row is labelled and whether it
 * is offered unprompted — the on-disk block is the same shape for all three.
 */
export type TokenContextKind = "size" | "scheme" | "feature";

/** A declared `$media` entry, seen as a place a token can carry a different value. */
export interface TokenContext {
  /** The `$media` entry name, e.g. `--sm` or `--dark`. */
  name: string;
  /** The style key its overrides live under, e.g. `@--sm`. */
  key: string;
  /** What the reader sees: "Dark" for a scheme, the raw `@--sm` for anything else. */
  label: string;
  kind: TokenContextKind;
  /** Present only when `kind` is `"scheme"`. */
  scheme?: "light" | "dark";
}

/**
 * The contexts a token can be overridden in, derived from `$media`.
 *
 * Schemes come first because they are the pair a colour token is always asked about; breakpoints
 * follow in the order {@link parseMediaEntries} sorts them (the same order the canvas shows its
 * panels in), then any other feature query. `--` is the base canvas width, not a context.
 *
 * @param {Record<string, string> | null | undefined} media
 * @returns {TokenContext[]}
 */
export function listTokenContexts(
  media: Record<string, string> | null | undefined,
): TokenContext[] {
  if (!media) {
    return [];
  }
  const { featureQueries, sizeBreakpoints } = parseMediaEntries(media);
  const schemes: TokenContext[] = [];
  const features: TokenContext[] = [];
  for (const { name, query } of featureQueries) {
    const scheme = schemeOfQuery(query);
    if (scheme) {
      schemes.push({
        key: `@${name}`,
        kind: "scheme",
        label: scheme === "dark" ? "Dark" : "Light",
        name,
        scheme,
      });
    } else {
      features.push({ key: `@${name}`, kind: "feature", label: `@${name}`, name });
    }
  }
  const sizes: TokenContext[] = sizeBreakpoints.map(({ name }) => ({
    key: `@${name}`,
    kind: "size",
    label: `@${name}`,
    name,
  }));
  return [...schemes, ...sizes, ...features];
}

// ─── Overrides ───────────────────────────────────────────────────────────────

/** A token's value in one context, alongside the context it came from. */
export interface TokenOverride {
  context: TokenContext;
  value: string | number;
}

/**
 * The block a context's overrides live in, or undefined when the context carries none.
 *
 * @param {JxStyle} style
 * @param {TokenContext} context
 */
function overrideBlock(style: JxStyle, context: TokenContext): Record<string, unknown> | undefined {
  const block = style[context.key];
  return block && typeof block === "object" ? (block as Record<string, unknown>) : undefined;
}

/**
 * A token's value in one context, or undefined when it inherits the base value.
 *
 * @param {JxStyle} style
 * @param {TokenContext} context
 * @param {string} token
 * @returns {string | number | undefined}
 */
export function readTokenOverride(
  style: JxStyle,
  context: TokenContext,
  token: string,
): string | number | undefined {
  const value = overrideBlock(style, context)?.[token];
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

/**
 * Write or clear a token's override in one context, IN PLACE.
 *
 * An empty value clears it, and an emptied block is removed rather than left as `"@--dark": {}` — a
 * block that exists but says nothing is a diff on every save and a rule the compiler emits for no
 * reason. The block is recreated on demand, so a caller holding a stale render still writes to the
 * right place.
 *
 * @param {JxStyle} style
 * @param {TokenContext} context
 * @param {string} token
 * @param {string} value — empty clears
 */
export function writeTokenOverride(
  style: JxStyle,
  context: TokenContext,
  token: string,
  value: string,
): void {
  if (value) {
    const block = (style[context.key] ??= {}) as Record<string, unknown>;
    block[token] = value;
    return;
  }
  const block = overrideBlock(style, context);
  if (!block) {
    return;
  }
  delete block[token];
  if (Object.keys(block).length === 0) {
    delete style[context.key];
  }
}

/**
 * Every context in which a token already carries an override, in {@link listTokenContexts} order.
 *
 * @param {JxStyle} style
 * @param {readonly TokenContext[]} contexts
 * @param {string} token
 * @returns {TokenOverride[]}
 */
export function tokenOverrides(
  style: JxStyle,
  contexts: readonly TokenContext[],
  token: string,
): TokenOverride[] {
  const out: TokenOverride[] = [];
  for (const context of contexts) {
    const value = readTokenOverride(style, context, token);
    if (value !== undefined) {
      out.push({ context, value });
    }
  }
  return out;
}

/**
 * The contexts a token can still be given an override in — the add affordance's menu.
 *
 * The predecessor had none: an override row appeared only for a token that already carried an
 * `@media` block, so the only way to create the first one was to hand-edit `project.json`. This is
 * the list of contexts that are declared and not yet used, minus the ones already shown unprompted
 * (`alreadyShown`), so the menu never offers a row the reader is already looking at.
 *
 * @param {JxStyle} style
 * @param {readonly TokenContext[]} contexts
 * @param {string} token
 * @param {readonly TokenContext[]} [alreadyShown]
 * @returns {TokenContext[]}
 */
export function addableContexts(
  style: JxStyle,
  contexts: readonly TokenContext[],
  token: string,
  alreadyShown: readonly TokenContext[] = [],
): TokenContext[] {
  const shown = new Set(alreadyShown.map((c) => c.name));
  return contexts.filter(
    (context) => !shown.has(context.name) && readTokenOverride(style, context, token) === undefined,
  );
}
