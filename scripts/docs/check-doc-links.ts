/**
 * Resolve every internal link in the docs, which nothing has ever done.
 *
 * The style guide says so itself, in a `:::doc-warning` it has been carrying: _"No gate checks
 * internal links. `docs:check` validates frontmatter, spec anchors, `code:` paths, images, and the
 * nav bijection — nothing resolves a link target. A typo, or a renamed page, ships silently."_
 *
 * Six pages were shipping broken links when this was written, all the same way: a relative
 * `./i18n.md` link, which the style guide forbids because the site serves the target verbatim
 * instead of rewriting it to a URL. The reader gets a 404 on a link the author tested locally in a
 * Markdown preview, where relative paths are exactly what works. That is why the rule is a gate and
 * not a convention: the broken form is the one that looks right while you write it.
 *
 * Anchors matter more than they look. Thirty-one links point at a heading slug, and a slug is
 * minted from a heading's RENDERED text, so rewording a heading silently breaks every inbound link
 * while re-casing one breaks nothing. A prose rewrite is exactly the change that does this, and
 * this gate is what stands between one and a corpus of dead fragments. `lib/headings.ts` derives
 * the slug by importing the site's own `slugifyHeading` rather than reimplementing it.
 *
 * Published pages are the ones in `docs/nav.json`. `docs/README.md` is a contributor file, is not
 * published, and its relative links to `../specs/README.md` are correct as written.
 *
 * Usage: `bun scripts/docs/check-doc-links.ts`
 */

import { existsSync, readFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { headingsOf } from "./lib/headings.ts";

const ROOT = resolve(import.meta.dir, "../..");
const DOCS_DIR = join(ROOT, "docs");
const NAV_PATH = join(DOCS_DIR, "nav.json");
const SITE_PAGES = join(ROOT, "sites/jxsuite.com/pages");

/** `[label](target)`, skipping images. Reference-style links are not used in this corpus. */
const LINK = /(?<!!)\[(?<label>[^\]]*)\]\((?<target>[^)\s]+)(?:\s+"[^"]*")?\)/g;
const FENCE = /^\s*(```|~~~)/;

export interface LinkRef {
  file: string;
  line: number;
  label: string;
  target: string;
}

/**
 * Every link in one document, outside fenced code and inline code spans.
 *
 * @param {string} source
 * @param {string} file
 * @returns {LinkRef[]}
 */
export function linksOf(source: string, file: string): LinkRef[] {
  const found: LinkRef[] = [];
  let inFence = false;
  for (const [i, raw] of source.split("\n").entries()) {
    if (FENCE.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    // A link inside backticks is being shown, not made. Blank the span, keep the offsets.
    const line = raw.replaceAll(/`+[^`]*`+/g, (m) => " ".repeat(m.length));
    for (const m of line.matchAll(LINK)) {
      found.push({
        file,
        label: m.groups?.label ?? "",
        line: i + 1,
        target: m.groups?.target ?? "",
      });
    }
  }
  return found;
}

interface NavNode {
  path: string;
  children?: NavNode[];
}

/**
 * The slugs the site publishes, in nav order.
 *
 * @param {string} navJson
 * @returns {string[]}
 */
export function navSlugs(navJson: string): string[] {
  const nav = JSON.parse(navJson) as { sections: NavNode[] };
  const out: string[] = [];
  const walk = (nodes: NavNode[]) => {
    for (const n of nodes) {
      out.push(n.path);
      walk(n.children ?? []);
    }
  };
  walk(nav.sections);
  return out;
}

/** `docs/studio/interface/tabs.md` -> `studio/interface/tabs`; `x/index.md` -> `x`. */
function docSlug(file: string): string {
  const rel = relative(DOCS_DIR, file).replaceAll("\\", "/");
  const slug = rel.slice(0, rel.length - extname(rel).length);
  return slug.endsWith("/index") ? slug.slice(0, -"/index".length) : slug;
}

