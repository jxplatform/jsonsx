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

/** Drop the cached model list (call after credentials/endpoint changes). */
export function invalidateModelCache() {
  cache = null;
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
  const data = (await resp.json()) as { models?: { id: string; name?: string }[] };
  cache = (data.models || []).map((m) => ({ id: m.id, name: m.name || m.id }));
  return cache;
}
