/**
 * The four relative-time formatters, read through the clock seam.
 *
 * Each of these called `Date.now()` inline, which meant the interesting branches — "yesterday",
 * "over a year ago", the locale-date fallback — could only be asserted as an offset from the real
 * present, and two reads seconds apart could legitimately disagree. Pinning the clock makes them
 * ordinary pure functions with a stated input.
 */
import "./with-dom.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { pinClock, unpinClock } from "../src/services/clock";
import { relativeDate } from "../src/panels/git-panel";
import { lastOpenedLabel } from "../src/panels/welcome-screen";
import { relativeTime } from "../src/panels/ai-chat/sessions-view";
import {
  addRecentProject,
  clearRecentProjects,
  getRecentFiles,
  getRecentProjects,
  trackRecentFile,
} from "../src/recent-projects";

const NOW = Date.parse("2026-01-15T09:30:00Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** An ISO instant `ms` before the pinned clock. */
function ago(ms: number): string {
  return new Date(NOW - ms).toISOString();
}

beforeEach(() => {
  localStorage.clear();
  pinClock(NOW);
});

afterEach(() => {
  unpinClock();
  localStorage.clear();
});

describe("git-panel relativeDate", () => {
  test("walks every unit, and falls back to a locale date past a month", () => {
    expect(relativeDate(ago(30_000))).toBe("just now");
    expect(relativeDate(ago(5 * MINUTE))).toBe("5m ago");
    expect(relativeDate(ago(59 * MINUTE))).toBe("59m ago");
    expect(relativeDate(ago(3 * HOUR))).toBe("3h ago");
    expect(relativeDate(ago(23 * HOUR))).toBe("23h ago");
    expect(relativeDate(ago(4 * DAY))).toBe("4d ago");
    expect(relativeDate(ago(29 * DAY))).toBe("29d ago");

    const old = ago(400 * DAY);
    expect(relativeDate(old)).toBe(new Date(old).toLocaleDateString());
  });

  test("a commit dated in the future reads as just now, not as a negative age", () => {
    expect(relativeDate(new Date(NOW + HOUR).toISOString())).toBe("just now");
  });

  test("the same commit reads the same on every call while the clock is pinned", () => {
    const iso = ago(2 * MINUTE);
    expect(relativeDate(iso)).toBe("2m ago");
    expect(relativeDate(iso)).toBe("2m ago");
  });
});

describe("welcome-screen lastOpenedLabel", () => {
  test("defaults to the pinned clock rather than the wall clock", () => {
    expect(lastOpenedLabel(NOW - 30_000)).toBe("just now");
    expect(lastOpenedLabel(NOW - 2 * MINUTE)).toBe("2 minutes ago");
    expect(lastOpenedLabel(NOW - DAY)).toBe("yesterday");
    expect(lastOpenedLabel(NOW - 400 * DAY)).toBe("over a year ago");
  });
});

describe("sessions-view relativeTime", () => {
  test("defaults to the pinned clock rather than the wall clock", () => {
    expect(relativeTime(NOW - 30_000)).toBe("just now");
    expect(relativeTime(NOW - 3 * HOUR)).toBe("3h ago");
    expect(relativeTime(NOW - DAY - HOUR)).toBe("yesterday");
  });
});

describe("recent projects and files stamp the clock", () => {
  test("a recent project's timestamp is the pinned instant, so 'last opened' is honest", () => {
    clearRecentProjects();
    addRecentProject("Showcase", "/tmp/showcase");
    const [entry] = getRecentProjects();
    expect(entry!.timestamp).toBe(NOW);
    // The pair that matters: what was written is what the formatter reads back.
    expect(lastOpenedLabel(entry!.timestamp)).toBe("just now");
  });

  test("a recent file's timestamp is the pinned instant", () => {
    trackRecentFile({ name: "index.md", path: "pages/index.md", root: "/tmp/showcase" });
    const [file] = getRecentFiles("/tmp/showcase");
    expect(file!.timestamp).toBe(NOW);
  });
});
