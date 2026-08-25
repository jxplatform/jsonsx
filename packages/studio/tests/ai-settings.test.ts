/**
 * Tests for src/services/ai-settings.ts — localStorage-backed AI provider settings.
 *
 * Covers the happy path (persist/read/clear for key, base URL, model) and the defensive catch
 * branches taken when localStorage is unavailable or throws.
 */
import "./with-dom.ts";
import { clearSeededSettings, installMockPlatform } from "./harness";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  clearAiProvider,
  getBaseUrl,
  getOpenAiKey,
  hasOpenAiKey,
  saveAiProvider,
  setModel,
  setOpenAiKey,
} from "../src/services/ai-settings";
import { preferredModel } from "../src/services/ai-models";
import type { SettingsPatch } from "../src/types";

const realLocalStorage = globalThis.localStorage;

/**
 * Let the coalesced settings write run and land.
 *
 * The send is deferred to a microtask so one Save's three setters are read once, after the burst;
 * the backend call is a promise beyond that.
 */
async function flushWrites() {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** Swap in a localStorage whose every method throws, to exercise the catch branches. */
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
  globalThis.localStorage.clear();
}

/* The kernel holds its values in memory, so clearing the cache alone leaves the previous test's
   settings in place. Both go together, or these tests are order-dependent. */
beforeEach(() => {
  clearSeededSettings();
  localStorage.clear();
});

afterEach(restoreStorage);

describe("ai-settings — happy path", () => {
  test("persists, reads, and clears the OpenAI key", () => {
    expect(hasOpenAiKey()).toBe(false);
    setOpenAiKey("  sk-abc  ");
    expect(getOpenAiKey()).toBe("sk-abc"); // Trimmed
    expect(hasOpenAiKey()).toBe(true);
    setOpenAiKey("");
    expect(getOpenAiKey()).toBe("");
    expect(hasOpenAiKey()).toBe(false);
  });

  test("persists the base URL with trailing slashes stripped, and clears it", () => {
    expect(getBaseUrl()).toBe("");
    saveAiProvider({ apiKey: "sk-x", baseUrl: "http://localhost:11434/v1//", model: "" });
    expect(getBaseUrl()).toBe("http://localhost:11434/v1");
    clearAiProvider();
    expect(getBaseUrl()).toBe("");
  });

  test("model defaults to gpt-4o and round-trips a custom value", () => {
    expect(preferredModel()).toBe("gpt-4o");
    setModel("claude-sonnet-4-20250514");
    expect(preferredModel()).toBe("claude-sonnet-4-20250514");
    setModel("");
    // Blank is stored, but it is not a choice — a sender still gets the default.
    expect(preferredModel()).toBe("gpt-4o");
  });
});

describe("ai-settings — platform write-through", () => {
  afterEach(() => {
    delete (globalThis as { __jxPlatform?: unknown }).__jxPlatform;
  });

  test("setOpenAiKey writes the key through to the platform settings store", async () => {
    const patches: SettingsPatch[] = [];
    installMockPlatform({
      getSettings: async () => ({}),
      patchSettings: async (patch) => {
        patches.push(patch);
        return {};
      },
    });
    setOpenAiKey("sk-x");
    await flushWrites();
    expect(patches.length).toBe(1);
    expect(patches[0]?.set).toEqual({ "jx.ai.openaiKey": "sk-x" });
  });

  /**
   * The three setters that one Save calls used to produce three overlapping whole-map writes, each
   * reading localStorage at a different moment. `{"jx.ai.model": "gpt-4o"}` — the SECOND of three
   * snapshots, landing last — is what a real install was left holding.
   */
  test("saving a provider produces ONE write, taken after the burst has settled", async () => {
    const patches: SettingsPatch[] = [];
    installMockPlatform({
      getSettings: async () => ({}),
      patchSettings: async (patch) => {
        patches.push(patch);
        return {};
      },
    });
    saveAiProvider({
      apiKey: "sk-burst",
      baseUrl: "https://example.test/v1",
      model: "deepseek-v4-pro",
    });
    await flushWrites();
    expect(patches.length).toBe(1);
    expect(patches[0]?.set).toEqual({
      "jx.ai.baseUrl": "https://example.test/v1",
      "jx.ai.model": "deepseek-v4-pro",
      "jx.ai.openaiKey": "sk-burst",
    });
  });
});

describe("ai-settings — storage unavailable", () => {
  /**
   * The contract MOVED here, and improved. Reads used to go straight to localStorage, so storage
   * being unavailable meant every getter returned its default and the session behaved as if nothing
   * were configured. The kernel holds the values in memory, so a broken cache costs persistence
   * across a reload — not the settings you are using right now.
   */
  test("values set before storage broke are still readable", () => {
    setOpenAiKey("sk-before");
    setModel("claude-sonnet-4-20250514");
    installThrowingStorage();
    expect(getOpenAiKey()).toBe("sk-before");
    expect(hasOpenAiKey()).toBe(true);
    expect(preferredModel()).toBe("claude-sonnet-4-20250514");
  });

  test("getters fall back to defaults when nothing is stored and localStorage throws", () => {
    clearSeededSettings();
    installThrowingStorage();
    expect(getOpenAiKey()).toBe("");
    expect(hasOpenAiKey()).toBe(false);
    expect(getBaseUrl()).toBe("");
    expect(preferredModel()).toBe("gpt-4o");
  });

  test("setters swallow storage errors", () => {
    installThrowingStorage();
    expect(() => {
      saveAiProvider({ apiKey: "sk-x", baseUrl: "http://x", model: "gpt-4o-mini" });
    }).not.toThrow();
  });
});
