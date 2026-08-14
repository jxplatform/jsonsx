/**
 * Ai-writes.ts — what the assistant changed, per turn, and whether you can take it back.
 *
 * §7.4 (AI honesty). Two facts about an assistant turn were legible only to the model:
 *
 * 1. **Which files it changed.** The loop collected `result.summary` strings and fed them back into
 *    the conversation; the human got a paragraph of prose in which "I updated the hero" and "I
 *    rewrote layouts/base.json" are the same shape of sentence.
 * 2. **Which of those changes undo can reach.** Document tools mutate through `transactDoc`, so ⌘Z
 *    covers them. `write_file` and `write_project_config` go straight to disk through the platform,
 *    where there is no history and never was — and the caveat was appended to the MODEL-facing tool
 *    summary, telling the party that cannot press ⌘Z and not the party that can.
 *
 * A ledger rather than a parse of the summaries, because a summary is prose the model reads and a
 * ledger is a record the UI renders — deriving one from the other would make the panel's honesty
 * depend on the wording of a sentence written for somebody else.
 *
 * The tools record; the loop bounds the turn; the panel renders. Nothing here knows about lit, and
 * nothing here imports the loop, so a tool can be honest without either.
 */

/** One change the assistant made, as recorded by the tool that made it. */
export interface AiWrite {
  /** Project-relative path, or the document path for an in-editor mutation. */
  path: string;
  /** The tool that did it — the command title the chip renders. */
  tool: string;
  /**
   * True when the change went to disk with no transaction behind it.
   *
   * This is the undo caveat, as a fact rather than a sentence: a `disk` write is NOT reachable by
   * ⌘Z, by the tab's history, or by "Restore to here". The panel says so, in those words, to the
   * person who would otherwise press ⌘Z and believe it worked.
   */
  disk: boolean;
  /** False when the tool reported a failure — a listed attempt that changed nothing. */
  ok: boolean;
  /** Why it failed, when it did. */
  error?: string;
}

/** Every write recorded during one assistant turn, in the order the tools made them. */
export interface AiTurn {
  /** The id of the assistant message the turn produced — how the panel finds its own ledger. */
  id: string;
  writes: AiWrite[];
}

/** Completed turns, oldest first. Bounded: a session's history is the session store's job. */
const turns: AiTurn[] = [];

/** How many turns of ledger are kept. Older ones drop their summary; the messages remain. */
export const MAX_TURNS = 50;

let open: AiTurn | null = null;

/**
 * Start recording. Called by the agent loop once per user turn.
 *
 * Idempotent on the same id so a nested or re-entered loop cannot split one turn's writes across
 * two ledgers — which is the same class of bug as the batch that was opened against whichever tab
 * happened to be active.
 *
 * @param {string} id
 */
export function beginTurn(id: string): void {
  if (open?.id === id) {
    return;
  }
  open = { id, writes: [] };
}

/**
 * Record one change. A no-op when no turn is open, so a tool invoked outside the loop — a command,
 * a test — costs nothing and reports nothing.
 *
 * @param {AiWrite} write
 */
export function recordWrite(write: AiWrite): void {
  open?.writes.push(write);
}

/**
 * Close the open turn and file it under `id`.
 *
 * The id arrives at the END because it is the assistant message's id, which does not exist when the
 * turn starts — the loop opens the turn before it knows what the model will say.
 *
 * @param {string} id - The assistant message the turn produced
 * @returns {AiWrite[]} What was recorded
 */
export function endTurn(id: string): AiWrite[] {
  if (!open) {
    return [];
  }
  const turn: AiTurn = { id, writes: open.writes };
  open = null;
  if (turn.writes.length === 0) {
    return [];
  }
  turns.push(turn);
  while (turns.length > MAX_TURNS) {
    turns.shift();
  }
  return turn.writes;
}

/**
 * What the turn that produced this assistant message changed. Empty for a turn that changed
 * nothing, which is why the panel renders no summary at all rather than "Changed 0 files".
 *
 * @param {string} id
 * @returns {AiWrite[]}
 */
export function writesForTurn(id: string): AiWrite[] {
  return turns.find((turn) => turn.id === id)?.writes ?? [];
}

/**
 * The one-line summary the panel puts above the expander.
 *
 * Counts DISTINCT paths, not writes: a turn that edits the same document six times changed one
 * file, and saying "Changed 6 files" would be the same dishonesty in the other direction. Disk
 * writes are called out separately because they are the ones undo cannot reach.
 *
 * @param {AiWrite[]} writes
 * @returns {string}
 */
export function summarizeWrites(writes: AiWrite[]): string {
  const applied = writes.filter((w) => w.ok);
  const paths = new Set(applied.map((w) => w.path));
  const failed = writes.length - applied.length;
  if (paths.size === 0) {
    return failed > 0 ? `${failed} change${failed === 1 ? "" : "s"} failed` : "";
  }
  const files = `Changed ${paths.size} file${paths.size === 1 ? "" : "s"}`;
  const diskPaths = new Set(applied.filter((w) => w.disk).map((w) => w.path));
  const parts = [files];
  if (diskPaths.size > 0) {
    parts.push(
      `${diskPaths.size} written to disk — undo cannot reach ${diskPaths.size === 1 ? "it" : "them"}`,
    );
  }
  if (failed > 0) {
    parts.push(`${failed} failed`);
  }
  return parts.join(" · ");
}

/** Drop every ledger. For tests and for the "new chat" / "close project" paths. */
export function resetAiWrites(): void {
  turns.splice(0);
  open = null;
}