function pageFile(slug: string): string | undefined {
  for (const candidate of [join(DOCS_DIR, `${slug}.md`), join(DOCS_DIR, slug, "index.md")]) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

export interface Violation {
  id: string;
  file: string;
  line: number;
  message: string;
}

/**
 * Check one page's links against the published slug set and the anchors each target declares.
 *
 * @param {LinkRef[]} links
 * @param {Set<string>} published
 * @param {(slug: string) => Set<string> | undefined} anchorsFor
 * @param {(route: string) => boolean} siteRouteExists
 * @returns {Violation[]}
 */
export function checkLinks(
  links: LinkRef[],
  published: Set<string>,
  anchorsFor: (slug: string) => Set<string> | undefined,
  siteRouteExists: (route: string) => boolean,
): Violation[] {
  const out: Violation[] = [];
  const fail = (link: LinkRef, id: string, message: string) => {
    out.push({ file: link.file, id, line: link.line, message });
  };

  for (const link of links) {
    const { target } = link;
    if (target.startsWith("#")) {
      const own = anchorsFor(docSlug(link.file));
      if (own && !own.has(target.slice(1))) {
        fail(link, "link-unknown-anchor", `no heading on this page publishes "${target}"`);
      }
      continue;
    }
    // Anything with a scheme, a protocol-relative prefix, or a mail target leaves the site.
    if (/^[a-z][\w+.-]*:/i.test(target) || target.startsWith("//")) {
      continue;
    }
    if (target.startsWith(".")) {
      fail(
        link,
        "link-relative-md",
        `relative link "${target}" publishes broken: the site serves the target verbatim. ` +
          "Write a root-absolute slug, e.g. /docs/framework/site/i18n",
      );
      continue;
    }
    if (!target.startsWith("/")) {
      fail(link, "link-relative-md", `link "${target}" is neither root-absolute nor external`);
      continue;
    }

    const [path = "", anchor] = target.slice(1).split("#");
    if (path.endsWith(".md")) {
      fail(link, "link-md-extension", `link "${target}" keeps its .md extension`);
      continue;
    }
    if (path.endsWith("/") && path !== "docs/") {
      fail(link, "link-trailing-slash", `link "${target}" has a trailing slash`);
      continue;
    }
    if (!path.startsWith("docs/")) {
      if (!siteRouteExists(path)) {
        fail(link, "link-unknown-route", `link "${target}" matches no page under sites/*/pages`);
      }
      continue;
    }

    const slug = path.slice("docs/".length);
    if (!published.has(slug)) {
      fail(link, "link-unknown-page", `link "${target}" names no page in docs/nav.json`);
      continue;
    }
    if (anchor !== undefined && anchor !== "" && !anchorsFor(slug)?.has(anchor)) {
      fail(link, "link-unknown-anchor", `"${slug}" publishes no heading anchor "#${anchor}"`);
    }
  }
  return out;
}

/**
 * Every slug that appears as an inbound `#anchor`, and who points at it.
 *
 * Print it before rewording a heading: these are the anchors a rewrite must keep or update.
 *
 * @param {LinkRef[]} links
 * @returns {Map<string, LinkRef[]>}
 */
export function inboundAnchors(links: LinkRef[]): Map<string, LinkRef[]> {
  const out = new Map<string, LinkRef[]>();
  for (const link of links) {
    const m = /^\/docs\/([a-z0-9/-]+)#([^)\s]+)$/.exec(link.target);
    if (!m) {
      continue;
    }
    const key = `${m[1]}#${m[2]}`;
    out.set(key, [...(out.get(key) ?? []), link]);
  }
  return out;
}

/**
 * Read the committed tree: the published pages, their links, and their anchors.
 *
 * @returns {{
 *   links: LinkRef[];
 *   published: Set<string>;
 *   anchorsFor: (slug: string) => Set<string> | undefined;
 *   siteRouteExists: (route: string) => boolean;
 * }}
 */
export function readCorpus() {
  const published = new Set(navSlugs(readFileSync(NAV_PATH, "utf8")));
  const anchorCache = new Map<string, Set<string> | undefined>();

  const anchorsFor = (slug: string): Set<string> | undefined => {
    if (!anchorCache.has(slug)) {
      const file = pageFile(slug);
      const anchors = file
        ? new Set(headingsOf(readFileSync(file, "utf8")).map((h) => h.slug))
        : undefined;
      anchorCache.set(slug, anchors);
    }
    return anchorCache.get(slug);
  };

  const links: LinkRef[] = [];
  for (const slug of published) {
    const file = pageFile(slug);
    if (file) {
      links.push(
        ...linksOf(readFileSync(file, "utf8"), relative(ROOT, file).replaceAll("\\", "/")),
      );
    }
  }

  const siteRouteExists = (route: string): boolean => {
    const rel = route.replaceAll(/^\/+|\/+$/g, "");
    if (rel === "") {
      return true;
    }
    return [`${rel}.md`, `${rel}.json`, `${rel}/index.md`, `${rel}/index.json`].some((c) =>
      existsSync(join(SITE_PAGES, c)),
    );
  };

  return { anchorsFor, links, published, siteRouteExists };
}

async function main(): Promise<void> {
  const { anchorsFor, links, published, siteRouteExists } = readCorpus();

  if (process.argv.includes("--anchors")) {
    const inbound = inboundAnchors(links);
    console.log(`${inbound.size} heading anchor(s) are linked from inside /docs:\n`);
    for (const [key, refs] of [...inbound].toSorted()) {
      const from = refs.map((r) => `${r.file}:${r.line}`).join(", ");
      console.log(`  ${key}  (${refs.length}x)  ${from}`);
    }
    console.log("\nRewording one of these headings breaks every link above it. Re-casing is safe.");
    return;
  }

  const violations = checkLinks(links, published, anchorsFor, siteRouteExists);
  if (violations.length === 0) {
    console.log(
      `doc links: ${links.length} internal link(s) across ${published.size} page(s) all resolve.`,
    );
    return;
  }
  console.error(`\ndoc links: ${violations.length} violation(s):`);
  for (const v of violations) {
    console.error(`  [${v.id}] ${v.file}:${v.line} ${v.message}`);
  }
  process.exit(1);
}

if (import.meta.main) {
  await main();
}
