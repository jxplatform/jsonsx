/// <reference lib="dom" />
/**
 * Ai-settings.js — the AI assistant's provider settings, over the settings kernel.
 *
 * The Stack B proxy reads the OpenAI key from the `X-Api-Key` header (falling back to the server's
 * `OPENAI_API_KEY` env var). Studio stores a user-supplied key so the browser/dev build works
 * without an env var. The key never leaves the machine except to the same-origin proxy.
 *
 * This module is now a typed façade over `settings/kernel.ts` — the storage keys, defaults and
 * normalisation live in `settings/definitions.ts`, and the kernel owns the cache, the write queue
 * and change notification. What it keeps is the vocabulary: callers say `getOpenAiKey()`, not
 * `readSetting(SETTINGS.aiOpenAiKey)`.
 *
 * **Blank no longer deletes.** `setOpenAiKey("")` stores an empty string; {@link clearAiProvider}
 * is the revoke path. The old conflation read as a convenience right up until a form that blanked
 * its own drafts on Save called these setters with them, and a second Save revoked the credentials
 * the first had stored.
 *
 * @license MIT
 */

import { SETTINGS } from "./settings/definitions";
import {
  clearSettings,
  hasSetting,
  readStoredSetting,
  setSetting,
  setSettings,
} from "./settings/kernel";

/** @returns {string} The stored OpenAI key, or "" if none. */
export function getOpenAiKey() {
  return readStoredSetting(SETTINGS.aiOpenAiKey);
}

/**
 * Persist the OpenAI key.
 *
 * @param {string} key - The key to store. A blank value stores blank; it does NOT clear — see
 *   {@link clearAiProvider}.
 */
export function setOpenAiKey(key: string) {
  setSetting(SETTINGS.aiOpenAiKey, key || "");
}

/** @returns {boolean} Whether a non-empty key is stored. */
export function hasOpenAiKey() {
  return hasSetting(SETTINGS.aiOpenAiKey);
}

/**
 * @returns {string} The OpenAI-compatible base URL override (e.g. a local LLM, OpenRouter, Azure),
 *   or "" to use the proxy's default (`https://api.openai.com/v1` / server `OPENAI_BASE_URL`).
 */
export function getBaseUrl() {
  return readStoredSetting(SETTINGS.aiBaseUrl);
}

// ─── Model selection ────────────────────────────────────────────────────────

/**
 * The model the user actually chose, with no default standing in for silence.
 *
 * The getter this replaced masked _unset_ as `"gpt-4o"`, which is right for a sender and wrong for
 * anything that writes back: a form prefilled from it and then saved persists a choice nobody made,
 * which is how `jx.ai.model: "gpt-4o"` came to be the only surviving key in a settings file whose
 * owner had configured a different provider entirely. Senders want
 * {@link ../services/ai-models!preferredModel} instead.
 *
 * @returns {string} The stored model ID, or "" when none has been chosen.
 */
export function storedModel() {
  return readStoredSetting(SETTINGS.aiModel);
}

/**
 * Persist the selected model ID.
 *
 * @param {string} modelId - The model ID to store. A blank value stores blank; it does NOT clear.
 */
export function setModel(modelId: string) {
  setSetting(SETTINGS.aiModel, modelId || "");
}

/**
 * Store the provider's key, endpoint and model as ONE change.
 *
 * What a credentials form's Save should call. Three separate setters coalesce into one write
 * anyway, but they announce three times, and each intermediate announcement describes a provider
 * the user never asked for — a new key against the old endpoint, then against no model.
 *
 * @param {{ apiKey: string; baseUrl: string; model: string }} provider
 */
export function saveAiProvider(provider: { apiKey: string; baseUrl: string; model: string }) {
  setSettings([
    [SETTINGS.aiOpenAiKey, provider.apiKey],
    [SETTINGS.aiBaseUrl, provider.baseUrl],
    [SETTINGS.aiModel, provider.model],
  ]);
}

/**
 * Forget the provider entirely — key, endpoint and model.
 *
 * The one deletion path, and the one the Accounts list's Disconnect uses. Deliberately all three
 * together: a key with an orphaned endpoint is a state no surface knows how to describe.
 */
export function clearAiProvider() {
  clearSettings([SETTINGS.aiOpenAiKey, SETTINGS.aiBaseUrl, SETTINGS.aiModel]);
}
