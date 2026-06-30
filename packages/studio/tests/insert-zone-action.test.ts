/**
 * Tests for src/editor/insert-zone-action.ts — the cross-origin insertion "+" click handler.
 *
 * The module under test never touches `document`, and every heavy collaborator is mocked, so no DOM
 * harness is needed. The slash-menu mock captures the passed `opts` so the test can drive the inner
 * `onSelect` directly; the transact mock builds a fake transaction `t`, runs the mutation fn
 * against it, and exposes it so the test can assert the recorded selection + insert call.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { InsertZone } from "../src/canvas/iframe-protocol";

type AnyRec = Record<string, any>;

// Capture the opts passed to showSlashMenu so we can invoke its onSelect.
let capturedAnchor: AnyRec | null = null;
let capturedOpts: AnyRec | null = null;
void mock.module("../src/editor/slash-menu", () => ({
  showSlashMenu: (anchorEl: AnyRec, _filter: string, opts: AnyRec) => {
    capturedAnchor = anchorEl;
    capturedOpts = opts;
  },
}));

// The defaultDef mock returns a minimal def keyed by the tag so the test can assert it flowed through.
const defaultDefCalls: string[] = [];
void mock.module("../src/panels/shared", () => ({
  defaultDef: (tag: string) => {
    defaultDefCalls.push(tag);
    return { tagName: tag };
  },
}));

// The transactDoc mock builds a fake t and runs the mutation fn against it; mutateInsertNode is a spy.
let lastT: AnyRec | null = null;
let lastTab: AnyRec | null = null;
const insertCalls: AnyRec[] = [];
void mock.module("../src/tabs/transact", () => ({
  transactDoc: (tab: AnyRec, fn: (t: AnyRec) => void) => {
    lastTab = tab;
    const t: AnyRec = { session: { selection: null } };
    lastT = t;
    fn(t);
  },
  mutateInsertNode: (t: AnyRec, parentPath: AnyRec, index: number, def: AnyRec) => {
    insertCalls.push({ def, index, parentPath, t });
  },
}));

// The activeTab mock is the reactive ref the handler reads.
const activeTab: AnyRec = { value: { session: {} } };
void mock.module("../src/workspace/workspace", () => ({ activeTab }));

const { runInsertZoneAction } = await import("../src/editor/insert-zone-action");

const zone: InsertZone = {
  edge: "top",
  index: 2,
  insertParentPath: ["children", 0],
  rect: { height: 0, width: 0, x: 0, y: 0 },
};

beforeEach(() => {
  capturedAnchor = null;
  capturedOpts = null;
  defaultDefCalls.length = 0;
  insertCalls.length = 0;
  lastT = null;
  lastTab = null;
});

describe("runInsertZoneAction", () => {
  test("opens the slash menu anchored to the button with showFilter:true", () => {
    const btn = {} as unknown as HTMLElement;
    runInsertZoneAction(btn, zone);

    expect(capturedAnchor).toBe(btn);
    expect(capturedOpts!.showFilter).toBe(true);
    expect(typeof capturedOpts!.onSelect).toBe("function");
  });

  test("onSelect inserts the chosen tag's def and selects the new node's path", () => {
    const btn = {} as unknown as HTMLElement;
    runInsertZoneAction(btn, zone);

    capturedOpts!.onSelect({ tag: "p" });

    // The chosen tag was resolved through defaultDef.
    expect(defaultDefCalls).toEqual(["p"]);

    // The transaction ran against the active tab.
    expect(lastTab).toBe(activeTab.value);

    // The insert got (t, insertParentPath, index, def).
    expect(insertCalls.length).toBe(1);
    const call = insertCalls[0]!;
    expect(call.t).toBe(lastT);
    expect(call.parentPath).toEqual(zone.insertParentPath);
    expect(call.index).toBe(zone.index);
    expect(call.def).toEqual({ tagName: "p" });

    // The new node is selected at [...insertParentPath, "children", index].
    expect(lastT!.session.selection).toEqual([...zone.insertParentPath, "children", zone.index]);
  });
});
