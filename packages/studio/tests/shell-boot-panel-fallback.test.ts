/**
 * Boot-time Navigator-panel fallback (src/shell.ts).
 *
 * The other half of shell-boot-panel-migration: a stored id that names nothing — junk, a panel a
 * newer build introduced and this one does not have, a hand-edited localStorage — must not reach
 * `shell.leftTab`, because the Navigator would then render its "no panel is registered as…" state
 * on every cold start with no way for the user to know what to do about it.
 */
import "./with-dom.js";
import { describe, expect, test } from "bun:test";

localStorage.setItem(
  "jx-studio-panel-widths",
  JSON.stringify({ leftTab: "a-panel-from-the-future" }),
);

const { DEFAULT_PANEL_ID, shell } = await import("../src/shell");

describe("shell boot — an unrecognised panel id", () => {
  test("falls back to the default panel", () => {
    expect(shell.leftTab).toBe(DEFAULT_PANEL_ID);
  });
});
