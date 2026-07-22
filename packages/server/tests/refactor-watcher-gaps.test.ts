/**
 * Refactor-watcher-gaps.test.ts — deterministic branch coverage for createFsWatcher, driven by a
 * mocked chokidar so ignored event types and debounce-timer resets can be exercised without racing
 * a real filesystem watcher.
 */

import { describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import type { FsEventPayload } from "../src/refactor/fs-events";

type AllListener = (eventType: string, changedPath: string) => void;

class FakeWatcher {
  closed = false;
  private listeners: AllListener[] = [];

  on(_event: "all", listener: AllListener): this {
    this.listeners.push(listener);
    return this;
  }

  emit(eventType: string, changedPath: string): void {
    for (const listener of this.listeners) {
      listener(eventType, changedPath);
    }
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

let lastWatcher: FakeWatcher | null = null;
void mock.module("chokidar", () => ({
  watch: () => {
    lastWatcher = new FakeWatcher();
    return lastWatcher;
  },
}));

const { createFsWatcher } = await import("../src/refactor/watcher.ts");

const ROOT = "/fake/project";

const sleep = (ms: number) =>
  new Promise((r) => {
    setTimeout(r, ms);
  });

describe("createFsWatcher — event filtering and debounce", () => {
  test("ignores payload-less event types and coalesces rapid changes into one batch", async () => {
    const batches: FsEventPayload[][] = [];
    const handle = createFsWatcher(ROOT, (events) => batches.push(events), { debounce: 20 });
    const watcher = lastWatcher!;
    try {
      // An event type toFsEvent does not map (and the root itself, whose relative path is empty)
      // Produces no payload and schedules nothing.
      watcher.emit("raw", join(ROOT, "a.json"));
      watcher.emit("unlinkDir", ROOT);
      await sleep(60);
      expect(batches).toHaveLength(0);

      // Two rapid valid events: the second clears the first's pending debounce timer, so both
      // Arrive coalesced in a single batch.
      watcher.emit("add", join(ROOT, "a.json"));
      watcher.emit("change", join(ROOT, "a.json"));
      watcher.emit("change", join(ROOT, "b.json"));
      await sleep(60);
      expect(batches).toHaveLength(1);
      expect(batches[0]).toEqual([
        { isDir: false, path: "a.json", type: "add" },
        { isDir: false, path: "b.json", type: "change" },
      ]);
    } finally {
      await handle.close();
    }
  });
});
