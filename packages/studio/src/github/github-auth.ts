/// <reference lib="dom" />
/**
 * GitHub sign-in for Jx Studio: the desktop's loopback redirect, and the browser's device flow.
 *
 * **Which flow runs depends on what the build has, not on preference.** A desktop launcher exposes
 * `githubAuth` on `globalThis.__jxPlatform`, backed by an RFC 8252 loopback redirect with PKCE —
 * the user signs in on GitHub's own page in their own browser, the authorization code comes back to
 * a loopback server, and the token is stored in the app's config folder at `0600`. A page in a
 * browser has no loopback server to redirect to, so it keeps the Device Flow below.
 *
 * The Device Flow needs no server-side redirect endpoint, which is exactly why it was chosen here
 * and exactly why it is the wrong tool for a desktop app: RFC 8628 designed it for devices that
 * cannot show a browser or take typed input, and it costs the user a code copied between windows.
 *
 * **This flow fails, and until now it failed silently.** `https://github.com/login/device/code`
 * sends no `Access-Control-Allow-Origin`, so a browser cannot call it: in Studio-in-a-browser the
 * very first request rejects with a bare `TypeError`. That rejection used to become a thrown
 * `Error` out of {@link authenticateGithub}, into `void createGithubRepository(…)` in
 * `panels/git-panel.ts`, and from there into an unhandled promise rejection — the user clicked
 * "Create GitHub repository" and the app did nothing at all, forever, with no message anywhere.
 *
 * Three failures now reach a surface, each as the kind of record §16 says it is:
 *
 * - **Unreachable** (CORS, offline, DNS) → a **Problem**, because it must be fixed and the fix is not
 *   in this dialog, carrying `git.signInToGithub` as its Retry;
 * - **Refused by GitHub** (an HTTP error, `access_denied`, `expired_token`) → a **toast**, because
 *   the state is now correct and there is nothing to fix — the user declined, or waited too long;
 * - **A poll that keeps failing** → a Problem after {@link MAX_POLL_FAILURES} consecutive rejections,
 *   rather than the previous empty catch that re-armed the timer forever. A dialog that says
 *   "Waiting for authorization…" against a network that will never answer is the exact dishonesty
 *   the feedback system exists to end.
 *
 * **What it cannot tell you.** A cross-origin block and an unplugged cable are the same `TypeError`
 * here — the browser withholds the reason on purpose — so the detail names both rather than
 * guessing between them.
 *
 * The token is returned to callers and never rendered. In a browser it is stored in `localStorage`;
 * on the desktop it is in the launcher's `0600` credential store and this module holds it only in
 * memory for the session. `settings/preferences-accounts.ts` lists it as _stored or not_ and is the
 * only place it can be revoked (`studio.md` §15 rule 1).
 */

import { html } from "lit-html";
import { errorMessage } from "@jxsuite/schema/parse";
import { notify } from "../services/notify";
import { showDialog } from "../ui/layers";

const CLIENT_ID = "Ov23liYVlMFpgjOEPXJH";
const STORAGE_KEY = "jx_github_token";

/**
 * The desktop launcher's RFC 8252 sign-in, when this build is running inside one.
 *
 * Launcher-only, like `updater` and `windowControls`, and reached the same way — a loopback
 * redirect needs a loopback server, which a page in a browser does not have.
 */
interface NativeGithubAuth {
  signIn: (force?: boolean) => Promise<{ token: string }>;
  signOut: () => Promise<{ ok: boolean }>;
  status: () => Promise<{ stored: boolean }>;
}

function nativeAuth(): NativeGithubAuth | null {
  return (
    (globalThis as unknown as { __jxPlatform?: { githubAuth?: NativeGithubAuth } }).__jxPlatform
      ?.githubAuth ?? null
  );
}

/**
 * The token the desktop store handed us this session.
 *
 * On the desktop the token at rest is a `0600` file in the user's config directory, **not**
 * `localStorage` — so it is not readable by script in the webview between sessions, and it does not
 * survive in a place a stray extension or a copied profile can reach. Holding it in a module
 * variable is what keeps {@link getGithubToken} synchronous for its callers.
 */
