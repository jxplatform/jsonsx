/**
 * Ai-ask.ts — the assistant's one way to stop and put a question to the author.
 *
 * The agent loop `await`s `toolRegistry.execute` (`services/tool-executor.ts`), so a tool that
 * returns a pending promise suspends the turn. That is the whole mechanism: `ask_user` registers a
 * question, hands back a promise, and the panel resolves it when the human answers. No new chat
 * status, no pre-execution hook, and nothing in the published `@jxsuite/ai` changes —
 * `finishStream` has already set the state to `"idle"` by the time tools run, so a suspended turn
 * is idle by construction and this store is what "waiting" means.
 *
 * Two decisions are load-bearing and easy to get wrong on a rewrite:
 *
 * - **A skip is a SUCCESS.** "You decide" is a real answer to a question; only a stopped turn is a
 *   failure. Reporting a skip as an error would make the model apologise for having asked.
 * - **The answer never becomes a user message.** `toMessagesArray` serialises the array verbatim
 *   and a provider requires a `tool` reply to follow its `tool_calls` request; a user turn spliced
 *   between them is a 400. The answer travels as the tool result, and the chat view renders it into
 *   the question's own chip.
 *
 * Exactly one question can be outstanding, because `runAgentLoop` executes a round's tool calls
 * serially. The guard below is defensive, not load-bearing.
 *
 * @license MIT
 */

import { createToolDefinition, toolError, toolSuccess } from "@jxsuite/ai/tools";
import { reactive } from "../reactivity";
import { currentToolCallId, turnSignal } from "./ai-turn-signal";

import type { ToolRegistry } from "@jxsuite/ai/tools";

/** A question the assistant is waiting on. `id` is the tool-call id, so the chip and this agree. */
export interface PendingAsk {
  id: string;
  question: string;
  /** Short choices rendered as buttons. Free text is always allowed alongside them. */
  options: string[];
  /** One line of why-I'm-asking, rendered under the question. */
  context: string;
}

/** How a question was settled. `answer: null` with `skipped` is the author saying "you decide". */
export interface AskAnswer {
  answer: string | null;
  skipped: boolean;
}

/** Max choices rendered as buttons; beyond this the question wants free text, not a menu. */
const MAX_OPTIONS = 6;

const state = reactive<{ pending: PendingAsk | null }>({ pending: null });

/** The resolver for {@link state.pending}, kept out of the reactive object (it is not render data). */
let settle: ((answer: AskAnswer) => void) | null = null;

/** Torn down with the question so a stopped turn does not leave a listener on a dead signal. */
let detachAbort: (() => void) | null = null;

function clear() {
  state.pending = null;
  settle = null;
  detachAbort?.();
  detachAbort = null;
}

/**
 * The outstanding question, or null. Reactive — read it inside an `effect()` to repaint on it.
 *
 * @returns {PendingAsk | null}
 */
export function pendingAsk(): PendingAsk | null {
  return state.pending;
}

/** Whether a turn is suspended on the author. The composer's Send becomes Answer on this. */
export function isAwaitingAnswer(): boolean {
  return state.pending !== null;
}

/**
 * Register a question and suspend until it is settled.
 *
 * @param {PendingAsk} ask
 * @returns {Promise<AskAnswer>} Resolves on an answer, a skip, or the turn being stopped (`{
 *   answer: null, skipped: false }` — the shape the tool reports as a failure).
 */
