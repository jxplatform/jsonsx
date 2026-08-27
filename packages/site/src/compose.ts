/**
 * Composing one page — routing, layout, `<head>` and context — over a project's working tree.
 *
 * Every rule here belongs to a sibling module in this package, not to this one: a page's URL
 * ({@link ./routes.ts}), the layout it wraps in ({@link ./layout.ts}), the `<head>` those merge
 * into ({@link ./head-merger.ts}) and the `$site`/`$page` state it binds against
 * ({@link ./context.ts}) are each decided in exactly one place, so a live render and `jx build`
 * cannot quietly disagree about what a route is. What is written here is only the assembly, and the
 * IO is injected — the same function reads off a disk, out of a Durable Object's SQLite table, or
 * over `fetch`.
 *
 * Two things the build does are deliberately NOT done:
 *
 * **`$paths` is not expanded.** Expanding a dynamic route means resolving a content collection or
 * running a module. It is also not needed: this serves on demand, so `/blog/hello` MATCHES
 * `pages/blog/[slug].json` and takes `slug` from the URL. What is lost is knowing which concrete
 * pages exist — `/blog/anything` renders — and that is the right trade for a surface whose job is
 * "show me this page".
 *
 * **`imports` are not rebased.** The build rewrites a project-level relative import onto the page's
 * own directory because the output tree has a different shape from the source tree. This serves the
 * source tree at the origin root, where the authored path already means what it says.
 */

import { compareRoutes, fileToRoute, isRoutedPageFile, matchRoute } from "./routes.ts";
import type { RouteShape } from "./routes.ts";
import { resolveLayout } from "./layout.ts";
import { mergeHead } from "./head-merger.ts";
import { injectContext } from "./context.ts";
import { localeDirection, localeOfRoute, resolveI18n } from "@jxsuite/schema/locale";
import { parseJxDocument } from "@jxsuite/schema/parse";
import type { JxDocument, JxElement, JxHeadEntry, ProjectConfig } from "@jxsuite/schema/types";

/** Everything the composer settled about a page before a renderer sees it. */
export interface ComposedPage {
  doc: JxDocument;
  head: JxHeadEntry[];
  lang: string;
  dir: "ltr" | "rtl";
}

/**
 * Turning a non-JSON document's bytes into a document, or null when this host has no parser for it.
 *
 * Named for the same reason {@link ./layout.ts}'s `LayoutLoader` is: it is the seam a host fills,
 * and what it decides is whether non-JSON pages render at all. A host with the project's format
 * registry (a Bun server, the desktop app) supplies one and `pages/index.md` composes; a host
 * without one (a Worker, where a format's parser is not reachable) omits it, and the caller gets a
 * named error instead of a blank page.
 */
export type DocumentParser = (
  path: string,
  text: string,
) => Promise<JxDocument | null> | JxDocument | null;

/** Reading the working tree — the one thing this module cannot do for itself. */
export interface SiteIO {
  /** A project file's text, or null when the tree has no such file. */
  read: (path: string) => Promise<string | null>;
  /** Every non-deleted path in the tree. */
  paths: () => readonly string[];
  /** Parse a non-JSON document through its format. Absent where the host has no format registry. */
  parse?: DocumentParser;
}

/** A page file and the route it answers. */
export interface PageRoute extends RouteShape {
  /** Project path of the page source, e.g. `pages/blog/[slug].json`. */
  sourcePath: string;
}

/** The route table, in match order. Static beats dynamic beats catch-all. */
export function routeTable(paths: readonly string[]): PageRoute[] {
  return paths
    .filter((path) => path.startsWith("pages/") && isRoutedPageFile(path))
    .map((path) => Object.assign(fileToRoute(path), { sourcePath: path }))
    .toSorted(compareRoutes);
}

/** Read and parse a page document, whatever format its extension claims. */
async function readDocument(io: SiteIO, path: string): Promise<JxDocument | null> {
  const text = await io.read(path);
  if (text === null) {
    return null;
  }
  if (path.endsWith(".json")) {
    return parseJxDocument(text, path);
  }
  return io.parse ? ((await io.parse(path, text)) ?? null) : null;
}

/** The project's configuration, or an empty one when it has none this host can read. */
export async function readProjectConfig(io: SiteIO): Promise<ProjectConfig> {
  const text = await io.read("project.json");
  if (text === null) {
    return {} as ProjectConfig;
  }
  try {
    return JSON.parse(text) as ProjectConfig;
  } catch {
    /* A project whose config does not parse still has pages, and refusing to render any of them
       would hide the one error the author can act on behind a blank origin. */
    return {} as ProjectConfig;
  }
}

