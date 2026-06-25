/**
 * Score.js — derive the logic-only rubric axes from a settled harness run.
 *
 * Produces _objective sub-signals + evidence_ and a conservative suggested score per axis — never a
 * bare number (testing-plan §10.3: no self-serving scores; pick the lower score when uncertain).
 * Browser-only ceilings (rendered-DOM Correctness ≥4, seamless Undo/Redo) are returned as `N/A
 * (browser)` — the studio owns those.
 *
 * See docs/ai-assistant-headless-harness.md §3 Step 3.
 */

import { undo, redo } from "../../src/tabs/transact";
import { validateDoc } from "../../src/services/jx-validate";

/** @param {string} content */
function parseToolResult(content) {
  try {
    return JSON.parse(content);
  } catch {
    return { success: false, error: "(unparseable tool result)", _raw: content };
  }
}

/**
 * Extract the flat list of tool calls the model emitted, in order.
 *
 * @param {{ messages: { role: string; toolCalls?: { name: string; arguments: string }[] }[] }} chatState
 */
export function extractToolCalls(chatState) {
  const calls = [];
  for (const m of chatState.messages) {
    if (m.role === "assistant" && m.toolCalls) {
      for (const tc of m.toolCalls) calls.push({ name: tc.name, arguments: tc.arguments });
    }
  }
  return calls;
}

/**
 * Extract tool _results_ (role: "tool"), parsed, in order.
 *
 * @param {{ messages: { role: string; content: string }[] }} chatState
 */
export function extractToolResults(chatState) {
  return chatState.messages.filter((m) => m.role === "tool").map((m) => parseToolResult(m.content));
}

/**
 * Score one settled run.
 *
 * @param {object} args
 * @param {ReturnType<import("./real-llm.js").buildRealHarness>} args.harness
 * @param {number} args.rounds - Model-call count (wrap the client with countingClient to capture).
 * @param {(doc: any, ctx: object) => boolean | number | Promise<boolean | number>} [args.check] -
 *   outcome assertion. Receives the final document and a ctx ({ writes, readWritten }) so file-
 *   creation tests (Layer 3) can assert on written files. Return boolean or 0..1 fraction. Drives
 *   Completeness — independent of _which_ tools the model used (testing-plan §3.1). May be async.
 * @param {object} [args.ctx] - Extra context handed to `check` (file writes, etc.).
 * @param {boolean} [args.mustReadFirst] - Whether the task requires read_document before mutating
 *   (§5.1).
 * @returns {Promise<object>}
 */
