/**
 * The built site on its own origin — what `View: Open in Browser` opens.
 *
 * A built page is written for its published origin and addresses everything ROOT-absolutely:
 * `dist/basics/fetch/index.html` links to `/basics/counter` and loads `/components/fetch-demo.js`.
 * So it is only browsable when those paths resolve against the OUTPUT — and on the editor's server
 * they resolve against the project's SOURCES, because that is the editor's whole job. The two are
 * the same URLs holding different bytes: `/components/fetch-demo.js` is the module of formulas the
 * compiler reads in the sources, and the custom-element definition the page needs in the output.
 *
 * Serving the output as a 404 fallback on the editor's server looks like it works — the page and
 * the assets that exist in only one of the two spaces arrive — and then the reader gets the source
 * module for anything that exists in both. Measured: the page rendered, `customElements.get(...)`
 * was null, and nothing on it did anything. No ordering fixes that; one origin cannot hold two
 * meanings for one path.
 *
 * Hence a second server, rooted AT the output directory, where every path has exactly the meaning
 * the published site gives it. Nothing is injected — no live-reload client, no rewriting — because
 * the point is to hand the reader the bytes that will be deployed. `View: Open in Browser` builds,
 * then opens a URL here.
 *
 * It is bound to loopback and serves only files under the output directory, which is the artefact
 * the author is about to publish; it carries none of the editor's privileged routes and needs no
 * token. Servers are reused per project root — opening ten pages opens one port — and they live for
 * the life of the process: the map is keyed by root and two windows on one project share an origin,
 * so no single window's teardown may close it.
 */

import { serveSiteOutput, siteOutDir } from "./site-output.ts";

/** A running preview server for one project. */
export interface SitePreview {
  /** Origin to prefix a route with, e.g. `http://127.0.0.1:41234`. */
  origin: string;
  port: number;
}

interface Running extends SitePreview {
  server: { stop: (closeActiveConnections?: boolean) => void };
}

/** One server per project root — a second `Open in Browser` reuses the first one's port. */
const running = new Map<string, Running>();

/**
 * Start (or reuse) the preview server for `projectRoot`, or `null` when there is nothing to serve:
 * not a site project, or a site nobody has built yet. A caller that has just built gets a server;
 * one that has not gets the honest answer rather than a port that 404s everything.
 */
export function startSitePreview(projectRoot: string): SitePreview | null {
  const outDir = siteOutDir(projectRoot);
  if (!outDir) {
    return null;
  }
  const existing = running.get(projectRoot);
  if (existing) {
    return { origin: existing.origin, port: existing.port };
  }
  const server = Bun.serve({
    fetch: async (req: Request) => {
      const url = new URL(req.url);
      let decoded: string;
      try {
        decoded = decodeURIComponent(url.pathname);
      } catch {
        return new Response("Bad request", { status: 400 });
      }
      const res = await serveSiteOutput(decoded, projectRoot);
      if (res) {
        return res;
      }
      /* The site's OWN 404 page when it has one, at the status the published site would send.
         A generated `404.html` is a page the author wrote; showing it is more faithful than
         showing this server's opinion, and it is how the static hosts serve it. */
      const notFound = await serveSiteOutput("/404.html", projectRoot);
      return notFound
        ? new Response(notFound.body, { headers: notFound.headers, status: 404 })
        : new Response("Not found", { status: 404 });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  // `server.url` rather than `server.port`: the origin is the thing being handed to a browser, and
  // Reading it from the server that is actually listening cannot disagree with it.
  const entry: Running = {
    origin: server.url.origin,
    port: Number(server.url.port),
    server,
  };
  running.set(projectRoot, entry);
  return { origin: entry.origin, port: entry.port };
}

/** The origin already serving `projectRoot`, without starting one. */
export function sitePreviewOrigin(projectRoot: string): string | null {
  return running.get(projectRoot)?.origin ?? null;
}

/** Stop every preview server (process teardown, and the hook tests close their ports with). */
export function stopSitePreviews(): void {
  for (const entry of running.values()) {
    entry.server.stop(true);
  }
  running.clear();
}
