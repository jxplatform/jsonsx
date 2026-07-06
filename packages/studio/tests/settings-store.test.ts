/**
 * Tests for src/services/settings-store.ts — sync of user settings between localStorage and the
 * platform's backend user-settings store: boot hydration, one-shot migration of local-only values,
 * write-through persistence, and the no-op paths on platforms without a settings store.
 */
import { flush, installMockPlatform } from "./harness";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  hydrateSettings,
  PERSISTED_SETTINGS_KEYS,
  persistSettings,
} from "../src/services/settings-store";
import type { StudioPlatform } from "../src/types";

const [KEY, BASE_URL, MODEL] = PERSISTED_SETTINGS_KEYS;

/** Drop any platform a prior test registered so hasPlatform() reflects the dev-server case. */
function clearPlatform() {
  delete (globalThis as { __jxPlatform?: StudioPlatform }).__jxPlatform;
}

/** Install a mock platform backed by an in-memory settings map, recording every saveSettings call. */
function installSettingsBackend(seed: Record<string, string> = {}) {
  let store: Record<string, string> = { ...seed };
  const saves: Record<string, string>[] = [];
  installMockPlatform({
    getSettings: async () => ({ ...store }),
    saveSettings: async (settings) => {
      saves.push({ ...settings });
      store = { ...settings };
    },
  });
  return { get: () => store, saves };
}

const realLocalStorage = globalThis.localStorage;

/** Swap in a localStorage whose every method throws, to exercise the defensive catch branches. */
function installThrowingStorage() {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem() {
        throw new Error("nope");
      },
      setItem() {
        throw new Error("nope");
      },
      removeItem() {
        throw new Error("nope");
      },
    },
    writable: true,
  });
}

function restoreStorage() {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: realLocalStorage,
    writable: true,
  });
}

beforeEach(() => {
  clearPlatform();
  localStorage.clear();
});

afterEach(() => {
  restoreStorage();
  localStorage.clear();
  clearPlatform();
});

describe("hydrateSettings", () => {
  test("writes backend values into localStorage without pushing back", async () => {
    const backend = installSettingsBackend({
      [BASE_URL]: "http://localhost:11434/v1",
      [KEY]: "sk-backend",
      [MODEL]: "gpt-4o-mini",
    });
    await hydrateSettings();
    expect(localStorage.getItem(KEY)).toBe("sk-backend");
    expect(localStorage.getItem(BASE_URL)).toBe("http://localhost:11434/v1");
    expect(localStorage.getItem(MODEL)).toBe("gpt-4o-mini");
    expect(backend.saves.length).toBe(0); // Nothing local-only → no migration push
  });

  test("pushes local-only values back exactly once with the merged map (migration)", async () => {
    localStorage.setItem(KEY, "sk-local");
    localStorage.setItem(BASE_URL, "http://local:8080/v1");
    const backend = installSettingsBackend({ [MODEL]: "gpt-4o-mini" });
    await hydrateSettings();
    // The backend's value wins where it has one; local-only values are merged in.
    expect(localStorage.getItem(MODEL)).toBe("gpt-4o-mini");
    expect(backend.saves.length).toBe(1);
    expect(backend.saves[0]).toEqual({
      [BASE_URL]: "http://local:8080/v1",
      [KEY]: "sk-local",
      [MODEL]: "gpt-4o-mini",
    });
  });

  test("tolerates a rejecting getSettings", async () => {
    localStorage.setItem(KEY, "sk-keep");
    installMockPlatform({
      getSettings: async () => {
        throw new Error("backend down");
      },
      saveSettings: async () => {},
    });
    await hydrateSettings();
    expect(localStorage.getItem(KEY)).toBe("sk-keep"); // Untouched
  });

  test("tolerates a rejecting saveSettings during migration", async () => {
    localStorage.setItem(KEY, "sk-local");
    installMockPlatform({
      getSettings: async () => ({}),
      saveSettings: async () => {
        throw new Error("write failed");
      },
    });
    await hydrateSettings();
    await flush();
    expect(localStorage.getItem(KEY)).toBe("sk-local");
  });

  test("skips the migration push when the platform lacks saveSettings", async () => {
    localStorage.setItem(KEY, "sk-local");
    installMockPlatform({ getSettings: async () => ({}) });
    await hydrateSettings();
    expect(localStorage.getItem(KEY)).toBe("sk-local");
  });

  test("swallows a throwing localStorage when writing backend values", async () => {
    installSettingsBackend({ [KEY]: "sk-backend" });
    installThrowingStorage();
    await hydrateSettings(); // Must not throw
  });

  test("is a no-op when the platform lacks getSettings", async () => {
    localStorage.setItem(KEY, "sk-local");
    installMockPlatform(); // Default mock has no settings store
    await hydrateSettings();
    expect(localStorage.getItem(KEY)).toBe("sk-local");
  });

  test("is a no-op when no platform is registered", async () => {
    localStorage.setItem(KEY, "sk-local");
    await hydrateSettings();
    expect(localStorage.getItem(KEY)).toBe("sk-local");
  });
});

describe("persistSettings", () => {
  test("sends the current localStorage values and skips null/empty keys", async () => {
    const backend = installSettingsBackend();
    localStorage.setItem(KEY, "sk-now");
    localStorage.setItem(BASE_URL, ""); // Empty → skipped
    localStorage.setItem(MODEL, "gpt-4o");
    persistSettings();
    await flush();
    expect(backend.saves.length).toBe(1);
    expect(backend.saves[0]).toEqual({ [KEY]: "sk-now", [MODEL]: "gpt-4o" });
  });

  test("sends an empty map when nothing is stored, so cleared settings clear the backend", async () => {
    const backend = installSettingsBackend({ [KEY]: "sk-stale" });
    persistSettings();
    await flush();
    expect(backend.saves).toEqual([{}]);
    expect(backend.get()).toEqual({});
  });

  test("tolerates a rejecting saveSettings", async () => {
    installMockPlatform({
      getSettings: async () => ({}),
      saveSettings: async () => {
        throw new Error("write failed");
      },
    });
    localStorage.setItem(KEY, "sk-now");
    persistSettings(); // Must not throw (rejection is swallowed)
    await flush();
  });

  test("reads nothing from a throwing localStorage", async () => {
    const backend = installSettingsBackend();
    installThrowingStorage();
    persistSettings();
    await flush();
    expect(backend.saves).toEqual([{}]);
  });

  test("is a no-op when the platform lacks saveSettings", () => {
    localStorage.setItem(KEY, "sk-now");
    const { state } = installMockPlatform(); // Default mock has no settings store
    expect(() => {
      persistSettings();
    }).not.toThrow();
    expect(state.calls.some(([name]) => name === "saveSettings")).toBe(false);
  });

  test("is a no-op when no platform is registered", () => {
    localStorage.setItem(KEY, "sk-now");
    expect(() => {
      persistSettings();
    }).not.toThrow();
  });
});