export function askUser(ask: PendingAsk): Promise<AskAnswer> {
  return new Promise<AskAnswer>((resolve) => {
    state.pending = ask;
    settle = resolve;

    /* The turn's signal, not a parameter: `ToolRegistry.execute` has nowhere to pass one. Without
       this, Stop would leave the loop awaiting a promise nothing could ever resolve. */
    const signal = turnSignal();
    if (signal?.aborted) {
      clear();
      resolve({ answer: null, skipped: false });
      return;
    }
    if (signal) {
      const onAbort = () => {
        cancelAsk();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      detachAbort = () => signal.removeEventListener("abort", onAbort);
    }
  });
}

/**
 * Answer the outstanding question.
 *
 * @param {string} text
 * @returns {boolean} False when nothing was pending, so a caller can fall through to a normal send.
 */
export function answerAsk(text: string): boolean {
  if (!settle) {
    return false;
  }
  const resolve = settle;
  clear();
  resolve({ answer: text, skipped: false });
  return true;
}

/**
 * Decline to answer — "you decide". Settles as a success, so the turn carries on.
 *
 * @returns {boolean} False when nothing was pending.
 */
export function skipAsk(): boolean {
  if (!settle) {
    return false;
  }
  const resolve = settle;
  clear();
  resolve({ answer: null, skipped: true });
  return true;
}

/** Settle an outstanding question as unanswered. Called from `stop()` and from the turn's abort. */
export function cancelAsk(): void {
  if (!settle) {
    return;
  }
  const resolve = settle;
  clear();
  resolve({ answer: null, skipped: false });
}

/** Drop any outstanding question without settling a turn. For New Chat and for tests. */
export function resetAsk(): void {
  cancelAsk();
  clear();
}

/**
 * Register `ask_user` into a tool registry.
 *
 * The description carries the discipline the tool needs to be worth having: a question the model
 * could have answered itself is noise, and a question about a setting the pipeline never receives
 * is worse than noise, because the answer cannot be honoured.
 *
 * @param {Pick<ToolRegistry, "register">} registry
 */
export function registerAskTool(registry: Pick<ToolRegistry, "register">): void {
  registry.register(
    createToolDefinition({
      name: "ask_user",
      description:
        "Pause and put a question to the user; the turn waits for their reply and resumes with " +
        "it. Use it ONLY for a judgement that is genuinely theirs — which pages matter, whether to " +
        "keep the original design, whether a low-fidelity page is acceptable. Never ask something " +
        "you can decide yourself or discover with another tool, and never ask about an option you " +
        "cannot act on. One question at a time; offer options when the sensible answers are a " +
        "short list, and the user may always reply in their own words instead.",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "The question, in one sentence, addressed to the user.",
          },
          options: {
            type: "array",
            items: { type: "string" },
            description:
              `Up to ${MAX_OPTIONS} short answers, rendered as buttons. Omit when the answer is ` +
              "open-ended.",
          },
          context: {
            type: "string",
            description:
              "One line of why you are asking — what you found that made this a judgement call.",
          },
        },
        required: ["question"],
      },
      execute: async (args) => {
        /* Everything `unknown`, and every field narrowed by `typeof` rather than by `?.`. The
           registry's `validate()` is "a lightweight structural check, not a JSON Schema validator",
           `strict: false` skips it entirely, and this tool may be registered into someone else's
           registry — so an argument that is a number is a case, not an impossibility. Optional
           chaining guards null, not type: `context?.trim()` threw on one. */
        const { question, options, context } = args as {
          question?: unknown;
          options?: unknown;
          context?: unknown;
        };
        if (typeof question !== "string" || !question.trim()) {
          return toolError('Pass "question" — the question to put to the user.');
        }
        if (isAwaitingAnswer()) {
          return toolError("A question is already waiting for the user.");
        }
        const choices = Array.isArray(options)
          ? options
              .filter((o): o is string => typeof o === "string" && o.trim().length > 0)
              .slice(0, MAX_OPTIONS)
          : [];

        const { answer, skipped } = await askUser({
          context: typeof context === "string" ? context.trim() : "",
          /* The tool-call id, so the chip the transcript draws and the question this registers are
             the same thing. Without it a restored, permanently unanswered question would render
             identically to the live one. */
          id: currentToolCallId(),
          options: choices,
          question: question.trim(),
        });

        if (skipped) {
          /* A success: the model asked, and "you decide" is an answer. Rendering it as a failure
             would have the model apologise for having asked a fair question. */
          return toolSuccess(
            { answer: null, skipped: true },
            "The user declined to answer; proceed with your best judgment.",
          );
        }
        if (answer === null) {
          return toolError("The user did not answer — the turn was stopped.");
        }
        return toolSuccess({ answer, skipped: false }, `The user answered: "${answer}"`);
      },
    }),
  );
}