/**
 * Union two `$elements` lists, keeping declaration order and dropping repeats.
 *
 * An entry is either a bare specifier (a string) or a `{ $ref }`; both are keyed by the thing they
 * name, so a page and its layout declaring the same component register it once.
 */
export function unionElements(
  ...lists: (readonly unknown[] | undefined)[]
): (string | JxElement)[] | undefined {
  const seen = new Set<string>();
  const merged: (string | JxElement)[] = [];
  for (const entry of lists.flatMap((list) => list ?? [])) {
    const key =
      typeof entry === "string"
        ? entry
        : ((entry as { $ref?: string } | null)?.$ref ?? JSON.stringify(entry));
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(entry as string | JxElement);
    }
  }
  return merged.length > 0 ? merged : undefined;
}

/** A component file in the project's own library, keyed by the tag it defines. */
const COMPONENT_FILE = /^components\/([^/]+-[^/]*)\.json$/;

/**
 * A `$ref`'s project path, so the same file written from two places is one key.
 *
 * A layout says `../components/nav.json` and a page says `./components/nav.json` for one file. Both
 * resolve against the shell's base rather than against the document that wrote them, so both name
 * `/components/nav.json` — and comparing the raw strings would register it twice.
 */
function refPath(ref: string): string {
  return new URL(ref, "file:///").pathname;
}

/** Every custom-element tag a document tree names, root included. */
function collectTagNames(node: unknown, into: Set<string>): void {
  if (!node || typeof node !== "object") {
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      collectTagNames(child, into);
    }
    return;
  }
  const { children, tagName } = node as { children?: unknown; tagName?: unknown };
  if (typeof tagName === "string" && tagName.includes("-")) {
    into.add(tagName);
  }
  collectTagNames(children, into);
}

/**
 * The project components a document USES, as `$elements` entries it never declared.
 *
 * `$elements` is a declaration, and almost nothing declares one: across the shipped starters a
 * layout names the chrome it uses and no page names anything, because in a BUILD it does not have
 * to — the compiler scans the rendered HTML for tags it compiled and emits a module script per tag
 * (`site-build.ts`, `injectComponentScripts`). The studio canvas reaches the same answer a third
 * way, walking the document against its component registry. Only this composer took `$elements`
 * literally, so a page rendered its own components as inert unknown tags while the canvas beside it
 * rendered them correctly — and, as everywhere else in this area, with nothing reported anywhere.
 *
 * The walk is transitive, which the other two auto-discoveries are not: a component's own tags are
 * found by reading it, so `sa-pricing` bringing `sa-check-item` registers both. The build gets that
 * for free by scanning HTML it has already rendered; here the definition has to be opened. It is
 * bounded by the components a page actually reaches, and each is opened once.
 *
 * Only `.json` components are discoverable, because a `$ref` is resolved by the browser: the
 * runtime fetches the file and parses it as a document, so a component in a format needing an
 * extension's parser cannot be registered this way whoever discovers it.
 */
async function discoverElements(io: SiteIO, doc: JxDocument): Promise<{ $ref: string }[]> {
  const available = new Map<string, string>();
  for (const path of io.paths()) {
    const tag = COMPONENT_FILE.exec(path)?.[1];
    if (tag !== undefined) {
      available.set(tag, path);
    }
  }
  if (available.size === 0) {
    return [];
  }

  /* What the document already declares, at any level: the union above has run, so this is the
     page's, the layout's and the project's together. A declared entry is still WALKED — it may
     bring components of its own — it is just not declared a second time. */
  const declared = new Set<string>();
  for (const entry of doc.$elements ?? []) {
    const ref = (entry as { $ref?: unknown } | null)?.$ref;
    if (typeof ref === "string") {
      declared.add(refPath(ref));
    }
  }

  const discovered: { $ref: string }[] = [];
  const opened = new Set<string>();
  let frontier: unknown[] = [doc];
  while (frontier.length > 0) {
    const tags = new Set<string>();
    for (const node of frontier) {
      collectTagNames(node, tags);
    }
    const next: unknown[] = [];
    for (const tag of tags) {
      const path = available.get(tag);
      if (path === undefined || opened.has(tag)) {
        continue;
      }
      opened.add(tag);
      const ref = `./${path}`;
      if (!declared.has(refPath(ref))) {
        discovered.push({ $ref: ref });
      }
      const definition = await readDocument(io, path);
      if (definition) {
        next.push(definition);
      }
    }
    frontier = next;
  }
  return discovered;
}

