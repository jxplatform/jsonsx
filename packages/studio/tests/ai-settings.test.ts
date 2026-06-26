/**
 * Tests for src/services/ai-settings.ts — localStorage-backed AI provider settings.
 *
 * Covers the happy path (persist/read/clear for key, base URL, model) and the defensive catch
 * branches taken when localStorage is unavailable or throws.
 */
import "./with-dom.ts";
import { afterEach, describe, expect, test } from "bun:test";
import {
  getBaseUrl,
  getModel,
  getOpenAiKey,
  hasOpenAiKey,
  setBaseUrl,
  setModel,
  setOpenAiKey,
} from "../src/services/ai-settings";

const realLocalStorage = globalThis.localStorage;

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
    setBaseUrl("http://localhost:11434/v1//");
    expect(getBaseUrl()).toBe("http://localhost:11434/v1");
    setBaseUrl("   ");
    expect(getBaseUrl()).toBe("");
  });

  test("model defaults to gpt-4o and round-trips a custom value", () => {
    expect(getModel()).toBe("gpt-4o");
    setModel("claude-sonnet-4-20250514");
    expect(getModel()).toBe("claude-sonnet-4-20250514");
    setModel("");
    expect(getModel()).toBe("gpt-4o"); // Cleared → default
  });
});

describe("ai-settings — storage unavailable", () => {
  test("getters fall back to defaults when localStorage throws", () => {
    installThrowingStorage();
    expect(getOpenAiKey()).toBe("");
    expect(hasOpenAiKey()).toBe(false);
    expect(getBaseUrl()).toBe("");
    expect(getModel()).toBe("gpt-4o");
  });

  test("setters swallow storage errors", () => {
    installThrowingStorage();
    expect(() => {
      setOpenAiKey("sk-x");
      setBaseUrl("http://x");
      setModel("gpt-4o-mini");
    }).not.toThrow();
  });
});
