/**
 * Boot-time Navigator-panel migration (src/shell.ts).
 *
 * Third of the boot trio, beside shell-boot-default and shell-boot-restore: the record is built at
 * IMPORT time, so the persisted state is staged before the module loads.
 *
 * The rename `blocks → insert` is the case that matters. A stored panel id outlives the build that
 * wrote it, so the only two honest outcomes for one are "translated" or "replaced by the default" —
 * and the failure mode without a migration is not an error, it is a Navigator that silently comes
 * up on a different panel than the one you left it on, once, with no way to tell why.
 */
import "./with-dom.js";
import { describe, expect, test } from "bun:test";

localStorage.setItem(
  "jx-studio-panel-widths",
  JSON.stringify({ leftTab: "blocks", left: 300, leftCollapsed: false }),
);

const { DEFAULT_PANEL_ID, NAVIGATOR_PANEL_IDS, shell } = await import("../src/shell");

describe("shell boot — the persisted panel id", () => {
  test("a renamed id is translated once, on read", () => {
    expect(shell.leftTab).toBe("insert");
  });

  test("what it woke up on is a declared panel", () => {
    expect([...NAVIGATOR_PANEL_IDS] as string[]).toContain(shell.leftTab);
  });

  test("the old id is not silently kept alive as an alias", () => {
    expect([...NAVIGATOR_PANEL_IDS]).not.toContain("blocks");
    expect(DEFAULT_PANEL_ID).toBe("layers");
  });
});
