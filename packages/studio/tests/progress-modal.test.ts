/**
 * The one blocking progress surface (`ui/progress-modal.ts`).
 *
 * What is worth pinning is what §7.3 changed: the modal is no longer the operation's only memory
 * (every one of them leaves an Activity entry behind), it is no longer inescapable (`Run in the
 * background` and Escape both hand the app back while the work continues), and it no longer owns
 * the error view — a failure is a Problem, with the captured log as its detail.
 */
import { flush, pointer } from "./harness";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { initLayers } from "../src/ui/layers";
import { showProgressModal } from "../src/ui/progress-modal";
import { activities, resetActivities } from "../src/panels/activity-panel";
import { problems, resetNotifications } from "../src/services/notify";
import { shell } from "../src/shell";

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

/** Press Escape inside the card — the layer wrapper, not the body, decides what happens. */
function escape(): void {
  card()?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
}

function buttonLabelled(label: string): HTMLElement | undefined {
  return [...(card()?.querySelectorAll("sp-button") ?? [])].find((el) =>
    el.textContent?.includes(label),
  ) as HTMLElement | undefined;
}

afterEach(() => {
  modalLayer().innerHTML = "";
  resetActivities();
  resetNotifications();
  shell.docks.bottom.collapsed = true;
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

  test("the operation is recorded in Activity, blocking or not", async () => {
    const h = showProgressModal({ source: "Packages", status: "Running…", title: "Installing" });
    await flush();
    expect(activities).toHaveLength(1);
    expect(activities[0]?.title).toBe("Installing");
    expect(activities[0]?.source).toBe("Packages");
    expect(activities[0]?.state).toBe("running");
    h.done();
    // The entry OUTLIVES the modal — that is the whole point of promoting it out of here.
    expect(card()).toBeNull();
    expect(activities[0]?.state).toBe("done");
  });

  test("setStatus updates the status line and the entry together", async () => {
    const h = showProgressModal({ title: "Installing" });
    await flush();
    h.setStatus("Linking…");
    await flush();
    expect(card()?.textContent).toContain("Linking…");
    expect(activities[0]?.status).toBe("Linking…");
    h.done();
  });

  test("log() goes to the entry, not to the modal", async () => {
    const h = showProgressModal({ title: "Installing" });
    await flush();
    h.log("resolving 40 packages");
    expect(activities[0]?.log).toEqual(["resolving 40 packages"]);
    expect(card()?.textContent).not.toContain("resolving 40 packages");
    h.done();
  });

  test("done() removes the modal", async () => {
    const h = showProgressModal({ title: "Installing" });
    await flush();
    h.done();
    expect(card()).toBeNull();
  });

  test("Run in the background keeps the work and shows it where it lives", async () => {
    const h = showProgressModal({ title: "Installing" });
    await flush();
    pointer(buttonLabelled("Run in the background")!, "click");
    expect(card()).toBeNull();
    expect(activities[0]?.state).toBe("running");
    // "Where it lives" is the Bottom dock's Activity tab, opened by the same setter ⌘J writes.
    expect(shell.bottomTab).toBe("activity");
    expect(shell.docks.bottom.collapsed).toBe(false);
    h.done();
  });

  test("Escape means the same thing the button does — stop blocking, not stop working", async () => {
    const h = showProgressModal({ title: "Installing" });
    await flush();
    escape();
    expect(card()).toBeNull();
    expect(activities[0]?.state).toBe("running");
    h.done();
  });

  test("Cancel appears only when the operation handed one over, and it stops the work", async () => {
    let stopped = 0;
    const plain = showProgressModal({ title: "Installing" });
    await flush();
    expect(buttonLabelled("Cancel")).toBeUndefined();
    plain.done();

    showProgressModal({
      cancel: () => {
        stopped += 1;
      },
      title: "Installing",
    });
    await flush();
    pointer(buttonLabelled("Cancel")!, "click");
    expect(stopped).toBe(1);
    expect(card()).toBeNull();
  });

  test("a one-line failure is its own headline in Problems", async () => {
    const h = showProgressModal({ source: "Packages", title: "Installing" });
    await flush();
    h.fail("EACCES denied");
    await flush();
    expect(card()).toBeNull();
    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toBe("EACCES denied");
    expect(problems[0]?.source).toBe("Packages");
  });

  test("a captured log becomes the detail, under a headline that names the operation", async () => {
    const h = showProgressModal({ title: "Installing" });
    await flush();
    h.fail("error: no matching version\n  at bun install\n  giving up");
    await flush();
    // Three of the four call sites pass `result.log` as their message. A Problems list whose first
    // Row is 400 lines of `bun` output is not a list.
    expect(problems[0]?.message).toBe("Installing failed");
    expect(problems[0]?.detail).toContain("no matching version");
    expect(activities[0]?.state).toBe("failed");
  });

  test("an empty failure still says something", async () => {
    const h = showProgressModal({ title: "Installing" });
    await flush();
    h.fail("");
    expect(problems[0]?.message).toBe("Installing failed");
  });

  test("setStatus/fail after done are no-ops", async () => {
    const h = showProgressModal({ title: "Installing" });
    await flush();
    h.done();
    h.setStatus("late");
    h.fail("late");
    h.done();
    expect(card()).toBeNull();
    expect(problems).toHaveLength(0);
    expect(activities[0]?.state).toBe("done");
  });
});
