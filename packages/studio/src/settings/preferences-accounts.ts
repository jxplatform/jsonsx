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
 *
 * **Cloudflare has two spellings, and this file used to know only one.** On a platform that brokers
 * the connection (Jx Cloud), there is no local token to enumerate — `getCfToken()` is empty by
 * design — so the row said "Not connected" to every hosted user, named no account, and offered a
 * Disconnect that cleared nothing server-side. The hosted state comes from the PAL instead, cached
 * here because a template must not start a fetch on every repaint.
 */

import { clearGithubToken, githubTokenLocation, githubTokenStored } from "../github/github-auth";
import { clearCfConnection, getCfAccountId, getCfToken } from "../services/cf-settings";
import { clearAiProvider, getBaseUrl, hasOpenAiKey } from "../services/ai-settings";
import { preferredModel, resetModelCache } from "../services/ai-models";
import { getPlatform, hasPlatform } from "../platform";
import type { CfConnection } from "../types";

/** One thing a row can do besides existing. */
export interface AccountAction {
  /** Stable key — the button's `data-action`, so a test names an intent rather than a label. */
  id: string;
  label: string;
  /** Spectrum `variant`; omitted for the default treatment. */
  variant?: string;
  /** Do it. Async ones repaint the sheet when they settle. */
  run: () => void | Promise<void>;
}

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
  /**
   * What this row offers, when a plain Disconnect is not the whole story.
   *
   * Absent on the rows whose only verb is "forget it", which is every locally stored credential. A
   * brokered Cloudflare connection has three more — reconnect a lapsed grant, choose an account,
   * connect for the first time — and none of them is expressible as `revoke`.
   */
  actions?: AccountAction[];
}

// ─── The brokered Cloudflare connection ──────────────────────────────────────

/** What the broker last said, or "checking" before it has been asked. */
let _cfState: CfConnection | null | "checking" = "checking";

/** The in-flight read, so a repaint during one does not start a second. */
let _cfInFlight: Promise<void> | null = null;

/**
 * Whether the platform brokers the Cloudflare connection rather than holding a pasted token.
 *
 * Keyed on `cfConnect` — the hosted OAuth flow — because that is the member whose presence means
 * "there is a connection this app did not store locally".
 */
export function platformBrokersCf(): boolean {
  return hasPlatform() && Boolean(getPlatform().cfConnect);
}

/**
 * Re-read the brokered connection and announce it. Always refetches; the Accounts section runs it
 * when it is shown and after every action, because the answer changes server-side.
 */
export async function refreshCfConnection(): Promise<void> {
  if (!platformBrokersCf()) {
    return;
  }
  _cfInFlight ??= (async () => {
    try {
      _cfState = (await getPlatform().cfConnection?.()) ?? null;
    } catch {
      /* An unreachable broker is not a connection. The row says "not connected", which is what the
         app can act on; the error itself belongs to whatever surface made the call the user asked
         for, not to a list that repaints itself. */
      _cfState = null;
    }
    _cfInFlight = null;
    notifyCredentialsChanged();
  })();
  await _cfInFlight;
}

/** Kick the first read, once. Safe to call from a template — later paints are no-ops. */
export function ensureCfConnection(): void {
  if (platformBrokersCf() && _cfState === "checking" && !_cfInFlight) {
    void refreshCfConnection();
  }
}

/**
 * Forget the cached broker answer.
 *
 * Called when Preferences opens, and that is the point: the row would otherwise paint the answer
 * from the LAST visit — an hour-old "Connected — Acme" over a grant that has since lapsed — and
 * only correct itself when the re-read landed. Saying "checking" while it checks is the honest
 * version of the same half-second.
 */
export function resetCfConnectionCache(): void {
  _cfState = "checking";
  _cfInFlight = null;
}

/** Run the hosted flow, then re-read. The models cache goes because the AI gate keys on it too. */
async function hostedConnect(): Promise<void> {
  const outcome = await getPlatform().cfConnect?.();
  if (outcome?.status === "connected" && !outcome.connection.accountId) {
    /* Dynamically, and this is the load-bearing half: the picker imports THIS module for
       `notifyCredentialsChanged`, so a static import here would close the cycle. */
    const { openCfAccountPicker } = await import("../ui/cf-account-picker");
    await openCfAccountPicker();
  }
  resetModelCache();
  await refreshCfConnection();
}

/** The brokered row — five states, and each one names the next move. */
function brokeredCloudflareRecord(): AccountRecord {
  const disconnect: AccountAction = {
    id: "disconnect",
    label: "Disconnect",
    run: async () => {
      await getPlatform().cfDisconnect?.();
      resetModelCache();
      await refreshCfConnection();
    },
    variant: "negative",
  };
  const connect = (label: string): AccountAction => ({
    id: label === "Connect" ? "connect" : "reconnect",
    label,
    run: hostedConnect,
    variant: "accent",
  });
  const base = { id: "cloudflare", label: "Cloudflare", revoke: () => {} };

  if (_cfState === "checking") {
    return { ...base, actions: [], connected: false, detail: "Checking your connection…" };
  }
  if (!_cfState?.connected) {
    return {
      ...base,
      actions: [connect("Connect")],
      connected: false,
      detail: "Not connected. Connecting publishes this site and runs the assistant on Workers AI.",
    };
  }
  const revoke = () => {
    void disconnect.run();
  };
  if (_cfState.needsReconnect) {
    return {
      ...base,
      actions: [connect("Reconnect"), disconnect],
      connected: true,
      detail: "Connection expired. Reconnect to keep publishing and the assistant working.",
      revoke,
    };
  }
  if (_cfState.needsAccount || !_cfState.accountId) {
    return {
      ...base,
      actions: [
        {
          id: "choose-account",
          label: "Choose account",
          run: async () => {
            const { openCfAccountPicker } = await import("../ui/cf-account-picker");
            if (await openCfAccountPicker()) {
              resetModelCache();
              await refreshCfConnection();
            }
          },
          variant: "accent",
        },
        disconnect,
      ],
      connected: true,
      detail: "Connected, but no account is chosen yet — publishing and the assistant need one.",
      revoke,
    };
  }
  return {
    ...base,
    actions: [disconnect],
    connected: true,
    detail: `Connected — ${_cfState.accountName ?? _cfState.accountId}.`,
    revoke,
  };
}

/** The locally stored row: a pasted API token, on desktop and the dev server. */
function localCloudflareRecord(): AccountRecord {
  const cfToken = getCfToken();
  const cfAccount = getCfAccountId();
  return {
    connected: Boolean(cfToken),
    detail: cfToken
      ? `Connected${cfAccount ? ` — account ${cfAccount}` : ""}.`
      : "Not connected. Publishing will ask when it needs it.",
    id: "cloudflare",
    label: "Cloudflare",
    revoke: clearCfConnection,
  };
}

/**
 * The three accounts, always all three.
 *
 * A disconnected account still gets a row: "you are not signed in to GitHub" is information, and a
 * list that hides what is absent cannot answer the question the section exists to answer.
 */
export function listAccounts(): AccountRecord[] {
  const githubToken = githubTokenStored();
  const model = preferredModel();
  const endpoint = getBaseUrl();
  return [
    {
      id: "github",
      label: "GitHub",
      detail: githubToken
        ? githubTokenLocation() === "desktop"
          ? "Signed in — the token is in this app's config folder, readable only by you."
          : "Signed in — a device-flow token is stored in this browser."
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
      revoke: clearAiProvider,
    },
    platformBrokersCf() ? brokeredCloudflareRecord() : localCloudflareRecord(),
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
