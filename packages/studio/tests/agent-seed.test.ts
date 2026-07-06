/**
 * Tests for src/services/agent-seed.ts — the cross-window pending assistant prompt handoff.
 *
 * Covers the set/has/consume round-trip, consume-on-read deletion, per-root isolation, stale-entry
 * expiry (15 min), malformed entries, and the defensive branches when localStorage throws.
 */
import "./with-dom.ts";
import { afterEach, describe, expect, test } from "bun:test";
import {
  consumePendingAgentPrompt,
  hasPendingAgentPrompt,
  setPendingAgentPrompt,
} from "../src/services/agent-seed";

const KEY = "jx.ai.pendingAgentPrompt:/proj";
const realLocalStorage = globalThis.localStorage;

function swapStorage(value: unknown) {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value,
    writable: true,
  });
}

afterEach(() => {
  swapStorage(realLocalStorage);
  globalThis.localStorage.clear();
});

describe("agent-seed", () => {
  test("set → has → consume round-trips, and consume deletes the entry", () => {
    setPendingAgentPrompt("/proj", "build a pricing page");
    expect(hasPendingAgentPrompt("/proj")).toBe(true);
    const raw = globalThis.localStorage.getItem(KEY);
    expect(raw).not.toBeNull();
    const stored = JSON.parse(raw!) as { prompt: string; ts: number };
    expect(stored.prompt).toBe("build a pricing page");
    expect(typeof stored.ts).toBe("number");
    expect(consumePendingAgentPrompt("/proj")).toBe("build a pricing page");
    // Consume-on-read: the entry is gone.
    expect(globalThis.localStorage.getItem(KEY)).toBeNull();
    expect(hasPendingAgentPrompt("/proj")).toBe(false);
    expect(consumePendingAgentPrompt("/proj")).toBeNull();
  });

  test("prompts are isolated per project root", () => {
    setPendingAgentPrompt("/a", "prompt for a");
    setPendingAgentPrompt("/b", "prompt for b");
    expect(consumePendingAgentPrompt("/a")).toBe("prompt for a");
    // Consuming /a leaves /b untouched.
    expect(hasPendingAgentPrompt("/b")).toBe(true);
    expect(consumePendingAgentPrompt("/b")).toBe("prompt for b");
  });

  test("stale entries (older than 15 min) are dropped by has and consume", () => {
    const stale = JSON.stringify({ prompt: "old", ts: Date.now() - 16 * 60 * 1000 });
    globalThis.localStorage.setItem(KEY, stale);
    expect(hasPendingAgentPrompt("/proj")).toBe(false);
    // The stale entry was removed on read.
    expect(globalThis.localStorage.getItem(KEY)).toBeNull();
    globalThis.localStorage.setItem(KEY, stale);
    expect(consumePendingAgentPrompt("/proj")).toBeNull();
    expect(globalThis.localStorage.getItem(KEY)).toBeNull();
  });

  test("an entry younger than 15 min is still fresh", () => {
    globalThis.localStorage.setItem(
      KEY,
      JSON.stringify({ prompt: "recent", ts: Date.now() - 14 * 60 * 1000 }),
    );
    expect(hasPendingAgentPrompt("/proj")).toBe(true);
    expect(consumePendingAgentPrompt("/proj")).toBe("recent");
  });

  test("malformed entries are dropped", () => {
    globalThis.localStorage.setItem(KEY, "{not json");
    expect(hasPendingAgentPrompt("/proj")).toBe(false);
    expect(consumePendingAgentPrompt("/proj")).toBeNull();
    globalThis.localStorage.setItem(KEY, JSON.stringify({ prompt: 42, ts: "later" }));
    expect(hasPendingAgentPrompt("/proj")).toBe(false);
    // The bad-shape entry was removed on read.
    expect(globalThis.localStorage.getItem(KEY)).toBeNull();
  });

  test("storage failures are swallowed", () => {
    const boom = () => {
      throw new Error("nope");
    };
    swapStorage({ getItem: boom, removeItem: boom, setItem: boom });
    expect(() => {
      setPendingAgentPrompt("/proj", "x");
    }).not.toThrow();
    expect(hasPendingAgentPrompt("/proj")).toBe(false);
    expect(consumePendingAgentPrompt("/proj")).toBeNull();
    // A removeItem-only failure still returns the prompt from consume.
    swapStorage({
      getItem: (k: string) => realLocalStorage.getItem(k),
      removeItem: boom,
      setItem: (k: string, v: string) => {
        realLocalStorage.setItem(k, v);
      },
    });
    setPendingAgentPrompt("/proj", "sticky");
    expect(consumePendingAgentPrompt("/proj")).toBe("sticky");
  });
});
