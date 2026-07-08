import { describe, expect, test } from "bun:test";
import { colorForKey, PRESENCE_PALETTE } from "../src/awareness-types.ts";

describe("colorForKey", () => {
  test("is deterministic", () => {
    expect(colorForKey("octocat")).toBe(colorForKey("octocat"));
  });

  test("always returns a palette color", () => {
    const palette: readonly string[] = PRESENCE_PALETTE;
    for (const key of ["a", "octocat", "kevin", "žžž", "", "user-42"]) {
      expect(palette).toContain(colorForKey(key));
    }
  });

  test("spreads across the palette", () => {
    const colors = new Set(Array.from({ length: 64 }, (_, i) => colorForKey(`user-${i}`)));
    expect(colors.size).toBeGreaterThan(3);
  });
});
