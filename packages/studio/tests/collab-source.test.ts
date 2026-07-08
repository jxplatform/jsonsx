import { installMockPlatform } from "./harness";
import { createMockCollabHub, settleCollab } from "./collab-mock";
import { toRaw } from "../src/reactivity";
import { jsonClone } from "../src/utils/studio-utils";
import { closeAllTabs, openTab } from "../src/workspace/workspace";
import {
  collabSourceContext,
  configureCollabNotifier,
  configureCollabParser,
  configureCollabSerializer,
  resetCollabForTests,
} from "../src/collab/collab-session";
import { collabState } from "../src/collab/collab-state";
import { mutateUpdateProperty, transactDoc } from "../src/tabs/transact";
import { bindMonacoToSharedText } from "../src/collab/monaco-binding";
import type { MonacoModelLike, SharedTextLike } from "../src/collab/monaco-binding";
import {
  acquireSourceCanonical,
  canonicalOf,
  LOCAL_ORIGIN,
  sourceText,
  updateSourceText,
} from "@jxsuite/collab";
import type { JxMutableNode } from "@jxsuite/schema/types";
import type { Tab } from "../src/tabs/tab";
import { afterEach, describe, expect, test } from "bun:test";

const DOC: JxMutableNode = { children: [{ tagName: "p", textContent: "Base" }], tagName: "div" };
const PATH = "pages/source.json";

async function openAttached(hub: ReturnType<typeof createMockCollabHub>) {
  installMockPlatform({ collab: hub.capability });
  configureCollabSerializer((tab) => Promise.resolve(JSON.stringify(toRaw(tab.doc.document))));
  configureCollabParser((_tab, text) =>
    Promise.resolve({ document: JSON.parse(text) as JxMutableNode }),
  );
  const tab = openTab({ document: structuredClone(DOC), documentPath: PATH, id: PATH });
  await settleCollab();
  expect(collabState(tab).active).toBe(true);
  return tab;
}

function tabJson(tab: Tab): JxMutableNode {
  return jsonClone(toRaw(tab.doc.document)) as JxMutableNode;
}

afterEach(() => {
  closeAllTabs();
  resetCollabForTests();
});

describe("the canonical source lock", () => {
  test("enter flips the lock with a fresh serialization; leave hands it back", async () => {
    const hub = createMockCollabHub();
    const tab = await openAttached(hub);
    const ctx = collabSourceContext(tab)!;
    expect(ctx).not.toBeNull();

    await ctx.enter();
    await settleCollab();
    expect(canonicalOf(hub.serverDoc(PATH))).toBe("source");
    expect(sourceText(hub.serverDoc(PATH)).toString()).toBe(JSON.stringify(DOC));

    ctx.leave();
    await settleCollab();
    expect(canonicalOf(hub.serverDoc(PATH))).toBe("structure");
  });

  test("structural edits freeze for OTHERS while a peer holds source", async () => {
    const notifications: string[] = [];
    const hub = createMockCollabHub();
    const tab = await openAttached(hub);
    configureCollabNotifier((message) => notifications.push(message));

    // A peer flips the lock remotely.
    const peer = (await hub.capability(PATH))!;
    acquireSourceCanonical(peer.doc, JSON.stringify(DOC), LOCAL_ORIGIN);
    await settleCollab();
    expect(collabState(tab).sourceCanonical).toBe(true);

    const before = tabJson(tab);
    transactDoc(tab, (t) => mutateUpdateProperty(t, ["children", 0], "textContent", "Blocked"));
    expect(tabJson(tab)).toEqual(before);
    expect(notifications.some((m) => m.includes("Source editing"))).toBe(true);
    peer.destroy();
  });

  test("the source reconciler parses peer text edits into everyone's structure", async () => {
    const hub = createMockCollabHub();
    const tab = await openAttached(hub);
    const ctx = collabSourceContext(tab)!;
    await ctx.enter();
    await settleCollab();

    // A peer types into the shared text; this client (in source mode) is the reconciler.
    const peer = (await hub.capability(PATH))!;
    const edited = { children: [{ tagName: "h1", textContent: "From source" }], tagName: "main" };
    updateSourceText(peer.doc, JSON.stringify(edited), LOCAL_ORIGIN);
    // The parse mirror is debounced 600ms.
    await new Promise((resolve) => {
      setTimeout(resolve, 800);
    });
    await settleCollab();

    expect(tabJson(tab)).toEqual(edited as JxMutableNode);
    peer.destroy();
  });
});

