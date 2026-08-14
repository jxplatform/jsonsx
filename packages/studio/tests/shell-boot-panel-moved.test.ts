/**
 * Boot with a panel id that MOVED DOCKS (src/shell.ts).
 *
 * The fourth boot case, and a different failure from `shell-boot-panel-migration`'s rename. §7.2
 * settled Problems into the Bottom dock, so `"problems"` is no longer a Navigator panel under any
 * name — there is nothing to alias it to. A build from before that correction can still have
 * written `leftTab: "problems"` to this machine, and the only honest outcome is the default panel:
 * the Navigator cannot show a Bottom dock tab, and a Navigator that comes up empty saying "no panel
 * is registered as problems" is the wedge {@link migratePanelId} exists to prevent.
 *
 * The Bottom dock is unaffected — its own `bottomTab` already defaults to Problems — so the list
 * the user was looking at is one ⌘4 away, not gone.
 */
import "./with-dom.js";
import { describe, expect, test } from "bun:test";

localStorage.setItem(
  "jx-studio-panel-widths",
  JSON.stringify({ leftTab: "problems", left: 300, leftCollapsed: false }),
);

const { DEFAULT_BOTTOM_TAB, DEFAULT_PANEL_ID, migratePanelId, NAVIGATOR_PANEL_IDS, shell } =
  await import("../src/shell");

describe("shell boot — a panel id that changed docks", () => {
  test("the Navigator wakes on the default rather than on a panel it cannot host", () => {
    expect(shell.leftTab).toBe(DEFAULT_PANEL_ID);
  });

  test("it migrates to nothing — there is no Navigator name for it to become", () => {
    expect(migratePanelId("problems")).toBeNull();
    expect([...NAVIGATOR_PANEL_IDS] as string[]).not.toContain("problems");
  });

  test("and the list itself is still one chord away, in the dock that now hosts it", () => {
    expect(DEFAULT_BOTTOM_TAB).toBe("problems");
    expect(shell.bottomTab).toBe("problems");
  });
});
