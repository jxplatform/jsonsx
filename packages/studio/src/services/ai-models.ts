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

import { getPlatform } from "../platform";
import { getBaseUrl, getOpenAiKey } from "./ai-settings";

export interface AiModel {
  id: string;
  name: string;
}

let cache: AiModel[] | null = null;
let proxyConfigured = false;
let proxyManaged = false;
let proxyDefaultModel = "";

/** Drop the cached model list (call after credentials/endpoint changes). */
export function invalidateModelCache() {
  cache = null;
  proxyConfigured = false;
  proxyManaged = false;
  proxyDefaultModel = "";
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
  const modelsUrl = chatUrl.replace(/\/chat$/, "/models");

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
  const data = (await resp.json()) as {
    models?: { id: string; name?: string }[];
    configured?: boolean;
    managed?: boolean;
    defaultModel?: string;
  };
  proxyConfigured = data.configured === true;
  proxyManaged = data.managed === true;
  proxyDefaultModel = data.defaultModel ?? "";
  cache = (data.models || []).map((m) => ({ id: m.id, name: m.name || m.id }));
  return cache;
}