describe("the Monaco ↔ shared-text binding", () => {
  function fakeModel(initial: string) {
    let value = initial;
    const listeners: ((event: {
      changes: { rangeOffset: number; rangeLength: number; text: string }[];
    }) => void)[] = [];
    const applied: { start: number; end: number; text: string }[] = [];
    const model: MonacoModelLike = {
      applyEdits: (edits) => {
        for (const edit of edits) {
          const range = edit.range as { start: number; end: number };
          applied.push({ end: range.end, start: range.start, text: edit.text });
          value = value.slice(0, range.start) + edit.text + value.slice(range.end);
        }
        return null;
      },
      getPositionAt: (offset) => offset,
      getValue: () => value,
      onDidChangeContent: (cb) => {
        listeners.push(cb);
        return { dispose: () => listeners.splice(listeners.indexOf(cb), 1) };
      },
    };
    const emitLocalEdit = (offset: number, length: number, text: string) => {
      value = value.slice(0, offset) + text + value.slice(offset + length);
      for (const cb of listeners) {
        cb({ changes: [{ rangeLength: length, rangeOffset: offset, text }] });
      }
    };
    return {
      applied,
      emitLocalEdit,
      model,
      rangeFactory: { fromPositions: (start: unknown, end: unknown) => ({ end, start }) },
      value: () => value,
    };
  }

  test("adopts the shared text, sends local edits, applies remote deltas, and mutes echoes", async () => {
    const hub = createMockCollabHub();
    installMockPlatform({ collab: hub.capability });
    const handle = (await hub.capability(PATH))!;
    updateSourceText(handle.doc, "hello world", "seed");

    const fake = fakeModel("stale");
    const binding = bindMonacoToSharedText({
      localOrigin: LOCAL_ORIGIN,
      model: fake.model,
      rangeFactory: fake.rangeFactory,
      text: sourceText(handle.doc) as unknown as SharedTextLike,
    });
    expect(fake.value()).toBe("hello world");

    // Local typing reaches the shared text (and, via the hub, the server doc).
    fake.emitLocalEdit(5, 0, ",");
    expect(sourceText(handle.doc).toString()).toBe("hello, world");
    await settleCollab();
    expect(sourceText(hub.serverDoc(PATH)).toString()).toBe("hello, world");

    // A remote edit lands in the buffer without echoing back.
    const appliedBefore = fake.applied.length;
    updateSourceText(handle.doc, "hello, brave world", "remote-peer");
    expect(fake.value()).toBe("hello, brave world");
    expect(fake.applied.length).toBeGreaterThan(appliedBefore);
    expect(sourceText(handle.doc).toString()).toBe("hello, brave world");

    // A remote deletion maps back into the buffer too.
    updateSourceText(handle.doc, "hello, world", "remote-peer");
    expect(fake.value()).toBe("hello, world");

    binding.dispose();
    fake.emitLocalEdit(0, 0, "x");
    expect(sourceText(handle.doc).toString()).toBe("hello, world");
    handle.destroy();
  });

  test("a matching buffer needs no initial adopt edit, and doc-less texts apply directly", () => {
    const events: ((event: unknown, transaction: { origin: unknown }) => void)[] = [];
    let stored = "same";
    const bareText: SharedTextLike = {
      delete: (index, length) => {
        stored = stored.slice(0, index) + stored.slice(index + length);
      },
      doc: null,
      insert: (index, text) => {
        stored = stored.slice(0, index) + text + stored.slice(index);
      },
      observe: (cb) => events.push(cb as never),
      toString: () => stored,
      unobserve: () => {},
    };
    const fake = fakeModel("same");
    const binding = bindMonacoToSharedText({
      localOrigin: "local",
      model: fake.model,
      rangeFactory: fake.rangeFactory,
      text: bareText,
    });
    // Identical content: no adopt edit was applied.
    expect(fake.applied).toHaveLength(0);
    // Local edits apply without a doc transaction wrapper.
    fake.emitLocalEdit(4, 0, "!");
    expect(stored).toBe("same!");
    // Same-origin remote events are muted echoes.
    for (const cb of events) {
      cb({ delta: [{ insert: "zzz" }] }, { origin: "local" });
    }
    expect(fake.value()).toBe("same!");
    binding.dispose();
  });
});
