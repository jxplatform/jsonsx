/// <reference lib="dom" />
/**
 * Ai-settings.js — local persistence for the AI assistant's provider settings.
 *
 * The Stack B proxy reads the OpenAI key from the `X-Api-Key` header (falling back to the server's
 * `OPENAI_API_KEY` env var). Studio stores a user-supplied key in localStorage so the browser/dev
 * build works without an env var. The key never leaves the machine except to the same-origin proxy.
 *
 * @license MIT
 */

import { persistSettings } from "./settings-store";

const KEY_STORAGE = "jx.ai.openaiKey";
const BASE_URL_STORAGE = "jx.ai.baseUrl";
const MODEL_STORAGE = "jx.ai.model";
const DEFAULT_MODEL = "gpt-4o";

/** @returns {string} The stored OpenAI key, or "" if none/unavailable. */
export function getOpenAiKey() {
  try {
    return globalThis.localStorage?.getItem(KEY_STORAGE) ?? "";
  } catch {
    return "";
  }
}

/**
 * Persist (or clear) the OpenAI key.
 *
 * @param {string} key - The key to store; an empty/blank value clears it.
 */
export function setOpenAiKey(key: string) {
  try {
    const trimmed = (key || "").trim();
    if (trimmed) {
      globalThis.localStorage?.setItem(KEY_STORAGE, trimmed);
    } else {
      globalThis.localStorage?.removeItem(KEY_STORAGE);
    }
    persistSettings();
  } catch {
    /* LocalStorage unavailable — settings are not persisted. */
  }
}

/** @returns {boolean} Whether a non-empty key is stored. */
export function hasOpenAiKey() {
  return getOpenAiKey().length > 0;
}

/**
 * @returns {string} The OpenAI-compatible base URL override (e.g. a local LLM, OpenRouter, Azure),
 *   or "" to use the proxy's default (`https://api.openai.com/v1` / server `OPENAI_BASE_URL`).
 */
export function getBaseUrl() {
  try {
    return globalThis.localStorage?.getItem(BASE_URL_STORAGE) ?? "";
  } catch {
    return "";
  }
}

/**
 * Persist (or clear) the base URL override.
 *
 * @param {string} url - The base URL; an empty/blank value clears the override.
 */
export function setBaseUrl(url: string) {
  try {
    const trimmed = (url || "").trim().replace(/\/+$/, "");
    if (trimmed) {
      globalThis.localStorage?.setItem(BASE_URL_STORAGE, trimmed);
    } else {
      globalThis.localStorage?.removeItem(BASE_URL_STORAGE);
    }
    persistSettings();
  } catch {
    /* LocalStorage unavailable — settings are not persisted. */
  }
}

// ─── Model selection ────────────────────────────────────────────────────────

/** @returns {string} The stored model ID, or the default ("gpt-4o"). */
export function getModel() {
  try {
    return globalThis.localStorage?.getItem(MODEL_STORAGE) || DEFAULT_MODEL;
  } catch {
    return DEFAULT_MODEL;
  }
}

/**
 * Persist the selected model ID.
 *
 * @param {string} modelId - The model ID to store; an empty/blank value clears it, reverting to
 *   default.
 */
export function setModel(modelId: string) {
  try {
    const trimmed = (modelId || "").trim();
    if (trimmed) {
      globalThis.localStorage?.setItem(MODEL_STORAGE, trimmed);
    } else {
      globalThis.localStorage?.removeItem(MODEL_STORAGE);
    }
    persistSettings();
  } catch {
    /* LocalStorage unavailable — settings are not persisted. */
  }
}
