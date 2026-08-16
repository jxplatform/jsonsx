/**
 * OAuth 2.0 for native apps: the loopback redirect (RFC 8252) with PKCE (RFC 7636).
 *
 * **Why not the device flow.** The desktop app's one sign-in uses GitHub's device flow, which RFC
 * 8628 designed for devices that cannot show a browser or take typed input — a TV, a CLI on a
 * headless box. A desktop app has both, and paying the device flow's price anyway means the user
 * copies a code between two windows and the app polls a token endpoint on a timer. RFC 8252 §7.3
 * names the loopback redirect as the answer for exactly this shape of client, and the host it needs
 * already exists: `project-server.ts` runs a loopback `Bun.serve` on an ephemeral port.
 *
 * Three requirements are load-bearing, and each one is a real attack if dropped:
 *
 * - **The redirect host is the literal `127.0.0.1`, never `localhost`** (§8.3). `localhost` is a
 *   name, and a name resolves — a `hosts` entry, a resolver, or a DNS search domain can point it
 *   somewhere else, and the authorization code would be delivered there. The literal address cannot
 *   be redirected. It also sidesteps the quieter failure: a resolver that answers `localhost` with
 *   `::1` while the server bound IPv4, so the browser reaches nothing at all.
 * - **PKCE with `S256`, never `plain`** (RFC 7636 §4.2, RFC 8252 §8.1). A public client keeps no
 *   secret, so the authorization code is the whole credential; another local process that observes
 *   the redirect can replay it. The verifier is what binds the code to the client that asked for
 *   it, and `plain` sends the verifier itself in the authorization request, which defeats the
 *   point.
 * - **`state` is single-use, short-lived, and compared in constant time** (RFC 6749 §10.12). It is
 *   the CSRF defense: without it, any local page can hand this server a callback for an
 *   authorization _it_ started, and the app adopts an attacker's account.
 *
 * The authorization code never reaches a rendered page: the callback answers HTML with no query
 * string of its own and `Referrer-Policy: no-referrer`, so nothing carries it onward.
 */

import { secretsMatch } from "./net-guard.ts";

/** The loopback redirect path this server hosts. */
export const OAUTH_CALLBACK_PATH = "/__jx_oauth__/callback";

/** RFC 8252 §8.3: the literal address, because a name can be resolved elsewhere. */
export const LOOPBACK_ADDRESS = "127.0.0.1";

/** How long an authorization may stay outstanding before its `state` is forgotten. */
export const STATE_TTL_MS = 5 * 60 * 1000;

/** Base64url of raw bytes, unpadded (RFC 7636 §A). */
function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCodePoint(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/** A cryptographically random base64url string of `bytes` bytes of entropy. */
function randomToken(bytes: number): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** A PKCE verifier and its `S256` challenge. */
export interface PkcePair {
  verifier: string;
  challenge: string;
  method: "S256";
}

/**
 * Mint a PKCE verifier and its challenge.
 *
 * 32 random bytes is 43 base64url characters — the minimum RFC 7636 §4.1 allows, and the length
 * every reference implementation uses.
 *
 * @returns {Promise<PkcePair>}
 */
export async function createPkce(): Promise<PkcePair> {
  const verifier = randomToken(32);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { challenge: base64url(new Uint8Array(digest)), method: "S256", verifier };
}

/** What a caller must know to start an authorization. */
export interface AuthorizationRequest {
  /** The provider's authorization endpoint, e.g. `https://github.com/login/oauth/authorize`. */
  authorizationEndpoint: string;
  clientId: string;
  scope?: string;
  /** Extra authorization parameters the provider defines (`prompt`, `login`, …). */
  extraParams?: Record<string, string>;
}

/** One outstanding authorization. */
export interface PendingAuthorization {
  /** The URL to open in the user's own browser (RFC 8252 §7.3 — never an embedded webview). */
  authorizationUrl: string;
  /** The exact `redirect_uri` sent, which the token exchange must repeat verbatim. */
  redirectUri: string;
  state: string;
  verifier: string;
  /** Resolves with the authorization code once the provider redirects back; rejects on refusal. */
  code: Promise<string>;
  /** Abandon this authorization (the user closed the dialog). Its `state` stops being accepted. */
  cancel: () => void;
}

interface Outstanding {
  verifier: string;
  expiresAt: number;
  resolve: (code: string) => void;
  reject: (error: Error) => void;
}

export interface LoopbackAuthorizer {
  /** Start an authorization against a server listening on `port`. */
  begin: (port: number, request: AuthorizationRequest) => Promise<PendingAuthorization>;
  /** Answer the loopback redirect. Returns null when the path is not the callback. */
  handleCallback: (url: URL) => Response | null;
  /** Fail every outstanding authorization (server shutdown). */
  stop: () => void;
  /** How many authorizations are outstanding (tests, and the shutdown assertion). */
  pending: () => number;
}

/**
 * The redirect URI for a server bound to `port`.
 *
 * @param {number} port
 * @returns {string}
 */
export function loopbackRedirectUri(port: number): string {
  return `http://${LOOPBACK_ADDRESS}:${port}${OAUTH_CALLBACK_PATH}`;
}

/** The page the browser lands on. Deliberately inert: no script, no query, no referrer. */
function callbackPage(title: string, message: string): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
      `<title>${title}</title></head><body style="font:16px/1.5 system-ui;margin:4rem auto;max-width:32rem">` +
      `<h1 style="font-size:1.25rem">${title}</h1><p>${message}</p></body></html>`,
    {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/html; charset=utf-8",
        /*
         * The authorization code arrives in this request's query string. Without this header the
         * browser would put that URL in the `Referer` of anything the page loaded — and the code is
         * the credential until it is exchanged.
         */
        "Referrer-Policy": "no-referrer",
      },
    },
  );
}

