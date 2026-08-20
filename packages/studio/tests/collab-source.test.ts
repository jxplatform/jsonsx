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

  /**
   * AND FOR THE LOCK HOLDER, who used to be the one client exempt from its own freeze.
   *
   * The exemption (`&& !session.inSourceMode`) assumed a carrier that does not exist. A structural
   * edit made while this client holds the lock never reaches the shared `Y.Text` — `scheduleMirror`
   * returns early while canonical is `"source"` — and nothing notices, because the source observer
   * fires on TEXT changes only. The tree and the text simply diverged, and the divergence was
   * resolved at `leave()`: it runs `sourceParseNow` before releasing, the UNCHANGED text parses
   * back into the pre-edit tree, and the revert reaches every client as a `"remote"` origin, which
   * passes this gate by design. The layer the author deleted in the Outline reappeared seconds
   * later, with no explanation, to the one person the toast was never shown to.
   *
   * Mirroring the other way is not the alternative — that is the round trip `monaco-buffer.ts`'s
   * clause 5 exists to refuse. Clause 5's own reasoning settles it: if the CRDT owns the text and
   * the tree is derived from it, nobody edits the tree directly, the pen-holder included.
   */
  test("…and for the client HOLDING the lock, which is told why", async () => {
    const notifications: string[] = [];
    const hub = createMockCollabHub();
    const tab = await openAttached(hub);
    configureCollabNotifier((message) => notifications.push(message));
    const ctx = collabSourceContext(tab)!;

    await ctx.enter();
    await settleCollab();
    expect(collabState(tab).sourceCanonical).toBe(true);

    const before = tabJson(tab);
    transactDoc(tab, (t) => mutateUpdateProperty(t, ["children", 0], "textContent", "FromOutline"));

    expect(tabJson(tab)).toEqual(before);
    expect(notifications.some((m) => m.includes("Source editing"))).toBe(true);
    // The invariant the freeze exists for: while the text is canonical, the tree it is parsed into
    // Agrees with it. A divergence here is an edit `leave()` is about to silently take back.
    expect(sourceText(hub.serverDoc(PATH)).toString()).toBe(JSON.stringify(before));

    ctx.leave();
    await settleCollab();
    expect(canonicalOf(hub.serverDoc(PATH))).toBe("structure");
    expect(tabJson(tab)).toEqual(before);
  });

  /**
   * TOGGLING CODE VIEW OFF AND ON INSIDE ONE ROUND TRIP, which stranded the lock.
   *
   * `enter()` flips the room's canonical lock before the binding module is even imported, and
   * `leave()` lives in exactly one place — the cleanup `canvas-render.ts`'s
   * `createSourceCollabBinding` returns. So two overlapping mounts meant the FIRST one's cleanup
   * releasing a lock the SECOND one now held: a co-edited buffer bound to a `Y.Text` the room had
   * stopped treating as canonical, with the structure mirror free to serialize over it and publish
   * the result to every peer.
   *
   * The release now belongs to the holder. The stale mount's `leave()` is not a smaller release —
   * it is not a release at all, and it does not reset the awareness `mode` either, because this
   * client really is still in source mode.
   */
  test("a stale mount's leave cannot release the live mount's lock", async () => {
    const hub = createMockCollabHub();
    const tab = await openAttached(hub);
    const first = collabSourceContext(tab)!;
    const second = collabSourceContext(tab)!;

    await first.enter();
    await settleCollab();
    expect(canonicalOf(hub.serverDoc(PATH))).toBe("source");

    // The toggle: a second mount claims the surface before the first one's cleanup fires.
    await second.enter();
    await settleCollab();
    first.leave();
    await settleCollab();

    expect(canonicalOf(hub.serverDoc(PATH))).toBe("source");
    expect(collabState(tab).sourceCanonical).toBe(true);

    // And the holder can still hand it back.
    second.leave();
    await settleCollab();
    expect(canonicalOf(hub.serverDoc(PATH))).toBe("structure");
  });

  /**
   * The other half of the same identity: an ACQUIRE that lands after the surface it was for is
   * gone.
   *
   * `enter()` awaits a serialization through the format host, and a cold round trip is long enough
   * to open Code view, close it, and have the room hand the lock back — at which point the stale
   * promise resolves and re-freezes everybody, seeded from a surface nobody is looking at. Nothing
   * would ever release it: the mount that would have called `leave()` was torn down before it had a
   * binding. The freeze is honest enough to include the lock holder now, so that state is the whole
   * room unable to edit anything, structure or source, until someone reloads.
   */
  test("an acquire that resolves after its surface is gone does not re-freeze the room", async () => {
    const hub = createMockCollabHub();
    const tab = await openAttached(hub);
    let resolveStale: (() => void) | null = null;
    configureCollabSerializer(
      (t) =>
        new Promise<string>((resolve) => {
          resolveStale = () => resolve(JSON.stringify(toRaw(t.doc.document)));
        }),
    );
    const stale = collabSourceContext(tab)!;
    const staleEntering = stale.enter();

    // The author toggles Code view again while the first serialization is still in flight: a second
    // Mount takes the lock and gives it back.
    configureCollabSerializer((t) => Promise.resolve(JSON.stringify(toRaw(t.doc.document))));
    const live = collabSourceContext(tab)!;
    await live.enter();
    await settleCollab();
    live.leave();
    await settleCollab();
    expect(canonicalOf(hub.serverDoc(PATH))).toBe("structure");

    resolveStale!();
    await staleEntering;
    await settleCollab();

    // Nobody is in Code view, so nobody holds the lock — and structural editing still works.
    expect(canonicalOf(hub.serverDoc(PATH))).toBe("structure");
    expect(collabState(tab).sourceCanonical).toBe(false);
    transactDoc(tab, (t) => mutateUpdateProperty(t, ["children", 0], "textContent", "Still mine"));
    expect((tabJson(tab).children as JxMutableNode[])[0]!.textContent).toBe("Still mine");
  });

  /**
   * A READ-ONLY GUEST COULD FREEZE THE ROOM FOREVER, and neither half of it could get out.
   *
   * `enter()` returns at its `canWrite` guard, so a read-only client never acquires the lock — but
   * it does publish `mode: "source"` the moment it opens Code view, and `otherSourceEditors`
   * counted it. So the LAST write-capable editor's `leave()` saw "somebody else still has Code view
   * open" and released nothing, and the guest's own `leave()` returned at the same `canWrite`
   * guard, holding nothing it could hand back. `meta.canonical` stayed `"source"` for the whole
   * room, and with the lock-holder exemption gone from the transact gate that is every client
   * frozen out of every structural edit — permanently, with only a keyed toast to explain it.
   *
   * A client that cannot write cannot be the one holding a write, which is the same reasoning the
   * reconciler election already uses.
   */
  test("a read-only peer in code view does not keep the lock after the writer leaves", async () => {
    const hub = createMockCollabHub();
    const tab = await openAttached(hub);
    const guest = (await hub.capability(PATH))!;
    guest.awareness.setLocalState({
      canWrite: false,
      focusedPath: PATH,
      mode: "source",
      user: { color: "#fff", login: "guest" },
    });
    await settleCollab();

    const ctx = collabSourceContext(tab)!;
    await ctx.enter();
    await settleCollab();
    expect(canonicalOf(hub.serverDoc(PATH))).toBe("source");

    ctx.leave();
    await settleCollab();

    expect(canonicalOf(hub.serverDoc(PATH))).toBe("structure");
    expect(collabState(tab).sourceCanonical).toBe(false);
    // And structural editing works again for everybody, which is the whole point of the release.
    transactDoc(tab, (t) => mutateUpdateProperty(t, ["children", 0], "textContent", "Unfrozen"));
    expect((tabJson(tab).children as JxMutableNode[])[0]!.textContent).toBe("Unfrozen");
    guest.destroy();
  });

  test("a WRITE-CAPABLE peer in code view still holds the lock open", async () => {
    const hub = createMockCollabHub();
    const tab = await openAttached(hub);
    const peer = (await hub.capability(PATH))!;
    peer.awareness.setLocalState({
      canWrite: true,
      focusedPath: PATH,
      mode: "source",
      user: { color: "#fff", login: "peer" },
    });
    await settleCollab();

    const ctx = collabSourceContext(tab)!;
    await ctx.enter();
    await settleCollab();
    ctx.leave();
    await settleCollab();

    // Somebody is still co-editing the text the tree is derived from — releasing would make the
    // Structure canonical underneath them.
    expect(canonicalOf(hub.serverDoc(PATH))).toBe("source");
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

describe("Monaco binding integration surface", () => {
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
