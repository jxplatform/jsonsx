/**
 * Clock — the one seam every _relative_ time in Studio reads "now" through.
 *
 * Four surfaces render a duration rather than an instant: the Source Control panel's commit ages
 * and "last refreshed", the Start pane's "last opened", the chat session list's row times, and the
 * recents list those two read from. Each of them called `Date.now()` inline, which had two costs:
 *
 * 1. **They were untestable.** A formatter that reads the wall clock can only be asserted against an
 *    offset from the real present, so "yesterday" and "over a year ago" were never covered.
 * 2. **They drift.** Two captures of the same state minutes apart legitimately read `01:59 PM` and
 *    `02:04 PM` (UX-REDESIGN-PLAN §13.4 measured exactly that on the git-panel shot).
 *
 * This is deliberately NOT a global `Date.now` override. Monaco, every `setTimeout`, the collab
 * clock and the transaction log all read the real clock and must keep reading it — pinning time for
 * the whole realm hangs the editor. Four imports, four honest readers.
 *
 * `pinClock` is also what makes session restore's "last opened" honest: the value written is the
 * value the formatter reads back.
 */

/** Epoch milliseconds the clock is pinned to, or `null` while it follows the real clock. */
let _pinned: number | null = null;

/**
 * The current time in epoch milliseconds — pinned when {@link pinClock} has been called, otherwise
 * the wall clock.
 *
 * Frozen rather than offset while pinned: a shot, a test and a bug report all want the SAME answer
 * on the tenth read as on the first, and a ticking pin reintroduces exactly the drift it exists to
 * remove.
 */
export function now(): number {
  return _pinned ?? Date.now();
}

/**
 * Pin the clock to a fixed instant. Accepts epoch milliseconds, a `Date`, or anything `Date` parses
 * (the `2026-01-15T09:30:00Z` an `open.clock` field carries).
 *
 * @returns The pinned instant, in epoch milliseconds.
 * @throws {TypeError} When the value cannot be read as a time — a silently-ignored pin would
 *   photograph the wall clock and the capture would be accepted.
 */
export function pinClock(at: number | string | Date): number {
  const ms = at instanceof Date ? at.getTime() : typeof at === "number" ? at : Date.parse(at);
  if (!Number.isFinite(ms)) {
    throw new TypeError(`clock: cannot pin to ${JSON.stringify(at)}`);
  }
  _pinned = ms;
  return ms;
}

/** Release the pin; {@link now} follows the wall clock again. */
export function unpinClock(): void {
  _pinned = null;
}

/** Whether the clock is currently pinned. Read by `probe.state()` and by the tests. */
export function isClockPinned(): boolean {
  return _pinned !== null;
}
