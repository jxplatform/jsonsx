/**
 * Media types (RFC 6838), parsed rather than passed through.
 *
 * A format declares `mediaType` and the string reaches an HTTP header, an editor's file association
 * and a Studio label. Until now nothing checked it, so `text/markdown;variant GFM` — missing an `=`
 * — would have been served verbatim to a browser as a malformed header value.
 *
 * The grammar is `type "/" [tree "."] subtype ["+" suffix] *(";" parameter)`, with both halves
 * limited to 127 characters of a restricted character set. Registration trees (`vnd.`, `prs.`,
 * `x.`) are recognized because they are what distinguishes "this is registered with IANA" from
 * "this is mine" — the check here is grammatical, not a registry lookup.
 *
 * Pure string math — no node imports — so browser hosts can import this module.
 *
 * @docs extending/extensions/formats
 */

/** RFC 6838 §4.2: the first character, then up to 126 more from the restricted set. */
const RESTRICTED_NAME = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/;

/** The standards tree is the absence of a facet; these three are the others RFC 6838 §3 defines. */
const KNOWN_TREES = new Set(["vnd", "prs", "x"]);

export interface MediaType {
  /** `text` in `text/markdown`. Lower-cased: RFC 6838 §4.2 makes both halves case-insensitive. */
  type: string;
  /** `markdown` in `text/markdown` — the tree facet and `+suffix` removed. */
  subtype: string;
  /** `vnd`, `prs`, `x`, or null for the standards tree. */
  tree: string | null;
  /** `json` in `application/feed+json`. */
  suffix: string | null;
  /** Parameter names lower-cased; values kept as written, minus surrounding quotes. */
  parameters: Record<string, string>;
}

/**
 * Parse a media type, or return null when it does not match the grammar.
 *
 * @param {unknown} value
 * @returns {MediaType | null}
 */
export function parseMediaType(value: unknown): MediaType | null {
  if (typeof value !== "string") {
    return null;
  }
  const [essence, ...paramParts] = value.split(";");
  const slash = (essence ?? "").indexOf("/");
  if (slash === -1) {
    return null;
  }
  const type = (essence ?? "").slice(0, slash).trim().toLowerCase();
  const rawSubtype = (essence ?? "")
    .slice(slash + 1)
    .trim()
    .toLowerCase();
  if (!RESTRICTED_NAME.test(type) || !RESTRICTED_NAME.test(rawSubtype)) {
    return null;
  }

  /*
   * `+suffix` binds last: `application/vnd.acme.thing+json` is the `vnd` tree, subtype
   * `acme.thing`, suffix `json`. Split the suffix off before the tree so a dotted subtype keeps
   * its dots.
   */
  const plus = rawSubtype.lastIndexOf("+");
  const suffix = plus === -1 ? null : rawSubtype.slice(plus + 1);
  const withoutSuffix = plus === -1 ? rawSubtype : rawSubtype.slice(0, plus);
  if (suffix === "") {
    return null;
  }
  const dot = withoutSuffix.indexOf(".");
  const facet = dot === -1 ? null : withoutSuffix.slice(0, dot);
  const tree = facet !== null && KNOWN_TREES.has(facet) ? facet : null;
  const subtype = tree === null ? withoutSuffix : withoutSuffix.slice(tree.length + 1);
  if (subtype === "") {
    return null;
  }

  const parameters: Record<string, string> = {};
  for (const part of paramParts) {
    const eq = part.indexOf("=");
    if (eq === -1) {
      return null;
    }
    const name = part.slice(0, eq).trim().toLowerCase();
    let paramValue = part.slice(eq + 1).trim();
    if (name === "") {
      return null;
    }
    if (paramValue.startsWith('"') && paramValue.endsWith('"') && paramValue.length >= 2) {
      paramValue = paramValue.slice(1, -1);
    }
    parameters[name] = paramValue;
  }

  return { parameters, subtype, suffix, tree, type };
}

/** Render a parsed media type back to its canonical string. */
export function formatMediaType(media: MediaType): string {
  const facet = media.tree === null ? "" : `${media.tree}.`;
  const suffix = media.suffix === null ? "" : `+${media.suffix}`;
  const params = Object.entries(media.parameters)
    .map(([name, value]) => `; ${name}=${value}`)
    .join("");
  return `${media.type}/${facet}${media.subtype}${suffix}${params}`;
}

/**
 * A human-readable reason the value is not a media type, or null when it is one.
 *
 * Separate from {@link parseMediaType} because a caller validating configuration needs to say what
 * is wrong, and a caller reading a type only needs to know whether it could.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function mediaTypeProblem(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") {
    return "expected a media type string";
  }
  if (!value.includes("/")) {
    return `"${value}" has no "/" — a media type is type/subtype (RFC 6838 §4.2)`;
  }
  if (parseMediaType(value) === null) {
    return `"${value}" is not a well-formed media type (RFC 6838 §4.2)`;
  }
  return null;
}

/**
 * The media type without its parameters: `text/markdown` for `text/markdown; variant=GFM`.
 *
 * Anything that **keys** on a type rather than describing one wants this — a File System Access
 * `accept` map, an editor language id, a registry lookup. Those are the call sites that broke the
 * moment a format declared the `variant` parameter RFC 7763 defines, so the distinction belongs
 * here rather than in each caller's `split`.
 *
 * @param {unknown} value
 * @returns {string | null} Null when the value is not a media type at all
 */
export function mediaTypeEssence(value: unknown): string | null {
  const media = parseMediaType(value);
  if (media === null) {
    return null;
  }
  const facet = media.tree === null ? "" : `${media.tree}.`;
  const suffix = media.suffix === null ? "" : `+${media.suffix}`;
  return `${media.type}/${facet}${media.subtype}${suffix}`;
}

/** True when the type names an unregistered format under the `x.` or deprecated `x-` convention. */
export function isUnregisteredMediaType(value: unknown): boolean {
  const media = parseMediaType(value);
  return media !== null && (media.tree === "x" || media.subtype.startsWith("x-"));
}
