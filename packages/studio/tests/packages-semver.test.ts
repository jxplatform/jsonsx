/** Tests for src/packages/semver.ts — the minimal version-comparison helpers. */
import { describe, expect, test } from "bun:test";
import { compareSemver, isComparable, isUpgrade, stripRange } from "../src/packages/semver";

describe("stripRange", () => {
  test("strips caret/tilde/comparators and bare versions", () => {
    expect(stripRange("^0.19.0")).toBe("0.19.0");
    expect(stripRange("~1.2.3")).toBe("1.2.3");
    expect(stripRange(">=2.0.0")).toBe("2.0.0");
    expect(stripRange("v3.1.0")).toBe("3.1.0");
    expect(stripRange("1.0.0")).toBe("1.0.0");
  });
});

describe("isComparable", () => {
  test("accepts plain semver ranges, rejects non-registry specs", () => {
    expect(isComparable("^1.2.3")).toBe(true);
    expect(isComparable("0.30.1")).toBe(true);
    expect(isComparable("workspace:^")).toBe(false);
    expect(isComparable("file:../x")).toBe(false);
    expect(isComparable("dev")).toBe(false);
    expect(isComparable("*")).toBe(false);
    expect(isComparable("latest")).toBe(false);
  });
});

describe("compareSemver", () => {
  test("orders by major, minor, then patch", () => {
    expect(compareSemver("1.0.0", "2.0.0")).toBe(-1);
    expect(compareSemver("0.30.1", "0.19.0")).toBe(1);
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
    expect(compareSemver("^1.2.4", "~1.2.3")).toBe(1);
    expect(compareSemver("1.2.0", "1.10.0")).toBe(-1);
  });

  test("ignores pre-release / build metadata", () => {
    expect(compareSemver("1.2.3-beta.1", "1.2.3")).toBe(0);
    expect(compareSemver("1.2.3+build", "1.2.3")).toBe(0);
  });
});

describe("isUpgrade", () => {
  test("true only when latest is strictly newer and both comparable", () => {
    expect(isUpgrade("^0.19.0", "0.30.1")).toBe(true);
    expect(isUpgrade("^0.30.1", "0.30.1")).toBe(false);
    expect(isUpgrade("^0.31.0", "0.30.1")).toBe(false);
    expect(isUpgrade("workspace:^", "0.30.1")).toBe(false);
    expect(isUpgrade("^1.0.0", "dev")).toBe(false);
  });
});
