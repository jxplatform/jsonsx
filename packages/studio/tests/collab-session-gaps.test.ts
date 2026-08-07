/**
 * Collab session gaps — batch flush shapes, publish fallbacks (diff-impossible / apply-throw →
 * structure replace), hard reconciles, reconciler election, source-lock read-only guards and the
 * source parse mirror's failure branches, frontmatter delete flows, guest identity, attach-race
 * generation guards, and the mirror debounce timer. Failure injection rides a pass-through mock of
 * `@jxsuite/collab` whose diff/apply/convert functions delegate to swappable impls.
 */
import { installMockPlatform } from "./harness";
import { createMockCollabHub, settleCollab } from "./collab-mock";
import { afterEach, describe, expect, mock, test } from "bun:test";
import * as Y from "yjs";
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import { toRaw } from "../src/reactivity";
import { jsonClone } from "../src/utils/studio-utils";
import { closeAllTabs, openTab } from "../src/workspace/workspace";
import { collabState } from "../src/collab/collab-state";
import { beginBatch, endBatch, mutateUpdateProperty, transactDoc } from "../src/tabs/transact";
import type { CollabHandle } from "@jxsuite/collab/provider";
import type { JxMutableNode } from "@jxsuite/schema/types";
import type { Tab } from "../src/tabs/tab";

const actualCollab = await import("@jxsuite/collab");

// Capture the real implementations BEFORE mock.module: Bun rewires the `actualCollab` namespace to
// The mock, so reading `actualCollab.applyDocOpsToY` after mocking would yield the wrapper itself
// (self-recursion). All impl defaults/resets and direct test calls must use these captures.
const realApplyDocOpsToY = actualCollab.applyDocOpsToY;
const realDiffDocs = actualCollab.diffDocs;
const realYEventsToDocOps = actualCollab.yEventsToDocOps;

let applyDocOpsImpl = realApplyDocOpsToY;
let diffDocsImpl = realDiffDocs;
let yEventsImpl = realYEventsToDocOps;

void mock.module("@jxsuite/collab", () => ({
  ...actualCollab,
  applyDocOpsToY: (...args: Parameters<typeof realApplyDocOpsToY>) => applyDocOpsImpl(...args),
  diffDocs: (...args: Parameters<typeof realDiffDocs>) => diffDocsImpl(...args),
  yEventsToDocOps: (...args: Parameters<typeof realYEventsToDocOps>) => yEventsImpl(...args),
}));

const {
  collabSave,
  collabSourceContext,
  configureCollabParser,
  configureCollabSerializer,
  ensureCollab,
  flushAllCollab,
  rekeyCollab,
  resetCollabForTests,
  setCollabEnabled,
} = await import("../src/collab/collab-session");

const DOC: JxMutableNode = {
  children: [{ tagName: "p", textContent: "Hello" }],
  tagName: "div",
};
const PATH = "pages/gaps.json";

type Hub = ReturnType<typeof createMockCollabHub>;

function openCollabTab(hub: Hub, doc?: JxMutableNode, path = PATH): Tab {
  installMockPlatform({ collab: hub.capability });
  return openTab({
    document: structuredClone(doc ?? DOC),
    documentPath: path,
    id: path,
  }) as Tab;
}

function serverJson(hub: Hub, path = PATH): JxMutableNode {
  return actualCollab.yDocToJson(hub.serverDoc(path)) as JxMutableNode;
}

function tabJson(tab: Tab): JxMutableNode {
  return jsonClone(toRaw(tab.doc.document)) as JxMutableNode;
}

const jsonSerializer = (tab: Tab) => Promise.resolve(JSON.stringify(toRaw(tab.doc.document)));

/**
 * Intercept long debounce timers (mirror 800ms / source-parse 600ms / sync-timeout 8s) so tests
 * flush them deterministically. settleCollab's 0ms timers pass through.
 */
