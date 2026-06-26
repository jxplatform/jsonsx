/**
 * Render-critic.js — shadow-render grader for the AI-assistant eval harness.
 *
 * The unbuilt "6c shadow-render critic" from docs/ai-assistant-decision.md. Mounts a produced Jx
 * document with the *real* @jxsuite/runtime under happy-dom (the same render path the Studio canvas
 * uses, see packages/studio/src/canvas/canvas-live-render.ts) and reports any error it surfaces:
 * thrown errors during scope-building or node rendering, and console.error/warn (unresolved $ref /
 * $prototype, reactive-binding failures, etc.).
 *
 * Error strings are written LLM-first (Fowler's "Sensors"): each one names the failure and how to
 * fix it, so the same output can later be fed back into the live agent loop.
 *
 * @license MIT
 */

import { buildScope, renderNode, setSkipServerFunctions } from "@jxsuite/runtime";
import type { JxDocument, JxElement } from "@jxsuite/schema/types";

/** @typedef {{ pass: boolean; errors: string[] }} GradeResult */

/**
 * Phrase a captured runtime failure as an actionable correction instruction.
 *
 * @param {string} raw
 * @returns {string}
 */
function asSensorMessage(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes("must map to a .class.json")) {
    return `${raw}\n  → Fix: point the import at a "*.class.json" file, or remove the $prototype if no class is needed.`;
  }
  if (lower.includes("failed to register element") || lower.includes("defineelement")) {
    return `${raw}\n  → Fix: the custom element could not be loaded. Check the $elements $ref path resolves to a real component file.`;
  }
  if (
    lower.includes("is not defined") ||
    lower.includes("cannot read") ||
    lower.includes("undefined")
  ) {
    return `${raw}\n  → Fix: a template binding (\${...}) references state that doesn't exist. Declare it in "state" or correct the expression.`;
  }
  return raw;
}

/**
 * Shadow-render a Jx document and grade whether it renders cleanly.
 *
 * Assumes happy-dom is already registered globally (import "./with-dom.ts" once per process).
 *
 * @param {unknown} doc - The produced Jx document (raw, not reactive).
 * @returns {Promise<GradeResult>}
 */
export async function renderCritic(doc: unknown): Promise<{ pass: boolean; errors: string[] }> {
  const errors: string[] = [];

  // Capture the runtime's own diagnostics — it warns (not throws) on most soft failures
  // (unresolved $ref, bad import maps), exactly as the canvas does in production.
  const origError = console.error;
  const origWarn = console.warn;
  /** @param {unknown[]} args */
  const collect = (...args: unknown[]) => {
    errors.push(
      asSensorMessage(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ")),
    );
  };
  console.error = collect;
  console.warn = collect;

  // Off-screen container; never attached to the live document.
  const host = document.createElement("div");

  try {
    // No server-function resolution — mirrors the canvas's non-preview mode.
    // Otherwise the harness would hang on proxy calls it can't service.
    setSkipServerFunctions(true);

    const renderDoc = structuredClone(doc) as JxDocument;
    const $defs = await buildScope(renderDoc, {}, "http://eval.local/");
    const el = renderNode(renderDoc as JxElement, $defs, { _path: [] });
    host.append(el);
  } catch (error) {
    errors.push(
      asSensorMessage(`Render threw: ${error instanceof Error ? error.message : String(error)}`),
    );
  } finally {
    console.error = origError;
    console.warn = origWarn;
    host.remove();
  }

  // De-dupe — a single bad node often warns repeatedly across reactive passes.
  const unique = [...new Set(errors)];
  return { pass: unique.length === 0, errors: unique };
}
