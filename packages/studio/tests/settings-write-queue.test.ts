/**
 * Tests for src/services/settings/write-queue.ts — the coalescing, serializing write queue.
 *
 * The scheduler is injected throughout, so "the end of the burst" is a point the test decides
 * rather than a microtask it has to guess at. Both guarantees are tested separately because they
 * are different: coalescing is about how MANY sends go out, serializing is about their ORDER.
 */
import { describe, expect, test } from "bun:test";
import { createWriteQueue } from "../src/services/settings/write-queue";
import type { SettingsPatch } from "../src/services/settings/write-queue";

/** A queue whose flush runs only when the test says so. */
function manualQueue(send: (patch: SettingsPatch) => Promise<void>) {
  const scheduled: (() => void)[] = [];
  const errors: { error: unknown; patch: SettingsPatch }[] = [];
  const queue = createWriteQueue({
    onError: (error, patch) => errors.push({ error, patch }),
    schedule: (run) => scheduled.push(run),
    send,
  });
  return {
    errors,
    queue,
    /** Run every flush scheduled so far. */
    tick() {
      const due = scheduled.splice(0);
      for (const run of due) {
        run();
      }
    },
  };
}

describe("coalescing", () => {
  test("three enqueues in one burst produce ONE send with the merged patch", async () => {
    const sent: SettingsPatch[] = [];
    const { queue, tick } = manualQueue(async (patch) => {
      sent.push(patch);
    });
    queue.enqueue({ a: "1" });
    queue.enqueue({ b: "2" });
    queue.enqueue({ c: "3" });
    expect(sent).toEqual([]); // Nothing goes out mid-burst.
    tick();
    await queue.settled();
    expect(sent).toEqual([{ a: "1", b: "2", c: "3" }]);
  });

  test("a later value for the same key wins within a burst", async () => {
    const sent: SettingsPatch[] = [];
    const { queue, tick } = manualQueue(async (patch) => {
      sent.push(patch);
    });
    queue.enqueue({ model: "first" });
    queue.enqueue({ model: "second" });
    tick();
    await queue.settled();
    expect(sent).toEqual([{ model: "second" }]);
  });

  /** A null is a deletion, and must survive coalescing rather than being treated as absent. */
  test("a deletion merges like any other value", async () => {
    const sent: SettingsPatch[] = [];
    const { queue, tick } = manualQueue(async (patch) => {
      sent.push(patch);
    });
    queue.enqueue({ key: "sk-x" });
    queue.enqueue({ key: null });
    tick();
    await queue.settled();
    expect(sent).toEqual([{ key: null }]);
  });

  /**
   * A scheduler that runs the same flush twice must not send twice — the burst was handed over on
   * the first call, and `pending` is empty by the second.
   */
  test("running a scheduled flush twice sends once", async () => {
    const sent: SettingsPatch[] = [];
    let scheduled: (() => void) | null = null;
    const queue = createWriteQueue({
      schedule: (run) => {
        scheduled = run;
      },
      send: async (patch) => {
        sent.push(patch);
      },
    });
    queue.enqueue({ a: "1" });
    scheduled!();
    scheduled!();
    await queue.settled();
    expect(sent).toEqual([{ a: "1" }]);
  });

  test("a second burst is its own send", async () => {
    const sent: SettingsPatch[] = [];
    const { queue, tick } = manualQueue(async (patch) => {
      sent.push(patch);
    });
    queue.enqueue({ a: "1" });
    tick();
    await queue.settled();
    queue.enqueue({ b: "2" });
    tick();
    await queue.settled();
    expect(sent).toEqual([{ a: "1" }, { b: "2" }]);
  });
});

describe("serializing", () => {
  /**
   * The defect: N overlapping writes against one file, each with a different snapshot and no
   * ordering, so whichever landed last won.
   */
  test("a send never overlaps the one before it", async () => {
    const events: string[] = [];
    let release: (() => void) | null = null;
    const { queue, tick } = manualQueue(async (patch) => {
      const [name] = Object.keys(patch);
      events.push(`start:${name}`);
      if (name === "first") {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      events.push(`end:${name}`);
    });

    queue.enqueue({ first: "1" });
    tick();
    await Promise.resolve();
    queue.enqueue({ second: "2" });
    tick();
    // The second send must not have started while the first is still out.
    await Promise.resolve();
    expect(events).toEqual(["start:first"]);

    release!();
    await queue.settled();
    expect(events).toEqual(["start:first", "end:first", "start:second", "end:second"]);
  });
});

describe("failure", () => {
  test("reports the error with the patch that did not land", async () => {
    const boom = new Error("write failed");
    const { errors, queue, tick } = manualQueue(async () => {
      throw boom;
    });
    queue.enqueue({ key: "sk-x" });
    tick();
    await queue.settled();
    expect(errors).toEqual([{ error: boom, patch: { key: "sk-x" } }]);
  });

  /** One failed write must not poison the chain — the next is still delivered. */
  test("keeps sending after a failure", async () => {
    const sent: SettingsPatch[] = [];
    let failNext = true;
    const { queue, tick } = manualQueue(async (patch) => {
      if (failNext) {
        failNext = false;
        throw new Error("write failed");
      }
      sent.push(patch);
    });
    queue.enqueue({ a: "1" });
    tick();
    await queue.settled();
    queue.enqueue({ b: "2" });
    tick();
    await queue.settled();
    expect(sent).toEqual([{ b: "2" }]);
  });

  test("a failure with no onError is still absorbed", async () => {
    const queue = createWriteQueue({
      schedule: (run) => run(),
      send: async () => {
        throw new Error("write failed");
      },
    });
    queue.enqueue({ a: "1" });
    await queue.settled(); // Must not reject.
  });
});

describe("defaults", () => {
  test("settled() resolves when nothing was ever enqueued", async () => {
    const queue = createWriteQueue({ send: async () => {} });
    await queue.settled();
  });

  test("without an injected scheduler the burst goes out on a microtask", async () => {
    const sent: SettingsPatch[] = [];
    const queue = createWriteQueue({
      send: async (patch) => {
        sent.push(patch);
      },
    });
    queue.enqueue({ a: "1" });
    queue.enqueue({ b: "2" });
    expect(sent).toEqual([]); // Still the same synchronous turn.
    await queue.settled();
    expect(sent).toEqual([{ a: "1", b: "2" }]);
  });
});
