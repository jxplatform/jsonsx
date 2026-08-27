/**
 * The backend connection, said out loud.
 *
 * Only one launcher can lose a backend mid-session: the chromium desktop shell holds a single
 * long-lived WebSocket to its project server. When that socket died, every later call returned a
 * promise that NEVER SETTLED — `WebSocket.send()` on a closed socket discards the frame instead of
 * throwing, so nothing rejected, nothing resolved, and the visible symptom was **Open Project**
 * doing nothing at all. No toast, no log, no failed state. Restarting Studio was the only
 * recovery.
 *
 * The transport now rejects those calls, and this is the other half: a person needs to be told
 * which of "it is broken" and "it is coming back" they are in. One keyed problem so a flapping
 * connection cannot stack up a column of identical rows, dismissed on recovery so a fixed thing
 * does not stay on the Problems list (§16.1's third tier, and §16.6's rule that a record is retired
 * by whoever owns its life).
 *
 * A platform without `subscribeConnection` — the dev server, electrobun — installs nothing. There
 * is no connection to lose there, and a notice about one would be a lie.
 *
 * @docs studio/interface/problems-and-progress
 */

import { getPlatform } from "../platform";
import { dismiss, notify } from "./notify";
import type { Notification } from "./notify";

/** One key for every connection notice, so a flapping socket replaces rather than accumulates. */
const CONNECTION_KEY = "platform:connection";

/** The outstanding "we are disconnected" record, so recovery can retire it. */
let outstanding: Notification | null = null;

/**
 * Start reporting the backend connection. Returns an unsubscribe, or null on a platform that has no
 * connection to report.
 *
 * @returns {(() => void) | null}
 */
export function watchConnection(): (() => void) | null {
  const subscribe = getPlatform().subscribeConnection;
  if (!subscribe) {
    return null;
  }
  const unsubscribe = subscribe(({ online, reason }) => {
    if (online) {
      if (outstanding) {
        dismiss(outstanding.id);
        outstanding = null;
        notify.success("Reconnected to the Jx backend.", { source: "Backend" });
      }
      return;
    }
    /* Already reported. A reconnect attempt failing is the same state, not a new one. */
    if (outstanding) {
      return;
    }
    outstanding = notify.error(reason ?? "Lost connection to the Jx backend.", {
      detail:
        "Editing continues, but anything that reads or writes files will fail until it comes " +
        "back. Studio is retrying.",
      key: CONNECTION_KEY,
      source: "Backend",
    });
  });
  /* Unsubscribing retires the notice with it: the watcher is the only thing that would ever have
     dismissed it, so leaving it on the Problems list would leave a report nobody can clear. */
  return () => {
    unsubscribe();
    if (outstanding) {
      dismiss(outstanding.id);
      outstanding = null;
    }
  };
}
