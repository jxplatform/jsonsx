/**
 * Tests for src/services/settings/definitions.ts — the settings registry.
 *
 * The key table is asserted LITERALLY. These strings are what is already on disk in every installed
 * copy of Studio, so renaming one silently orphans a user's stored value; the point of writing them
 * out is that a rename has to change this file too, in the same commit, where a reviewer sees it
 * beside the migration it needs.
 */
import { describe, expect, test } from "bun:test";
import { ALL_SETTINGS, SETTINGS, USER_SETTING_KEYS } from "../src/services/settings/definitions";

describe("the key table", () => {
  test("names exactly the keys already on disk", () => {
    expect(Object.fromEntries(ALL_SETTINGS.map((d) => [d.key, d.default]))).toEqual({
      "jx-studio-theme": "",
      "jx.ai.baseUrl": "",
      "jx.ai.model": "gpt-4o",
      "jx.ai.openaiKey": "",
      "jx.cf.accountId": "",
      "jx.cf.token": "",
      "jx.files.showIgnored": "",
      "jx.keybindings": "",
    });
  });

  test("every key is unique", () => {
    const keys = ALL_SETTINGS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("derivation", () => {
  /** The list this replaced was hand-maintained beside the table, and fell behind it. */
  test("USER_SETTING_KEYS is derived from the scope, not restated", () => {
    expect(USER_SETTING_KEYS).toEqual(
      ALL_SETTINGS.filter((d) => d.scope === "user").map((d) => d.key),
    );
  });
});

describe("invariants", () => {
  /** A secret that did not roam would be re-entered per window, which is not a secret store. */
  test("every secret is user-scoped", () => {
    for (const definition of ALL_SETTINGS.filter((d) => d.secret)) {
      expect(definition.scope).toBe("user");
    }
  });

  /**
   * A credential's default can only ever be "no credential". A non-empty one would make
   * `hasSetting` true for a user who has configured nothing.
   */
  test("no secret declares a default", () => {
    for (const definition of ALL_SETTINGS.filter((d) => d.secret)) {
      expect(definition.default).toBe("");
    }
  });

  test("normalize is idempotent", () => {
    const samples = ["", "  ", "sk-abc", "https://example.test/v1", "https://example.test/v1///"];
    for (const definition of ALL_SETTINGS) {
      const { normalize } = definition;
      if (!normalize) {
        continue;
      }
      for (const sample of samples) {
        expect(normalize(normalize(sample))).toBe(normalize(sample));
      }
    }
  });

  test("the base URL normalizer trims and drops trailing slashes", () => {
    const { normalize } = SETTINGS.aiBaseUrl;
    expect(normalize("  https://example.test/v1///  ")).toBe("https://example.test/v1");
    expect(normalize("http://localhost:11434/v1")).toBe("http://localhost:11434/v1");
  });
});
