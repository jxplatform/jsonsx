/**
 * `services/notify.ts` — the notification record and its two stores.
 *
 * What these assert is the CONTRACT the two hosts render from: which tier a severity lands in, what
 * a `key` does to a repeat, that a toast stack is bounded, and that the `problems` array is the
 * shape the Bottom dock was promised.
 */
import "./harness";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  clearProblems,
  dismiss,
  MAX_TOASTS,
  notify,
  problemCount,
  problems,
  resetNotifications,
  SEVERITIES,
  TIERS,
  toasts,
  TOAST_LIFETIME_MS,
} from "../src/services/notify";
import { pinClock, unpinClock } from "../src/services/clock";

beforeEach(() => {
  resetNotifications();
});

afterEach(() => {
  resetNotifications();
  unpinClock();
});

describe("tier selection", () => {
  test("a failure lands in Problems and stays there", () => {
    notify.error("Could not save.");
    expect(problems).toHaveLength(1);
    expect(toasts).toHaveLength(0);
    expect(problems[0]!.tier).toBe("problem");
  });

  test("success, info and warn are toasts — reversible or needing no action", () => {
    notify.success("Copied");
    notify.info("Syncing…");
    notify.warn("No save target");
    expect(toasts.map((t) => t.severity)).toEqual(["success", "info", "warn"]);
    expect(problems).toHaveLength(0);
  });

  test("an explicit tier overrides the severity default — a warning that must be fixed", () => {
    notify.warn("Required cells are empty", { tier: "problem" });
    expect(problems).toHaveLength(1);
    expect(problems[0]!.severity).toBe("warn");
  });

  test("the declared tiers are exactly the two that have a host", () => {
    expect([...TIERS]).toEqual(["toast", "problem"]);
    expect([...SEVERITIES]).toEqual(["success", "info", "warn", "error"]);
  });
});

describe("the record", () => {
  test("carries the recovery command id, its args, the detail, the source and the path", () => {
    const record = notify.error("Could not save index.json.", {
      action: "file.save",
      actionArgs: { force: true },
      detail: "EACCES",
      path: "pages/index.json",
      source: "Save",
    });
    expect(record).toMatchObject({
      action: "file.save",
      actionArgs: { force: true },
      detail: "EACCES",
      message: "Could not save index.json.",
      path: "pages/index.json",
      severity: "error",
      source: "Save",
      tier: "problem",
    });
  });

  test("a toast carries a lifetime; a problem carries none", () => {
    const toast = notify.success("Copied");
    expect(toast.timeoutMs).toBe(TOAST_LIFETIME_MS.success);
    expect(notify.warn("Slow").timeoutMs).toBe(TOAST_LIFETIME_MS.warn);
    expect(notify.error("Broken").timeoutMs).toBeUndefined();
  });

  test("an explicit timeout wins, and 0 means hold until dismissed", () => {
    expect(notify.info("Held", { timeoutMs: 0 }).timeoutMs).toBe(0);
    expect(notify.info("Brief", { timeoutMs: 25 }).timeoutMs).toBe(25);
  });

  test("`at` reads the clock seam, so a pinned clock pins the row's timestamp", () => {
    pinClock("2026-01-15T09:30:00Z");
    expect(notify.success("Saved").at).toBe(Date.parse("2026-01-15T09:30:00Z"));
  });

  test("ids are unique, which is what a lit repeat key needs", () => {
    const ids = [notify.info("a").id, notify.info("b").id, notify.error("c").id];
    expect(new Set(ids).size).toBe(3);
  });
});

describe("keys", () => {
  test("a repeat with the same key replaces the first rather than stacking", () => {
    notify.error("Render failed (gen 1)", { key: "canvas.render" });
    notify.error("Render failed (gen 2)", { key: "canvas.render" });
    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toBe("Render failed (gen 2)");
  });

  test("keys are per store: the same key in each tier keeps both", () => {
    notify.info("Cloning…", { key: "git.clone" });
    notify.error("Clone failed", { key: "git.clone" });
    expect(toasts).toHaveLength(1);
    expect(problems).toHaveLength(1);
  });

  test("unkeyed notifications never replace each other", () => {
    notify.error("one");
    notify.error("two");
    expect(problems).toHaveLength(2);
  });
});

describe("the stores", () => {
  test("the toast stack is bounded — the oldest retires to make room", () => {
    for (let i = 0; i < MAX_TOASTS + 2; i++) {
      notify.info(`msg ${i}`);
    }
    expect(toasts).toHaveLength(MAX_TOASTS);
    expect(toasts[0]!.message).toBe("msg 2");
  });

  test("Problems are unbounded — a list of things to fix does not evict", () => {
    for (let i = 0; i < MAX_TOASTS + 5; i++) {
      notify.error(`broken ${i}`);
    }
    expect(problems).toHaveLength(MAX_TOASTS + 5);
  });

  test("dismiss takes a record off whichever list holds it", () => {
    const toast = notify.success("Copied");
    const problem = notify.error("Broken");
    expect(dismiss(toast.id)).toBe(true);
    expect(dismiss(problem.id)).toBe(true);
    expect(dismiss("nope")).toBe(false);
    expect(toasts).toHaveLength(0);
    expect(problems).toHaveLength(0);
  });

  test("clearProblems with a predicate drops only what the fixer fixed", () => {
    notify.error("a", { source: "Save" });
    notify.error("b", { source: "Save" });
    notify.error("c", { source: "Canvas" });
    expect(clearProblems((p) => p.source === "Save")).toBe(2);
    expect(problems.map((p) => p.message)).toEqual(["c"]);
    expect(clearProblems()).toBe(1);
    expect(problems).toHaveLength(0);
  });

  test("problemCount counts all, or one severity — the rail badge and the status bar", () => {
    notify.error("a");
    notify.warn("b", { tier: "problem" });
    expect(problemCount()).toBe(2);
    expect(problemCount("error")).toBe(1);
    expect(problemCount("warn")).toBe(1);
    expect(problemCount("success")).toBe(0);
  });

  test("resetNotifications empties both", () => {
    notify.success("a");
    notify.error("b");
    resetNotifications();
    expect(toasts).toHaveLength(0);
    expect(problems).toHaveLength(0);
  });
});

describe("notify() directly", () => {
  test("takes the severity as its first argument, as §7.1 spells it", () => {
    const record = notify("warn", "Careful", { source: "Preview" });
    expect(record.severity).toBe("warn");
    expect(record.source).toBe("Preview");
    expect(toasts).toHaveLength(1);
  });
});
