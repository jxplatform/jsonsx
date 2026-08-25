/**
 * Tests for src/services/settings/kernel.ts — the owner of every application setting's value:
 * default-masking vs stored reads, the single deletion path, coalesced write-through, boot
 * hydration with its one-shot migration, remote patches, and the no-op paths on platforms with no
 * backend store.
 */
import { flush, installMockPlatform } from "./harness";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SETTINGS } from "../src/services/settings/definitions";
import {
  adoptRemoteSettings,
  clearSettings,
  hasSetting,
  hydrateSettings,
  onSettingsChanged,
  readStoredSetting,
  resetSettings,
  setSetting,
  setSettings,
  settingsSettled,
  watchRemoteSettings,
} from "../src/services/settings/kernel";
import type { SettingsPatch, StudioPlatform } from "../src/types";

/* Read off the registry rather than restated, so a key rename moves the test with the code. */
const KEY = SETTINGS.aiOpenAiKey.key;
const BASE_URL = SETTINGS.aiBaseUrl.key;
const MODEL = SETTINGS.aiModel.key;

/** Drop any platform a prior test registered so hasPlatform() reflects the dev-server case. */
function clearPlatform() {
  delete (globalThis as { __jxPlatform?: StudioPlatform }).__jxPlatform;
}

/**
 * A mock platform over an in-memory store that APPLIES patches the way the real one does — a key
 * named by neither `set` nor `remove` is left alone. A mock that replaced the map instead would
 * make the whole point of this step untestable.
 */
function installSettingsBackend(seed: Record<string, string> = {}) {
  let store: Record<string, string> = { ...seed };
  const patches: SettingsPatch[] = [];
  installMockPlatform({
    getSettings: async () => ({ ...store }),
    patchSettings: async (patch) => {
      patches.push({ remove: [...(patch.remove ?? [])], set: { ...patch.set } });
      store = { ...store, ...patch.set };
      for (const key of patch.remove ?? []) {
        delete store[key];
      }
      return { ...store };
    },
  });
  return { get: () => store, patches };
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
  resetSettings();
  localStorage.clear();
});

afterEach(() => {
  restoreStorage();
  resetSettings();
  localStorage.clear();
  clearPlatform();
});

describe("reading", () => {
  /** Unset and stored-blank read the same, and neither invents the declared default. */
  test("readStoredSetting never substitutes the default", () => {
    expect(readStoredSetting(SETTINGS.aiModel)).toBe("");
    setSetting(SETTINGS.aiModel, "deepseek-v4-pro");
    expect(readStoredSetting(SETTINGS.aiModel)).toBe("deepseek-v4-pro");
    setSetting(SETTINGS.aiModel, "");
    expect(readStoredSetting(SETTINGS.aiModel)).toBe("");
  });

  test("hasSetting distinguishes unset, stored-empty, and stored", () => {
    expect(hasSetting(SETTINGS.aiOpenAiKey)).toBe(false);
    setSetting(SETTINGS.aiOpenAiKey, "");
    expect(hasSetting(SETTINGS.aiOpenAiKey)).toBe(false);
    setSetting(SETTINGS.aiOpenAiKey, "sk-x");
    expect(hasSetting(SETTINGS.aiOpenAiKey)).toBe(true);
  });

  test("reads are synchronous and survive a throwing localStorage", () => {
    setSetting(SETTINGS.aiModel, "gpt-4o-mini");
    installThrowingStorage();
    // The Map is the source of truth; the cache is only a cache.
    expect(readStoredSetting(SETTINGS.aiModel)).toBe("gpt-4o-mini");
  });
});

