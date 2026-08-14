/**
 * The host half of the keymap sync: the chord table reaches every live frame, and reaches it again
 * whenever the author rebinds a key.
 *
 * The frame cannot see the registry, so it holds a COPY — and a copy with no invalidation is a
 * second authority that drifts. That is what the three hand-written lists in
 * `canvas/iframe-keys.ts` were, and what made rebinding ⌘B in Preferences leave the canvas bound to
 * the old chord for ever. These cases pin the two moments the copy is refreshed: a frame becoming
 * ready, and a keymap change.
 */
import "./with-dom.js";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { registerPrimaryStage, resetWorkspaceWithTab } from "./harness";
import { surfaceForPane } from "../src/canvas/surface-registry";

const { happyDOM } = globalThis as unknown as { happyDOM: { setURL: (u: string) => void } };
happyDOM.setURL("http://localhost:3000/");

interface FakeChannel {
  posts: Record<string, unknown>[];
  deliver: (m: Record<string, unknown>) => void;
}
const channels: FakeChannel[] = [];

void mock.module("../src/canvas/iframe-channel", () => ({
  postMessageChannel: (opts: Record<string, unknown>) => {
    let handler: ((m: Record<string, unknown>) => void) | null = null;
    const rec: FakeChannel = { deliver: (m) => handler?.(m), posts: [] };
    channels.push(rec);
    return {
      dispose: () => {},
      onMessage: (h: (m: Record<string, unknown>) => void) => {
        handler = h;
        return () => {};
      },
      post: (m: Record<string, unknown>) => rec.posts.push(m),
      target: opts.target,
    };
  },
}));

void mock.module("../src/canvas/canvas-live-render", () => ({
  resolveCanvasDocument: () =>
    Promise.resolve({
      docBase: "http://localhost:3000/doc.json",
      mapperCtx: {
        arrayPaths: [],
        canvasMode: "design",
        layoutWrapped: false,
        pageContentOffset: null,
        pageContentPrefix: null,
      },
      renderDoc: { children: ["hi"], tagName: "div" },
      siteStyle: null,
    }),
}));

void mock.module("../src/panels/stylebook-panel", () => ({
  renderComponentPreview: async () => document.createElement("div"),
}));

const { mountIframeCanvas, publishKeymap, setKeymapSource } =
  await import("../src/canvas/iframe-host");
const { initShellRefs } = await import("../src/store");

/** Every `keymap` message a channel received, newest last. */
function keymapPosts(channel: FakeChannel): Record<string, unknown>[] {
  return channel.posts.filter((post) => post.kind === "keymap");
}

/** Mount one host and take it to `ready`, which is when the table is due. */
async function mountReady(): Promise<FakeChannel> {
  const canvasEl = document.createElement("div");
  document.body.append(canvasEl);
  const surface = surfaceForPane("primary");
  surface.renderGeneration = 1;
  surface.panels.push({ canvas: canvasEl, ready: true } as never);
  await mountIframeCanvas(1, { tagName: "div" } as never, canvasEl);
  const channel = channels.at(-1)!;
  channel.deliver({ kind: "ready" });
  return channel;
}

beforeEach(() => {
  channels.length = 0;
  document.body.innerHTML = "";
  initShellRefs();
  registerPrimaryStage();
  resetWorkspaceWithTab({ tagName: "div" } as never);
});

describe("setKeymapSource", () => {
  test("a frame is handed the table the moment it says it is ready", async () => {
    setKeymapSource(() => ({ chords: [{ chord: "mod+s", scope: "global" }], mac: false }));
    const channel = await mountReady();
    expect(keymapPosts(channel)).toEqual([
      { chords: [{ chord: "mod+s", scope: "global" }], kind: "keymap", mac: false },
    ]);
  });

  test("the table is READ on every publish, never captured", async () => {
    // The whole point of a source rather than a value: the registry is the one authority, and the
    // Host asks it again rather than holding what it was told once.
    let chords: { chord: string; scope: "caret" | "canvas" | "global" }[] = [
      { chord: "mod+s", scope: "global" },
    ];
    setKeymapSource(() => ({ chords, mac: false }));
    const channel = await mountReady();
    chords = [{ chord: "mod+b", scope: "caret" as const }];
    publishKeymap();
    expect(keymapPosts(channel).at(-1)).toEqual({
      chords: [{ chord: "mod+b", scope: "caret" }],
      kind: "keymap",
      mac: false,
    });
  });

  test("a keymap change reposts to every live frame — this is what rebinding needs", async () => {
    let notify: null | (() => void) = null;
    setKeymapSource(
      () => ({ chords: [{ chord: "mod+b", scope: "caret" }], mac: true }),
      (listener) => {
        notify = listener;
        return () => {};
      },
    );
    const channel = await mountReady();
    const before = keymapPosts(channel).length;
    (notify as (() => void) | null)?.();
    expect(keymapPosts(channel).length).toBe(before + 1);
  });

  test("publishing with no source posts nothing rather than an empty table", async () => {
    // An empty table means "forward nothing", so publishing one by accident would make the canvas
    // Keyboard go silent — worse than not publishing at all.
    setKeymapSource(undefined as never);
    const channel = await mountReady();
    publishKeymap();
    expect(keymapPosts(channel)).toEqual([]);
  });
});
