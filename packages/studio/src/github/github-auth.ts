/// <reference lib="dom" />
/**
 * GitHub OAuth Device Flow authentication for Jx Studio.
 *
 * Uses the Device Flow so the user authenticates in their browser without needing a server-side
 * redirect endpoint.
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
 * The token is stored in `localStorage` and returned to callers; it is never rendered.
 * `settings/preferences-accounts.ts` lists it as _stored or not_ and is the only place it can be
 * revoked (`studio.md` §15 rule 1).
 */

import { html } from "lit-html";
import { errorMessage } from "@jxsuite/schema/parse";
import { notify } from "../services/notify";
import { showDialog } from "../ui/layers";

const CLIENT_ID = "Ov23liYVlMFpgjOEPXJH";
const STORAGE_KEY = "jx_github_token";

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
  return localStorage.getItem(STORAGE_KEY);
}

export function clearGithubToken() {
  localStorage.removeItem(STORAGE_KEY);
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