describe("writing", () => {
  test("normalize is applied on write", () => {
    setSetting(SETTINGS.aiBaseUrl, "  https://example.test/v1///  ");
    expect(readStoredSetting(SETTINGS.aiBaseUrl)).toBe("https://example.test/v1");
    setSetting(SETTINGS.aiOpenAiKey, "  sk-padded  ");
    expect(readStoredSetting(SETTINGS.aiOpenAiKey)).toBe("sk-padded");
  });

  /**
   * The class of defect this makes unrepresentable: a form that blanked its own drafts on Save then
   * called these setters with them, and the second Save revoked what the first had stored.
   */
  test("setSetting with a blank STORES blank; only clearSettings deletes", () => {
    setSetting(SETTINGS.aiOpenAiKey, "sk-x");
    setSetting(SETTINGS.aiOpenAiKey, "");
    expect(localStorage.getItem(KEY)).toBe("");
    expect(readStoredSetting(SETTINGS.aiOpenAiKey)).toBe("");

    clearSettings([SETTINGS.aiOpenAiKey]);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  test("clearSettings is idempotent and announces nothing when there was nothing", () => {
    const seen: string[][] = [];
    const off = onSettingsChanged((keys) => seen.push([...keys]));
    clearSettings([SETTINGS.aiOpenAiKey]);
    expect(seen).toEqual([]);
    off();
  });

  test("a write that changes nothing announces nothing", () => {
    setSetting(SETTINGS.aiModel, "gpt-4o-mini");
    const seen: string[][] = [];
    const off = onSettingsChanged((keys) => seen.push([...keys]));
    setSetting(SETTINGS.aiModel, "gpt-4o-mini");
    expect(seen).toEqual([]);
    off();
  });

  test("setSettings announces once for the whole group", () => {
    const seen: string[][] = [];
    const off = onSettingsChanged((keys) => seen.push([...keys]));
    setSettings([
      [SETTINGS.aiOpenAiKey, "sk-group"],
      [SETTINGS.aiBaseUrl, "https://example.test/v1"],
      [SETTINGS.aiModel, "deepseek-v4-pro"],
    ]);
    expect(seen).toEqual([[KEY, BASE_URL, MODEL]]);
    off();
  });

  test("clearSettings forgets a group in one change", () => {
    setSettings([
      [SETTINGS.aiOpenAiKey, "sk-group"],
      [SETTINGS.aiBaseUrl, "https://example.test/v1"],
    ]);
    clearSettings([SETTINGS.aiOpenAiKey, SETTINGS.aiBaseUrl]);
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(localStorage.getItem(BASE_URL)).toBeNull();
  });

  test("a throwing localStorage does not stop the write", () => {
    installThrowingStorage();
    expect(() => {
      setSetting(SETTINGS.aiModel, "gpt-4o-mini");
      clearSettings([SETTINGS.aiModel]);
    }).not.toThrow();
  });
});

describe("write-through", () => {
  /**
   * One Save mutates three settings. Each used to send its own whole-map replace, so three
   * overlapping writes raced over one file and the last to land won — which is how a settings file
   * came to hold `{"jx.ai.model": "gpt-4o"}`, the second of three snapshots.
   */
  test("a burst of writes produces ONE send, taken after the burst settles", async () => {
    const backend = installSettingsBackend();
    setSetting(SETTINGS.aiOpenAiKey, "sk-burst");
    setSetting(SETTINGS.aiBaseUrl, "https://example.test/v1");
    setSetting(SETTINGS.aiModel, "deepseek-v4-pro");
    await settingsSettled();
    expect(backend.patches).toEqual([
      {
        remove: [],
        set: {
          [BASE_URL]: "https://example.test/v1",
          [KEY]: "sk-burst",
          [MODEL]: "deepseek-v4-pro",
        },
      },
    ]);
  });

  /**
   * The store is what a fresh install reads back at boot. `"jx.ai.model": ""` there would be a
   * model choice rather than the absence of one, so an emptied value travels as a removal.
   */
  test("an emptied value is sent as a removal, not as a blank", async () => {
    const backend = installSettingsBackend({ [KEY]: "sk-old" });
    await hydrateSettings();
    clearSettings([SETTINGS.aiOpenAiKey]);
    await settingsSettled();
    expect(backend.patches.at(-1)).toEqual({ remove: [KEY], set: {} });
    expect(backend.get()).toEqual({});
  });

  test("a later write goes out after the first, not alongside it", async () => {
    const backend = installSettingsBackend();
    setSetting(SETTINGS.aiOpenAiKey, "sk-first");
    await settingsSettled();
    setSetting(SETTINGS.aiOpenAiKey, "sk-second");
    await settingsSettled();
    expect(backend.patches.map((p) => p.set?.[KEY])).toEqual(["sk-first", "sk-second"]);
  });

  test("keeps sending after a rejected write", async () => {
    const sent: SettingsPatch[] = [];
    let failNext = true;
    installMockPlatform({
      getSettings: async () => ({}),
      patchSettings: async (patch) => {
        if (failNext) {
          failNext = false;
          throw new Error("write failed");
        }
        sent.push(patch);
        return {};
      },
    });
    setSetting(SETTINGS.aiOpenAiKey, "sk-doomed");
    await settingsSettled();
    setSetting(SETTINGS.aiOpenAiKey, "sk-second");
    await settingsSettled();
    expect(sent).toEqual([{ remove: [], set: { [KEY]: "sk-second" } }]);
  });

  test("is a no-op when the platform lacks patchSettings", async () => {
    const { state } = installMockPlatform(); // Default mock has no settings store
    setSetting(SETTINGS.aiOpenAiKey, "sk-x");
    await settingsSettled();
    expect(state.calls.some(([name]) => name === "patchSettings")).toBe(false);
  });

  test("is a no-op when no platform is registered", async () => {
    expect(() => {
      setSetting(SETTINGS.aiOpenAiKey, "sk-x");
    }).not.toThrow();
    await settingsSettled();
  });

  /**
   * The send is deferred to the end of the tick, so the platform it was scheduled against can be
   * gone by the time it runs — a window tearing down mid-save.
   */
  test("drops the deferred send when the platform goes away before it runs", async () => {
    const backend = installSettingsBackend();
    setSetting(SETTINGS.aiOpenAiKey, "sk-now");
    clearPlatform();
    await settingsSettled();
    expect(backend.patches).toEqual([]);
  });
});

describe("hydrateSettings", () => {
  test("adopts the backend's values and announces them", async () => {
    installSettingsBackend({ [KEY]: "sk-backend", [MODEL]: "deepseek-v4-pro" });
    const seen: string[][] = [];
    const off = onSettingsChanged((keys) => seen.push([...keys]));
    await hydrateSettings();
    expect(readStoredSetting(SETTINGS.aiOpenAiKey)).toBe("sk-backend");
    expect(localStorage.getItem(KEY)).toBe("sk-backend");
    expect(seen).toEqual([[KEY, MODEL]]);
    off();
  });

  test("pushes cache-only values up once, so an upgrading user keeps what they had", async () => {
    /* Written with NO platform registered, which is the state an upgrading user is in: the value
       reached this machine's cache from a build that had no backend store to write it to. */
    setSetting(SETTINGS.aiOpenAiKey, "sk-local");
    await settingsSettled();
    const backend = installSettingsBackend();
    await hydrateSettings();
    await settingsSettled();
    expect(backend.patches).toEqual([{ remove: [], set: { [KEY]: "sk-local" } }]);
  });

  test("the backend wins over a local value, and is not pushed back", async () => {
    setSetting(SETTINGS.aiModel, "local-model");
    await settingsSettled();
    const backend = installSettingsBackend({ [MODEL]: "backend-model" });
    await hydrateSettings();
    await settingsSettled();
    expect(readStoredSetting(SETTINGS.aiModel)).toBe("backend-model");
    expect(backend.patches).toEqual([]);
  });

  test("makes no migration push when the backend already knows every value", async () => {
    const backend = installSettingsBackend({ [KEY]: "sk-backend" });
    await hydrateSettings();
    await settingsSettled();
    expect(backend.patches).toEqual([]);
  });

  test("tolerates a rejecting getSettings", async () => {
    installMockPlatform({
      getSettings: async () => {
        throw new Error("read failed");
      },
    });
    await hydrateSettings(); // Must not throw
  });

  test("is a no-op when the platform lacks getSettings", async () => {
    setSetting(SETTINGS.aiOpenAiKey, "sk-local");
    installMockPlatform(); // Default mock has no settings store
    await hydrateSettings();
    expect(readStoredSetting(SETTINGS.aiOpenAiKey)).toBe("sk-local");
  });

  test("is a no-op when no platform is registered", async () => {
    setSetting(SETTINGS.aiOpenAiKey, "sk-local");
    await hydrateSettings();
    expect(readStoredSetting(SETTINGS.aiOpenAiKey)).toBe("sk-local");
  });
});

describe("adoptRemoteSettings", () => {
  /**
   * News, not an edit. Echoing it back would have two windows writing the same value at each other
   * forever.
   */
  test("applies and announces, but does not write back", async () => {
    const backend = installSettingsBackend();
    const seen: string[][] = [];
    const off = onSettingsChanged((keys) => seen.push([...keys]));
    adoptRemoteSettings({ [MODEL]: "from-elsewhere" });
    await settingsSettled();
    expect(readStoredSetting(SETTINGS.aiModel)).toBe("from-elsewhere");
    expect(localStorage.getItem(MODEL)).toBe("from-elsewhere");
    expect(seen).toEqual([[MODEL]]);
    expect(backend.patches).toEqual([]);
    off();
  });

  /** A Disconnect in one window has to reach the others, and absence is how it travels. */
  test("a key the store no longer holds is forgotten here too", () => {
    setSetting(SETTINGS.aiOpenAiKey, "sk-mine");
    adoptRemoteSettings({});
    expect(readStoredSetting(SETTINGS.aiOpenAiKey)).toBe("");
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  /** Our own write comes back through the same watch. By then the values match, so nothing moved. */
  test("announces nothing when the store already matches — the self-echo case", () => {
    setSetting(SETTINGS.aiModel, "same");
    const seen: string[][] = [];
    const off = onSettingsChanged((keys) => seen.push([...keys]));
    adoptRemoteSettings({ [MODEL]: "same" });
    expect(seen).toEqual([]);
    off();
  });
});

describe("watchRemoteSettings", () => {
  test("subscribes through the platform and adopts what it is handed", () => {
    let push: ((settings: Record<string, string>) => void) | null = null;
    installMockPlatform({
      getSettings: async () => ({}),
      subscribeSettings: (handler) => {
        push = handler;
        return () => {};
      },
    });
    watchRemoteSettings();
    expect(push).not.toBeNull();
    push!({ [MODEL]: "pushed" });
    expect(readStoredSetting(SETTINGS.aiModel)).toBe("pushed");
  });

  /** A platform that cannot push leaves a second window stale, never wrong. */
  test("is a no-op on a platform without the subscription, and with no platform", () => {
    installMockPlatform();
    expect(() => watchRemoteSettings()).not.toThrow();
    clearPlatform();
    expect(() => watchRemoteSettings()).not.toThrow();
  });
});

describe("subscription", () => {
  test("the unsubscribe stops delivery", () => {
    const seen: string[][] = [];
    const off = onSettingsChanged((keys) => seen.push([...keys]));
    setSetting(SETTINGS.aiModel, "one");
    off();
    setSetting(SETTINGS.aiModel, "two");
    expect(seen).toEqual([[MODEL]]);
  });
});

describe("resetSettings", () => {
  /**
   * `?profile=fresh`'s half of the story: clearing localStorage alone left the kernel's Map holding
   * everything, so "fresh" was not fresh. It deliberately does NOT write to the backend — a clean
   * profile must not destroy credentials that belong to the user rather than to the profile.
   */
  test("drops every value and its cache, without touching the backend", async () => {
    const backend = installSettingsBackend();
    setSettings([
      [SETTINGS.aiOpenAiKey, "sk-x"],
      [SETTINGS.aiModel, "gpt-4o-mini"],
    ]);
    await settingsSettled();
    backend.patches.length = 0;

    resetSettings();
    await flush();
    expect(readStoredSetting(SETTINGS.aiOpenAiKey)).toBe("");
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(backend.patches).toEqual([]);
  });

  test("announces the keys it dropped", () => {
    setSetting(SETTINGS.aiModel, "gpt-4o-mini");
    const seen: string[][] = [];
    const off = onSettingsChanged((keys) => seen.push([...keys]));
    resetSettings();
    expect(seen).toEqual([[MODEL]]);
    off();
  });
});
