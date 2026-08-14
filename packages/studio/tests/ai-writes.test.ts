/**
 * Tests for src/services/ai-writes.ts — the per-turn record of what the assistant changed (§7.4).
 *
 * The two facts under test are the two the panel could not previously state: WHICH files a turn
 * changed, and which of those changes undo can reach. The second is the load-bearing one — document
 * tools go through `transactDoc`, `write_file` goes straight to disk, and the caveat used to be
 * appended to the MODEL-facing tool summary rather than shown to the person holding ⌘Z.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  MAX_TURNS,
  beginTurn,
  endTurn,
  recordWrite,
  resetAiWrites,
  summarizeWrites,
  writesForTurn,
} from "../src/services/ai-writes";

const doc = (path: string) => ({ disk: false, ok: true, path, tool: "update_style" });
const disk = (path: string) => ({ disk: true, ok: true, path, tool: "write_file" });

beforeEach(() => {
  resetAiWrites();
});

describe("recording", () => {
  test("a turn files its writes under the message id it ends on", () => {
    beginTurn("t1");
    recordWrite(doc("pages/index.json"));
    recordWrite(disk("layouts/base.json"));
    expect(endTurn("msg_7")).toHaveLength(2);
    expect(writesForTurn("msg_7").map((w) => w.path)).toEqual([
      "pages/index.json",
      "layouts/base.json",
    ]);
  });

  test("a write outside a turn costs nothing and is reported nowhere", () => {
    /* A tool invoked from a command or a test is not part of an assistant turn, and must not
       silently attach itself to whichever one happened to run last. */
    recordWrite(doc("pages/index.json"));
    beginTurn("t1");
    expect(endTurn("msg_1")).toEqual([]);
    expect(writesForTurn("msg_1")).toEqual([]);
  });

  test("beginTurn is idempotent on the same id, so a re-entered loop is still one turn", () => {
    beginTurn("t1");
    recordWrite(doc("a.json"));
    beginTurn("t1");
    recordWrite(doc("b.json"));
    expect(endTurn("msg_1").map((w) => w.path)).toEqual(["a.json", "b.json"]);
  });

  test("a turn that changed nothing files nothing — the panel renders no summary at all", () => {
    beginTurn("t1");
    expect(endTurn("msg_1")).toEqual([]);
    expect(writesForTurn("msg_1")).toEqual([]);
  });

  test("endTurn with no open turn is harmless", () => {
    expect(endTurn("msg_1")).toEqual([]);
  });

  test("the ledger is bounded — old turns drop, the messages stay", () => {
    for (let i = 0; i <= MAX_TURNS; i++) {
      beginTurn(`t${i}`);
      recordWrite(doc(`p${i}.json`));
      endTurn(`msg_${i}`);
    }
    expect(writesForTurn("msg_0")).toEqual([]);
    expect(writesForTurn(`msg_${MAX_TURNS}`)).toHaveLength(1);
  });
});

describe("summarizeWrites", () => {
  test("counts DISTINCT files, not writes", () => {
    /* Six edits to one document changed one file. "Changed 6 files" would be the same dishonesty
       in the other direction. */
    const writes = Array.from({ length: 6 }, () => doc("pages/index.json"));
    expect(summarizeWrites(writes)).toBe("Changed 1 file");
  });

  test("calls out the disk writes undo cannot reach", () => {
    expect(summarizeWrites([doc("a.json"), disk("b.json")])).toBe(
      "Changed 2 files · 1 written to disk — undo cannot reach it",
    );
  });

  test("pluralises the caveat when more than one write went to disk", () => {
    expect(summarizeWrites([disk("a.json"), disk("b.json")])).toBe(
      "Changed 2 files · 2 written to disk — undo cannot reach them",
    );
  });

  test("failures are counted separately from what landed", () => {
    const failed = { disk: true, error: "EROFS", ok: false, path: "c.json", tool: "write_file" };
    expect(summarizeWrites([doc("a.json"), failed])).toBe("Changed 1 file · 1 failed");
  });

  test("a turn where everything failed says so and claims no files", () => {
    const failed = { disk: true, error: "EROFS", ok: false, path: "c.json", tool: "write_file" };
    expect(summarizeWrites([failed, failed])).toBe("2 changes failed");
  });

  test('nothing recorded summarises to nothing, never to "Changed 0 files"', () => {
    expect(summarizeWrites([])).toBe("");
  });
});
