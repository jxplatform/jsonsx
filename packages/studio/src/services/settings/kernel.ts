/// <reference lib="dom" />
/**
 * The settings kernel — one owner for every application setting's value.
 *
 * **The model.** The backend store is authoritative, `localStorage` is a synchronous cache of it,
 * and every write is a per-key patch applied by whoever owns the file. What this replaces collapsed
 * all three roles: `localStorage` was the truth, and it was mirrored to disk by whole-map replaces
 * computed from whichever window happened to write last. On the chromium launcher — where every
 * window is its own process with its own browser profile, and so its own `localStorage` — a window
 * holding no settings could therefore overwrite the shared file with an almost empty map. Nothing
 * told the other window it had happened.
 *
 * **Why a Map and not just localStorage.** Reads must be synchronous: the chrome theme is read
 * before the first paint (`shell.ts` says so explicitly — a mismatch flashes the shell), and every
 * credential gate reads on the render path. But the authoritative copy arrives asynchronously. An
 * in-memory Map seeded from the cache at module evaluation gives both: correct on the first frame,
 * and reconciled by {@link hydrateSettings} the moment the backend answers.
 *
 * **The one deletion path.** {@link setSetting} with `""` STORES an empty string;
 * {@link clearSetting} is the only thing that removes. Blank used to mean delete, which read as a
 * convenience until a form that blanked its own drafts on save called the setters with them — and
 * pressing Save a second time revoked the credentials the first press had stored. Making blank
 * unrepresentable as a deletion is what stops that whole class, rather than fixing the one caller.
 *
 * @license MIT
 */

import { getPlatform, hasPlatform } from "../../platform";
import { notify } from "../notify";
import { ALL_SETTINGS, USER_SETTINGS } from "./definitions";
import type { SettingDefinition } from "./definitions";
import { createWriteQueue } from "./write-queue";
import type { SettingsPatch } from "./write-queue";

/** The synchronous source of truth. Absent key means unset — which is not the same as `""`. */
const values = new Map<string, string>();

