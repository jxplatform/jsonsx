/// <reference lib="dom" />
/**
 * Ai-models.js — available-model listing from the studio AI proxy.
 *
 * Fetches the proxy's /models endpoint (the chat endpoint's sibling), forwarding the
 * stored API key as X-Api-Key and the endpoint override as X-Api-Base-URL so the proxy
 * lists models from the user's chosen provider. Shared by the credentials form and the
 * chat composer's model picker; results are cached module-wide until invalidated (e.g.
 * after credentials change).
 *
 * @license MIT
 */

import type { AiModelsResponse } from "@jxsuite/protocol";
import { getPlatform } from "../platform";
import { getBaseUrl, getOpenAiKey, hasOpenAiKey, storedModel } from "./ai-settings";
import { SETTINGS } from "./settings/definitions";
import { onSettingsChanged } from "./settings/kernel";

export interface AiModel {
  id: string;
  name: string;
  /**
   * Whether the backend says the model can call tools.
   *
   * Absent when it did not say, which is the ordinary case for a BYOK provider — only a managed
   * catalogue knows. `false` is therefore a statement and `undefined` is silence, and no gate may
   * collapse the two: a Workers AI chat-only model must be labelled, an OpenAI model must not.
   */
  toolSupport?: boolean;
  /** The backend's declared context window in tokens, when it declares one. */
  contextWindow?: number;
}

/**
 * The credentials a model list belongs to.
 *
 * Two fields, taken together or not at all. The per-field overrides this replaces let a caller pass
 * a draft key with a stored base URL, which is a pair that was never configured anywhere.
 */
export interface AiCredentials {
  apiKey: string;
  baseUrl: string;
}

/** The credentials the app is configured with right now. */
export function aiConnection(): AiCredentials {
  return { apiKey: getOpenAiKey(), baseUrl: getBaseUrl() };
}

/**
 * An opaque identity for a credential pair.
 *
 * NUL-joined rather than concatenated: a key ending in the base URL's first characters would
 * otherwise be indistinguishable from a shorter key and a longer URL.
 */
function fingerprint(credentials: AiCredentials): string {
  return `${credentials.apiKey}\u0000${credentials.baseUrl}`;
}

let cache: AiModel[] | null = null;

/**
 * Which credentials {@link cache} was listed under.
 *
 * The cache used to be unkeyed, and two callers with different credentials wrote to it: the
 * credentials form fetches with the drafts being edited, while the capability probe fetches with
 * whatever is stored. Whichever landed last won, so the chat composer's picker could list a
 * different provider's models than the one actually configured — which is exactly what a user saw
 * after configuring a provider and finding the shell offering someone else's catalogue.
 */
let cacheKey = "";

let proxyConfigured = false;
let proxyManaged = false;
let proxyDefaultModel = "";
let proxyCode: AiModelsResponse["code"];

/**
 * One-shot capability probe shared by every credentials gate, plus the hosts to repaint when it
 * settles. Managed platforms (cloud Workers AI) and env-keyed dev servers report their state from
 * /models, so the gate cannot know which paths to offer until this has run once.
 */
let proxyProbe: Promise<void> | null = null;
const probeListeners = new Set<() => void>();

/**
 * How long a settled probe is trusted before a window refocus re-runs it.
 *
 * The probe is one-shot by construction (`proxyProbe ??=`) and the only thing that re-arms it is
 * the settings subscription below — which never fires for a HOSTED grant, because nothing about it
 * is stored in this browser. So a Cloudflare grant that lapsed mid-session left every gate showing
 * the reading it took at boot: the assistant reported itself configured, and every send failed. Ten
 * minutes is well inside the hour a Cloudflare access token lives.
 */
export const PROBE_STALE_MS = 600_000;

/** When the probe last settled (0 = never). The age {@link PROBE_STALE_MS} is measured against. */
let probeSettledAt = 0;

/** Whether {@link installProbeRefresh} has already registered its listener. */
let probeRefreshInstalled = false;

/**
 * Drop the cached list and the capability reading.
 *
 * No surface calls this: it runs off the settings subscription below, because "the credentials
 * changed" is a fact about the store rather than something each form has to remember to announce —
 * and a form that forgot left every gate reading a stale capability probe. It stays exported only
 * so a test can start from a cold module.
 */
export function resetModelCache() {
  cache = null;
  cacheKey = "";
  proxyConfigured = false;
  proxyManaged = false;
  proxyDefaultModel = "";
  proxyCode = undefined;
  /* The probe's result IS the flags above. Clearing them while keeping the settled promise
     would strand every gate on a permanent "unconfigured, unmanaged" reading — ensureProxyProbe
     would no-op forever and the managed option would vanish until a full reload. */
  proxyProbe = null;
  probeSettledAt = 0;
}

