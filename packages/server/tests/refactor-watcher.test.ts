import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFsWatcher } from "../src/refactor/index";
import type { FsEventPayload } from "../src/refactor/index";

const FIXTURES = join(import.meta.dir, "_fixtures_fs_watcher");

const sleep = (ms: number) =>
  new Promise((r) => {
    setTimeout(r, ms);
  });

describe("createFsWatcher", () => {
  test("delivers a coalesced batch of fs events to the sink", async () => {
    mkdirSync(FIXTURES, { recursive: true });
    const batches: FsEventPayload[][] = [];
    const handle = createFsWatcher(FIXTURES, (events) => batches.push(events), { debounce: 20 });
    try {
      // Let chokidar settle before writing.
      await sleep(150);
      writeFileSync(join(FIXTURES, "note.json"), `{"v":${Date.now()}}`);

      const start = Date.now();
      while (batches.length === 0 && Date.now() - start < 3000) {
        await sleep(25);
      }
      expect(batches.length).toBeGreaterThan(0);
      expect(batches[0]?.some((e) => e.path === "note.json")).toBe(true);
    } finally {
      await handle.close();
      rmSync(FIXTURES, { force: true, recursive: true });
    }
  });

  test("close() is safe to call before any event fires", async () => {
    mkdirSync(FIXTURES, { recursive: true });
    const handle = createFsWatcher(FIXTURES, () => {});
    await handle.close();
    rmSync(FIXTURES, { force: true, recursive: true });
    expect(true).toBe(true);
  });
});