/**
 * Create the authorizer that owns outstanding authorizations for one server.
 *
 * @param {object} [options]
 * @param {number} [options.ttlMs] Override the state lifetime (tests).
 * @returns {LoopbackAuthorizer}
 */
export function createLoopbackAuthorizer(options: { ttlMs?: number } = {}): LoopbackAuthorizer {
  const ttlMs = options.ttlMs ?? STATE_TTL_MS;
  const outstanding = new Map<string, Outstanding>();

  /** Drop every authorization whose state has aged out. */
  const sweep = (): void => {
    const now = Date.now();
    for (const [state, entry] of outstanding) {
      if (entry.expiresAt <= now) {
        outstanding.delete(state);
        entry.reject(new Error("The sign-in took too long and was abandoned."));
      }
    }
  };

  /**
   * Find an outstanding authorization by state, comparing in constant time.
   *
   * A `Map.get` would return on the first differing character, which is a timing oracle on a value
   * whose whole job is to be unguessable by a local process. The scan is over at most a handful of
   * entries, so the cost is nothing.
   */
  const take = (state: string): { key: string; entry: Outstanding } | null => {
    for (const [key, entry] of outstanding) {
      if (secretsMatch(key, state)) {
        return { entry, key };
      }
    }
    return null;
  };

  return {
    async begin(port, request) {
      sweep();
      const { challenge, method, verifier } = await createPkce();
      const state = randomToken(32);
      const redirectUri = loopbackRedirectUri(port);

      const authorizeUrl = new URL(request.authorizationEndpoint);
      authorizeUrl.searchParams.set("client_id", request.clientId);
      authorizeUrl.searchParams.set("redirect_uri", redirectUri);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("state", state);
      authorizeUrl.searchParams.set("code_challenge", challenge);
      authorizeUrl.searchParams.set("code_challenge_method", method);
      if (request.scope) {
        authorizeUrl.searchParams.set("scope", request.scope);
      }
      for (const [key, value] of Object.entries(request.extraParams ?? {})) {
        authorizeUrl.searchParams.set(key, value);
      }

      let resolve!: (code: string) => void;
      let reject!: (error: Error) => void;
      const code = new Promise<string>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      // Nothing awaits this promise until the caller does; an unobserved rejection is not a crash.
      code.catch(() => {});
      outstanding.set(state, { expiresAt: Date.now() + ttlMs, reject, resolve, verifier });

      return {
        authorizationUrl: authorizeUrl.href,
        cancel: () => {
          const found = take(state);
          if (found) {
            outstanding.delete(found.key);
            found.entry.reject(new Error("The sign-in was cancelled."));
          }
        },
        code,
        redirectUri,
        state,
        verifier,
      };
    },

    handleCallback(url) {
      if (url.pathname !== OAUTH_CALLBACK_PATH) {
        return null;
      }
      sweep();
      const state = url.searchParams.get("state");
      const found = state === null ? null : take(state);
      if (!found) {
        /*
         * No matching state: either this callback belongs to an authorization that expired, or it
         * belongs to none at all — which is the CSRF this parameter exists to catch. Both answer
         * the same way, because telling them apart tells an attacker whether they guessed.
         */
        return callbackPage(
          "This sign-in could not be completed",
          "The request did not match a sign-in started by this app. Start again from Jx Studio.",
        );
      }
      // Single-use: a replayed callback finds nothing, whatever its outcome was.
      outstanding.delete(found.key);

      const error = url.searchParams.get("error");
      if (error !== null) {
        found.entry.reject(
          new Error(url.searchParams.get("error_description") ?? `Authorization failed: ${error}`),
        );
        return callbackPage(
          "Sign-in was not completed",
          "You can close this tab and try again from Jx Studio.",
        );
      }

      const code = url.searchParams.get("code");
      if (code === null || code === "") {
        found.entry.reject(
          new Error("The provider redirected back without an authorization code."),
        );
        return callbackPage(
          "This sign-in could not be completed",
          "The provider sent no authorization code. Start again from Jx Studio.",
        );
      }

      found.entry.resolve(code);
      return callbackPage("You're signed in", "You can close this tab and return to Jx Studio.");
    },

    pending: () => outstanding.size,

    stop() {
      for (const [, entry] of outstanding) {
        entry.reject(new Error("The server stopped before the sign-in completed."));
      }
      outstanding.clear();
    },
  };
}

