/**
 * GitHub sign-in for the desktop app: RFC 8252 loopback redirect with RFC 7636 PKCE.
 *
 * The browser Studio keeps the device flow, and must — GitHub's device endpoints send no CORS
 * headers, so a page cannot call them, and a page has no loopback server to redirect to either. The
 * desktop has both a real browser and a loopback `Bun.serve`, which is precisely the client RFC
 * 8252 describes, so it takes the redirect flow: no code to copy between windows, no polling, and
 * an authorization code that is useless to anyone who intercepts it without the verifier.
 *
 * The authorization page opens in the user's **own browser**, not a webview (RFC 8252 §8.12). An
 * embedded webview would let the app read what the user types into the provider's page, which is
 * exactly the property the provider's login form depends on not being true — and it would not carry
 * the user's existing GitHub session, so it costs them a password prompt as well.
 */

import { exchangeCode } from "@jxsuite/server/oauth-loopback";
import type { LoopbackAuthorizer } from "@jxsuite/server/oauth-loopback";
import { readCredential, writeCredential } from "./credential-store";
import { openExternal } from "./utils";

/** The same OAuth app the browser Studio's device flow uses. */
const CLIENT_ID = "Ov23liYVlMFpgjOEPXJH";
const AUTHORIZATION_ENDPOINT = "https://github.com/login/oauth/authorize";
const TOKEN_ENDPOINT = "https://github.com/login/oauth/access_token";
const SCOPE = "repo";

/** Where the credential lands in the 0600 store. */
export const GITHUB_CREDENTIAL = "github.token";

/** The loopback server hosting the redirect, installed by whichever launcher created it. */
interface AuthorizationHost {
  authorizer: LoopbackAuthorizer;
  port: number;
}

let host: AuthorizationHost | null = null;

/**
 * Tell the sign-in flow which loopback server hosts its redirect.
 *
 * The launcher creates the server after the RPC handler map is built, so the host is installed
 * rather than injected. Without it, sign-in reports that it cannot run instead of opening a browser
 * at a redirect URI nothing is listening on.
 *
 * @param {AuthorizationHost | null} next
 */
export function setAuthorizationHost(next: AuthorizationHost | null): void {
  host = next;
}

/**
 * Whether a token is already stored — the only thing the webview may ask about the store.
 *
 * @returns {Promise<{ stored: boolean }>}
 */
export async function githubTokenStatus(): Promise<{ stored: boolean }> {
  return { stored: (await readCredential(GITHUB_CREDENTIAL)) !== null };
}

/** Forget the stored token. Revoking it on GitHub's side is the user's own account page. */
export async function githubSignOut(): Promise<{ ok: boolean }> {
  await writeCredential(GITHUB_CREDENTIAL, null);
  return { ok: true };
}

/**
 * Sign in, returning the access token.
 *
 * A stored token is returned as-is: this is the desktop twin of Studio's "already authenticated"
 * short-circuit, and re-running the flow for a token we already hold would send the user to a
 * browser for nothing.
 *
 * @param {object} [params]
 * @param {boolean} [params.force] Ignore the stored token and run the flow again.
 * @returns {Promise<{ token: string }>}
 */
export async function githubSignIn(params: { force?: boolean } = {}): Promise<{ token: string }> {
  if (!params.force) {
    const existing = await readCredential(GITHUB_CREDENTIAL);
    if (existing !== null) {
      return { token: existing };
    }
  }
  if (!host) {
    throw new Error("Sign-in is unavailable: this window has no loopback server to redirect to.");
  }

  const pending = await host.authorizer.begin(host.port, {
    authorizationEndpoint: AUTHORIZATION_ENDPOINT,
    clientId: CLIENT_ID,
    scope: SCOPE,
  });

  if (!openExternal(pending.authorizationUrl)) {
    pending.cancel();
    throw new Error("Could not open a browser to sign in to GitHub.");
  }

  const code = await pending.code;
  const result = await exchangeCode({
    clientId: CLIENT_ID,
    code,
    redirectUri: pending.redirectUri,
    tokenEndpoint: TOKEN_ENDPOINT,
    verifier: pending.verifier,
  });

  await writeCredential(GITHUB_CREDENTIAL, result.accessToken);
  return { token: result.accessToken };
}
