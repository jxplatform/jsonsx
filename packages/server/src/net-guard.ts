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
import { problem } from "./problem.ts";

export const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * The whole loopback block, not just `127.0.0.1`.
 *
 * IANA reserves `127.0.0.0/8` (RFC 1122 §3.2.1.3), and every address in it is the same machine —
 * `127.0.0.2` reaches this process exactly as `127.0.0.1` does. A gate that recognized only the
 * canonical spelling would reject a client that used any other, while granting nothing: an attacker
 * who can send from `127.0.0.53` is already on the host.
 */
const IPV4_LOOPBACK = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * The unspecified address, accepted as a **Host** and never as an **Origin**.
 *
 * As a Host it is ordinary: a server bound to `0.0.0.0` inside a container is reached at that
 * literal, and the request is as local as any other. As an Origin it is meaningless — no page is
 * ever served from `http://0.0.0.0` — so a request claiming it is either confused or probing, and
 * treating the two positions alike would widen the gate for nothing.
 */
const UNSPECIFIED_HOST = "0.0.0.0";

/** Strip a trailing `:port`, keeping a bracketed IPv6 literal intact. */
function bareHost(host: string): string {
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end === -1 ? host : host.slice(0, end + 1);
  }
  const colon = host.indexOf(":");
  return colon === -1 ? host : host.slice(0, colon);
}

/** True when a hostname (optionally with :port) is a loopback host. */
export function isLoopbackHost(host: string | null | undefined): boolean {
  if (!host) {
    return false;
  }
  const h = bareHost(host).toLowerCase();
  return LOOPBACK_HOSTS.has(h) || IPV4_LOOPBACK.test(h);
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
    // Deliberately NOT accepting the unspecified address here; see UNSPECIFIED_HOST.
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
  return isLoopbackHost(host) || bareHost(host) === UNSPECIFIED_HOST;
}

/**
 * How much cross-origin traffic a surface tolerates.
 *
 * `strict` is the default and what every privileged route uses. `embeddable` exists for exactly one
 * reason: the desktop canvas renders the project inside an iframe on a **different origin**, so the
 * subresources that page requests — its images, its stylesheets, its modules — legitimately arrive
 * `cross-site`. Refusing those would break the canvas; accepting them for a route that can write a
 * file or run an `import()` would hand away the containment. So the difference is a property of the
 * surface, named at the call site.
 */
export type FetchPolicy = "strict" | "embeddable";

/**
 * Whether `Sec-Fetch-*` says this request is one the surface accepts (Fetch Metadata Request
 * Headers).
 *
 * The header states the requester's intent directly, which is what `Origin` cannot do: a
 * same-origin GET omits `Origin` entirely, so the gate has to accept an absent one — a hole
 * `Sec-Fetch-Site` does not have.
 *
 * **Absent means accept, and that is a hard requirement rather than a concession.** The header is
 * browser-supplied. curl omits it, Bun-native clients omit it, the desktop RPC bridge omits it, and
 * `packages/server/tests/**` builds well over a hundred bare `Request`s. Requiring it would refuse
 * every non-browser client on the machine while stopping no attacker, because the threat model here
 * is a _page_ — and a page always sends it. `fetchMetadataAbsentIsAccepted` in
 * `tests/net-guard.test.ts` is the test that makes deleting this loud.
 *
 * Under `strict`:
 *
 * - `same-origin` and `none` — the served page and a typed URL. Allowed.
 * - `cross-site` — allowed **only** for a top-level document navigation, which is a person following
 *   a link. A cross-site _subresource_ or form POST is the CSRF this gate exists for.
 * - `same-site` — **denied**, which is stricter than the standard's Resource Isolation Policy and
 *   deliberate: on `127.0.0.1` there is no meaningful "site" wider than the origin, so `same-site`
 *   means _a different port on this machine_ — precisely the other-local-process threat a loopback
 *   bind cannot address.
 *
 * @param {Request} req
 * @param {FetchPolicy} policy
 * @returns {boolean}
 */