/** Read the cache defensively; unavailable or throwing storage reads as unset. */
function readCache(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** Mirror a value into the cache, so the next boot is correct before the backend answers. */
function writeCache(key: string, value: string | null): void {
  try {
    if (value === null) {
      globalThis.localStorage?.removeItem(key);
    } else {
      globalThis.localStorage?.setItem(key, value);
    }
  } catch {
    /* Storage unavailable (private mode) — the Map still serves this session. */
  }
}

/** Seed from the cache. Runs at module evaluation, before anything can read. */
for (const definition of ALL_SETTINGS) {
  const cached = readCache(definition.key);
  if (cached !== null) {
    values.set(definition.key, cached);
  }
}

// ─── Reading ──────────────────────────────────────────────────────────────────

/**
 * The value the user actually chose — the ONLY read. A default never stands in for silence here.
 *
 * There is deliberately no default-masking sibling. One existed, and every bug in this area came
 * from a caller taking the masked value for a chosen one: a form prefilled with `"gpt-4o"` and
 * saved it, so an install whose owner had configured a different provider was left holding
 * `jx.ai.model: "gpt-4o"` and nothing else. A consumer that needs a fallback composes it where the
 * fallbacks are known — see `ai-models.ts`'s `preferredModel`, which asks the backend what it
 * prefers before reaching for a name invented here.
 *
 * @returns The stored value, or "" when none is stored.
 */
export function readStoredSetting(definition: SettingDefinition): string {
  return values.get(definition.key) ?? "";
}

/** Whether a value is stored — as distinct from stored-and-empty, or absent-with-a-default. */
export function hasSetting(definition: SettingDefinition): boolean {
  return (values.get(definition.key) ?? "") !== "";
}

// ─── Change notification ──────────────────────────────────────────────────────

const listeners = new Set<(keys: readonly string[]) => void>();

/**
 * Subscribe to settings changes, local or remote. Returns the unsubscribe.
 *
 * This is the seam that lets a surface hold no copy of a setting: the composer's model picker, the
 * Accounts list and the New Project gates all read through the kernel and repaint on this, rather
 * than each caching a value that another window can invalidate.
 */
export function onSettingsChanged(listener: (keys: readonly string[]) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Announce the keys that moved. Never called with an empty list. */
function announce(keys: readonly string[]): void {
  for (const listener of listeners) {
    listener(keys);
  }
}

// ─── Writing ──────────────────────────────────────────────────────────────────

const queue = createWriteQueue({
  onError(error: unknown) {
    notify("error", "Your settings could not be saved.", {
      detail: error instanceof Error ? error.message : String(error),
      key: "settings-write",
      source: "Settings",
    });
  },
  async send(patch: SettingsPatch) {
    if (!hasPlatform()) {
      return;
    }
    const platform = getPlatform();
    if (!platform.patchSettings) {
      return;
    }
    /*
     * Only the keys that actually moved go on the wire. A key this window never touched is one the
     * backend leaves exactly as it found it — which is what stops a second window's settings being
     * cleared by a window that happens to hold none of them.
     *
     * An empty value is sent as a REMOVAL. The store is what a fresh install reads back at boot, and
     * `"jx.ai.model": ""` there would be a model choice rather than the absence of one.
     */
    const set: Record<string, string> = {};
    const remove: string[] = [];
    for (const [key, value] of Object.entries(patch)) {
      if (value) {
        set[key] = value;
      } else {
        remove.push(key);
      }
    }
    await platform.patchSettings({ remove, set });
  },
});

/** Resolves when every settings write made so far has been sent. */
export function settingsSettled(): Promise<void> {
  return queue.settled();
}

/**
 * Apply a patch: `null` deletes, a string stores. Keys named by neither are untouched.
 *
 * Returns the keys that actually moved, so a no-op write announces nothing and schedules nothing.
 */
function apply(patch: SettingsPatch): string[] {
  const moved: string[] = [];
  for (const [key, next] of Object.entries(patch)) {
    const before = values.get(key) ?? null;
    if (before === next) {
      continue;
    }
    if (next === null) {
      values.delete(key);
    } else {
      values.set(key, next);
    }
    writeCache(key, next);
    moved.push(key);
  }
  return moved;
}

/** Store a value. An empty string is a VALUE; {@link clearSetting} is the only deletion. */
export function setSetting(definition: SettingDefinition, value: string): void {
  const next = definition.normalize ? definition.normalize(value) : value;
  const moved = apply({ [definition.key]: next });
  if (moved.length > 0) {
    queue.enqueue({ [definition.key]: next });
    announce(moved);
  }
}

/**
 * Store several settings as one change — one announcement, one write.
 *
 * What a form's Save should call. Three separate `setSetting`s would coalesce into one write
 * anyway, but they would announce three times, and each intermediate announcement describes a state
 * the user never asked for.
 */
export function setSettings(entries: readonly [SettingDefinition, string][]): void {
  const patch: SettingsPatch = {};
  for (const [definition, value] of entries) {
    patch[definition.key] = definition.normalize ? definition.normalize(value) : value;
  }
  const moved = apply(patch);
  if (moved.length > 0) {
    queue.enqueue(patch);
    announce(moved);
  }
}

/** Forget several settings as one change — the shape a Disconnect wants. */
export function clearSettings(definitions: readonly SettingDefinition[]): void {
  const patch: SettingsPatch = {};
  for (const definition of definitions) {
    patch[definition.key] = null;
  }
  const moved = apply(patch);
  if (moved.length > 0) {
    queue.enqueue(patch);
    announce(moved);
  }
}

// ─── Hydration ────────────────────────────────────────────────────────────────

/**
 * Reconcile with the backend store. Call once, after the platform is registered; a no-op on
 * platforms without one (dev server, cloud), where the cache is all there is.
 *
 * Deliberately not awaited by the boot path — hydration must not block the first paint — which is
 * safe because the Map is already serving cached values by then. Anything the backend holds wins;
 * anything only this machine holds is pushed up once, so a user upgrading from a cache-only build
 * does not lose what they had configured.
 */
export async function hydrateSettings(): Promise<void> {
  if (!hasPlatform()) {
    return;
  }
  const platform = getPlatform();
  if (!platform.getSettings) {
    return;
  }
  let stored: Record<string, string>;
  try {
    stored = await platform.getSettings();
  } catch {
    return;
  }
  const incoming: SettingsPatch = {};
  let needsMigration = false;
  for (const definition of USER_SETTINGS) {
    const backendValue = stored[definition.key];
    if (backendValue) {
      incoming[definition.key] = backendValue;
    } else if (values.get(definition.key)) {
      needsMigration = true;
    }
  }
  const moved = apply(incoming);
  if (moved.length > 0) {
    announce(moved);
  }
  if (needsMigration) {
    /* Push this machine's cache-only values up, through the same queue as any other write so it
       cannot race one the user is making at the same moment. Only the keys the backend lacks — a
       patch says nothing about the rest, so hydration cannot echo back what it just read. */
    const push: SettingsPatch = {};
    for (const definition of USER_SETTINGS) {
      const value = values.get(definition.key);
      if (value && !stored[definition.key]) {
        push[definition.key] = value;
      }
    }
    queue.enqueue(push);
  }
}

/**
 * Adopt the backend store as another window (or a hand-edit) left it.
 *
 * Applied and announced, but never written back: this is news, not an edit, and echoing it would
 * have two windows writing the same value at each other. A key the store no longer holds is
 * forgotten here too, so a Disconnect in one window reaches the others.
 *
 * Self-echo needs no filter. Our own write reaches us through the same watch, and by then the
 * values already match — {@link apply} reports nothing moved, so nothing is announced.
 */
export function adoptRemoteSettings(stored: Record<string, string>): void {
  const patch: SettingsPatch = {};
  for (const definition of USER_SETTINGS) {
    patch[definition.key] = stored[definition.key] ?? null;
  }
  const moved = apply(patch);
  if (moved.length > 0) {
    announce(moved);
  }
}

/**
 * Subscribe to the backend store, if this platform can push. A no-op where it cannot.
 *
 * Called once at boot. The returned unsubscribe is not used — Studio boots this module once per
 * window and never unwinds it — so it is deliberately dropped rather than stored somewhere nothing
 * would read it.
 */
export function watchRemoteSettings(): void {
  if (!hasPlatform()) {
    return;
  }
  getPlatform().subscribeSettings?.(adoptRemoteSettings);
}

/**
 * Drop every value this kernel holds, cache included.
 *
 * The `?profile=fresh` startup profile's half of the story: clearing `localStorage` alone left the
 * Map — and the backend store — untouched, so "fresh" was not fresh. This does not write to the
 * backend, because a clean profile must not destroy credentials that belong to the user rather than
 * to the profile.
 */
export function resetSettings(): void {
  const moved = [...values.keys()];
  values.clear();
  for (const key of moved) {
    writeCache(key, null);
  }
  if (moved.length > 0) {
    announce(moved);
  }
}