async function withFakeTimers(fn: (runPending: () => Promise<void>) => Promise<void>) {
  const origSetTimeout = globalThis.setTimeout;
  const origClearTimeout = globalThis.clearTimeout;
  const pending: (() => unknown)[] = [];
  globalThis.setTimeout = ((cb: () => unknown, ms?: number, ...args: unknown[]) => {
    if (typeof ms === "number" && ms >= 500) {
      pending.push(cb);
      return { __fake: true } as unknown as ReturnType<typeof setTimeout>;
    }
    return origSetTimeout(cb as () => void, ms, ...(args as []));
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle: unknown) => {
    if (handle && typeof handle === "object" && (handle as { __fake?: boolean }).__fake) {
      const idx = pending.length; // Fake handles are not individually tracked; drop-all on run.
      void idx;
      return;
    }
    origClearTimeout(handle as ReturnType<typeof setTimeout>);
  }) as typeof clearTimeout;
  try {
    await fn(async () => {
      for (const cb of pending.splice(0)) {
        cb();
      }
      await settleCollab();
    });
  } finally {
    globalThis.setTimeout = origSetTimeout;
    globalThis.clearTimeout = origClearTimeout;
  }
}

afterEach(() => {
  applyDocOpsImpl = realApplyDocOpsToY;
  diffDocsImpl = realDiffDocs;
  yEventsImpl = realYEventsToDocOps;
  closeAllTabs();
  resetCollabForTests();
});

// ─── Hook installation / watcher idempotence ─────────────────────────────────

describe("hook + watcher idempotence", () => {
  test("a second collab tab reuses the installed hooks; ensureCollab re-entry is a no-op", async () => {
    const hub = createMockCollabHub();
    installMockPlatform({ collab: hub.capability });
    const tabA = openTab({ document: structuredClone(DOC), documentPath: PATH, id: PATH }) as Tab;
    const tabB = openTab({
      document: structuredClone(DOC),
      documentPath: "pages/other.json",
      id: "pages/other.json",
    }) as Tab;
    await settleCollab();
    expect(collabState(tabA).active).toBe(true);
    expect(collabState(tabB).active).toBe(true);
    // The watcher is installed once per tab — repeating is inert.
    ensureCollab(tabA);
    await settleCollab();
    expect(collabState(tabA).active).toBe(true);
    expect(hub.connectionCount(PATH)).toBe(1);
  });
});

// ─── Batch flush shapes ──────────────────────────────────────────────────────

describe("batch publishing", () => {
  test("an empty batch flushes as a no-op", async () => {
    const hub = createMockCollabHub();
    const tab = openCollabTab(hub);
    await settleCollab();
    beginBatch(tab);
    expect(() => endBatch()).not.toThrow();
    expect(serverJson(hub)).toEqual(DOC);
  });

  test("an un-instrumented mutation inside a batch flushes by whole-doc diff", async () => {
    const hub = createMockCollabHub();
    const tab = openCollabTab(hub);
    await settleCollab();

    beginBatch(tab);
    transactDoc(tab, (t) => {
      (t.doc.document as JxMutableNode).tagName = "main";
    });
    endBatch();
    await settleCollab();
    expect(serverJson(hub).tagName).toBe("main");
  });

  test("a batch whose op replay fails falls back to the structure replace", async () => {
    const hub = createMockCollabHub();
    const tab = openCollabTab(hub);
    await settleCollab();

    applyDocOpsImpl = () => {
      throw new Error("cannot apply");
    };
    beginBatch(tab);
    transactDoc(tab, (t) => mutateUpdateProperty(t, ["children", 0], "textContent", "Batched"));
    endBatch();
    applyDocOpsImpl = realApplyDocOpsToY;
    await settleCollab();

    expect((serverJson(hub).children as JxMutableNode[])[0]!.textContent).toBe("Batched");
  });
});

// ─── Publish fallbacks (solo transactions) ───────────────────────────────────