export function fetchMetadataAllows(req: Request, policy: FetchPolicy = "strict"): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (!site) {
    return true;
  }
  if (site === "same-origin" || site === "none") {
    return true;
  }
  if (site === "cross-site") {
    if (policy === "embeddable") {
      return true;
    }
    // A person following a link, and nothing else.
    return (
      req.headers.get("sec-fetch-mode") === "navigate" &&
      req.headers.get("sec-fetch-dest") === "document" &&
      req.method === "GET"
    );
  }
  // `same-site` and anything unrecognized.
  return policy === "embeddable" && site === "same-site";
}

/**
 * Origin/Host + Fetch Metadata request gate (no token). Returns a 403 Response when the request is
 * not loopback-safe, else null.
 *
 * Suitable for a same-origin dev server: the browser sends a loopback Origin on cross-origin POSTs,
 * so this closes CSRF + DNS-rebinding without a shared token. The Fetch Metadata check is folded in
 * here rather than added at each call site, which is what makes it reach every gated surface at
 * once — there are no new call sites to remember.
 */
export function originHostGate(req: Request, policy: FetchPolicy = "strict"): Response | null {
  if (!originIsLoopbackOrAbsent(req) || !hostIsLoopbackOrAbsent(req)) {
    return problem("forbidden", "Forbidden");
  }
  if (!fetchMetadataAllows(req, policy)) {
    return problem("forbidden", "Forbidden");
  }
  return null;
}

/**
 * Compare two secrets without leaking their common prefix through timing.
 *
 * The token is in a URL that a local process may be able to guess at but not read, so a
 * character-by-character early return is a real oracle: an attacker who can time responses recovers
 * it one character at a time. Length is compared first and separately, because a length mismatch is
 * not secret — the token's length is fixed and public.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function secretsMatch(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    // oxlint-disable-next-line no-bitwise -- constant-time accumulation; a branch here is the leak.
    diff |= (a.codePointAt(i) ?? 0) ^ (b.codePointAt(i) ?? 0);
  }
  return diff === 0;
}

/**
 * The token a request presents, from either place it may carry one.
 *
 * The query parameter is what the canvas iframe uses, because an iframe's `src` is the only place
 * it can put one. `Authorization: Bearer` is accepted **additively** for everything else — a fetch,
 * a curl, a desktop bridge — since a secret in a URL is logged, referred and shoulder-surfable, and
 * offering a header costs nothing.
 *
 * @param {Request} req
 * @param {URL} url
 * @returns {string | null}
 */
export function presentedToken(req: Request, url: URL): string | null {
  const bearer = req.headers.get("authorization");
  if (bearer?.toLowerCase().startsWith("bearer ")) {
    const value = bearer.slice("bearer ".length).trim();
    if (value !== "") {
      return value;
    }
  }
  return url.searchParams.get("token");
}

/**
 * Token + Origin/Host + Fetch Metadata gate. Returns a 403 Response when the token mismatches OR
 * the request is not loopback-safe, else null. Used by the cross-origin desktop server whose canvas
 * iframe carries the token in the URL. Pass `token: null` to skip the token check.
 */
export function loopbackGate(
  req: Request,
  url: URL,
  token: string | null,
  policy: FetchPolicy = "strict",
): Response | null {
  if (token !== null) {
    const presented = presentedToken(req, url);
    if (presented === null || !secretsMatch(presented, token)) {
      return problem("forbidden", "Forbidden");
    }
  }
  return originHostGate(req, policy);
}

/** Normalize a path for cross-platform containment comparison (separators + case on Windows). */
export function normalizeForCompare(p: string): string {
  /*
   * NFC, and this is not cosmetic. `readdir` on macOS returns a decomposed filename while a path
   * from a file picker, a config file or a URL arrives precomposed — two different strings for one
   * file. Containment is a string comparison, so without normalizing, every path holding an accent
   * silently failed to be contained: the file existed, the check said it was outside the root, and
   * the request 404'd with nothing to search for.
   */
  const slashed = p.replaceAll("\\", "/").normalize("NFC");
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
    return { reject: problem("invalidRequest", "Bad request") };
  }
  if (/%2e|%2f/i.test(path)) {
    return { reject: problem("notFound", "Not found") };
  }
  const normPath = path.replace(/^\/{2,}/, "/");
  return { path, normPath };
}