let nativeToken: string | null = null;

/** Whether the desktop store holds a token, as of the last time it was asked. */
let nativeStored = false;

/**
 * Record that the desktop's credential store does (or does not) hold a token.
 *
 * The launcher calls this once at startup. It carries a **boolean, not the token**: the accounts
 * pane only needs to know whether one exists, and handing the webview a credential it has not been
 * asked to use is the exposure the 0600 store exists to remove. When a sign-in does happen the
 * token arrives through {@link authenticateGithub} and lives in memory for that session.
 *
 * @param {boolean} stored
 */
export function hydrateGithubToken(stored: boolean): void {
  nativeStored = stored;
}

/**
 * Whether a GitHub credential exists, wherever it lives.
 *
 * Separate from {@link getGithubToken} because the two questions genuinely differ on the desktop: a
 * token can be stored on disk and not yet in this session's memory, and the accounts pane asks
 * "signed in?" while rendering — synchronously — where an API caller asks for the credential itself
 * and can await it.
 *
 * @returns {boolean}
 */
export function githubTokenStored(): boolean {
  return nativeToken !== null || nativeStored || localStorage.getItem(STORAGE_KEY) !== null;
}

/** Where the credential this build would use actually lives, for text that says so. */
export function githubTokenLocation(): "desktop" | "browser" {
  return nativeAuth() ? "desktop" : "browser";
}

/** One key for the whole sign-in, so a second attempt REPLACES the first report. */
const NOTIFY_KEY = "github.auth";

const SOURCE = "Source Control";

/** The Retry every report carries — one command, so the button's label comes off the record. */
const RETRY = "git.signInToGithub";

/**
 * How many consecutive poll rejections end the wait.
 *
 * Three, not one: the device flow legitimately polls across a laptop's sleep and a Wi-Fi hop, and
 * failing on the first blip would abandon a sign-in the user is in the middle of completing.
 */
export const MAX_POLL_FAILURES = 3;

/** Both halves of what a browser will not tell us, said once. */
const UNREACHABLE_DETAIL =
  "The request never reached GitHub. GitHub's device-flow endpoints send no CORS headers, so a " +
  "browser cannot call them directly — the desktop app can. A machine that is offline fails " +
  "identically, and the browser does not say which happened.";

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval?: number;
}

interface TokenResponse {
  access_token?: string;
  error?: string;
}

export function getGithubToken() {
  return nativeToken ?? localStorage.getItem(STORAGE_KEY);
}

export function clearGithubToken() {
  nativeToken = null;
  nativeStored = false;
  localStorage.removeItem(STORAGE_KEY);
  // Fire-and-forget: the accounts pane's revoke is synchronous, and a store that failed to forget
  // The token is not something the user can act on from there.
  void nativeAuth()
    ?.signOut()
    .catch(() => {});
}

/** The request never completed — a Problem, with the one sentence that covers both causes. */
function reportUnreachable(error: unknown): void {
  notify.error("Could not reach GitHub to sign in.", {
    action: RETRY,
    detail: `${UNREACHABLE_DETAIL}\n\n${errorMessage(error)}`,
    key: NOTIFY_KEY,
    source: SOURCE,
  });
}

/** GitHub answered, and said no. Nothing is broken, so this rests rather than persists. */
function reportRefused(message: string, detail: string): void {
  notify.warn(message, { action: RETRY, detail, key: NOTIFY_KEY, source: SOURCE });
}

/**
 * Start the device flow.
 *
 * @returns The device code payload, or null when the request failed — reported, never thrown, so a
 *   caller that forgot to catch cannot turn a network error back into silence.
 */
