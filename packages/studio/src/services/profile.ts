/**
 * Startup profiles — a named, defined cold start.
 *
 * "What does Studio look like to someone who has never opened it?" currently has no answer inside
 * the app. Every consumer of that question reaches _around_ it: the screenshot runner injects
 * `localStorage.clear()` before the first navigation, the verify recipe says "use a fresh browser
 * profile", and a support thread says "try a private window". All three clear the whole ORIGIN —
 * including keys Studio does not own — and none of them can be invoked from inside the running
 * app.
 *
 * Three shipped things need it to be a real, addressable state:
 *
 * - **Per-project layout and session persistence** cannot be tested without a defined starting point;
 *   "whatever was in storage" is not one.
 * - **Preferences: Reset Layout** is `applyProfile("fresh")` scoped to the layout keys, and the plan
 *   promises it is "always one action away".
 * - **Support** wants "reproduce with a clean profile" to be a URL, not an instruction.
 *
 * The profile is selected by `?profile=<id>` and applied ONCE, at import time, before anything
 * reads persisted state — {@link import("../shell").shell} calls this above its own `localStorage`
 * read for exactly that reason. `?clock=` rides alongside because it is the other boot-time knob:
 * both describe the world the app wakes up in, and neither changes behaviour after.
 */

import { pinClock } from "./clock";

/** What a profile resets. */
export type ProfileReset = "none" | "app-state";

export interface StartupProfile {
  id: string;
  /** Shown wherever a profile is offered (Preferences, the palette). */
  description: string;
  reset: ProfileReset;
}

/**
 * The profiles Studio declares.
 *
 * `default` is not a no-op by omission — it is a named state, so "the app started normally" and
 * "the profile was unrecognised" are different outcomes and the second one is loud.
 */
export const STARTUP_PROFILES: Readonly<Record<string, StartupProfile>> = {
  default: {
    description: "Resume whatever was persisted — layout, recents, settings, chat history.",
    id: "default",
    reset: "none",
  },
  fresh: {
    description: "A first-run app: no layout, no recents, no settings, no history.",
    id: "fresh",
    reset: "app-state",
  },
};

export const DEFAULT_PROFILE_ID = "default";

/**
 * Studio's own persisted keys, by prefix.
 *
 * Scoped rather than `localStorage.clear()`: the dev server, the docs site and Studio share an
 * origin, and a profile that wipes a neighbour's state is a worse bug than the one it fixes. Every
 * key Studio writes begins with `jx` followed by one of these separators — the panel widths, the
 * recents, the GitHub token, the AI and Cloudflare settings, the chat sessions, the update
 * dismissals and the canvas debug flag.
 */
const OWNED_KEY_PATTERN = /^jx[-._:]/;

/** Whether a storage key belongs to Studio and is therefore a profile's to clear. */
export function isStudioStorageKey(key: string): boolean {
  return OWNED_KEY_PATTERN.test(key);
}

/**
 * Drop every Studio-owned key from `localStorage`.
 *
 * @returns The keys removed, so a caller (Preferences, a test) can report what it did.
 */
export function clearStudioStorage(): string[] {
  const store = globalThis.localStorage as Storage | undefined;
  if (!store) {
    return [];
  }
  const doomed: string[] = [];
  try {
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key && isStudioStorageKey(key)) {
        doomed.push(key);
      }
    }
    for (const key of doomed) {
      store.removeItem(key);
    }
  } catch {
    // Storage unavailable (private mode, disabled cookies) — there is nothing persisted to reset.
  }
  return doomed;
}

/**
 * Apply a profile by id.
 *
 * @throws {RangeError} When the id is not declared. A misspelled profile that silently fell back to
 *   `default` would start the app in the state the caller was trying to avoid.
 */
export function applyProfile(id: string): StartupProfile {
  const profile = STARTUP_PROFILES[id];
  if (!profile) {
    throw new RangeError(
      `unknown startup profile "${id}"; declared: ${Object.keys(STARTUP_PROFILES).join(", ")}`,
    );
  }
  if (profile.reset === "app-state") {
    clearStudioStorage();
  }
  return profile;
}

/** What {@link applyStartupProfile} resolved. */
export interface StartupState {
  profile: StartupProfile;
  /** The instant the clock was pinned to, or `null` when it follows the wall clock. */
  clock: number | null;
}

let _startup: StartupState | null = null;

/**
 * Read `?profile=` and `?clock=` and apply them. Idempotent — the first call wins, so importing
 * this from a second module cannot re-clear storage the app has already written to.
 *
 * @param search The query string to read. Defaults to the live location, and is passed explicitly
 *   by the tests, which have no navigation.
 */
export function applyStartupProfile(search?: string): StartupState {
  if (_startup) {
    return _startup;
  }
  const query = new URLSearchParams(search ?? globalThis.location?.search ?? "");
  const profile = applyProfile(query.get("profile") ?? DEFAULT_PROFILE_ID);
  const clockParam = query.get("clock");
  _startup = { clock: clockParam === null ? null : pinClock(clockParam), profile };
  return _startup;
}

/** What the app started as. `null` until {@link applyStartupProfile} has run. */
export function startupState(): StartupState | null {
  return _startup;
}

/** Forget the resolved startup state, so the next call re-reads the query. Tests only. */
export function resetStartupProfile(): void {
  _startup = null;
}
