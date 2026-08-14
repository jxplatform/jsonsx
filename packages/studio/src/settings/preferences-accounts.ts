/**
 * Preferences-accounts.ts — every credential Studio holds, in one list that can also forget them.
 *
 * Studio stores three kinds of secret in three unrelated places and, until this file, could neither
 * enumerate nor clear any of them:
 *
 * - The GitHub device-flow token (`github/github-auth.ts`) — `clearGithubToken()` had **zero
 *   callers**, so signing out was impossible from inside the app;
 * - The AI provider key, endpoint and model (`services/ai-settings.ts`) — clearable only by saving a
 *   blank key into a dialog that did not say that is what a blank key means;
 * - The Cloudflare publish token and account id (`services/cf-settings.ts`) — not clearable at all.
 *
 * Plan §9.3 puts them under Preferences › Accounts, "listed, revocable". This module is that list.
 * It is deliberately UI-free — a record per account with a `revoke` — so the disconnect path is
 * testable without a dialog, and so the same records can back a future Problems entry or an
 * `accounts.revoke` command without being re-derived from a template.
 *
 * **No secret is ever returned.** A record says whether something is stored and what it is for;
 * printing a token into a list is how a screenshot leaks one.
 */

import { clearGithubToken, getGithubToken } from "../github/github-auth";
import { getCfAccountId, getCfToken, setCfAccountId, setCfToken } from "../services/cf-settings";
import {
  getBaseUrl,
  getModel,
  hasOpenAiKey,
  setBaseUrl,
  setModel,
  setOpenAiKey,
} from "../services/ai-settings";

/** One stored credential, as the Accounts section renders it. */
export interface AccountRecord {
  /** Stable key — the value `revokeAccount` takes and the row's `data-account`. */
  id: string;
  /** The service, in the words its own docs use. */
  label: string;
  /** What is held, or what connecting would buy. Never the secret. */
  detail: string;
  connected: boolean;
  /** Forget it. Idempotent: revoking a disconnected account is a no-op, not an error. */
  revoke: () => void;
}

/**
 * The three accounts, always all three.
 *
 * A disconnected account still gets a row: "you are not signed in to GitHub" is information, and a
 * list that hides what is absent cannot answer the question the section exists to answer.
 */
export function listAccounts(): AccountRecord[] {
  const githubToken = getGithubToken();
  const cfToken = getCfToken();
  const cfAccount = getCfAccountId();
  const model = getModel();
  const endpoint = getBaseUrl();
  return [
    {
      id: "github",
      label: "GitHub",
      detail: githubToken
        ? "Signed in — a device-flow token is stored on this machine."
        : "Not signed in. Cloning and pushing will ask when they need it.",
      connected: Boolean(githubToken),
      revoke: clearGithubToken,
    },
    {
      id: "ai",
      label: "AI provider",
      detail: hasOpenAiKey()
        ? `Key stored. Model ${model}${endpoint ? ` via ${endpoint}` : ""}.`
        : "No key stored. The Assistant section is where one is entered.",
      connected: hasOpenAiKey(),
      revoke: () => {
        setOpenAiKey("");
        setBaseUrl("");
        setModel("");
      },
    },
    {
      id: "cloudflare",
      label: "Cloudflare",
      detail: cfToken
        ? `Connected${cfAccount ? ` — account ${cfAccount}` : ""}.`
        : "Not connected. Publishing will ask when it needs it.",
      connected: Boolean(cfToken),
      revoke: () => {
        setCfToken("");
        setCfAccountId("");
      },
    },
  ];
}

/**
 * Revoke one account by id.
 *
 * @returns `true` when an account by that id exists, `false` when it does not — so a caller with a
 *   stale id finds out rather than silently doing nothing.
 */
export function revokeAccount(id: string): boolean {
  const account = listAccounts().find((candidate) => candidate.id === id);
  if (!account) {
    return false;
  }
  account.revoke();
  notifyCredentialsChanged();
  return true;
}

const _listeners = new Set<() => void>();

/**
 * Subscribe to credential changes. Returns the unsubscribe.
 *
 * This is the seam that keeps the dependency one-directional: the assistant panel shows a "no
 * provider connected" notice, Preferences is where a key is now entered and cleared, and the panel
 * would otherwise have to be imported BY the dialog it opens. Instead both depend on this leaf.
 */
export function onCredentialsChanged(listener: () => void): () => void {
  _listeners.add(listener);
  return () => {
    _listeners.delete(listener);
  };
}

/** Announce that a credential was saved or revoked. */
export function notifyCredentialsChanged(): void {
  for (const listener of _listeners) {
    listener();
  }
}

/** Drop every subscription — tests only; the app subscribes once, at mount. */
export function resetCredentialListeners(): void {
  _listeners.clear();
}
