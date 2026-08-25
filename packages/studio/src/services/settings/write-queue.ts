/**
 * A coalescing, serializing write queue.
 *
 * The defect it exists to make unrepresentable: saving a provider mutates three settings through
 * three setters, and each setter used to fire its own whole-map write. Three overlapping writes went
 * out against one file, each reading storage at a different moment, with no ordering between them —
 * so whichever landed last won. That was observed in the wild as a settings file holding
 * `{"jx.ai.model": "gpt-4o"}`: the SECOND of three snapshots, landing last, a state storage itself
 * never rested in.
 *
 * Two rules, and they are different guarantees:
 *
 * 1.  **Coalesce.** Every mutation in one synchronous burst merges into a single patch, sent once
 *     the burst has finished. N setters produce one write, not N.
 * 2.  **Serialize.** At most one send is in flight. A mutation made while one is out waits for it
 *     rather than racing it, so the order the app made changes in is the order the store sees them.
 *
 * Generic over the transport so the kernel can hand it a platform call and a test can hand it an
 * array. `schedule` is injectable for the same reason.
 *
 * @license MIT
 */

/**
 * A set of changes to apply. `null` DELETES the key; a key named by neither map is left alone.
 *
 * That is the whole difference from the whole-map replace this supersedes: a writer that says
 * nothing about a key cannot destroy it, so a window with a stale or empty view of settings can no
 * longer clear a sibling window's.
 */
export type SettingsPatch = Record<string, string | null>;

export interface WriteQueueOptions {
  /** Deliver one merged patch. Rejection is reported through {@link WriteQueueOptions.onError}. */
  send: (patch: SettingsPatch) => Promise<void>;
  /** Called with the failure and the patch that did not land. */
  onError?: (error: unknown, patch: SettingsPatch) => void;
  /**
   * Defer to the end of the current burst. Defaults to `queueMicrotask`.
   *
   * A microtask rather than a timer: the burst is synchronous, so the patch goes out in the same
   * turn the user acted in, and nothing can observe a half-applied save.
   */
  schedule?: (run: () => void) => void;
}

export interface WriteQueue {
  /** Merge `patch` into the pending one, scheduling a send if none is pending. */
  enqueue: (patch: SettingsPatch) => void;
  /** Resolves when everything enqueued so far has been sent (or has failed and been reported). */
  settled: () => Promise<void>;
}

/**
 * Create a queue over `send`.
 *
 * @param {WriteQueueOptions} opts
 * @returns {WriteQueue}
 */
export function createWriteQueue(opts: WriteQueueOptions): WriteQueue {
  const schedule = opts.schedule ?? queueMicrotask;

  /** Merged changes not yet handed to `send`; null when nothing is waiting. */
  let pending: SettingsPatch | null = null;

  /**
   * The chain every send is appended to.
   *
   * Always resolved — each link ends in a handler — so one failed write cannot poison the writes
   * queued behind it.
   */
  let tail: Promise<void> = Promise.resolve();

  /**
   * Resolves when the most recently scheduled burst has been sent.
   *
   * Tracked explicitly rather than inferred from {@link tail}: a caller that enqueues and then
   * awaits would otherwise be awaiting the tail as it stood BEFORE its own patch joined it, and
   * whether that happens to work depends on how many turns the scheduler takes.
   */
  let idle: Promise<void> = Promise.resolve();

  /** Hand the merged burst to `send`, appended to the chain. */
  function flush(): Promise<void> {
    const patch = pending;
    pending = null;
    if (!patch) {
      return tail;
    }
    tail = tail
      .then(() => opts.send(patch))
      .catch((error: unknown) => {
        opts.onError?.(error, patch);
      });
    return tail;
  }

  return {
    enqueue(patch: SettingsPatch) {
      if (pending) {
        Object.assign(pending, patch);
        return;
      }
      pending = { ...patch };
      idle = new Promise<void>((resolve) => {
        schedule(() => {
          void flush().then(resolve);
        });
      });
    },

    settled() {
      return idle;
    },
  };
}