/**
 * The one call `exchangeCode` makes, named so a test can stand in for it without implementing the
 * whole of `fetch` (which carries Bun's `preconnect`, among other things).
 */
export type TokenFetch = (input: string, init: RequestInit) => Promise<Response>;

/** A token response, in the shape RFC 6749 §5.1 defines. */
export interface TokenResult {
  accessToken: string;
  tokenType: string;
  scope?: string;
  refreshToken?: string;
  expiresIn?: number;
}

/**
 * Exchange an authorization code for a token (RFC 6749 §4.1.3), binding the PKCE verifier.
 *
 * `redirect_uri` is repeated verbatim because §4.1.3 requires it to match the one the authorization
 * request carried — the provider uses it as part of the code's identity, so a normalized or
 * reconstructed value is rejected.
 *
 * No client secret is sent. A desktop app cannot keep one (RFC 8252 §8.5): shipping it puts it in
 * every copy of the binary, where it is a secret in name only. The verifier is what authenticates
 * this exchange.
 *
 * @param {object} params
 * @param {string} params.tokenEndpoint
 * @param {string} params.clientId
 * @param {string} params.code
 * @param {string} params.verifier
 * @param {string} params.redirectUri
 * @param {TokenFetch} [params.fetchImpl] Injectable for tests.
 * @returns {Promise<TokenResult>}
 */
export async function exchangeCode(params: {
  tokenEndpoint: string;
  clientId: string;
  code: string;
  verifier: string;
  redirectUri: string;
  fetchImpl?: TokenFetch;
}): Promise<TokenResult> {
  const body = new URLSearchParams({
    client_id: params.clientId,
    code: params.code,
    code_verifier: params.verifier,
    grant_type: "authorization_code",
    redirect_uri: params.redirectUri,
  });
  const doFetch = params.fetchImpl ?? fetch;
  const response = await doFetch(params.tokenEndpoint, {
    body,
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const payload = (await response.json().catch(() => null)) as {
    access_token?: unknown;
    error?: unknown;
    error_description?: unknown;
    expires_in?: unknown;
    refresh_token?: unknown;
    scope?: unknown;
    token_type?: unknown;
  } | null;

  if (payload && typeof payload.error === "string") {
    const description =
      typeof payload.error_description === "string" ? payload.error_description : payload.error;
    throw new Error(`The provider refused the sign-in: ${description}`);
  }
  if (!response.ok || !payload || typeof payload.access_token !== "string") {
    throw new Error(`The token exchange failed (HTTP ${response.status}).`);
  }
  return {
    accessToken: payload.access_token,
    ...(typeof payload.expires_in === "number" ? { expiresIn: payload.expires_in } : {}),
    ...(typeof payload.refresh_token === "string" ? { refreshToken: payload.refresh_token } : {}),
    ...(typeof payload.scope === "string" ? { scope: payload.scope } : {}),
    tokenType: typeof payload.token_type === "string" ? payload.token_type : "bearer",
  };
}
