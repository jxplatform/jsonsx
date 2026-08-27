/**
 * The backend-connection watcher.
 *
 * The bug it exists for: the chromium desktop shell holds one long-lived WebSocket, and when it
 * died every later PAL call returned a promise that NEVER SETTLED — `WebSocket.send()` on a closed
 * socket discards the frame instead of throwing. Nothing rejected, nothing resolved, and the
 * visible symptom was **Open Project** doing nothing at all. The transport rejects those calls now;
 * this is the other half, which is telling a person which of "it is broken" and "it is coming back"
 * they are in.
 */
import { installMockPlatform } from "./harness";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { watchConnection } from "../src/services/connection";
import { problems, resetNotifications, toasts } from "../src/services/notify";
import type { StudioPlatform } from "../src/types";

type Listener = (state: { online: boolean; reason?: string }) => void;

/** Install a platform that can report its connection, and return the hook that drives it. */
function withConnection(): { emit: Listener; unsubscribed: () => boolean } {
  let listener: Listener | null = null;
  let stopped = false;
  installMockPlatform({
    subscribeConnection: (handler: Listener) => {
      listener = handler;
      return () => {
        stopped = true;
        listener = null;
      };
    },
  } as Partial<StudioPlatform>);
  return {
    emit: (state) => listener?.(state),
    unsubscribed: () => stopped,
  };
}

/** The live watcher, stopped between tests — its unsubscribe is what clears its module state. */
let stopWatching: (() => void) | null = null;

/** Start the watcher and remember how to stop it. */
function start(): void {
  stopWatching = watchConnection();
}

beforeEach(() => {
  resetNotifications();
});

afterEach(() => {
  stopWatching?.();
  stopWatching = null;
  resetNotifications();
});

describe("watchConnection", () => {
  test("installs nothing on a platform with no connection to lose", () => {
    // The dev server talks over fetch; a notice about a socket it does not have would be a lie.
    installMockPlatform({} as Partial<StudioPlatform>);
    expect(watchConnection()).toBeNull();
  });

  test("a disconnection is a problem, with the transport's own words", () => {
    const { emit } = withConnection();
    start();
    emit({ online: false, reason: "Lost connection to the Jx backend — reconnecting…" });

    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toContain("Lost connection");
    expect(problems[0]!.source).toBe("Backend");
  });

  test("a retry that fails is the same state, not a new row", () => {
    const { emit } = withConnection();
    start();
    emit({ online: false });
    emit({ online: false });
    emit({ online: false });
    expect(problems).toHaveLength(1);
  });

  test("recovery retires the problem and says so", () => {
    const { emit } = withConnection();
    start();
    emit({ online: false });
    expect(problems).toHaveLength(1);

    emit({ online: true });
    expect(problems).toHaveLength(0);
    expect(toasts.at(-1)?.message).toContain("Reconnected");
  });

  test("an online signal with nothing outstanding announces nothing", () => {
    // The socket opening for the first time is not a recovery.
    const { emit } = withConnection();
    start();
    emit({ online: true });
    expect(toasts).toHaveLength(0);
    expect(problems).toHaveLength(0);
  });

  test("unsubscribing takes the notice with it", () => {
    /* The watcher is the only thing that would ever have dismissed it, so leaving it behind would
       leave a report on the Problems list that nobody can clear. */
    const { emit, unsubscribed } = withConnection();
    start();
    emit({ online: false });
    expect(problems).toHaveLength(1);

    stopWatching!();
    stopWatching = null;
    expect(unsubscribed()).toBe(true);
    expect(problems).toHaveLength(0);
  });
});
