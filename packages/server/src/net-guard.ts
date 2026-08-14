/**
 * Shared network/path security primitives for the server package.
 *
 * These were originally private to `project-server.ts` (the hardened, token-gated desktop server).
 * They are extracted here so the plain dev server (`server.ts`) can reuse the SAME loopback checks,
 * realpath containment, and URL-decode hardening instead of its previous string-prefix logic.
 *
 * Security model. Loopback bind (127.0.0.1) is the primary control: LAN pages and other local
 * processes cannot read a loopback page's location, so cross-origin requests are the realistic
 * threat. `originHostGate` and `loopbackGate` are the request-level gate that rejects a
 * non-loopback Origin or a non-loopback Host (anti-CSRF and anti-DNS-rebinding); `loopbackGate`
 * additionally checks a token, which the desktop server's cross-origin canvas iframe needs but the
 * same-origin dev server does not. `containedPath`, `serveContained`, and `serveProjectFile`
 * contain a filesystem path within a root via a lexical relative() check plus a realpath re-check
 * (symlink escape defense). `decodeAndNormalizePath` decodes the URL pathname once and rejects
 * over-encoded dot and slash sequences.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";
import { resolveAssetUrl } from "@jxsuite/schema/asset-paths";
import type { AssetMount } from "@jxsuite/schema/asset-paths";

export const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** True when a hostname (optionally with :port) is a loopback host. */
export function isLoopbackHost(host: string | null | undefined): boolean {
  if (!host) {
    return false;
  }
  // Strip a trailing :port (but keep bracketed IPv6 intact for the literal set).
  let h = host;
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    h = end === -1 ? h : h.slice(0, end + 1);
  } else {
    const colon = h.indexOf(":");
    if (colon !== -1) {
      h = h.slice(0, colon);
    }
  }
  return LOOPBACK_HOSTS.has(h.toLowerCase());
}

/**
 * Accept when the Origin's host is loopback OR Origin is absent (Bun-native / test clients send no
 * Origin). Do NOT hardcode-match one literal origin — localhost and 127.0.0.1 are distinct origins,
 * and a too-strict check would 403 legitimate clients.
 */
export function originIsLoopbackOrAbsent(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) {
    return true;
  }
  try {
    return isLoopbackHost(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/**
 * Reject a Host header that is present and NOT loopback (defeats DNS-rebinding, where Host is the
 * attacker domain). An absent Host (Bun-native clients) is accepted.
 */
export function hostIsLoopbackOrAbsent(req: Request): boolean {
  const host = req.headers.get("host");
  if (!host) {
    return true;
  }
  return isLoopbackHost(host);
}

/**
 * Origin/Host-only request gate (no token). Returns a 403 Response when the request is not
 * loopback-safe, else null. Suitable for a same-origin dev server: the browser sends a loopback
 * Origin on cross-origin POSTs, so this closes CSRF + DNS-rebinding without a shared token.
 */
export function originHostGate(req: Request): Response | null {
  if (!originIsLoopbackOrAbsent(req) || !hostIsLoopbackOrAbsent(req)) {
    return new Response("Forbidden", { status: 403 });
  }
  return null;
}

/**
 * Token + Origin/Host gate. Returns a 403 Response when the token mismatches OR the request is not
 * loopback-safe, else null. Used by the cross-origin desktop server whose canvas iframe carries the
 * token in the URL. Pass `token: null` to skip the token check (Origin/Host only).
 */
export function loopbackGate(req: Request, url: URL, token: string | null): Response | null {
  if (token !== null && url.searchParams.get("token") !== token) {
    return new Response("Forbidden", { status: 403 });
  }
  return originHostGate(req);
}

/** Normalize a path for cross-platform containment comparison (separators + case on Windows). */
export function normalizeForCompare(p: string): string {
  const slashed = p.replaceAll("\\", "/");
  return process.platform === "win32" ? slashed.toLowerCase() : slashed;
}

/**
 * Contain `absPath` within `root`: a lexical relative() check followed by a realpath re-check so a
 * symlink inside the tree cannot point outside it. Returns the (possibly realpath'd) absolute path
 * when contained, or null otherwise. The caller must already have decoded the URL pathname.
 */
export function containedPath(absPath: string, root: string): string | null {
  // (1) Lexical containment.
  const rel = relative(root, absPath);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return null;
  }
  // (2) realpath BOTH and re-check the realpath is still under realRoot (symlink containment).
  let realRoot: string;
  let realPath: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    // Root itself is unresolvable: fall back to lexical-only containment.
    return absPath;
  }
  try {
    realPath = realpathSync(absPath);
  } catch {
    // Target does not exist yet — lexical containment already passed; let the caller's existence
    // Check decide. (Reads will 404; the write-path resolves its own parent separately.)
    return absPath;
  }
  const nRoot = normalizeForCompare(realRoot);
  const nPath = normalizeForCompare(realPath);
  if (nPath === nRoot || nPath.startsWith(nRoot.endsWith("/") ? nRoot : `${nRoot}/`)) {
    return realPath;
  }
  return null;
}