export async function scoreRun({ harness, rounds, check, ctx = {}, mustReadFirst = false }) {
  const { chatState, tab } = harness;
  const calls = extractToolCalls(chatState);
  const results = extractToolResults(chatState);
  const doc = rawDoc(tab);
  const noToolCalls = calls.length === 0;

  // ── Completeness: did the document actually reach the goal state? ──
  let completeness;
  if (noToolCalls) {
    completeness = { score: 1, why: "model emitted no tool calls" };
  } else if (!check) {
    completeness = {
      score: 3,
      why: "no outcome assertion defined — tools fired, result unverified",
    };
  } else {
    const r = await check(doc, ctx);
    const frac = typeof r === "number" ? r : r ? 1 : 0;
    completeness =
      frac >= 1
        ? { score: 5, why: "outcome assertion fully satisfied" }
        : frac > 0
          ? { score: 3, why: `outcome partially met (${Math.round(frac * 100)}%)` }
          : { score: 2, why: "tools fired but the goal state was not reached" };
  }

  // ── Read-first (§5.1 hard constraint): mutating before reading is a Correctness/Recovery risk. ──
  const MUTATORS = new Set([
    "set_property",
    "set_style",
    "set_text",
    "add_child",
    "remove_node",
    "move_node",
    "add_state",
    "update_state",
    "create_component",
    "create_page",
  ]);
  const firstMutatorIdx = calls.findIndex((c) => MUTATORS.has(c.name));
  const readBeforeMutate =
    firstMutatorIdx === -1 ||
    calls.slice(0, firstMutatorIdx).some((c) => c.name === "read_document");
  const readFirst = !mustReadFirst
    ? { ok: true, why: "N/A — read-first not required for this task" }
    : readBeforeMutate
      ? { ok: true, why: "read_document preceded the first mutation" }
      : { ok: false, why: "mutated before reading — guessed paths instead of reading (§5.1)" };

  // ── Efficiency: fewer model rounds is better, but the mandatory read_document is NOT a cost
  // (§3.1) — discount one round when the task required reading first and the model complied, so a
  // clean read→mutate→wrap scores like a 2-round mutate→wrap rather than being capped at 3. ──
  const readDiscount =
    mustReadFirst && readFirst.ok && calls.some((c) => c.name === "read_document") ? 1 : 0;
  const effRounds = Math.max(1, rounds - readDiscount);
  const effScore = noToolCalls ? 1 : Math.max(1, 6 - Math.min(effRounds, 5));
  const efficiency = {
    score: effScore,
    why: readDiscount
      ? `${rounds} round(s), ${effRounds} after discounting the mandatory read (§3.1)`
      : `${rounds} model round(s)`,
  };

  // ── Recovery: only meaningful when a tool returned success:false ──
  const failures = results.filter((r) => r.success === false);
  const finalErrors = await validateDoc(doc);
  const recovery =
    failures.length === 0
      ? { score: 5, why: "N/A — no tool failures", na: true }
      : finalErrors.length === 0
        ? {
            score: 4,
            why: `${failures.length} failure(s), but final doc is valid (self-corrected)`,
          }
        : { score: 2, why: `${failures.length} failure(s); doc still invalid: ${finalErrors[0]}` };

  // ── Correctness floor: schema-valid is the floor (≥3); ceiling needs rendered DOM (browser) ──
  const correctness =
    finalErrors.length === 0
      ? {
          score: 3,
          why: "schema-valid (floor). Ceiling ≥4 requires rendered-DOM check in studio.",
          ceiling: "N/A (browser)",
        }
      : { score: 1, why: `schema-invalid: ${finalErrors[0]}` };

  // ── Undo (partial): revert to the pre-run snapshot, then redo. Seamless Ctrl+Z/Y is browser. ──
  const undoResult = checkUndoRedo(tab);

  return {
    model: harness.model,
    rounds,
    toolCalls: calls.map((c) => c.name),
    readFirst,
    axes: {
      completeness,
      correctness,
      efficiency,
      recovery,
      undo: undoResult,
    },
    evidence: {
      toolCalls: calls,
      toolResults: results,
      finalDocValid: finalErrors.length === 0,
      finalErrors,
      readFirst,
    },
  };
}

/** Deep-clone the live doc out of the reactive proxy for validation/comparison. */
function rawDoc(tab) {
  return JSON.parse(JSON.stringify(tab.doc.document));
}

/**
 * Undo back to the original snapshot, confirm it reverts, then redo to confirm re-apply. Returns a
 * partial Undo/Redo axis result — the seamless-keybinding ceiling stays in the studio.
 *
 * @param {import("../../src/tabs/tab").Tab} tab
 */
function checkUndoRedo(tab) {
  const original = JSON.stringify(tab.history.snapshots[0]?.document ?? null);
  const afterEdit = JSON.stringify(tab.doc.document);

  if (afterEdit === original) {
    return { score: 5, why: "N/A — run made no undoable change", na: true };
  }

  // Walk undo back to index 0.
  let guard = 0;
  while (tab.history.index > 0 && guard++ < 50) undo(tab);
  const afterUndo = JSON.stringify(tab.doc.document);
  const reverted = afterUndo === original;

  // Redo forward again.
  let guard2 = 0;
  while (tab.history.index < tab.history.snapshots.length - 1 && guard2++ < 50) redo(tab);
  const afterRedo = JSON.stringify(tab.doc.document);
  const reapplied = afterRedo === afterEdit;

  if (reverted && reapplied) {
    return {
      score: 4,
      why: "undo reverted to original + redo re-applied (ceiling 5 = seamless Ctrl+Z/Y, browser)",
    };
  }
  if (reverted) {
    return { score: 3, why: "undo reverted, but redo did not restore the edited state" };
  }
  return { score: 1, why: "undo did not return to the original snapshot" };
}
