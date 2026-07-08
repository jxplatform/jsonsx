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
import { attachCursorStyles, cursorRulesFor, cursorStylesheet } from "../src/collab/monaco-cursors";
import type { AwarenessLike } from "../src/collab/monaco-cursors";
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

describe("y-monaco integration surface", () => {
  test("collabSourceContext exposes the real Y.Text and the connection awareness", async () => {
    const hub = createMockCollabHub();
    const tab = await openAttached(hub);
    const ctx = collabSourceContext(tab)!;
    expect(ctx.awareness).toBeDefined();
    expect(typeof (ctx.text as { toString: () => string }).toString).toBe("function");
    // The text IS the session doc's shared source (same instance the provider persists).
    updateSourceText(hub.serverDoc(PATH), "shared!", LOCAL_ORIGIN);
    await settleCollab();
    expect(String(ctx.text)).toBe("shared!");
  });

  test("cursor styles render one colored rule set per remote client and track the roster", () => {
    const states = new Map<number, unknown>([
      [1, { user: { color: "#e5484d", login: "octocat", name: "Octo Cat" } }],
      [2, { user: { color: "#30a46c", login: "viewer" } }],
      [3, { user: {} }],
      [9, { user: { color: "#4f9cf9", login: "self" } }],
    ]);
    const listeners: (() => void)[] = [];
    const awareness: AwarenessLike = {
      clientID: 9,
      getStates: () => states,
      off: (_event, cb) => listeners.splice(listeners.indexOf(cb), 1),
      on: (_event, cb) => listeners.push(cb),
    };
    const detach = attachCursorStyles(awareness, document);
    const style = document.head.querySelector<HTMLStyleElement>("style[data-jx-collab-cursors]");
    expect(style).not.toBeNull();
    expect(style!.textContent).toContain(".yRemoteSelection-1{background-color:#e5484d44;}");
    expect(style!.textContent).toContain(".yRemoteSelectionHead-2");
    // Self (9) and identity-less peers (3) get no rules.
    expect(style!.textContent).not.toContain("yRemoteSelection-9");
    expect(style!.textContent).not.toContain("yRemoteSelection-3");
    // The name flag carries the display name, CSS-escaped.
    expect(style!.textContent).toContain('content:"Octo Cat"');

    // Roster changes re-render through the awareness listener.
    states.set(1, { user: { color: "#f5a524", login: "octocat" } });
    for (const cb of listeners) {
      cb();
    }
    expect(style!.textContent).toContain("#f5a52444");

    detach();
    expect(document.head.querySelector("style[data-jx-collab-cursors]")).toBeNull();
    expect(listeners).toHaveLength(0);
  });

  test("cursor rules escape hostile display names", () => {
    const rules = cursorRulesFor(5, "#fff", String.raw`a"b\c`);
    expect(rules).toContain(String.raw`content:"a\"b\\c"`);
    const sheet = cursorStylesheet({
      clientID: 1,
      getStates: () => new Map([[2, { user: { color: "#000", login: "x" } }]]),
      off: () => {},
      on: () => {},
    });
    expect(sheet).toContain("yRemoteSelection-2");
  });
});