/**
 * Serve a file under `root` if it both exists and is contained. Returns the Response, or null when
 * missing/traversed (caller decides the fallthrough status).
 */
export async function serveContained(absPath: string, root: string): Promise<Response | null> {
  const safe = containedPath(absPath, root);
  if (!safe) {
    return null;
  }
  const file = Bun.file(safe);
  if (await file.exists()) {
    return new Response(file);
  }
  return null;
}

/**
 * Try to serve a project file at its natural URL: an extension asset mount, then
 * absolute-under-root, then root-relative, then public/. Each candidate goes through containedPath
 * (realpath). `decodedPath` is the once-decoded URL pathname (leading slash, forward slashes).
 *
 * Mounts come first and are contained against their own directory rather than the project root:
 * they exist precisely to publish directories that may sit outside it (extensions.md §8.5).
 *
 * The project's BUILT OUTPUT is deliberately NOT here, nor anywhere else in an editing server's
 * chain: these paths mean the project's SOURCES, and a built page addresses the same paths meaning
 * its own output. The built site is served on its own origin instead — see
 * {@link file://./site-preview.ts}.
 */
export async function serveProjectFile(
  decodedPath: string,
  root: string,
  mounts: readonly AssetMount[] = [],
): Promise<Response | null> {
  for (const mount of [...mounts].toSorted((a, b) => b.urlPrefix.length - a.urlPrefix.length)) {
    const mounted = resolveAssetUrl([mount], decodedPath);
    if (!mounted) {
      continue;
    }
    const res = await serveContained(mounted, mount.dir);
    if (res) {
      return res;
    }
  }
  // Map the URL pathname back to a filesystem path. On Windows the browser requests an absolute
  // Path as /C:/Users/… (leading slash + forward slashes); drop the slash before the drive letter.
  // A POSIX absolute path arrives as //abs/path.
  const fsPath = decodedPath.startsWith("//")
    ? decodedPath.slice(1)
    : decodedPath.replace(/^\/([A-Za-z]:)/, "$1");

  // 1. Absolute path that falls under the project root.
  if (normalizeForCompare(fsPath).startsWith(normalizeForCompare(root))) {
    const res = await serveContained(fsPath, root);
    if (res) {
      return res;
    }
  }

  // 2. Root-relative.
  const relRes = await serveContained(resolve(root, `.${decodedPath}`), root);
  if (relRes) {
    return relRes;
  }

  // 3. public/ subdirectory.
  const pubRes = await serveContained(resolve(root, "public", `.${decodedPath}`), root);
  if (pubRes) {
    return pubRes;
  }

  return null;
}

/** Result of decoding a URL pathname: the safe decoded/normalized path, or a rejection Response. */
export type DecodedPath = { path: string; normPath: string } | { reject: Response };

/**
 * Decode a URL pathname ONCE and reject over-encoding bypasses. Returns `{ path, normPath }` where
 * `path` is the once-decoded pathname and `normPath` collapses runs of leading slashes to one, or
 * `{ reject }` with a 400/404 Response when the input is malformed or still contains an encoded
 * dot/slash after one decode.
 */
export function decodeAndNormalizePath(url: URL): DecodedPath {
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return { reject: new Response("Bad request", { status: 400 }) };
  }
  if (/%2e|%2f/i.test(path)) {
    return { reject: new Response("Not found", { status: 404 }) };
  }
  const normPath = path.replace(/^\/{2,}/, "/");
  return { path, normPath };
}
