/**
 * Content-Security-Policy, derived from the pages the build actually produced.
 *
 * A static site cannot use nonces — a nonce has to be fresh per response, and these responses are
 * files — so hashes are the only route to a strict `script-src`. That works here because the inline
 * scripts Jx emits are **constants**: the colour-scheme pre-paint script is one fixed IIFE, and the
 * import map is the same two-entry object on every page of a build. A handful of hashes therefore
 * covers a whole site, which matters because Cloudflare Pages caps a `_headers` file at roughly a
 * hundred rules — a per-page policy would be unusable past a small site.
 *
 * Sources are collected by **scanning finished HTML** rather than by asking each emission site what
 * it emitted. There are seven places that can put a `<script>` on a page and a hash that does not
 * match the shipped bytes is worse than no policy at all, so the scan runs on the exact string
 * about to be written to disk.
 *
 * @docs framework/site/deployment
 */

import { createHash } from "node:crypto";
import type { CspConfig, HeadersConfig } from "@jxsuite/schema/types";

/** Everything a page contributed to the policy. Accumulated across the whole build. */
export interface CspSources {
  /** `'sha256-…'` for each distinct inline script. */
  scriptHashes: Set<string>;
  scriptOrigins: Set<string>;
  styleOrigins: Set<string>;
  imgOrigins: Set<string>;
  fontOrigins: Set<string>;
  frameOrigins: Set<string>;
}

export function emptyCspSources(): CspSources {
  return {
    fontOrigins: new Set(),
    frameOrigins: new Set(),
    imgOrigins: new Set(),
    scriptHashes: new Set(),
    scriptOrigins: new Set(),
    styleOrigins: new Set(),
  };
}

/**
 * Script `type` values the browser executes, and therefore the ones `script-src` governs.
 *
 * An empty or absent type is classic JavaScript. Everything else — `application/ld+json` above all
 * — is a _data block_: the browser never executes it, CSP never checks it, and hashing it would add
 * a hash that authorizes nothing. Verified in Chrome against an enforced policy.
 */
const EXECUTABLE_TYPES = new Set(["", "module", "importmap", "text/javascript", "module-shim"]);

