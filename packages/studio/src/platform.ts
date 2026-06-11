/// <reference lib="dom" />
/**
 * Platform.js — Platform Abstraction Layer (PAL)
 *
 * Studio is backend-agnostic. Each deployment target (desktop, dev server, cloud) registers a
 * platform adapter at startup. All file I/O, project loading, and component discovery goes through
 * this interface.
 *
 * Uses window.__jxPlatform so the platform can be registered from a separate script bundle (e.g.
 * init.js) before studio.js loads.
 *
 * See spec/desktop.md §3 for the full StudioPlatform interface.
 */

import type { StudioPlatform } from "./types";

const g = globalThis as unknown as { __jxPlatform?: StudioPlatform };

/** @param {StudioPlatform} platform */
export function registerPlatform(platform: StudioPlatform) {
  g.__jxPlatform = platform;
}

/** @returns {StudioPlatform} */
export function getPlatform() {
  if (!g.__jxPlatform) {
    throw new Error("No platform registered. Call registerPlatform() before starting Studio.");
  }
  return g.__jxPlatform;
}

/** @returns {boolean} */
export function hasPlatform() {
  return g.__jxPlatform != null;
}
