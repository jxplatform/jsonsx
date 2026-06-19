/// <reference lib="dom" />
/**
 * GitHub OAuth Device Flow authentication for Jx Studio.
 *
 * Uses the Device Flow so the user authenticates in their browser without needing a server-side
 * redirect endpoint.
 */

import { html } from "lit-html";
import { showDialog } from "../ui/layers";

const CLIENT_ID = "Ov23liYVlMFpgjOEPXJH";
const STORAGE_KEY = "jx_github_token";

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

/**
 * Authenticate with GitHub via the Device Flow. Shows a dialog with the user code and polls until
 * the user completes authorization or cancels.
 *
 * @returns {Promise<string | null>} The access token, or null if cancelled.
 */
export async function authenticateGithub() {
  const existing = getGithubToken();
  if (existing) {
    return existing;
  }

  const codeRes = await fetch("https://github.com/login/device/code", {
    body: JSON.stringify({ client_id: CLIENT_ID, scope: "repo" }),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    method: "POST",
  });

  if (!codeRes.ok) {
    throw new Error("Failed to initiate GitHub device flow");
  }
  const codeData = (await codeRes.json()) as DeviceCodeResponse;

  const { device_code, user_code, verification_uri, interval = 5 } = codeData;

  return showDialog((done) => {
    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

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

        // Expired_token or access_denied
        done(null);
      } catch {
        pollTimer = setTimeout(poll, interval * 1000);
      }
    };

    pollTimer = setTimeout(poll, interval * 1000);

    return html`
      <sp-dialog-wrapper
        open
        headline="Sign in to GitHub"
        cancel-label="Cancel"
        @cancel=${() => {
          cancelled = true;
          if (pollTimer) {
            clearTimeout(pollTimer);
          }
          done(null);
        }}
        @close=${() => {
          cancelled = true;
          if (pollTimer) {
            clearTimeout(pollTimer);
          }
          done(null);
        }}
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
