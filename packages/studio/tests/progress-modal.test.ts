/** Tests for src/ui/progress-modal.ts — the blocking package-operation progress modal. */
import { flush, pointer } from "./harness";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { initLayers } from "../src/ui/layers";
import { showProgressModal } from "../src/ui/progress-modal";

beforeAll(() => {
  for (const id of ["layer-popover", "layer-modal", "layer-dialog"]) {
    if (!document.querySelector(`#${id}`)) {
      const el = document.createElement("div");
      el.id = id;
      document.body.append(el);
    }
  }
  initLayers();
});

function modalLayer(): HTMLElement {
  return document.querySelector("#layer-modal") as HTMLElement;
}

function card(): Element | null {
  return modalLayer().querySelector(".progress-modal");
}

afterEach(() => {
  modalLayer().innerHTML = "";
});

describe("showProgressModal", () => {
  test("renders a running view with spinner, title and status", async () => {
    const h = showProgressModal({ status: "Running…", title: "Installing" });
    await flush();
    expect(card()).not.toBeNull();
    expect(card()?.querySelector("sp-progress-circle")).not.toBeNull();
    expect(card()?.textContent).toContain("Installing");
    expect(card()?.textContent).toContain("Running…");
    h.done();
  });

  test("setStatus updates the status line", async () => {
    const h = showProgressModal({ title: "Installing" });
    await flush();
    h.setStatus("Linking…");
    await flush();
    expect(card()?.textContent).toContain("Linking…");
    h.done();
  });

  test("done() removes the modal", async () => {
    const h = showProgressModal({ title: "Installing" });
    await flush();
    h.done();
    expect(card()).toBeNull();
  });

  test("fail() shows the error log and Close dismisses it", async () => {
    const h = showProgressModal({ title: "Installing" });
    await flush();
    h.fail("boom log");
    await flush();
    expect(card()?.textContent).toContain("failed");
    expect(card()?.textContent).toContain("boom log");
    const btn = card()?.querySelector("sp-button") as HTMLElement;
    pointer(btn, "click");
    expect(card()).toBeNull();
  });

  test("setStatus/fail after done are no-ops", async () => {
    const h = showProgressModal({ title: "Installing" });
    await flush();
    h.done();
    h.setStatus("late");
    h.fail("late");
    expect(card()).toBeNull();
  });
});
