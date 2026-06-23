/**
 * Tests for src/version.ts — build-time metadata constants.
 *
 * Under `bun test` the build-time `define` substitutions are absent, so the `typeof` guards resolve
 * to the documented fallbacks. This verifies that safety net plus the static fields.
 */
import { describe, expect, test } from "bun:test";
import { APP_NAME, BUILD_DATE, GIT_COMMIT, LINKS, VERSION } from "../src/version";

describe("version constants", () => {
  test("app name is Jx Studio", () => {
    expect(APP_NAME).toBe("Jx Studio");
  });

  test("falls back to safe defaults when build-time defines are absent", () => {
    expect(VERSION).toBe("dev");
    expect(BUILD_DATE).toBe("");
    expect(GIT_COMMIT).toBe("unknown");
  });

  test("exposes https external links", () => {
    expect(LINKS.github).toMatch(/^https:\/\//);
    expect(LINKS.docs).toMatch(/^https:\/\//);
    expect(LINKS.license).toMatch(/^https:\/\//);
  });
});
