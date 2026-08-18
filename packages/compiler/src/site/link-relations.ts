/**
 * Link relation types (RFC 8288 §2.1), checked rather than trusted.
 *
 * A `rel` is the only thing that says what a `<link>` _means_. Get the value wrong — `stylshet`,
 * `canonicial`, `alternative` — and the tag is still well-formed HTML, still renders, still passes
 * every other check in this build, and simply does nothing: the stylesheet never loads, the
 * canonical never consolidates, the alternate is never followed. There is no runtime symptom to
 * notice, which is why this is a build-time check and not something an author eventually spots.
 *
 * **A warning, never an error.** RFC 8288 §2.1.2 admits extension relation types, the registry
 * gains entries between releases, and a `rel` nobody here recognizes is a page that works. Failing
 * a build over one would make Jx wrong about a site that is right.
 *
 * @docs framework/site/seo
 */

/**
 * The IANA Link Relation Types registry, snapshotted from
 * `https://www.iana.org/assignments/link-relations/link-relations-1.csv` on 2026-08-16.
 *
 * A snapshot, and named as one: the registry is the authority and this is a copy that will go stale
 * between releases. That is survivable precisely because an unrecognized value is a warning — a
 * relation registered after this list was taken produces one line of noise, not a broken build.
 * Regenerate from the CSV rather than hand-editing; the ordering is the CSV's, sorted.
 */
export const IANA_LINK_RELATIONS: ReadonlySet<string> = new Set([
  "about",
  "acl",
  "alternate",
  "amphtml",
  "api-catalog",
  "appendix",
  "apple-touch-icon",
  "apple-touch-startup-image",
  "archives",
  "author",
  "blocked-by",
  "bookmark",
  "c2pa-manifest",
  "canonical",
  "chapter",
  "cite-as",
  "collection",
  "compression-dictionary",
  "contents",
  "convertedfrom",
  "copyright",
  "create-form",
  "current",
  "deprecation",
  "describedby",
  "describes",
  "disclosure",
  "dns-prefetch",
  "dpp",
  "duplicate",
  "edit",
  "edit-form",
  "edit-media",
  "enclosure",
  "external",
  "first",
  "geofeed",
  "glossary",
  "help",
  "hosts",
  "hub",
  "ice-server",
  "icon",
  "index",
  "intervalafter",
  "intervalbefore",
  "intervalcontains",
  "intervaldisjoint",
  "intervalduring",
  "intervalequals",
  "intervalfinishedby",
  "intervalfinishes",
  "intervalin",
  "intervalmeets",
  "intervalmetby",
  "intervaloverlappedby",
  "intervaloverlaps",
  "intervalstartedby",
  "intervalstarts",
  "item",
  "last",
  "latest-version",
  "license",
  "linkset",
  "lrdd",
  "manifest",
  "mask-icon",
  "me",
  "media-feed",
  "memento",
  "micropub",
  "modulepreload",
  "monitor",
  "monitor-group",
  "next",
  "next-archive",
  "nofollow",
  "noopener",
  "noreferrer",
  "opener",
  "openid2.local_id",
  "openid2.provider",
  "original",
  "p3pv1",
  "payment",
  "pingback",
  "preconnect",
  "predecessor-version",
  "prefetch",
  "preload",
  "prerender",
  "prev",
  "prev-archive",
  "preview",
  "previous",
  "privacy-policy",
  "profile",
  "publication",
  "rdap-active",
  "rdap-bottom",
  "rdap-down",
  "rdap-top",
  "rdap-up",
  "related",
  "replies",
  "restconf",
  "ruleinput",
  "search",
  "section",
  "self",
  "service",
  "service-desc",
  "service-doc",
  "service-meta",
  "sip-trunking-capability",
  "sponsored",
  "start",
  "status",
  "stylesheet",
  "subsection",
  "successor-version",
  "sunset",
  "tag",
  "terms-of-service",
  "timegate",
  "timemap",
  "type",
  "ugc",
  "up",
  "version-history",
  "via",
  "webmention",
  "working-copy",
  "working-copy-of",
]);

/**
 * Values HTML accepts that the registry does not list.
 *
 * `shortcut` is the whole set, and it is here because `rel="shortcut icon"` predates the registry
 * and still appears in every favicon snippet on the web. The HTML Standard handles it explicitly as
 * a legacy spelling of `icon`; warning about it would be crying wolf on correct, working markup.
 */
const HTML_LEGACY_RELATIONS: ReadonlySet<string> = new Set(["shortcut"]);

/**
 * True when the token is an extension relation type — RFC 8288 §2.1.2's escape hatch, which is an
 * absolute URI and is how anyone declares a relation the registry does not carry.
 *
 * @param {string} token
 * @returns {boolean}
 */
function isExtensionRelation(token: string): boolean {
  // A registered name can never contain a colon, so this test cannot swallow a typo'd one.
  const colon = token.indexOf(":");
  if (colon === -1) {
    return false;
  }
  /*
   * Something has to follow the scheme. `new URL("canonical:")` parses — a scheme with an empty
   * opaque path is a URI — so without this, one stray keystroke at the end of a registered name
   * would be silently reclassified as a deliberate extension relation, which is the precise
   * mistake this whole module exists to catch.
   */
  if (colon === token.length - 1) {
    return false;
  }
  try {
    return new URL(token).protocol !== "";
  } catch {
    return false;
  }
}

/**
 * The relation tokens in a `rel` attribute that are neither registered, nor legacy HTML, nor an
 * extension URI.
 *
 * `rel` is a space-separated set (`rel="shortcut icon"`, `rel="noopener noreferrer"`), so each
 * token is judged on its own; comparison is case-insensitive, which is what the HTML Standard
 * specifies for link types.
 *
 * @param {unknown} rel - The raw attribute value
 * @returns {string[]} Unrecognized tokens, as written
 */
export function unregisteredRelations(rel: unknown): string[] {
  if (typeof rel !== "string") {
    return [];
  }
  return rel.split(/\s+/).filter((token) => {
    if (token === "") {
      return false;
    }
    const lower = token.toLowerCase();
    return (
      !IANA_LINK_RELATIONS.has(lower) &&
      !HTML_LEGACY_RELATIONS.has(lower) &&
      !isExtensionRelation(token)
    );
  });
}

/**
 * Every unrecognized relation token across a set of `<head>` entries, deduplicated.
 *
 * Deduplicated because one mistyped `rel` in a layout is on every page of the site, and a warning
 * repeated four hundred times is a warning nobody reads.
 *
 * @param {readonly { tagName?: string; attributes?: Record<string, unknown> }[]} entries
 * @returns {string[]}
 */
export function unregisteredHeadRelations(
  entries: readonly { tagName?: string; attributes?: Record<string, unknown> }[],
): string[] {
  const found = new Set<string>();
  for (const entry of entries) {
    if (entry?.tagName !== "link") {
      continue;
    }
    for (const token of unregisteredRelations(entry.attributes?.rel)) {
      found.add(token);
    }
  }
  return [...found];
}
