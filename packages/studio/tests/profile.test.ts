import "./with-dom.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  applyProfile,
  applyStartupProfile,
  clearStudioStorage,
  DEFAULT_PROFILE_ID,
  isStudioStorageKey,
  resetStartupProfile,
  STARTUP_PROFILES,
  startupState,
} from "../src/services/profile";
import { isClockPinned, now, unpinClock } from "../src/services/clock";

beforeEach(() => {
  localStorage.clear();
  resetStartupProfile();
  unpinClock();
});

afterEach(() => {
  localStorage.clear();
  resetStartupProfile();
  unpinClock();
});

describe("owned keys", () => {
  test("claims every separator Studio actually writes", () => {
    for (const key of [
      "jx-studio-panel-widths",
      "jx-studio-recent-projects",
      "jx-canvas-debug",
      "jx-ai-chat-sessions:/tmp/site",
      "jx.ai.model",
      "jx.cf.token",
      "jx_github_token",
      "jx:jxsuite-update-dismissed:/tmp/site:0.9.0",
    ]) {
      expect(isStudioStorageKey(key)).toBe(true);
    }
  });

  test("does not claim a neighbour's keys on the same origin", () => {
    for (const key of ["theme", "jxtra-cool", "docs:last-page", "sentry-session"]) {
      expect(isStudioStorageKey(key)).toBe(false);
    }
  });
});

describe("clearStudioStorage", () => {
  test("removes Studio's keys and reports them, leaving everything else", () => {
    localStorage.setItem("jx-studio-panel-widths", "{}");
    localStorage.setItem("jx.ai.model", "gpt");
    localStorage.setItem("theme", "dark");

    const removed = clearStudioStorage();

    expect(removed.toSorted()).toEqual(["jx-studio-panel-widths", "jx.ai.model"]);
    expect(localStorage.getItem("jx-studio-panel-widths")).toBeNull();
    expect(localStorage.getItem("theme")).toBe("dark");
  });
});

describe("applyProfile", () => {
  test("default keeps persisted state", () => {
    localStorage.setItem("jx-studio-panel-widths", "{}");
    expect(applyProfile("default")).toBe(STARTUP_PROFILES.default!);
    expect(localStorage.getItem("jx-studio-panel-widths")).toBe("{}");
  });

  test("fresh is a first-run app", () => {
    localStorage.setItem("jx-studio-recent-projects", "[]");
    expect(applyProfile("fresh").reset).toBe("app-state");
    expect(localStorage.getItem("jx-studio-recent-projects")).toBeNull();
  });

  test("an unknown id throws naming the declared ones, rather than falling back", () => {
    expect(() => applyProfile("freshh")).toThrow(RangeError);
    expect(() => applyProfile("freshh")).toThrow(/default, fresh/);
  });
});

describe("applyStartupProfile", () => {
  test("no query is the default profile and an unpinned clock", () => {
    const state = applyStartupProfile("");
    expect(state.profile.id).toBe(DEFAULT_PROFILE_ID);
    expect(state.clock).toBeNull();
    expect(isClockPinned()).toBe(false);
  });

  test("?profile=fresh clears Studio's persisted state", () => {
    localStorage.setItem("jx-studio-panel-widths", '{"left":400}');
    const state = applyStartupProfile("?profile=fresh");
    expect(state.profile.id).toBe("fresh");
    expect(localStorage.getItem("jx-studio-panel-widths")).toBeNull();
  });

  test("?clock= pins the clock alongside the profile", () => {
    const state = applyStartupProfile("?profile=fresh&clock=2026-01-15T09:30:00Z");
    expect(state.clock).toBe(Date.parse("2026-01-15T09:30:00Z"));
    expect(now()).toBe(Date.parse("2026-01-15T09:30:00Z"));
  });

  test("is idempotent, so a second importer cannot re-clear live state", () => {
    const first = applyStartupProfile("?profile=fresh");
    localStorage.setItem("jx-studio-panel-widths", '{"left":400}');
    const second = applyStartupProfile("?profile=fresh");
    expect(second).toBe(first);
    expect(localStorage.getItem("jx-studio-panel-widths")).toBe('{"left":400}');
  });

  test("startupState reports what the app started as, and nothing before that", () => {
    expect(startupState()).toBeNull();
    applyStartupProfile("?profile=fresh");
    expect(startupState()?.profile.id).toBe("fresh");
  });
});
