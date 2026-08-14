import { afterEach, describe, expect, test } from "bun:test";
import { isClockPinned, now, pinClock, unpinClock } from "../src/services/clock";

afterEach(() => {
  unpinClock();
});

describe("clock", () => {
  test("follows the wall clock until pinned", () => {
    expect(isClockPinned()).toBe(false);
    const before = Date.now();
    const reading = now();
    expect(reading).toBeGreaterThanOrEqual(before);
    expect(reading).toBeLessThanOrEqual(Date.now());
  });

  test("a pinned clock is frozen, not merely offset", () => {
    const at = pinClock("2026-01-15T09:30:00Z");
    expect(at).toBe(Date.parse("2026-01-15T09:30:00Z"));
    expect(isClockPinned()).toBe(true);
    const first = now();
    const second = now();
    expect(first).toBe(at);
    // The whole point: the tenth read answers what the first did.
    expect(second).toBe(first);
  });

  test("accepts epoch milliseconds and a Date", () => {
    expect(pinClock(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(now()).toBe(1_700_000_000_000);
    const d = new Date("2020-06-01T00:00:00Z");
    expect(pinClock(d)).toBe(d.getTime());
    expect(now()).toBe(d.getTime());
  });

  test("refuses an unreadable instant rather than silently keeping the wall clock", () => {
    expect(() => pinClock("half past tuesday")).toThrow(TypeError);
    expect(() => pinClock(Number.NaN)).toThrow(/cannot pin/);
    expect(isClockPinned()).toBe(false);
  });

  test("unpinning releases it", () => {
    pinClock(1000);
    expect(now()).toBe(1000);
    unpinClock();
    expect(isClockPinned()).toBe(false);
    expect(now()).toBeGreaterThan(1000);
  });
});
