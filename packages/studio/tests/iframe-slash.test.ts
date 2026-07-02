/**
 * Iframe-realm slash-menu bridge — the DI'd SlashController that proxies the engine's slash menu
 * across the postMessage bridge (slashShow/slashNav/slashDismiss out; slashSelect/slashDismissed
 * back), plus the capture-phase nav-key interception while the parent menu is open. The engine is
 * mocked to a recording registrar so the bridge's controller is driven directly.
 */
import "./with-dom.js";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { SlashCommand, SlashController } from "../src/editor/inline-edit";
import type { IframeToParent, ParentToIframe } from "../src/canvas/iframe-protocol";

let controller: SlashController | null = null;

void mock.module("../src/editor/inline-edit", () => ({
  setSlashController: (c: SlashController) => {
    controller = c;
  },
}));

const { startIframeSlashBridge } = await import("../src/canvas/iframe-slash");

function fakeChannel() {
  const posts: IframeToParent[] = [];
  let handler: ((m: ParentToIframe) => void) | null = null;
  const channel = {
    dispose() {
      // Unused by these tests.
    },
    onMessage(h: (m: ParentToIframe) => void) {
      handler = h;
      return () => {
        handler = null;
      };
    },
    post(m: IframeToParent) {
      posts.push(m);
    },
  } as never;
  return { channel, deliver: (m: ParentToIframe) => handler?.(m), posts };
}

const CMD: SlashCommand = { description: "Plain text", label: "Paragraph", tag: "p" };

let anchor: HTMLElement;
let stop: (() => void) | null = null;
let ch: ReturnType<typeof fakeChannel>;

function startBridge() {
  ch = fakeChannel();
  stop = startIframeSlashBridge(ch.channel, document);
}

const show = (filter: string, onSelect: (cmd: SlashCommand) => void = () => {}) =>
  controller!.show(anchor, filter, { onSelect });

beforeEach(() => {
  document.body.innerHTML = "";
  anchor = document.createElement("p");
  document.body.append(anchor);
  controller = null;
});

afterEach(() => {
  stop?.();
  stop = null;
});

describe("iframe slash bridge", () => {
  test("show posts slashShow with the anchor rect + filter and flips isOpen", () => {
    startBridge();
    expect(controller).not.toBeNull();
    expect(controller!.isOpen()).toBe(false);
    show("");
    expect(controller!.isOpen()).toBe(true);
    const posted = ch.posts.find((p) => p.kind === "slashShow");
    expect(posted).toMatchObject({ filter: "", kind: "slashShow" });
    const { rect } = posted as unknown as { rect: Record<string, number> };
    for (const k of ["x", "y", "width", "height"]) {
      expect(typeof rect[k]).toBe("number");
    }
  });

  test("re-showing with the SAME filter is deduped; a new filter re-posts", () => {
    startBridge();
    show("he");
    show("he");
    expect(ch.posts.filter((p) => p.kind === "slashShow")).toHaveLength(1);
    show("hea");
    expect(ch.posts.filter((p) => p.kind === "slashShow")).toHaveLength(2);
    expect(ch.posts.at(-1)).toMatchObject({ filter: "hea", kind: "slashShow" });
  });

  test("nav keys are intercepted capture-phase while open and posted as slashNav", () => {
    startBridge();
    show("");
    const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowDown" });
    document.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(ch.posts).toContainEqual({ key: "ArrowDown", kind: "slashNav" });
    // Non-nav keys pass through untouched (typing keeps filtering in the contenteditable).
    const t = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "a" });
    document.dispatchEvent(t);
    expect(t.defaultPrevented).toBe(false);
  });

  test("nav keys are NOT intercepted when the menu is closed", () => {
    startBridge();
    const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" });
    document.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    expect(ch.posts.some((p) => p.kind === "slashNav")).toBe(false);
  });

  test("slashSelect invokes the stored onSelect (plain-copied cmd) and closes", () => {
    startBridge();
    const picked: SlashCommand[] = [];
    show("", (cmd) => picked.push(cmd));
    ch.deliver({ cmd: CMD, kind: "slashSelect" });
    expect(picked).toEqual([CMD]);
    expect(controller!.isOpen()).toBe(false);
  });

  test("slashDismissed closes but KEEPS the callback — a subsequent slashSelect still fires", () => {
    startBridge();
    const picked: SlashCommand[] = [];
    show("", (cmd) => picked.push(cmd));
    // The parent's select() dismisses BEFORE it fires onSelect — the select must survive.
    ch.deliver({ kind: "slashDismissed" });
    expect(controller!.isOpen()).toBe(false);
    ch.deliver({ cmd: CMD, kind: "slashSelect" });
    expect(picked).toEqual([CMD]);
  });

  test("dismiss posts slashDismiss exactly once and only while open", () => {
    startBridge();
    controller!.dismiss();
    expect(ch.posts.some((p) => p.kind === "slashDismiss")).toBe(false);
    show("");
    controller!.dismiss();
    controller!.dismiss();
    expect(ch.posts.filter((p) => p.kind === "slashDismiss")).toHaveLength(1);
  });

  test("an in-iframe mousedown while open dismisses (the parent can't see iframe clicks)", () => {
    startBridge();
    show("");
    document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(controller!.isOpen()).toBe(false);
    expect(ch.posts.some((p) => p.kind === "slashDismiss")).toBe(true);
  });

  test("after dismissal the same filter posts again (dedupe state cleared)", () => {
    startBridge();
    show("he");
    controller!.dismiss();
    show("he");
    expect(ch.posts.filter((p) => p.kind === "slashShow")).toHaveLength(2);
  });

  test("teardown restores a no-op controller and removes the key listener", () => {
    startBridge();
    show("");
    const bridgeController = controller!;
    stop!();
    stop = null;
    // Teardown re-registered a noop controller with the engine…
    expect(controller).not.toBe(bridgeController);
    expect(controller!.isOpen()).toBe(false);
    controller!.show(anchor, "x", { onSelect: () => {} });
    expect(controller!.isOpen()).toBe(false);
    // …and the capture keydown no longer intercepts.
    const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowDown" });
    document.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });
});