/** The keys whose value changes what a provider would answer with. */
const CONNECTION_KEYS = new Set<string>([
  SETTINGS.aiOpenAiKey.key,
  SETTINGS.aiBaseUrl.key,
  SETTINGS.cfToken.key,
  SETTINGS.cfAccountId.key,
]);

onSettingsChanged((keys) => {
  if (keys.some((key) => CONNECTION_KEYS.has(key))) {
    resetModelCache();
  }
});

/**
 * The cached list, if it was listed under `credentials`. Null when it was not, or when there is
 * none — a caller must not show one provider's catalogue for another's key.
 */
export function cachedModels(credentials: AiCredentials): AiModel[] | null {
  return cache && cacheKey === fingerprint(credentials) ? cache : null;
}

/**
 * A model's entry in whatever list is cached, by id.
 *
 * Deliberately NOT keyed by credentials, unlike {@link cachedModels}. That key exists because
 * SHOWING one provider's catalogue under another's credentials is a lie about what is available;
 * asking "what did the backend say about this id" is not — the answer is either recorded or it is
 * not, and a mismatched key just yields `undefined`, which every caller already has to handle.
 */
function cachedModel(id: string): AiModel | undefined {
  return cache?.find((model) => model.id === id);
}

/**
 * Whether the backend said this model can call tools — `undefined` when it said nothing.
 *
 * The distinction is the whole point: a chat-only model is a legitimate choice, so this labels and
 * warns rather than gating, and silence must read as "no opinion" rather than as "no tools".
 */
export function modelToolSupport(id: string): boolean | undefined {
  return cachedModel(id)?.toolSupport;
}

/** The backend's declared context window for a model, in tokens — `undefined` when it declared none. */
export function modelContextWindow(id: string): number | undefined {
  return cachedModel(id)?.contextWindow;
}

/**
 * Run the capability probe once, repainting `onSettled` when it lands. Idempotent: concurrent and
 * repeated callers share the single in-flight fetch, and every registered host is notified. Probe
 * failure is not surfaced — an unreachable proxy simply leaves the gate showing the key form.
 *
 * @param {() => void} [onSettled] - Host re-render scheduler, registered for this and later probes.
 */
export function ensureProxyProbe(onSettled?: () => void) {
  if (onSettled) {
    probeListeners.add(onSettled);
  }
  proxyProbe ??= fetchAvailableModels({ force: true })
    .catch(() => {
      // Unreachable proxy — the key gate stays up.
    })
    .then(() => {
      probeSettledAt = Date.now();
      for (const notify of probeListeners) {
        notify();
      }
    });
}

/**
 * Re-run the capability probe when it is older than {@link PROBE_STALE_MS} and the backend holds
 * the credentials. Returns whether it re-armed, so a caller (and a test) can see that it did.
 *
 * Managed-only on purpose. A BYOK reading changes only when the stored key does, and the settings
 * subscription already covers that; a hosted grant expires on a clock this browser cannot see.
 */
export function refreshStaleProbe(): boolean {
  if (!proxyManaged || probeSettledAt === 0 || Date.now() - probeSettledAt < PROBE_STALE_MS) {
    return false;
  }
  proxyProbe = null;
  probeSettledAt = 0;
  ensureProxyProbe();
  return true;
}

/**
 * Re-check the probe whenever the window regains focus, which is where a lapsed grant is noticed.
 *
 * `focus` rather than a timer: the reading only matters when somebody is looking at Studio, and the
 * OAuth reconnect the stale reading would have hidden happens in another tab — so coming back IS
 * the event. Idempotent, and a no-op outside a browser so the module stays importable under a
 * bare-`bun` runner.
 */
export function installProbeRefresh(): void {
  if (typeof window === "undefined" || probeRefreshInstalled) {
    return;
  }
  probeRefreshInstalled = true;
  window.addEventListener("focus", () => {
    refreshStaleProbe();
  });
}

installProbeRefresh();

/**
 * Whether the assistant can run at all: a key stored in this browser, or a backend that holds
 * credentials itself (managed cloud platforms, env-keyed dev servers). Every credentials gate must
 * use this rather than `hasOpenAiKey()` alone — gating on the local key locks managed-platform
 * users out of features their own Cloudflare account is already paying for.
 */
export function hasAiCredentials(): boolean {
  return hasOpenAiKey() || isProxyConfigured();
}

/**
 * Whether the proxy reported itself configured on the last fetch — true when the backend holds
 * credentials (managed platforms, OPENAI_API_KEY env), so the assistant works without a locally
 * stored key.
 */
export function isProxyConfigured(): boolean {
  return proxyConfigured;
}

/** Whether the platform manages AI credentials itself (cloud Workers AI). */
export function isManagedProxy(): boolean {
  return proxyManaged;
}

