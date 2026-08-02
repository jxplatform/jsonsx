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
 *
 * **Every call is counted.** `getPlatform()` hands out a counting proxy, not the raw adapter, so
 * "is Studio waiting on I/O?" is one number rather than thirty hand-instrumented methods
 * (`probe.idle()` condition 4, spec §13.5). Wrapping at the READ point rather than at
 * `registerPlatform` is deliberate: desktop pre-registers its adapter on `window.__jxPlatform`
 * without ever calling the registrar, and this is the seam both paths share.
 */

import type { StudioPlatform } from "./types";

const g = globalThis as unknown as { __jxPlatform?: StudioPlatform };

/** @param {StudioPlatform} platform */
export function registerPlatform(platform: StudioPlatform) {
  g.__jxPlatform = platform;
}

// ─── In-flight accounting ─────────────────────────────────────────────────────

/** Method name → how many of its calls have not settled. Entries are deleted at zero. */
const inFlight = new Map<string, number>();

/**
 * One entry per platform call whose promise has not settled, named by its method.
 *
 * Repeats are meaningful: two concurrent `gitStatus` reads are two reasons the shell is not
 * settled, and the rejection message that names them is the whole point of §13.4 — 115 sleeps were
 * 115 places that could not fail.
 */
export function platformInFlight(): string[] {
  const names: string[] = [];
  for (const [method, count] of inFlight) {
    for (let i = 0; i < count; i++) {
      names.push(method);
    }
  }
  return names;
}

function enter(method: string): void {
  inFlight.set(method, (inFlight.get(method) ?? 0) + 1);
}

function leave(method: string): void {
  const count = (inFlight.get(method) ?? 1) - 1;
  if (count > 0) {
    inFlight.set(method, count);
  } else {
    inFlight.delete(method);
  }
}

/**
 * Wrap an adapter so every promise-returning member is counted while it is outstanding.
 *
 * Synchronous members are passed through untouched — they cannot be outstanding. Wrappers are
 * memoised per property so `platform.readFile === platform.readFile`, which matters because call
 * sites cache and compare these (`live-context.ts` tests `typeof platform[key] === "function"` to
 * derive `capability.*`, and a fresh closure per read would allocate on every predicate).
 */
function countingPlatform(platform: StudioPlatform): StudioPlatform {
  const wrappers = new Map<PropertyKey, { raw: unknown; wrapper: unknown }>();
  return new Proxy(platform, {
    get(target, property) {
      // `this` stays the raw adapter: a proxy receiver would re-enter this trap for every internal
      // Property read the method makes, counting nothing and costing everything.
      const value = Reflect.get(target, property) as unknown;
      if (typeof value !== "function" || typeof property !== "string") {
        return value;
      }
      // Keyed by the FUNCTION, not just the name: an adapter whose method is replaced later (a
      // Lazily-installed capability, a test swapping one out) must not keep answering through a
      // Wrapper closed over the old implementation.
      const cached = wrappers.get(property);
      if (cached && cached.raw === value) {
        return cached.wrapper;
      }
      const method = property;
      const wrapper = (...args: unknown[]): unknown => {
        const result = (value as (...a: unknown[]) => unknown).apply(target, args);
        if (typeof (result as PromiseLike<unknown> | null)?.then !== "function") {
          return result;
        }
        enter(method);
        const settle = () => {
          leave(method);
        };
        // Both arms: a rejected platform call is a call that FINISHED. Leaving it counted would
        // Wedge every later `idle()` behind an error the caller already handled.
        (result as PromiseLike<unknown>).then(settle, settle);
        return result;
      };
      wrappers.set(property, { raw: value, wrapper });
      return wrapper;
    },
  });
}

/** The adapter the counting proxy currently wraps, so re-registration re-wraps and nothing else. */
let counted: { raw: StudioPlatform; wrapped: StudioPlatform } | null = null;

/** @returns {StudioPlatform} */
export function getPlatform() {
  const raw = g.__jxPlatform;
  if (!raw) {
    throw new Error("No platform registered. Call registerPlatform() before starting Studio.");
  }
  if (counted?.raw !== raw) {
    counted = { raw, wrapped: countingPlatform(raw) };
  }
  return counted.wrapped;
}

/** @returns {boolean} */
export function hasPlatform() {
  return g.__jxPlatform != null;
}
