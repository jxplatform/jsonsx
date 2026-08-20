/**
 * An optional service worker, and the tombstone that makes turning it off mean something.
 *
 * A service worker is unlike every other output here: it is **sticky**. It survives redeploys, it
 * keeps running against a site that has moved on, and the visitors it breaks are precisely the ones
 * who came before — the people who already trusted the site enough to load it twice. Nothing else
 * the build emits can do that, which is why this one is off by default and why the interesting half
 * of the module is how you get rid of it.
 *
 * Three rules, and each exists because its absence produces a specific failure:
 *
 * 1. **Off by default.** A worker nobody asked for is a caching layer nobody debugged.
 * 2. **HTML is always network-first.** A cache-first worker serves a stale page indefinitely, and the
 *    author's next deploy cannot reach the visitor to fix it.
 * 3. **`serviceWorker: false` emits a tombstone** at the same URL: a worker that unregisters itself
 *    and deletes every cache it made. Without it, "off" only means "new visitors get nothing" —
 *    everyone who already registered keeps the old worker forever, and there is no way to reach
 *    them.
 *
 * @docs framework/site/deployment
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ServiceWorkerConfig } from "@jxsuite/schema/types";

/** The URL a worker is served from. Fixed: its scope cannot exceed its own path. */
export const SERVICE_WORKER_PATH = "sw.js";

/**
 * The one path family safe to serve cache-first.
 *
 * It is the build's only content-addressed output — `variantFilename()` embeds a digest of the
 * source bytes, so a changed image is a changed URL and a cached one can never be wrong. Everything
 * else is named after what it contains rather than after its content (`_headers` says the same in
 * `NEVER_IMMUTABLE`), so caching it first would serve edited components from a stale entry.
 */
export const CACHE_FIRST_PREFIX = "/images/_optimized/";

export interface ServiceWorkerOutput {
  /** Path relative to `outDir`, or null when nothing should be emitted. */
  path: string | null;
  source: string;
  warnings: string[];
  errors: string[];
}

/**
 * The file a site-absolute URL is served from, resolving a directory URL to its index.
 *
 * @param {string} url - Site-absolute, e.g. `/offline/`
 * @param {string} outDir
 * @returns {string}
 */
