/**
 * Link-target.ts — pure, dependency-free helpers for classifying and composing anchor `href`
 * targets in the properties panel's Link section.
 *
 * `classifyHref` splits a raw href string into a discriminated `{ kind, value }` pair so the UI can
 * offer a target-kind selector (Internal page / External URL / #anchor / mailto: / tel:).
 * `composeHref` is its inverse — the two round-trip for every kind so editing through the UI never
 * corrupts an href.
 *
 * Both functions are total (never throw) and have no DOM or platform dependencies, so they are
 * fully unit-testable in isolation.
 */

/** The distinct target kinds an anchor href can address. */
export type LinkKind = "internal" | "external" | "anchor" | "mailto" | "tel";

/** A classified href: its {@link LinkKind} plus the "bare" value for that kind's input. */
export interface LinkTarget {
  kind: LinkKind;
  /**
   * The user-facing value for the kind's input: - internal → the path (e.g. `/about/`) - external →
   * the full href (e.g. `https://x.com`) - anchor → the fragment WITHOUT the leading `#` (e.g.
   * `section`) - mailto → the email address WITHOUT the `mailto:` scheme - tel → the phone number
   * WITHOUT the `tel:` scheme
   */
  value: string;
}

/** Matches an absolute URL scheme like `http://`, `https://`, `ftp://`, or protocol-relative `//`. */
const ABSOLUTE_SCHEME = /^([a-z][a-z\d+.-]*:)?\/\//i;

/**
 * Classify a raw `href` string into a {@link LinkTarget}.
 *
 * Rules (checked in order): 1. `mailto:…` → `{ kind: "mailto", value: address }` 2. `tel:…` → `{
 * kind: "tel", value: number }` 3. `#…` → `{ kind: "anchor", value: rest }` (leading `#` stripped)
 * 4. absolute (`http(s)://…`) or protocol-relative (`//…`) → `{ kind: "external", value: href }` 5.
 * `/…` → `{ kind: "internal", value: path }` 6. anything else → `{ kind: "external", value: href
 * }`
 *
 * @param href The raw attribute value (may be empty)
 */
export function classifyHref(href = ""): LinkTarget {
  const value = href;
  const lower = value.toLowerCase();

  if (lower.startsWith("mailto:")) {
    return { kind: "mailto", value: value.slice("mailto:".length) };
  }
  if (lower.startsWith("tel:")) {
    return { kind: "tel", value: value.slice("tel:".length) };
  }
  if (value.startsWith("#")) {
    return { kind: "anchor", value: value.slice(1) };
  }
  if (ABSOLUTE_SCHEME.test(value)) {
    return { kind: "external", value };
  }
  if (value.startsWith("/")) {
    return { kind: "internal", value };
  }
  return { kind: "external", value };
}

/**
 * Compose an `href` string from a {@link LinkKind} and its bare value — the inverse of
 * {@link classifyHref}. An empty (or whitespace-only) value yields `""` for every kind so callers
 * can treat "cleared" uniformly. Round-trips with `classifyHref` for every kind.
 *
 * @param kind The target kind
 * @param value The bare value for that kind (address/number/fragment/path/href)
 */
export function composeHref(kind: LinkKind, value: string): string {
  const bare = (value ?? "").trim();
  if (!bare) {
    return "";
  }
  switch (kind) {
    case "mailto": {
      return `mailto:${bare}`;
    }
    case "tel": {
      return `tel:${bare}`;
    }
    case "anchor": {
      return bare.startsWith("#") ? bare : `#${bare}`;
    }
    // Internal / external — the bare value IS the href.
    default: {
      return bare;
    }
  }
}