/**
 * Why the proxy reported itself unconfigured, when it said so.
 *
 * Undefined on any backend that does not send one — every gate must treat that as "no reason given"
 * and fall back to the plain connect wording.
 */
export function proxyStateCode(): AiModelsResponse["code"] {
  return proxyCode;
}

/** The proxy's preferred model id ("" when it does not declare one). */
export function getProxyDefaultModel(): string {
  return proxyDefaultModel;
}

/**
 * The model to SEND: what the user chose, else what the backend says it prefers, else the built-in
 * default.
 *
 * The middle term is the point. A managed Workers AI backend declares its own `defaultModel`, and
 * that value was fetched, stored and never read — so a user who had chosen nothing got the
 * hardcoded `"gpt-4o"`, which Workers AI does not serve. Asking the backend what it prefers before
 * falling back to a name invented here is the difference between working and a 404 on the first
 * message.
 *
 * It lives here rather than in `ai-settings.ts` because only this module knows what the proxy said,
 * and `ai-settings` must not import it — this module already imports `ai-settings`.
 */
export function preferredModel(): string {
  return storedModel() || getProxyDefaultModel() || SETTINGS.aiModel.default;
}

/**
 * The sibling of the chat route, replacing the last path segment and keeping everything else.
 *
 * Written as a URL rewrite rather than `chatUrl.replace(/\/chat$/, …)`, because the chat URL is not
 * always a bare path: the desktop platform appends the loopback server's `?token=`, and a regex
 * anchored on the end of the string silently stopped matching the moment it did — leaving the
 * models request pointed at the chat endpoint.
 *
 * @param {string} chatUrl - Absolute or root-relative, with or without a query
 * @param {string} segment - The sibling route's last path segment
 * @returns {string}
 */
export function siblingRoute(chatUrl: string, segment: string): string {
  /*
   * A fixed sentinel base rather than `location.href`. The document's own URL is not always a
   * usable base — under the DOM test harness it is `about:blank`, which makes `new URL` throw and
   * would silently return the chat URL unchanged, pointing the models request at the chat endpoint.
   * The base is discarded below for a root-relative input, so its value cannot leak.
   */
  let url: URL;
  try {
    url = new URL(chatUrl, "http://jx.invalid");
  } catch {
    return chatUrl; // Not a URL at all — leave a caller's own string alone.
  }
  url.pathname = url.pathname.replace(/[^/]*$/, segment);
  return /^https?:/i.test(chatUrl) ? url.href : `${url.pathname}${url.search}`;
}

/**
 * Fetch the models available through the AI proxy. Returns the cached list when present unless
 * `force` is set; throws on HTTP/network failure (callers surface the error).
 *
 * @param {{ apiKey?: string; baseUrl?: string; force?: boolean }} [opts] - Credential overrides for
 *   drafts not yet saved to ai-settings.
 * @returns {Promise<AiModel[]>}
 */
export async function fetchAvailableModels(
  opts: { credentials?: AiCredentials; force?: boolean } = {},
): Promise<AiModel[]> {
  /* Resolve the credentials BEFORE consulting the cache. Checking the cache first is what let a
     list fetched under one provider be handed to a caller asking about another. */
  const credentials = opts.credentials ?? aiConnection();
  const key = fingerprint(credentials);
  if (cache && cacheKey === key && !opts.force) {
    return cache;
  }
  const plat = getPlatform();
  const chatUrl = await Promise.resolve(plat.aiChatUrl());
  const modelsUrl = siblingRoute(chatUrl, "models");

  const headers: Record<string, string> = {};
  if (credentials.apiKey) {
    headers["X-Api-Key"] = credentials.apiKey;
  }
  if (credentials.baseUrl) {
    headers["X-Api-Base-URL"] = credentials.baseUrl;
  }

  const resp = await fetch(modelsUrl, { headers });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}`);
  }
  const data = (await resp.json()) as Partial<AiModelsResponse>;
  proxyConfigured = data.configured === true;
  proxyManaged = data.managed === true;
  proxyDefaultModel = data.defaultModel ?? "";
  proxyCode = data.code;
  /* Capabilities are kept, not dropped. The backend has reported `toolSupport` all along and the
     ingest mapped `{id, name}` only, so a Workers AI model that cannot call tools looked exactly
     like one that can — the agent loop ran, called nothing, and answered as if that were normal.
     The keys are OMITTED rather than set to undefined: absent means "the backend said nothing",
     which is a third state both consumers depend on. */
  cache = (data.models || []).map((m) => {
    const model: AiModel = { id: m.id, name: m.name || m.id };
    if (typeof m.contextWindow === "number") {
      model.contextWindow = m.contextWindow;
    }
    if (typeof m.toolSupport === "boolean") {
      model.toolSupport = m.toolSupport;
    }
    return model;
  });
  cacheKey = key;
  return cache;
}
