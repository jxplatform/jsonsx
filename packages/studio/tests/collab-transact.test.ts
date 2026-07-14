import { installMockPlatform } from "./harness";
import { createMockCollabHub, settleCollab } from "./collab-mock";
import { toRaw } from "../src/reactivity";
import { jsonClone } from "../src/utils/studio-utils";
import { closeAllTabs, openTab } from "../src/workspace/workspace";
import { resetCollabForTests } from "../src/collab/collab-session";
import {
  beginBatch,
  endBatch,
  mutateInsertNode,
  mutateUpdateFrontmatter,
  mutateUpdateProperty,
  transact,
  transactDoc,
  undo,
} from "../src/tabs/transact";
import { applyDocOpsToY, frontmatterMap, LOCAL_ORIGIN, yDocToJson } from "@jxsuite/collab";
import type { JxMutableNode } from "@jxsuite/schema/types";
import type { Tab } from "../src/tabs/tab";
import { afterEach, describe, expect, test } from "bun:test";

const DOC: JxMutableNode = {
  children: [
    { tagName: "h1", textContent: "Title" },
    { tagName: "p", textContent: "Body" },
  ],
  tagName: "div",
};

const PATH = "pages/page.json";

async function openAttached(hub: ReturnType<typeof createMockCollabHub>) {
  installMockPlatform({ collab: hub.capability });
  const tab = openTab({ document: structuredClone(DOC), documentPath: PATH, id: PATH });
  await settleCollab();
  return tab;
}

function tabJson(tab: Tab): JxMutableNode {
  return jsonClone(toRaw(tab.doc.document)) as JxMutableNode;
}

afterEach(() => {
  closeAllTabs();
  resetCollabForTests();
});

describe("outbound publishing", () => {
  test("instrumented mutations land op-for-op in the shared tree", async () => {
    const hub = createMockCollabHub();
    const tab = await openAttached(hub);

    transactDoc(tab, (t) => mutateUpdateProperty(t, ["children", 0], "textContent", "Edited"));
    transactDoc(tab, (t) => mutateInsertNode(t, [], 2, { tagName: "footer" }));

    expect(yDocToJson(hub.serverDoc(PATH))).toEqual(tabJson(tab));
    // Local edits leave the tab dirty (explicit-save model): syncing to peers is automatic, but the
    // Save affordance stays lit until an explicit flush clears it via the server's doc-dirty.
    expect(tab.doc.dirty).toBe(true);
  });

  test("un-instrumented mutations reconcile by diff", async () => {
    const hub = createMockCollabHub();
    const tab = await openAttached(hub);

    transact(tab, (doc) => {
      (doc as { tagName?: string }).tagName = "main";
    });

    expect((yDocToJson(hub.serverDoc(PATH)) as { tagName?: string }).tagName).toBe("main");
    expect(yDocToJson(hub.serverDoc(PATH))).toEqual(tabJson(tab));
  });

  test("bypass root swaps (Monaco-style parse flush) publish via the microtask net", async () => {
    const hub = createMockCollabHub();
    const tab = await openAttached(hub);

    // Whole-document replace outside transactDoc, exactly like canvas-render's source flush.
    tab.doc.document = {
      children: [{ tagName: "article", textContent: "reparsed" }],
      tagName: "body",
    };
    await settleCollab();

    expect(yDocToJson(hub.serverDoc(PATH))).toEqual(tabJson(tab));
  });

  test("no republish loops: a quiet doc stays quiet", async () => {
    const hub = createMockCollabHub();
    const tab = await openAttached(hub);
    transactDoc(tab, (t) => mutateUpdateProperty(t, ["children", 0], "textContent", "Once"));
    await settleCollab();

    let updates = 0;
    const count = () => {
      updates += 1;
    };
    hub.serverDoc(PATH).on("update", count);
    await settleCollab(10);
    hub.serverDoc(PATH).off("update", count);
    expect(updates).toBe(0);
  });
});

describe("inbound application", () => {
  test("a peer's ops apply to the tab through the transaction pipeline", async () => {
    const hub = createMockCollabHub();
    const tab = await openAttached(hub);

    const peer = (await hub.capability(PATH))!;
    applyDocOpsToY(
      peer.doc,
      [{ key: "textContent", op: "set-key", path: ["children", 1], value: "From peer" }],
      LOCAL_ORIGIN,
    );
    await settleCollab();

    const doc = tabJson(tab) as { children: { textContent?: string }[] };
    expect(doc.children[1]!.textContent).toBe("From peer");
    // Remote edits never create local history entries.
    expect(tab.history.snapshots).toHaveLength(1);
    // A peer's edit means the shared doc now differs from disk: the room is dirty for this tab too.
    expect(tab.doc.dirty).toBe(true);
    peer.destroy();
  });

  test("concurrent local+peer sibling inserts converge on both sides", async () => {
    const hub = createMockCollabHub();
    const tab = await openAttached(hub);
    const peer = (await hub.capability(PATH))!;

    transactDoc(tab, (t) => mutateInsertNode(t, [], 0, { tagName: "local-nav" }));
    applyDocOpsToY(
      peer.doc,
      [{ index: 0, node: { tagName: "peer-aside" }, op: "insert-child", parentPath: [] }],
      LOCAL_ORIGIN,
    );
    await settleCollab();

    expect(tabJson(tab)).toEqual(yDocToJson(hub.serverDoc(PATH)));
    expect((tabJson(tab) as { children: unknown[] }).children).toHaveLength(4);
    peer.destroy();
  });
});

describe("frontmatter sync", () => {
  test("local frontmatter edits publish per-field", async () => {
    const hub = createMockCollabHub();
    const tab = await openAttached(hub);

    mutateUpdateFrontmatter(tab, "title", "New Title");
    await settleCollab();

    expect(frontmatterMap(hub.serverDoc(PATH)).get("title")).toBe("New Title");
  });

  test("peer frontmatter edits arrive per-field", async () => {
    const hub = createMockCollabHub();
    const tab = await openAttached(hub);
    const peer = (await hub.capability(PATH))!;

    peer.doc.transact(() => {
      frontmatterMap(peer.doc).set("description", "From peer");
    }, LOCAL_ORIGIN);
    await settleCollab();

    expect(tab.doc.content.frontmatter["description"]).toBe("From peer");
    peer.destroy();
  });
});

describe("batching", () => {
  test("an AI batch publishes once and undoes as one step", async () => {
    const hub = createMockCollabHub();
    const tab = await openAttached(hub);

    let serverTransactions = 0;
    hub.serverDoc(PATH).on("update", () => {
      serverTransactions += 1;
    });
    beginBatch(tab);
    transactDoc(tab, (t) => mutateUpdateProperty(t, ["children", 0], "textContent", "Step 1"));
    transactDoc(tab, (t) => mutateInsertNode(t, [], 2, { tagName: "step-two" }));
    endBatch();
    await settleCollab();

    expect(serverTransactions).toBe(1);
    expect(yDocToJson(hub.serverDoc(PATH))).toEqual(tabJson(tab));

    undo(tab);
    await settleCollab();
    const doc = tabJson(tab) as { children: { textContent?: string }[] };
    expect(doc.children[0]!.textContent).toBe("Title");
    expect(doc.children).toHaveLength(2);
    expect(yDocToJson(hub.serverDoc(PATH))).toEqual(tabJson(tab));
  });
});
