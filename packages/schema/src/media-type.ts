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

/**
 * `text/markdown` with the flavour Jx actually parses, per RFC 7763 §2 and the `variant` values RFC
 * 7764 registers. Bare `text/markdown` is a family, not a syntax — the `variant` is the only thing
 * on the wire that says which dialect a `.md` file is written in.
 */
export const MARKDOWN_MEDIA_TYPE = "text/markdown; variant=GFM";

/**
 * YAML's registered media type, per RFC 9512 §4.
 *
 * Deliberately **not** `text/yaml`. RFC 9512 §5 names `text/yaml`, `text/x-yaml` and
 * `application/x-yaml` as the pre-registration spellings and asks new implementations not to use
 * them — but they are still what most platform lookup tables answer, Bun's included, so serving a
 * `.yaml` file without an opinion here means serving a deprecated type.
 */
export const YAML_MEDIA_TYPE = "application/yaml";

/**
 * The media type Jx serves a file extension with, where the platform's own table is absent or
 * disagrees with the registration.
 *
 * This is not a general MIME table and must not grow into one: every host already has one for the
 * ordinary types, and duplicating those would create a second source of truth for `image/png`. What
 * is here is the short list where the platform answer is **wrong**, which is why each entry carries
 * the RFC that makes it wrong:
 *
 * - `.md` — every table answers bare `text/markdown`, which does not say which markdown (RFC 7763,
 *   RFC 7764). Jx knows: its parser is GFM, and the format class declares exactly this.
 * - `.yaml`/`.yml` — Bun answers `text/yaml` and Node's tables usually answer nothing at all;
 *   `application/yaml` is the registration (RFC 9512).
 *
 * Keys are lower-cased extensions including the dot; values carry `charset` because both types are
 * text and a browser that guesses the encoding of a UTF-8 document guesses wrong for exactly the
 * non-Latin content the rest of this repo works to support.
 */
export const MEDIA_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".markdown": `${MARKDOWN_MEDIA_TYPE}; charset=utf-8`,
  ".md": `${MARKDOWN_MEDIA_TYPE}; charset=utf-8`,
  ".yaml": `${YAML_MEDIA_TYPE}; charset=utf-8`,
  ".yml": `${YAML_MEDIA_TYPE}; charset=utf-8`,
};

/**
 * The media type for a path, or null to leave the host's own answer alone.
 *
 * Null is the common case and the point: a host calls this to _correct_ its table, not to replace
 * it, so anything absent from {@link MEDIA_TYPE_BY_EXTENSION} keeps whatever the host already
 * decided.
 *
 * @param {string} path - A file path or name; only its extension is read
 * @returns {string | null}
 */
export function mediaTypeForPath(path: string): string | null {
  const dot = path.lastIndexOf(".");
  if (dot <= path.lastIndexOf("/") || dot <= path.lastIndexOf("\\")) {
    return null;
  }
  return MEDIA_TYPE_BY_EXTENSION[path.slice(dot).toLowerCase()] ?? null;
}
