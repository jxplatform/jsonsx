/**
 * Ai-turn-signal.ts — what the agent loop knows that a tool needs and cannot be passed.
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

/** Clear the slots. Called from `runAgentLoop`'s `finally`, so it runs on every exit path. */
export function endTurnSignal(): void {
  _signal = undefined;
  _toolCallId = "";
}

let _toolCallId = "";

/**
 * Publish the id of the call about to execute. Called by `runAgentLoop` per tool call.
 *
 * A tool that outlives its own execution — `ask_user`, whose question stays on screen until a human
 * answers — needs the id to join what it registered to the chip the transcript is drawing. Without
 * it a restored, permanently unanswered question is indistinguishable from the live one.
 *
 * @param {string} id
 */
export function beginToolCall(id: string): void {
  _toolCallId = id;
}

/**
 * The id of the tool call currently executing, or `""` outside one.
 *
 * @returns {string}
 */
export function currentToolCallId(): string {
  return _toolCallId;
}