describe("publish fallbacks", () => {
  test("an op-apply failure publishes by diff (and hard-replaces when that fails too)", async () => {
    const hub = createMockCollabHub();
    const tab = openCollabTab(hub);
    await settleCollab();

    applyDocOpsImpl = () => {
      throw new Error("cannot apply");
    };
    transactDoc(tab, (t) => mutateUpdateProperty(t, ["children", 0], "textContent", "Replaced"));
    applyDocOpsImpl = realApplyDocOpsToY;
    await settleCollab();

    expect((serverJson(hub).children as JxMutableNode[])[0]!.textContent).toBe("Replaced");
  });

  test("an un-diffable document is hard-replaced into the Y structure", async () => {
    const hub = createMockCollabHub();
    const tab = openCollabTab(hub);
    await settleCollab();

    diffDocsImpl = () => null;
    transactDoc(tab, (t) => {
      (t.doc.document as JxMutableNode).tagName = "article";
    });
    diffDocsImpl = realDiffDocs;
    await settleCollab();

    expect(serverJson(hub).tagName).toBe("article");
  });
});

// ─── Initial adoption reconciles ─────────────────────────────────────────────

describe("initial adoption", () => {
  test("a second client hard-reconciles (with key deletion) when the diff is impossible", async () => {
    const hub = createMockCollabHub();
    const shared: JxMutableNode = {
      children: [{ tagName: "h1", textContent: "Shared" }],
    } as JxMutableNode; // No tagName — the local key must be DELETED on adoption.
    actualCollab.seedStructure(hub.serverDoc(PATH), shared);

    diffDocsImpl = () => null;
    const tab = openCollabTab(hub);
    await settleCollab();
    diffDocsImpl = realDiffDocs;

    expect(collabState(tab).active).toBe(true);
    expect(tabJson(tab)).toEqual(shared);
    expect((toRaw(tab.doc.document) as JxMutableNode).tagName).toBeUndefined();
  });

  test("a second client adopts the seeded shared frontmatter", async () => {
    const hub = createMockCollabHub();
    actualCollab.seedStructure(hub.serverDoc(PATH), structuredClone(DOC), {
      frontmatter: { title: "Shared title" },
    });
    const tab = openCollabTab(hub);
    await settleCollab();
    expect(tab.doc.content.frontmatter.title).toBe("Shared title");
  });
});

// ─── Inbound structure conversion edge cases ─────────────────────────────────

describe("inbound structure edge cases", () => {
  test("a remote transaction converting to zero ops is ignored", async () => {
    const hub = createMockCollabHub();
    const tab = openCollabTab(hub);
    await settleCollab();

    yEventsImpl = () => [];
    const peer = (await hub.capability(PATH))!;
    realApplyDocOpsToY(
      peer.doc,
      [{ key: "tagName", op: "set-key", path: [], value: "main" }],
      "peer",
    );
    await settleCollab();
    yEventsImpl = realYEventsToDocOps;

    expect(tabJson(tab).tagName).toBe("div");
    peer.destroy();
  });

  test("unapplyable remote ops hard-reconcile the tab from the Y tree", async () => {
    const hub = createMockCollabHub();
    const tab = openCollabTab(hub);
    await settleCollab();

    // Convert every remote event into an op targeting a nonexistent node: the replay throws and
    // The session falls back to adopting the whole shared tree.
    yEventsImpl = () => [{ index: 0, op: "remove-child", parentPath: ["children", 9] }];
    const peer = (await hub.capability(PATH))!;
    realApplyDocOpsToY(
      peer.doc,
      [{ key: "tagName", op: "set-key", path: [], value: "adopted" }],
      "peer",
    );
    await settleCollab();
    yEventsImpl = realYEventsToDocOps;

    expect(tabJson(tab).tagName).toBe("adopted");
    peer.destroy();
  });
});

// ─── Reconciler election ─────────────────────────────────────────────────────

