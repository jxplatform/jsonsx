/**
 * The toast host — the fourth overlay layer (`ui/layers.ts`).
 *
 * Three things are worth pinning here and nothing else is: that the host is a RENDERING of
 * `notify`'s store (nobody pushes DOM at it), that the recovery button is a projection of a command
 * record, and that the §13.3 clause 6 exception behaves the way it is written down — an
 * automation-gated infinite lifetime, and a settling toast that shows up in the idle account and
 * then stops.
 */
import { flush, mountOverlayLayers } from "./harness";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  initLayers,
  overlayIdleBlockers,
  toastsAreHeld,
  TOAST_ENTER_MS,
  unmountToastHost,
} from "../src/ui/layers";
import { notify, resetNotifications, toasts } from "../src/services/notify";
import { setActiveRegistry } from "../src/commands/active-registry";
import { createCommandRegistry } from "../src/commands/registry";
import { emptyContext, makeContext } from "../src/commands/context";
import { resolveRegion } from "../src/ui/regions";
import type { CommandContext } from "../src/commands/context";

let ctx: CommandContext = emptyContext();
const ran: { id: string; args: unknown }[] = [];

/** A registry with one visible command and one that is visible but refused. */
function buildRegistry() {
  const registry = createCommandRegistry({ getContext: () => ctx });
  registry.register({
    category: "Edit",
    id: "edit.undo",
    keybinding: "mod+z",
    level: "document",
    requires: "something to undo",
    run: (_c, args) => {
      ran.push({ args, id: "edit.undo" });
    },
    title: "Undo",
    when: () => true,
    enablement: (c) => c.document.canUndo,
  });
  return registry;
}

beforeEach(() => {
  document.body.innerHTML = "";
  /* The REAL layers, not four bare divs with the right ids. That fixture could not carry the
     live-region attributes or the region stamp, which is exactly what the first test below is
     about — it used to read them out of index.html's text instead. */
  mountOverlayLayers();
  resetNotifications();
  ran.length = 0;
  ctx = makeContext({ document: { open: true, canUndo: true } });
  setActiveRegistry(buildRegistry());
  initLayers();
});

afterEach(() => {
  unmountToastHost();
  resetNotifications();
  setActiveRegistry(null);
  document.body.innerHTML = "";
});

const host = () => document.querySelector("#layer-toast") as HTMLElement;

// ─── The layer itself ─────────────────────────────────────────────────────────

describe("the fourth layer", () => {
  test("resolves as `overlay.toasts` — a region that exists before anything goes wrong", () => {
    expect(resolveRegion("overlay.toasts")).toBe(host());
  });

  test("carries the live-region attributes on the HOST, not per toast", () => {
    /* Part of the frame rather than stamped when a toast arrives: the layer has to BE a live region
       before the first notification, and a stack of them is announced once rather than once per
       toast. Asserted on the rendered element, not on index.html's text — the frame is
       src/shell/tree.ts now, and the document carries an empty body. */
    const layer = host();
    expect(layer.getAttribute("role")).toBe("status");
    expect(layer.getAttribute("aria-live")).toBe("polite");
  });
});

// ─── Rendering ────────────────────────────────────────────────────────────────

describe("rendering", () => {
  test("a notification paints a toast, severity-classed", async () => {
    notify.success("Copied");
    await flush();
    const toast = host().querySelector(".toast");
    expect(toast?.classList.contains("toast--success")).toBe(true);
    expect(toast?.querySelector(".toast-message")?.textContent).toBe("Copied");
  });

  test("only toasts are rendered — a problem never reaches this layer", async () => {
    notify.error("Could not save.");
    await flush();
    expect(host().querySelectorAll(".toast")).toHaveLength(0);
  });

  test("several toasts stack in arrival order", async () => {
    notify.info("first");
    notify.info("second");
    await flush();
    expect([...host().querySelectorAll(".toast-message")].map((e) => e.textContent)).toEqual([
      "first",
      "second",
    ]);
  });

  test("dismissing removes the record, not just the node", async () => {
    notify.info("Syncing…", { timeoutMs: 0 });
    await flush();
    (host().querySelector(".toast-dismiss") as HTMLElement).click();
    await flush();
    expect(toasts).toHaveLength(0);
    expect(host().querySelectorAll(".toast")).toHaveLength(0);
  });
});

// ─── The recovery button is a command ────────────────────────────────────────

