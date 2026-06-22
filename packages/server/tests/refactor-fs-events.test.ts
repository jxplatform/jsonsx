import { describe, expect, test } from "bun:test";
import { coalesceFsEvents, toFsEvent } from "../src/refactor/fs-events";
import type { FsEventPayload } from "../src/refactor/fs-events";

/** Fold a list of events through the coalescer (replaces Array#reduce per lint rules). */
function fold(events: FsEventPayload[]): FsEventPayload[] {
  let acc: FsEventPayload[] = [];
  for (const e of events) {
    acc = coalesceFsEvents(acc, e);
  }
  return acc;
}

describe("toFsEvent", () => {
  test("maps a file add to a root-relative payload", () => {
    expect(toFsEvent("add", "/p", "/p/a.json")).toEqual({
      isDir: false,
      path: "a.json",
      type: "add",
    });
  });

  test("flags directory events and nests paths", () => {
    expect(toFsEvent("addDir", "/p", "/p/sub")).toEqual({
      isDir: true,
      path: "sub",
      type: "addDir",
    });
    expect(toFsEvent("unlink", "/p", "/p/x/y.json")?.path).toBe("x/y.json");
  });

  test("ignores non-fs chokidar events", () => {
    expect(toFsEvent("ready", "/p", "/p/a.json")).toBeNull();
    expect(toFsEvent("raw", "/p", "/p/a.json")).toBeNull();
  });

  test("rejects the root itself and paths outside it", () => {
    expect(toFsEvent("add", "/p", "/p")).toBeNull();
    expect(toFsEvent("add", "/p", "/other/z.json")).toBeNull();
  });
});

const ev = (type: FsEventPayload["type"], path: string): FsEventPayload => ({
  isDir: type === "addDir" || type === "unlinkDir",
  path,
  type,
});

describe("coalesceFsEvents", () => {
  test("appends events for distinct paths", () => {
    const out = fold([ev("add", "a")]);
    expect(coalesceFsEvents(out, ev("add", "b"))).toHaveLength(2);
  });

  test("add + unlink cancels", () => {
    expect(coalesceFsEvents([ev("add", "a")], ev("unlink", "a"))).toEqual([]);
    expect(coalesceFsEvents([ev("addDir", "s")], ev("unlinkDir", "s"))).toEqual([]);
  });

  test("add + change stays add", () => {
    expect(coalesceFsEvents([ev("add", "a")], ev("change", "a"))).toEqual([ev("add", "a")]);
  });

  test("unlink + add becomes a re-add", () => {
    expect(coalesceFsEvents([ev("unlink", "a")], ev("add", "a"))).toEqual([ev("add", "a")]);
  });

  test("change + unlink ends as unlink (last-wins)", () => {
    expect(coalesceFsEvents([ev("change", "a")], ev("unlink", "a"))).toEqual([ev("unlink", "a")]);
  });

  test("folding a burst collapses transient files", () => {
    const burst = [ev("add", "a"), ev("change", "a"), ev("add", "b"), ev("unlink", "b")];
    expect(fold(burst)).toEqual([ev("add", "a")]);
  });
});