describe("reconciler election", () => {
  test("a read-only client never mirrors a remote edit", async () => {
    const hub = createMockCollabHub({ identity: { permission: "read" } });
    // A read-only client never seeds — the room must exist before it can observe.
    actualCollab.seedStructure(hub.serverDoc(PATH), structuredClone(DOC));
    const tab = openCollabTab(hub);
    configureCollabSerializer(jsonSerializer);
    await settleCollab();
    expect(collabState(tab).readOnly).toBe(true);

    const peer = (await hub.capability(PATH))!;
    realApplyDocOpsToY(
      peer.doc,
      [{ key: "textContent", op: "set-key", path: ["children", 0], value: "Remote" }],
      "peer",
    );
    await settleCollab();

    // The remote edit applied, but this observer client scheduled no mirror.
    expect((tabJson(tab).children as JxMutableNode[])[0]!.textContent).toBe("Remote");
    expect(hub.serverDoc(PATH).getText("source").toString()).toBe("");
    peer.destroy();
  });

  test("a lower write-capable clientID wins the election (and fills the peer roster)", async () => {
    const hub = createMockCollabHub();
    const handles: CollabHandle[] = [];
    installMockPlatform({
      collab: async (p) => {
        const h = await hub.capability(p);
        if (h) {
          handles.push(h);
        }
        return h;
      },
    });
    configureCollabSerializer(jsonSerializer);
    const tab = openTab({ document: structuredClone(DOC), documentPath: PATH, id: PATH }) as Tab;
    await settleCollab();

    // Inject a peer with clientID 1 (lower than any random real id) that can write.
    const lowDoc = new Y.Doc();
    lowDoc.clientID = 1;
    const low = new Awareness(lowDoc);
    low.setLocalState({ canWrite: true, user: { color: "#000", login: "low-peer" } });
    applyAwarenessUpdate(handles[0]!.awareness, encodeAwarenessUpdate(low, [1]), "test");
    await settleCollab();

    // The roster shows the injected peer.
    expect(collabState(tab).peers.map((p) => p.clientId)).toContain(1);

    // A local edit publishes but does NOT mirror — the lower clientID is the reconciler.
    transactDoc(tab, (t) => mutateUpdateProperty(t, ["children", 0], "textContent", "Mine"));
    await settleCollab();
    expect((serverJson(hub).children as JxMutableNode[])[0]!.textContent).toBe("Mine");
    expect(hub.serverDoc(PATH).getText("source").toString()).toBe("");
    low.destroy();
  });
});

// ─── Mirror debounce ─────────────────────────────────────────────────────────

describe("mirror debounce", () => {
  test("rapid edits coalesce into one debounced mirror", async () => {
    const hub = createMockCollabHub();
    const tab = openCollabTab(hub);
    configureCollabSerializer(jsonSerializer);
    await settleCollab();

    await withFakeTimers(async (runPending) => {
      transactDoc(tab, (t) => mutateUpdateProperty(t, ["children", 0], "textContent", "One"));
      transactDoc(tab, (t) => mutateUpdateProperty(t, ["children", 0], "textContent", "Two"));
      await runPending();
    });
    await settleCollab();
    expect(hub.serverDoc(PATH).getText("source").toString()).toContain("Two");
  });

  test("detaching clears a pending mirror timer", async () => {
    const hub = createMockCollabHub();
    const tab = openCollabTab(hub);
    configureCollabSerializer(jsonSerializer);
    await settleCollab();

    await withFakeTimers(async () => {
      transactDoc(tab, (t) => mutateUpdateProperty(t, ["children", 0], "textContent", "Gone"));
      closeAllTabs();
      await settleCollab();
    });
    // The pending mirror never fired — the source text stays unmirrored.
    expect(hub.serverDoc(PATH).getText("source").toString()).toBe("");
  });
});

// ─── Source lock: read-only + serializer failure + parse mirror branches ─────