async function requestDeviceCode(): Promise<DeviceCodeResponse | null> {
  let codeRes: Response;
  try {
    codeRes = await fetch("https://github.com/login/device/code", {
      body: JSON.stringify({ client_id: CLIENT_ID, scope: "repo" }),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      method: "POST",
    });
  } catch (error) {
    reportUnreachable(error);
    return null;
  }

  if (!codeRes.ok) {
    reportRefused(
      "GitHub refused to start the sign-in.",
      `GitHub answered ${codeRes.status}${codeRes.statusText ? ` ${codeRes.statusText}` : ""}.`,
    );
    return null;
  }
  return (await codeRes.json()) as DeviceCodeResponse;
}

/**
 * Authenticate with GitHub via the Device Flow. Shows a dialog with the user code and polls until
 * the user completes authorization or cancels.
 *
 * @returns {Promise<string | null>} The access token, or null if it failed or was cancelled. Every
 *   `null` that is not a cancellation has already been reported.
 */
export async function authenticateGithub() {
  const existing = getGithubToken();
  if (existing) {
    return existing;
  }

  /*
   * The desktop takes the loopback redirect (RFC 8252): its browser opens the provider's own page,
   * the code comes back to a loopback server, and PKCE binds the exchange. The device flow below is
   * for the browser Studio, which has no loopback server to redirect to — and whose first request
   * to GitHub's device endpoint is refused by CORS anyway.
   */
  const native = nativeAuth();
  if (native) {
    try {
      const { token } = await native.signIn();
      nativeToken = token;
      return token;
    } catch (error) {
      reportRefused("GitHub sign-in was not completed.", errorMessage(error));
      return null;
    }
  }

  const codeData = await requestDeviceCode();
  if (!codeData) {
    return null;
  }

  const { device_code, user_code, verification_uri, interval = 5 } = codeData;

  return showDialog<string | null>((done) => {
    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;

    const stop = () => {
      cancelled = true;
      if (pollTimer) {
        clearTimeout(pollTimer);
      }
      done(null);
    };

    const poll = async () => {
      if (cancelled) {
        return;
      }
      try {
        const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
          body: JSON.stringify({
            client_id: CLIENT_ID,
            device_code,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          }),
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          method: "POST",
        });
        const tokenData = (await tokenRes.json()) as TokenResponse;
        failures = 0;

        if (tokenData.access_token) {
          localStorage.setItem(STORAGE_KEY, tokenData.access_token);
          done(tokenData.access_token);
          return;
        }

        if (tokenData.error === "authorization_pending") {
          pollTimer = setTimeout(poll, interval * 1000);
          return;
        }

        if (tokenData.error === "slow_down") {
          pollTimer = setTimeout(poll, (interval + 5) * 1000);
          return;
        }

        // Expired_token, access_denied, or anything else GitHub decides to answer. The state is
        // Correct — there is no token because the user did not grant one — so this rests.
        reportRefused(
          "GitHub sign-in was not completed.",
          tokenData.error === "access_denied"
            ? "The authorization was declined on GitHub."
            : tokenData.error === "expired_token"
              ? "The device code expired before it was entered."
              : `GitHub answered "${tokenData.error ?? "an unrecognised response"}".`,
        );
        cancelled = true;
        done(null);
      } catch (error) {
        failures += 1;
        if (failures >= MAX_POLL_FAILURES) {
          reportUnreachable(error);
          cancelled = true;
          done(null);
          return;
        }
        pollTimer = setTimeout(poll, interval * 1000);
      }
    };

    pollTimer = setTimeout(poll, interval * 1000);

    return html`
      <sp-dialog-wrapper
        open
        headline="Sign in to GitHub"
        cancel-label="Cancel"
        @cancel=${stop}
        @close=${stop}
      >
        <div class="github-auth-dialog">
          <p>Enter this code on GitHub to authorize Jx Studio:</p>
          <div class="github-auth-code">${user_code}</div>
          <p>
            <a href="${verification_uri}" target="_blank" rel="noopener"
              >Open ${verification_uri}</a
            >
          </p>
          <p class="github-auth-waiting">Waiting for authorization…</p>
        </div>
      </sp-dialog-wrapper>
    `;
  });
}
