/**
 * The one settings-modal path the main suite cannot reach: the swallowed `.catch` around the lazy
 * `extension-sections` import.
 *
 * Contributed settings sections arrive by dynamic import so the settings-modal ↔ extension-sections
 * module cycle stays broken. If that chunk fails, the built-in sections must still render — the
 * failure costs the user their contributed sections, never the whole modal. Making the module
 * factory throw is the only way to reach that handler; nothing else in a test run can fail a local
 * import. Lives in its own file because the mock is process-wide and would poison the other
 * settings suites.
 */
import { flush, installMockPlatform, resetStudioState } from "./harness";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { initLayers } from "../src/ui/layers";

for (const id of ["layer-popover", "layer-modal", "layer-dialog"]) {
  if (!document.querySelector(`#${id}`)) {
    const el = document.createElement("div");
    el.id = id;
    document.body.append(el);
  }
}
initLayers();

globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
  setTimeout(() => cb(0), 0);
  return 0;
}) as typeof requestAnimationFrame;

void mock.module("../src/settings/extension-sections", () => {
  throw new Error("extension-sections chunk unavailable");
});

const { closeSettingsModal, openSettingsModal } = await import("../src/settings/settings-modal");

describe("settings modal when the contributed-sections chunk fails to load", () => {
  beforeEach(() => {
    resetStudioState();
    installMockPlatform();
    closeSettingsModal();
  });

  test("the built-in sections still render and the modal stays usable", async () => {
    openSettingsModal();
    await flush(2);

    const modal = document.querySelector("#layer-modal");
    expect(modal?.textContent).toContain("Settings");
    // General is a built-in, so it must survive a contributed-section failure.
    expect(modal?.textContent).toContain("General");

    closeSettingsModal();
    expect(document.querySelector("#layer-modal")?.textContent?.trim()).toBe("");
  });
});