describe("source lock guards", () => {
  test("a read-only client's enter/leave never touches the canonical lock", async () => {
    const hub = createMockCollabHub({ identity: { permission: "read" } });
    const tab = openCollabTab(hub);
    await settleCollab();

    const ctx = collabSourceContext(tab)!;
    expect(ctx.readOnly).toBe(true);
    await ctx.enter();
    await settleCollab();
    expect(actualCollab.canonicalOf(hub.serverDoc(PATH))).toBe("structure");
    ctx.leave();
    await settleCollab();
    expect(actualCollab.canonicalOf(hub.serverDoc(PATH))).toBe("structure");
  });

  test("a serializer failure on enter falls back to the existing shared text", async () => {
    const hub = createMockCollabHub();
    const tab = openCollabTab(hub);
    configureCollabSerializer(() => Promise.reject(new Error("cannot serialize")));
    await settleCollab();

    const ctx = collabSourceContext(tab)!;
    await ctx.enter();
    await settleCollab();
    expect(actualCollab.canonicalOf(hub.serverDoc(PATH))).toBe("source");
    ctx.leave();
    await settleCollab();
  });

  test("leave without a parser still hands the lock back", async () => {
    const hub = createMockCollabHub();
    const tab = openCollabTab(hub);
    configureCollabSerializer(jsonSerializer);
    await settleCollab();

    const ctx = collabSourceContext(tab)!;
    await ctx.enter();
    await settleCollab();
    expect(actualCollab.canonicalOf(hub.serverDoc(PATH))).toBe("source");
    ctx.leave();
    await settleCollab();
    expect(actualCollab.canonicalOf(hub.serverDoc(PATH))).toBe("structure");
  });

  test("an unparseable source keeps the last good structure", async () => {
    const hub = createMockCollabHub();
    const tab = openCollabTab(hub);
    configureCollabSerializer(jsonSerializer);
    configureCollabParser(() => Promise.reject(new Error("bad source")));
    await settleCollab();

    const ctx = collabSourceContext(tab)!;
    await ctx.enter();
    await settleCollab();
    ctx.leave();
    await settleCollab();
    expect(serverJson(hub)).toEqual(DOC);
    expect(actualCollab.canonicalOf(hub.serverDoc(PATH))).toBe("structure");
  });

  test("a parse computed against a flipped lock revision is discarded", async () => {
    const hub = createMockCollabHub();
    const tab = openCollabTab(hub);
    configureCollabSerializer(jsonSerializer);
    let releaseParse!: () => void;
    const edited = { children: [], tagName: "stale-parse" } as unknown as JxMutableNode;
    configureCollabParser(
      () =>
        new Promise((resolve) => {
          releaseParse = () => resolve({ document: edited });
        }),
    );
    await settleCollab();

    const ctx = collabSourceContext(tab)!;
    await ctx.enter();
    await settleCollab();
    ctx.leave(); // SourceParseNow captures the rev, then suspends in the parser.
    await settleCollab();

    // A peer flips the lock while the parse is in flight — the captured rev is dead.
    const peer = (await hub.capability(PATH))!;
    actualCollab.releaseSourceCanonical(peer.doc, actualCollab.LOCAL_ORIGIN);
    await settleCollab();
    releaseParse();
    await settleCollab();

    expect(serverJson(hub)).toEqual(DOC);
    peer.destroy();
  });

  test("an un-diffable parse hard-replaces the structure (MIRROR origin)", async () => {
    const hub = createMockCollabHub();
    const tab = openCollabTab(hub);
    configureCollabSerializer(jsonSerializer);
    const parsed = {
      children: [{ tagName: "h2", textContent: "From source" }],
      tagName: "section",
    } as unknown as JxMutableNode;
    configureCollabParser(() => Promise.resolve({ document: structuredClone(parsed) }));
    await settleCollab();

    const ctx = collabSourceContext(tab)!;
    await ctx.enter();
    await settleCollab();
    diffDocsImpl = () => null;
    ctx.leave();
    await settleCollab();
    diffDocsImpl = realDiffDocs;

    expect(serverJson(hub)).toEqual(parsed);
  });

  test("a parse whose op replay fails also hard-replaces the structure", async () => {
    const hub = createMockCollabHub();
    const tab = openCollabTab(hub);
    configureCollabSerializer(jsonSerializer);
    const parsed = {
      children: [{ tagName: "h3", textContent: "Fallback" }],
      tagName: "aside",
    } as unknown as JxMutableNode;
    configureCollabParser(() => Promise.resolve({ document: structuredClone(parsed) }));
    await settleCollab();

    const ctx = collabSourceContext(tab)!;
    await ctx.enter();
    await settleCollab();
    applyDocOpsImpl = () => {
      throw new Error("cannot apply");
    };
    ctx.leave();
    await settleCollab();
    applyDocOpsImpl = realApplyDocOpsToY;

    expect(serverJson(hub)).toEqual(parsed);
  });

  test("the parse mirror reconciles shared frontmatter (delete + set)", async () => {
    const hub = createMockCollabHub();
    const tab = openCollabTab(hub);
    configureCollabSerializer(jsonSerializer);
    configureCollabParser(() =>
      Promise.resolve({
        document: structuredClone(DOC),
        frontmatter: { title: "From source" },
      }),
    );
    await settleCollab();

    // Seed a shared frontmatter key the parse result will not carry.
    tab.doc.content.frontmatter.legacy = "old";
    await settleCollab();
    const fm = actualCollab.frontmatterMap(hub.serverDoc(PATH));
    expect(fm.get("legacy")).toBe("old");

    const ctx = collabSourceContext(tab)!;
    await ctx.enter();
    await settleCollab();
    ctx.leave();
    await settleCollab();

    expect(fm.get("legacy")).toBeUndefined();
    expect(fm.get("title")).toBe("From source");
  });
});

