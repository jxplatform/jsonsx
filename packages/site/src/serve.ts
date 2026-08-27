/**
 * Turning one request into a response, on an origin that serves a project as a site.
 *
 * The decision order mirrors what a published site does with the same URL, which is the whole
 * contract of serving on an origin of its own: a path is a FILE if the tree has one there, and a
 * ROUTE otherwise. Getting that order wrong in either direction is visible — a `pages/` document
 * served as JSON instead of rendered, or a `/favicon.svg` answered with someone's index page.
 *
 * A host's own surfaces — a runtime bundle, a reload stream — are NOT a lane here. They are
 * dispatched before this function is reached, because a namespace only that host knows about is not
 * a fact about the site. What a host may add is a {@link ServeOptions.fallback}, tried after routes
 * and before the 404, which is where a lane like on-demand npm bundling belongs: it answers paths a
 * site legitimately asks for that this package cannot produce.
 */

import { candidatePaths, contentTypeFor, normalizeRequestPath } from "./paths.ts";
import { ComposeError, composeRoute, readProjectConfig, routeTable } from "./compose.ts";
import type { PageRoute, SiteIO } from "./compose.ts";
import { pageShell, problemShell } from "./shell.ts";
import type { ShellOptions } from "./shell.ts";
import type { ProjectConfig } from "@jxsuite/schema/types";

/** Reading bytes for a servable file — separate from {@link SiteIO} because assets are binary. */
export interface AssetIO {
  /** The file's bytes, or null when the tree cannot produce them. */
  bytes: (path: string) => Promise<Uint8Array | null>;
}

/** What this origin knows about a project, computed once per request. */
export interface SiteContext {
  config: ProjectConfig;
  routes: PageRoute[];
}

/** How a host wants pages shelled, and what it can answer that this package cannot. */
export interface ServeOptions {
  shell: ShellOptions;
  /** Tried after routes and before the 404 — a host's own lane for site-legitimate paths. */
  fallback?: (requestPath: string) => Promise<Response | null>;
}

/** Headers every response from this origin carries, whatever it is serving. */
export function siteHeaders(contentType: string): Record<string, string> {
  return {
    /* Never cached. A composed page is a function of a working tree that changes under it, and it
       is not revalidatable — there is no version of it to compare against. */
    "Cache-Control": "private, no-store",
    "Content-Type": contentType,
    /* A live render is a working copy, and an indexed one would compete with the site the author
       actually publishes. */
    "X-Robots-Tag": "noindex, nofollow",
    "X-Content-Type-Options": "nosniff",
    /* The origin this was reached from is nobody else's business — and on a desktop machine the
       referring origin is an editor holding a token. */
    "Referrer-Policy": "same-origin",
  };
}

/** Read the project's configuration and route table out of the tree. */
export async function siteContext(io: SiteIO): Promise<SiteContext> {
  return { config: await readProjectConfig(io), routes: routeTable(io.paths()) };
}

/** A plain 404, for when neither the tree nor the project has anything to say. */
function plainNotFound(): Response {
  return new Response("Not found", {
    headers: siteHeaders("text/plain; charset=utf-8"),
    status: 404,
  });
}

/**
 * Serve one path.
 *
 * @param {string} pathname - The request path, still URL-encoded
 * @param {SiteIO} io - Reads the working tree's text
 * @param {AssetIO} assets - Reads a servable file's bytes
 * @param {SiteContext} context - The project's configuration and route table
 * @param {ServeOptions} options - The shell contract, and the host's own fallback lane
 */
export async function serveSite(
  pathname: string,
  io: SiteIO,
  assets: AssetIO,
  context: SiteContext,
  options: ServeOptions,
): Promise<Response> {
  const requestPath = normalizeRequestPath(pathname);
  if (requestPath === null) {
    return plainNotFound();
  }

  // A file the tree really has, at the path the published site would serve it from.
  for (const candidate of candidatePaths(requestPath)) {
    const bytes = await assets.bytes(candidate);
    if (bytes) {
      return new Response(bytes as BodyInit, {
        headers: siteHeaders(contentTypeFor(candidate)),
      });
    }
  }

  const page = await composeSafely(io, context, pathname, options.shell);
  if (page) {
    return page;
  }

  const fallback = await options.fallback?.(requestPath);
  if (fallback) {
    return fallback;
  }

  /* The project's own 404, at 404 — the same thing a built site serves, because a reader who
     mistypes a URL should see the site's answer and not ours. */
  const notFound = await composeSafely(io, context, "/404", options.shell);
  if (notFound) {
    return new Response(await notFound.text(), {
      headers: siteHeaders("text/html; charset=utf-8"),
      status: 404,
    });
  }
  return plainNotFound();
}

/**
 * Compose a route into a response, turning a compose failure into a page that says so.
 *
 * A render that 500s tells the author nothing they can act on. A page naming the file and the
 * reason is the difference between "the preview is broken" and "this page needs a `.json` layout".
 */
async function composeSafely(
  io: SiteIO,
  context: SiteContext,
  pathname: string,
  shell: ShellOptions,
): Promise<Response | null> {
  let page;
  try {
    page = await composeRoute(io, context.routes, context.config, pathname);
  } catch (error) {
    if (error instanceof ComposeError) {
      return new Response(problemShell(error.message), {
        headers: siteHeaders("text/html; charset=utf-8"),
        status: 500,
      });
    }
    throw error;
  }
  if (!page) {
    return null;
  }
  return new Response(pageShell(page, shell), {
    headers: siteHeaders("text/html; charset=utf-8"),
  });
}