/**
 * Why a route could not be composed — a sentence for the reader, not a stack trace.
 *
 * The constructor is explicit rather than a `name` field initializer, and that is a coverage fact
 * rather than a style one: a class field on a subclass synthesizes a constructor, Bun counts that
 * synthesized function, and `new ComposeError(...)` never marks it entered — V8 attributes the call
 * to `Error`. The file then sits at 14/15 functions forever with every line covered, which reads
 * like an untested branch and is not one. Writing the constructor out is what makes the count
 * true.
 */
export class ComposeError extends Error {
  override readonly name: string;

  constructor(message: string) {
    super(message);
    this.name = "ComposeError";
  }
}

/**
 * Compose the page a URL asks for, or null when no route claims it.
 *
 * @param {SiteIO} io - Reads the working tree
 * @param {readonly PageRoute[]} routes - The table, in match order
 * @param {ProjectConfig} config - The project's configuration
 * @param {string} pathname - The request path, e.g. `/blog/hello/`
 */
export async function composeRoute(
  io: SiteIO,
  routes: readonly PageRoute[],
  config: ProjectConfig,
  pathname: string,
): Promise<ComposedPage | null> {
  const match = matchRoute(routes, pathname);
  if (!match) {
    return null;
  }
  return composePage(io, match.route, config, match.params);
}

/** Compose one known route with known parameters. */
export async function composePage(
  io: SiteIO,
  route: PageRoute,
  config: ProjectConfig,
  params: Record<string, string>,
): Promise<ComposedPage> {
  const pageDoc = await readDocument(io, route.sourcePath);
  if (!pageDoc) {
    throw new ComposeError(
      `${route.sourcePath} could not be read as a page. Only .json pages render here; other formats need their extension's parser, which this host does not run.`,
    );
  }

  const merged = await resolveLayout(pageDoc, config as Record<string, unknown>, async (ref) => {
    const doc = await readDocument(io, ref.replace(/^\.\//, ""));
    if (!doc) {
      throw new ComposeError(`Layout not found: ${ref}`);
    }
    return doc;
  });

  /*
   * `$elements` is legal on the page AND on the layout, and `resolveLayout` merges neither into the
   * other — so the composed document has only the LAYOUT's, and every custom element a page
   * declared for itself goes unregistered. The compiler reads both documents for exactly this
   * reason (`site-build.ts`, "a page of inert unknown elements with no error anywhere"), and the
   * failure is just as quiet here: the runtime renders `<site-card>` into the DOM, nothing defines
   * it, and the browser reports nothing at all.
   */
  const elements = unionElements(merged.$elements, pageDoc.$elements);
  if (elements) {
    merged.$elements = elements;
  }

  const { i18n } = resolveI18n(config);
  const siteRoute = {
    _pathParams: params,
    sourcePath: route.sourcePath,
    urlPattern: route.urlPattern,
  };
  injectContext(merged, config, siteRoute, null, i18n);

  /* After `injectContext`, because that is what merges the PROJECT's `$elements` in — discovering
     before it would re-declare every component the project already names for every page. */
  const discovered = await discoverElements(io, merged);
  const withDiscovered = unionElements(merged.$elements, discovered);
  if (withDiscovered) {
    merged.$elements = withDiscovered;
  }

  const pageHead = (pageDoc.$head ?? merged._pageHead ?? []) as JxHeadEntry[];
  const layoutHead = (merged.$head ?? []) as JxHeadEntry[];
  const siteHead = (config.$head ?? []) as JxHeadEntry[];
  const title = (pageDoc.title ?? merged._pageTitle ?? config.name ?? "") as string;
  const lang =
    (typeof pageDoc.$lang === "string" ? pageDoc.$lang : undefined) ??
    localeOfRoute(route.urlPattern, i18n) ??
    config.defaults?.lang ??
    "en";

  const head = mergeHead(siteHead, layoutHead, pageHead, {
    lang,
    title,
    ...(config.name === undefined ? {} : { siteName: config.name }),
  });

  /* `$head` is merged out of the document and rendered into the shell, so leaving it on the
     document would have the runtime inject every entry a second time on mount. */
  delete merged.$head;
  delete merged._pageHead;
  delete merged._pageTitle;

  return { dir: localeDirection(lang), doc: merged, head, lang };
}