describe("the recovery action", () => {
  test("is labelled with the COMMAND's title, not a bare Retry", async () => {
    notify.warn("Pasted", { action: "edit.undo", timeoutMs: 0 });
    await flush();
    expect(host().querySelector(".toast-action")?.textContent?.trim()).toBe("Undo");
  });

  test("runs the command with the record's args and retires the toast", async () => {
    notify.warn("Pasted", { action: "edit.undo", actionArgs: { steps: 2 }, timeoutMs: 0 });
    await flush();
    (host().querySelector(".toast-action") as HTMLElement).click();
    await flush();
    expect(ran).toEqual([{ args: { steps: 2 }, id: "edit.undo" }]);
    expect(toasts).toHaveLength(0);
  });

  test("is disabled — with the command's own reason — when the command refuses", async () => {
    ctx = makeContext({ document: { open: true, canUndo: false } });
    notify.warn("Pasted", { action: "edit.undo", timeoutMs: 0 });
    await flush();
    const button = host().querySelector(".toast-action") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toContain("something to undo");
  });

  test("an unregistered command id renders no button at all", async () => {
    // This is what lets a call site name a capability that lands next phase without shipping a
    // Dead control in the meantime.
    notify.warn("Attach failed", { action: "collab.share", timeoutMs: 0 });
    await flush();
    expect(host().querySelector(".toast-action")).toBeNull();
  });

  test("no action named — no button", async () => {
    notify.info("Syncing…", { timeoutMs: 0 });
    await flush();
    expect(host().querySelector(".toast-action")).toBeNull();
  });
});

// ─── §13.3 clause 6, the one listed exception ────────────────────────────────

describe("lifetime", () => {
  test("a resting toast retires itself after its own timeout", async () => {
    // 250ms, not 10: the lifetime has to outlast the RENDER, or the toast is created and retired
    // Between the call and the flush and never appears at all — which is how this failed under
    // `--coverage`, on the first assertion, in 78ms. The property under test is that a resting
    // Toast retires itself on a real timer; how short that timer is was never part of it.
    notify.info("brief", { timeoutMs: 250 });
    await flush();
    expect(host().querySelectorAll(".toast")).toHaveLength(1);
    // Polled, not slept. The retirement runs on a REAL timer — that is the property under test —
    // And a fixed wait is a bet on the scheduler that loses whenever the suite runs files
    // Concurrently, which `--coverage` instrumentation stretches further still. The deadline exists
    // Only so a toast that NEVER retires fails instead of hanging; it is not a timing assertion, so
    // It is deliberately far larger than any plausible scheduling delay.
    const deadline = Date.now() + 30_000;
    while (toasts.length > 0 && Date.now() < deadline) {
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
    }
    await flush();
    expect(toasts).toHaveLength(0);
  });

  test("timeoutMs 0 holds until dismissed", async () => {
    notify.info("held", { timeoutMs: 0 });
    await flush();
    await new Promise((resolve) => {
      setTimeout(resolve, 30);
    });
    expect(toasts).toHaveLength(1);
  });

  test("toastsAreHeld is false without ?automation=1", () => {
    expect(toastsAreHeld()).toBe(false);
  });

  test("under ?automation=1 nothing is scheduled — the exception, as written", async () => {
    const held = mock(() => true);
    const search = Object.getOwnPropertyDescriptor(globalThis.location, "search");
    Object.defineProperty(globalThis.location, "search", {
      configurable: true,
      get: () => "?automation=1",
    });
    try {
      expect(toastsAreHeld()).toBe(true);
      notify.info("photographed", { timeoutMs: 5 });
      await flush();
      await new Promise((resolve) => {
        setTimeout(resolve, 40);
      });
      expect(toasts).toHaveLength(1);
    } finally {
      if (search) {
        Object.defineProperty(globalThis.location, "search", search);
      }
      held();
    }
  });

  test("unmounting cancels every pending timer and clears the layer", async () => {
    notify.info("brief", { timeoutMs: 10 });
    await flush();
    unmountToastHost();
    expect(host().querySelectorAll(".toast")).toHaveLength(0);
    expect(overlayIdleBlockers()).toEqual([]);
    // The record survives — the HOST was torn down, not the notification.
    expect(toasts).toHaveLength(1);
  });
});

// ─── The idle account ────────────────────────────────────────────────────────

describe("overlayIdleBlockers", () => {
  test("is empty when nothing is on screen", () => {
    expect(overlayIdleBlockers()).toEqual([]);
  });

  test("names a settling toast, then stops — a RESTING toast is not a blocker", async () => {
    const media = globalThis.matchMedia;
    // Reduced motion would (correctly) mean no settle window at all, so state the other case.
    globalThis.matchMedia = (() => ({ matches: false })) as unknown as typeof globalThis.matchMedia;
    try {
      notify.info("settling", { timeoutMs: 0 });
      await flush();
      expect(overlayIdleBlockers()).toHaveLength(1);
      expect(overlayIdleBlockers()[0]).toContain("settling in");
      await new Promise((resolve) => {
        setTimeout(resolve, TOAST_ENTER_MS + 40);
      });
      expect(overlayIdleBlockers()).toEqual([]);
      expect(toasts).toHaveLength(1);
    } finally {
      globalThis.matchMedia = media;
    }
  });

  test("under reduced motion there is no settle window to wait for", async () => {
    const media = globalThis.matchMedia;
    globalThis.matchMedia = (() => ({ matches: true })) as unknown as typeof globalThis.matchMedia;
    try {
      notify.info("no animation", { timeoutMs: 0 });
      await flush();
      expect(overlayIdleBlockers()).toEqual([]);
    } finally {
      globalThis.matchMedia = media;
    }
  });
});
