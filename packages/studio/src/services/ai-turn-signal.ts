/**
 * Ai-turn-signal.ts — the running turn's AbortSignal, readable from inside a tool.
 *
 * `ToolRegistry.execute(name, args)` takes no signal, and its signature is fixed in the published
 * `@jxsuite/ai`. So `runAgentLoop` could hand its signal to `streamChat` and to nothing else: a tool
 * that ran for minutes (an import) could not be cancelled, and a tool that waits for a human
 * (`ask_user`) would have hung on Stop forever, because the promise the loop is awaiting has no
 * other way to learn the turn is over.
 *
 * An ambient slot rather than a parameter, for the same reason `services/ai-writes.ts` is one: the
 * loop already brackets each turn with `beginTurn`/`endTurn` in a try/finally, and this rides that
 * bracket. Only one turn runs at a time — `sendMessage` and `beginAssistantTurn` are both no-ops
 * while streaming — so a module-level slot is the whole of the state.
 *
 * @license MIT
 */

let _signal: AbortSignal | undefined;

/**
 * Publish the turn's signal for the tools it will run. Called by `runAgentLoop`.
 *
 * @param {AbortSignal} [signal] - The turn's signal; `undefined` leaves tools uncancellable, which
 *   is what a caller that passed no signal asked for.
 */
export function beginTurnSignal(signal?: AbortSignal): void {
  _signal = signal;
}

/**
 * The running turn's signal, or `undefined` outside a turn.
 *
 * A tool must treat `undefined` as "not cancellable" rather than as an error: the evals runner and
 * several tests drive the loop with no signal at all.
 *
 * @returns {AbortSignal | undefined}
 */
export function turnSignal(): AbortSignal | undefined {
  return _signal;
}

/** Clear the slot. Called from `runAgentLoop`'s `finally`, so it runs on every exit path. */
export function endTurnSignal(): void {
  _signal = undefined;
}
