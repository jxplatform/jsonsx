/**
 * The settings kernel's FIRST FRAME — its own test file because the property only exists once.
 *
 * The kernel seeds itself from the localStorage cache at module evaluation, so a value is readable
 * synchronously before the backend has answered. That is not a convenience: `shell.ts` reads the
 * chrome theme before the first paint, and its docblock records that a mismatch with the theme
 * `index.html` hard-codes flashes the shell.
 *
 * Proving it needs storage populated BEFORE the module is imported, which is possible exactly once
 * per module registry — so this file imports the kernel dynamically and does nothing else. Every
 * other kernel test runs against an already-seeded module and cannot see this.
 */
import "./with-dom.js";
import { describe, expect, test } from "bun:test";

localStorage.setItem("jx.ai.model", "seeded-before-import");
localStorage.setItem("jx.ai.openaiKey", "sk-seeded");
localStorage.setItem("jx-studio-theme", "light");

const { SETTINGS } = await import("../src/services/settings/definitions");
const { hasSetting, readStoredSetting } = await import("../src/services/settings/kernel");

describe("boot", () => {
  test("values already in the cache are readable synchronously, with no hydration", () => {
    expect(readStoredSetting(SETTINGS.aiModel)).toBe("seeded-before-import");
    expect(readStoredSetting(SETTINGS.theme)).toBe("light");
    expect(hasSetting(SETTINGS.aiOpenAiKey)).toBe(true);
  });

  test("a key absent from the cache reads as unset rather than as its default", () => {
    expect(readStoredSetting(SETTINGS.aiBaseUrl)).toBe("");
    expect(hasSetting(SETTINGS.cfToken)).toBe(false);
  });
});