function outputFileFor(url: string, outDir: string): string {
  const rel = url.replace(/^\//, "");
  return url.endsWith("/") || rel === "" ? join(outDir, rel, "index.html") : join(outDir, rel);
}

/** Normalize the config's two spellings into one shape. */
export function normalizeServiceWorker(
  value: ServiceWorkerConfig | boolean | undefined,
): ServiceWorkerConfig | false | null {
  if (value === undefined) {
    return null;
  }
  if (value === false) {
    return false;
  }
  if (value === true) {
    return {};
  }
  return value.enabled === false ? false : value;
}

/**
 * A short, stable id for a worker's configuration.
 *
 * The cache name embeds it so a config change rotates the cache. It deliberately does **not**
 * change per build: HTML is network-first and images are content-addressed, so a content-only
 * deploy needs no rotation — and a per-build name would throw away a warm cache on every deploy for
 * no benefit.
 */
function configId(config: ServiceWorkerConfig): string {
  const shape = JSON.stringify({
    fallback: config.offlineFallback ?? null,
    precache: [...(config.precache ?? [])].toSorted(),
    scope: config.scope ?? "/",
  });
  return createHash("sha256").update(shape, "utf8").digest("hex").slice(0, 8);
}

/**
 * The worker source for an enabled project.
 *
 * @param {ServiceWorkerConfig} config
 * @returns {ServiceWorkerOutput}
 */
export function buildServiceWorker(
  config: ServiceWorkerConfig,
  outDir?: string,
): ServiceWorkerOutput {
  const warnings: string[] = [];
  const errors: string[] = [];
  const precache = [...(config.precache ?? [])];
  const fallback = config.offlineFallback;
  if (fallback !== undefined && !precache.includes(fallback)) {
    /*
     * A fallback that was never cached cannot be served when the network is gone, which is the
     * only moment it exists for. Adding it is what the author meant; saying so is how they learn
     * the two settings are connected.
     */
    precache.push(fallback);
    warnings.push(
      `serviceWorker: "${fallback}" is the offline fallback but was not in \`precache\` — ` +
        "added, since a page that was never cached cannot be served offline.",
    );
  }

  /*
   * A precache URL that does not exist is a **build error**, and the reason is the failure mode:
   * `cache.addAll()` is all-or-nothing, so one unreachable entry rejects the install and the
   * worker never activates at all. The symptom is "the service worker does nothing", with no
   * error anywhere the author will look — which is exactly what happened the first time this was
   * run against a browser.
   */
  if (outDir !== undefined) {
    for (const url of precache) {
      if (!url.startsWith("/")) {
        errors.push(
          `serviceWorker.precache: "${url}" must be a site-absolute URL starting with /.`,
        );
      } else if (!existsSync(outputFileFor(url, outDir))) {
        errors.push(
          `serviceWorker.precache: "${url}" is not a file this build produced — ` +
            "`cache.addAll()` is all-or-nothing, so one bad entry stops the worker installing.",
        );
      }
    }
  }

  const cache = `jx-${configId(config)}`;
  const source = `/*
 * Generated by @jxsuite/compiler — configure via \`serviceWorker\` in project.json.
 * Set \`"serviceWorker": false\` to replace this with a worker that removes itself.
 */
const CACHE = ${JSON.stringify(cache)};
const PRECACHE = ${JSON.stringify(precache)};
const CACHE_FIRST = ${JSON.stringify(CACHE_FIRST_PREFIX)};
const OFFLINE_FALLBACK = ${JSON.stringify(fallback ?? null)};

self.addEventListener("install", (event) => {
  // Take over as soon as possible: a half-updated pair of workers is harder to reason about than
  // A single new one, and every response below tolerates a cold cache.
  self.skipWaiting();
  if (PRECACHE.length > 0) {
    /*
     * Fetched one at a time rather than with addAll(), which rejects the whole install if any
     * single request fails — leaving the worker permanently un-activated over one bad URL. The
     * build already checked these against its own output; this covers what it cannot see.
     */
    event.waitUntil(
      caches.open(CACHE).then((c) =>
        Promise.allSettled(PRECACHE.map((u) => c.add(u))).then((results) => {
          for (const [i, r] of results.entries()) {
            if (r.status === "rejected") console.warn("jx sw: could not precache", PRECACHE[i]);
          }
        }),
      ),
    );
  }
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Drop every cache this site made under a different config.
      for (const name of await caches.keys()) {
        if (name.startsWith("jx-") && name !== CACHE) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Content-addressed output only: the filename embeds a digest, so a hit can never be stale.
  if (url.pathname.startsWith(CACHE_FIRST)) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ??
          fetch(request).then((res) => {
            if (res.ok) caches.open(CACHE).then((c) => c.put(request, res.clone()));
            return res;
          }),
      ),
    );
    return;
  }

  /*
   * Everything else is network-first, HTML above all. A cache-first worker serves a stale page
   * indefinitely and the next deploy cannot reach the visitor to fix it — the cache is a fallback
   * for a failed request, never a substitute for one.
   */
  event.respondWith(
    (async () => {
      try {
        const res = await fetch(request);
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return res;
      } catch (error) {
        const hit = await caches.match(request);
        if (hit) return hit;
        if (OFFLINE_FALLBACK && request.mode === "navigate") {
          const page = await caches.match(OFFLINE_FALLBACK);
          if (page) return page;
        }
        throw error;
      }
    })(),
  );
});
`;

  return { errors, path: SERVICE_WORKER_PATH, source, warnings };
}

/**
 * The tombstone: a worker whose only job is to stop being one.
 *
 * It has to be served from the **same URL** as the worker it replaces, because that is the only URL
 * the browser will ever check for an update. A visitor who registered the old worker gets this one
 * on their next update check, it unregisters itself, deletes the caches, and reloads its clients
 * onto the live site.
 *
 * @returns {ServiceWorkerOutput}
 */
export function tombstoneServiceWorker(): ServiceWorkerOutput {
  const source = `/*
 * Generated by @jxsuite/compiler. This site had a service worker and no longer does.
 *
 * A worker is sticky: removing the file would leave every previous visitor running the old one
 * forever, because a 404 at this URL is not an instruction to stop. This is that instruction.
 */
self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith("jx-")) await caches.delete(name);
      }
      await self.registration.unregister();
      // Reload every open tab so it leaves this worker behind rather than finishing the session
      // Under a controller that has already unregistered.
      for (const client of await self.clients.matchAll({ type: "window" })) {
        client.navigate(client.url);
      }
    })(),
  );
});
`;
  return { errors: [], path: SERVICE_WORKER_PATH, source, warnings: [] };
}

/**
 * The inline registration script.
 *
 * Byte-identical on every page of a build, so a strict `script-src` needs exactly one hash for it
 * (site-architecture.md §14.3.1). It registers on `load` rather than immediately: a worker
 * competing with the page's own resources for bandwidth makes the first visit slower, which is the
 * visit that matters most.
 *
 * @param {string} scope
 * @returns {string}
 */
export function registrationScript(scope: string): string {
  return (
    `if('serviceWorker' in navigator){addEventListener('load',function(){` +
    `navigator.serviceWorker.register('/${SERVICE_WORKER_PATH}',{scope:${JSON.stringify(scope)}})` +
    `.catch(function(){})})}`
  );
}