const SCRIPT_TAG = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const LINK_TAG = /<link\b([^>]*)>/gi;
const IMG_TAG = /<img\b([^>]*)>/gi;
const SOURCE_TAG = /<source\b([^>]*)>/gi;
const IFRAME_TAG = /<iframe\b([^>]*)>/gi;
const FONT_EXTENSION = /\.(woff2?|ttf|otf|eot)(\?|#|$)/i;

/** Read one double- or single-quoted attribute out of a raw tag attribute string. */
function attr(attrs: string, name: string): string | undefined {
  return new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i")
    .exec(attrs)
    ?.slice(2)
    .find((v) => v !== undefined);
}

/** The origin of an absolute http(s) URL, or null for anything relative, `data:` or malformed. */
export function originOf(url: string | undefined): string | null {
  if (url === undefined || !/^https?:\/\//i.test(url)) {
    return null;
  }
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** The CSP source expression for an inline script's exact bytes. */
export function hashOf(source: string): string {
  return `'sha256-${createHash("sha256").update(source, "utf8").digest("base64")}'`;
}

/**
 * Scan one finished page and add what it needs to the accumulated sources.
 *
 * @param {string} html - The exact bytes about to be written
 * @param {CspSources} into
 */
export function collectCspSources(html: string, into: CspSources): void {
  for (const match of html.matchAll(SCRIPT_TAG)) {
    const attrs = match[1] ?? "";
    const src = attr(attrs, "src");
    const type = (attr(attrs, "type") ?? "").trim().toLowerCase();
    if (src !== undefined) {
      const origin = originOf(src);
      if (origin) {
        into.scriptOrigins.add(origin);
      }
      continue;
    }
    if (EXECUTABLE_TYPES.has(type)) {
      into.scriptHashes.add(hashOf(match[2] ?? ""));
    }
  }

  for (const match of html.matchAll(LINK_TAG)) {
    const attrs = match[1] ?? "";
    const rel = (attr(attrs, "rel") ?? "").toLowerCase();
    const href = attr(attrs, "href");
    const origin = originOf(href);
    if (!origin) {
      continue;
    }
    if (rel.includes("stylesheet")) {
      into.styleOrigins.add(origin);
    }
    if (FONT_EXTENSION.test(href ?? "") || (attr(attrs, "as") ?? "") === "font") {
      into.fontOrigins.add(origin);
    }
  }

  for (const [tag, group] of [
    [IMG_TAG, into.imgOrigins],
    [SOURCE_TAG, into.imgOrigins],
    [IFRAME_TAG, into.frameOrigins],
  ] as const) {
    for (const match of html.matchAll(tag)) {
      const attrs = match[1] ?? "";
      for (const value of [attr(attrs, "src"), ...srcsetUrls(attr(attrs, "srcset"))]) {
        const origin = originOf(value);
        if (origin) {
          group.add(origin);
        }
      }
    }
  }
}

/** The URLs in a `srcset`, without their descriptors. */
function srcsetUrls(srcset: string | undefined): string[] {
  return srcset === undefined
    ? []
    : srcset
        .split(",")
        .map((candidate) => candidate.trim().split(/\s+/)[0] ?? "")
        .filter(Boolean);
}

/** Normalize the config's three spellings into one shape, or null when CSP is off. */
export function normalizeCspConfig(security: HeadersConfig["security"]): CspConfig | null {
  const csp = security?.csp;
  if (csp === undefined || csp === false) {
    return null;
  }
  if (csp === true) {
    return {};
  }
  if (csp === "report-only") {
    return { mode: "report-only" };
  }
  return csp;
}

/**
 * Build the policy. Returns the headers to add, which is more than one when reporting is on:
 * `report-to` names an endpoint group that `Reporting-Endpoints` has to define.
 *
 * `style-src` carries `'unsafe-inline'` and always will until the style pipeline changes. Every
 * page has a generated `<style>` block whose content is per-page, so hashing them would put one
 * hash per page into a site-wide header, and per-element `style=` attributes have no hash form at
 * all. Both are recorded as a divergence rather than papered over — and note that a hash and
 * `'unsafe-inline'` in the same directive cancel: the browser ignores the keyword, so a partial job
 * here would be worse than an honest one.
 *
 * @param {CspSources} sources
 * @param {CspConfig} config
 * @returns {Record<string, string>}
 */
export function buildCspHeaders(sources: CspSources, config: CspConfig): Record<string, string> {
  const list = (fixed: string[], origins: Set<string>) => [...fixed, ...origins].join(" ");

  const directives: Record<string, string | false> = {
    "base-uri": "'self'",
    "default-src": "'self'",
    "font-src": list(["'self'"], sources.fontOrigins),
    "form-action": "'self'",
    // Matches the `X-Frame-Options: SAMEORIGIN` emitted beside it; two headers disagreeing about
    // Framing is a worse outcome than either answer.
    "frame-ancestors": "'self'",
    "frame-src": list(["'self'"], sources.frameOrigins),
    "img-src": list(["'self'", "data:"], sources.imgOrigins),
    "object-src": "'none'",
    "script-src": list(["'self'", ...[...sources.scriptHashes].toSorted()], sources.scriptOrigins),
    "style-src": list(["'self'", "'unsafe-inline'"], sources.styleOrigins),
  };

  if (config.reportUri !== undefined && config.reportUri !== "") {
    directives["report-to"] = "csp-endpoint";
    // Deprecated in CSP3 and still the only one some browsers implement, so both are emitted.
    directives["report-uri"] = config.reportUri;
  }

  for (const [name, value] of Object.entries<string | false>(config.directives ?? {})) {
    directives[name] = value;
  }

  const policy = Object.entries(directives)
    .filter(([, value]) => value !== false && value !== "")
    .toSorted(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, value]) => `${name} ${String(value)}`)
    .join("; ");

  const headerName =
    config.mode === "report-only"
      ? "Content-Security-Policy-Report-Only"
      : "Content-Security-Policy";
  const headers: Record<string, string> = { [headerName]: policy };
  if (config.reportUri !== undefined && config.reportUri !== "") {
    headers["Reporting-Endpoints"] = `csp-endpoint="${config.reportUri}"`;
  }
  return headers;
}
