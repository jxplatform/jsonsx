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
import { getBaseUrl, getOpenAiKey, hasOpenAiKey } from "./ai-settings";

export interface AiModel {
  id: string;
  name: string;
}

let cache: AiModel[] | null = null;
let proxyConfigured = false;
let proxyManaged = false;
let proxyDefaultModel = "";

/**
 * One-shot capability probe shared by every credentials gate, plus the hosts to repaint when it
 * settles. Managed platforms (cloud Workers AI) and env-keyed dev servers report their state from
 * /models, so the gate cannot know which paths to offer until this has run once.
 */
let proxyProbe: Promise<void> | null = null;
const probeListeners = new Set<() => void>();

/** Drop the cached model list (call after credentials/endpoint changes). */
export function invalidateModelCache() {
  cache = null;
  proxyConfigured = false;
  proxyManaged = false;
  proxyDefaultModel = "";
  /* The probe's result IS the three flags above. Clearing them while keeping the settled promise
     would strand every gate on a permanent "unconfigured, unmanaged" reading — ensureProxyProbe
     would no-op forever and the managed option would vanish until a full reload. */
  proxyProbe = null;
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
      for (const notify of probeListeners) {
        notify();
      }
    });
}

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

/** The proxy's preferred model id ("" when it does not declare one). */
export function getProxyDefaultModel(): string {
  return proxyDefaultModel;
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
  opts: { apiKey?: string; baseUrl?: string; force?: boolean } = {},
): Promise<AiModel[]> {
  if (cache && !opts.force) {
    return cache;
  }
  const plat = getPlatform();
  const chatUrl = await Promise.resolve(plat.aiChatUrl());
  const modelsUrl = siblingRoute(chatUrl, "models");

  const headers: Record<string, string> = {};
  const apiKey = opts.apiKey || getOpenAiKey();
  if (apiKey) {
    headers["X-Api-Key"] = apiKey;
  }
  const baseUrl = opts.baseUrl || getBaseUrl();
  if (baseUrl) {
    headers["X-Api-Base-URL"] = baseUrl;
  }

  const resp = await fetch(modelsUrl, { headers });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}`);
  }
  const data = (await resp.json()) as Partial<AiModelsResponse>;
  proxyConfigured = data.configured === true;
  proxyManaged = data.managed === true;
  proxyDefaultModel = data.defaultModel ?? "";
  cache = (data.models || []).map((m) => ({ id: m.id, name: m.name || m.id }));
  return cache;
}