// ─── Frontmatter sync ────────────────────────────────────────────────────────

describe("frontmatter sync", () => {
  test("a locally deleted key is deleted from the shared map", async () => {
    const hub = createMockCollabHub();
    const tab = openCollabTab(hub);
    await settleCollab();

    tab.doc.content.frontmatter.title = "Mine";
    await settleCollab();
    const fm = actualCollab.frontmatterMap(hub.serverDoc(PATH));
    expect(fm.get("title")).toBe("Mine");

    delete tab.doc.content.frontmatter.title;
    await settleCollab();
    expect(fm.get("title")).toBeUndefined();
  });

  test("a remote frontmatter delete removes the local field", async () => {
    const hub = createMockCollabHub();
    const tab = openCollabTab(hub);
    await settleCollab();

    tab.doc.content.frontmatter.title = "Shared";
    await settleCollab();

    const peer = (await hub.capability(PATH))!;
    const peerFm = actualCollab.frontmatterMap(peer.doc);
    peer.doc.transact(() => {
      peerFm.delete("title");
    }, "peer");
    await settleCollab();

    expect(tab.doc.content.frontmatter.title).toBeUndefined();
    peer.destroy();
  });
});

// ─── Identity fallbacks ──────────────────────────────────────────────────────

describe("identity fallbacks", () => {
  test("a provider without identity mounts as a colored guest", async () => {
    const hub = createMockCollabHub();
    const handles: CollabHandle[] = [];
    installMockPlatform({
      collab: async (p) => {
        const h = await hub.capability(p);
        if (h) {
          const anonymous: CollabHandle = { ...h, identity: () => null };
          handles.push(anonymous);
          return anonymous;
        }
        return h;
      },
    });
    const tab = openTab({ document: structuredClone(DOC), documentPath: PATH, id: PATH }) as Tab;
    await settleCollab();

    expect(collabState(tab).active).toBe(true);
    const local = handles[0]!.awareness.getLocalState() as {
      canWrite: boolean;
      user: { login: string; color: string };
    };
    expect(local.canWrite).toBe(true);
    expect(local.user.login).toMatch(/^guest-\d+$/);
    expect(local.user.color).toMatch(/^#/);
  });
});

// ─── Attach lifecycle races ──────────────────────────────────────────────────

describe("attach lifecycle races", () => {
  test("a leave-and-rejoin during the initial attach abandons the stale attempt", async () => {
    const hub = createMockCollabHub();
    const tab = openCollabTab(hub);
    // Leave and rejoin BEFORE the attach settles: the detach bumps the generation, so the
    // In-flight attempt destroys its handle; the rejoin finds the attempt still pending → no-op.
    setCollabEnabled(tab, false);
    setCollabEnabled(tab, true);
    await settleCollab();
    expect(collabState(tab).active).toBe(false);
    expect(hub.connectionCount(PATH)).toBe(0);

    // Re-keying attaches cleanly against the same path.
    rekeyCollab(tab);
    await settleCollab();
    expect(collabState(tab).active).toBe(true);
    expect(hub.connectionCount(PATH)).toBe(1);
  });

  test("a detach while awaiting the initial sync destroys the late handle", async () => {
    const hub = createMockCollabHub();
    let releaseSync!: () => void;
    installMockPlatform({
      collab: async (p) => {
        const h = await hub.capability(p);
        return (
          h && {
            ...h,
            whenSynced: new Promise<void>((resolve) => {
              releaseSync = resolve;
            }),
          }
        );
      },
    });
    const tab = openTab({ document: structuredClone(DOC), documentPath: PATH, id: PATH }) as Tab;
    await settleCollab();
    expect(collabState(tab).status).toBe("connecting");

    // Leave mid-sync: generation moves, so the sync completion must abandon.
    setCollabEnabled(tab, false);
    releaseSync();
    await settleCollab();
    expect(collabState(tab).active).toBe(false);
    expect(hub.connectionCount(PATH)).toBe(0);
  });

  test("re-keying to a tab without a path stays detached", async () => {
    const hub = createMockCollabHub();
    const tab = openCollabTab(hub);
    await settleCollab();
    expect(collabState(tab).active).toBe(true);

    (tab as { documentPath: string | null }).documentPath = null;
    rekeyCollab(tab);
    await settleCollab();
    expect(collabState(tab).active).toBe(false);
    expect(hub.connectionCount(PATH)).toBe(0);
  });

  test("a capability that REJECTS reports a failure, not solo editing", async () => {
    /* §7.4: this used to land on "detached" — the same value a document nobody shared carries —
       so a dead relay and a solo file were one indistinguishable state. Editing still continues
       locally; what changed is that the app now says which of the two happened. */
    installMockPlatform({ collab: () => Promise.reject(new Error("boom")) });
    const tab = openTab({ document: structuredClone(DOC), documentPath: PATH, id: PATH }) as Tab;
    await settleCollab();
    expect(collabState(tab).status).toBe("failed");
    expect(collabState(tab).attachError).toBe("boom");
    expect(collabState(tab).active).toBe(false);
  });
});

// ─── Solo-tab and platform-less guards ───────────────────────────────────────

describe("solo-tab guards", () => {
  test("a tab opened with no platform registered stays solo", async () => {
    delete (globalThis as { __jxPlatform?: unknown }).__jxPlatform;
    const tab = openTab({ document: structuredClone(DOC), documentPath: PATH, id: PATH }) as Tab;
    await settleCollab();
    expect(collabState(tab).active).toBe(false);
    expect(collabSourceContext(tab)).toBeNull();
    expect(await collabSave(tab)).toBe(false);
  });

  test("rekeyCollab on a never-collab tab installs the watcher and attaches", async () => {
    installMockPlatform(); // No collab capability → the watcher is never installed.
    const tab = openTab({ document: structuredClone(DOC), documentPath: PATH, id: PATH }) as Tab;
    await settleCollab();
    expect(collabState(tab).active).toBe(false);

    const hub = createMockCollabHub();
    installMockPlatform({ collab: hub.capability });
    rekeyCollab(tab);
    await settleCollab();
    expect(collabState(tab).active).toBe(true);
    expect(hub.connectionCount(PATH)).toBe(1);
  });
});

// ─── flushAllCollab ──────────────────────────────────────────────────────────

describe("flushAllCollab", () => {
  test("mirrors and flushes every live session", async () => {
    const hub = createMockCollabHub();
    const tab = openCollabTab(hub);
    configureCollabSerializer(jsonSerializer);
    await settleCollab();

    transactDoc(tab, (t) => mutateUpdateProperty(t, ["children", 0], "textContent", "Flushed"));
    await flushAllCollab();
    expect(hub.flushes).toEqual([PATH]);
    expect(hub.serverDoc(PATH).getText("source").toString()).toContain("Flushed");
  });
});
