/**
 * The app's live region, and the property that made it necessary: posting a notification announces
 * it, whatever host the record lands in.
 */

import "./harness";
import { afterEach, describe, expect, test } from "bun:test";
import { announce, resetAnnouncer } from "../src/services/announce";
import { notify, resetNotifications } from "../src/services/notify";

/** The text a region is holding, after the clear-then-set turn. */
async function spoken(politeness: "assertive" | "polite"): Promise<string> {
  await new Promise((resolve) => {
    setTimeout(resolve, 1);
  });
  return document.querySelector(`#jx-live-${politeness}`)?.textContent ?? "";
}

afterEach(() => {
  resetAnnouncer();
  resetNotifications();
});

describe("announce", () => {
  test("creates a region that assistive technology can actually reach", async () => {
    announce("Saved");
    const node = document.querySelector("#jx-live-polite")!;
    expect(node.getAttribute("aria-live")).toBe("polite");
    expect(node.getAttribute("role")).toBe("status");
    expect(node.getAttribute("aria-atomic")).toBe("true");
    // Not display:none — that removes it from the accessibility tree, announcing nothing.
    expect((node as HTMLElement).style.display).not.toBe("none");
    expect((node as HTMLElement).style.position).toBe("absolute");
    expect(await spoken("polite")).toBe("Saved");
  });

  test("assertive and polite are separate regions", async () => {
    // The attribute is read when the region is created, so one region cannot serve both.
    announce("Save failed", "assertive");
    announce("Saved", "polite");
    expect(await spoken("assertive")).toBe("Save failed");
    expect(await spoken("polite")).toBe("Saved");
    expect(document.querySelector("#jx-live-assertive")?.getAttribute("role")).toBe("alert");
  });

  test("the same message twice is announced twice", async () => {
    /*
     * A live region announces a CHANGE, so writing the same string again is not one. Without the
     * clear-then-set, a second identical failure would be silent — which is the failure a user
     * would be least able to explain.
     */
    announce("Save failed", "assertive");
    expect(await spoken("assertive")).toBe("Save failed");
    const node = document.querySelector("#jx-live-assertive")!;
    announce("Save failed", "assertive");
    expect(node.textContent).toBe("");
    expect(await spoken("assertive")).toBe("Save failed");
  });

  test("an empty message is not posted", async () => {
    announce("");
    expect(document.querySelector("#jx-live-polite")).toBeNull();
  });

  test("only one region per politeness is ever created", () => {
    announce("one");
    announce("two");
    expect(document.querySelectorAll("#jx-live-polite")).toHaveLength(1);
  });
});

describe("notify announces", () => {
  test("a failure interrupts, even though it lands in a panel and not a toast", async () => {
    /*
     * This is the whole point. `error` defaults to the `problem` tier, whose host is the Bottom
     * dock's Problems list — which had no live region, and could not usefully have one, because a
     * region inside a hidden tab announces nothing.
     */
    const record = notify.error("Save failed");
    expect(record.tier).toBe("problem");
    expect(await spoken("assertive")).toBe("Save failed");
  });

  test("a success waits its turn", async () => {
    notify.success("Saved");
    expect(await spoken("polite")).toBe("Saved");
    expect(await spoken("assertive")).toBe("");
  });

  test("the source is spoken, because nothing else groups the message for a listener", async () => {
    notify.error("Pull stopped", { source: "Source Control" });
    expect(await spoken("assertive")).toBe("Source Control: Pull stopped");
  });
});
