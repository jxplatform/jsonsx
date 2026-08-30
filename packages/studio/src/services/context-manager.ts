/**
 * Context-manager.js — Token budget management for the AI assistant
 *
 * Estimates token usage and trims conversation history before each send to keep the
 * context window within safe limits (ADR docs/ai-assistant-decision.md §11.4).
 *
 * Strategy (MVP): keep the system prompt + the most recent messages, dropping the oldest
 * messages when the estimated total exceeds the configured token budget. Dropped messages
 * are replaced with a single summary note so the model knows history was truncated.
 *
 * @license MIT
 */

import type { createChatState } from "@jxsuite/ai/chat-state";
import { modelContextWindow } from "./ai-models";

/** Shape of a single entry returned by `chatState.toMessagesArray()`. */
interface MessageArrayEntry {
  role: string;
  content?: string | null;
  tool_calls?: {
    function?: { name?: string; arguments?: string };
  }[];
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Rough heuristic: average 4 characters per token. */
const CHARS_PER_TOKEN = 4;

/**
 * Approximate context windows (in tokens) per model id, longest-prefix matched. Used to derive a
 * model-aware budget instead of a flat cap (ADR §14.2). Conservative fallback for unknown models.
 */
const MODEL_CONTEXT_WINDOWS: [string, number][] = [
  ["gpt-4o", 128_000],
  ["gpt-4.1", 1_000_000],
  ["gpt-4-turbo", 128_000],
  ["gpt-4", 8192],
  ["gpt-3.5", 16_385],
  ["o1", 200_000],
  ["o3", 200_000],
  ["claude", 200_000],
];

/** Fallback window for models not in the table above. */
const DEFAULT_CONTEXT_WINDOW = 32_000;

/** Fraction of the window we'll actually fill before trimming. */
const BUDGET_FRACTION = 0.8;

/** Fraction of the window at which we surface a "context getting large" warning. */
const WARN_FRACTION = 0.5;

/**
 * Resolve the context window (tokens) for a model id: what the backend reported, else a
 * longest-prefix match on the table above, else the conservative default.
 *
 * The backend's number goes first because the table can only ever know the names it was written
 * with. Every `@cf/*` model missed it and was budgeted at {@link DEFAULT_CONTEXT_WINDOW}, so a
 * managed 128k model started dropping the oldest turns at about 25.6k — a fifth of what it could
 * hold, on the one backend that actually publishes the figure.
 *
 * @param {string | undefined} model
 * @returns {number}
 */
function contextWindowFor(model: string | undefined): number {
  if (!model) {
    return DEFAULT_CONTEXT_WINDOW;
  }
  const reported = modelContextWindow(model);
  if (reported !== undefined && reported > 0) {
    return reported;
  }
  const id = model.toLowerCase();
  let best = 0;
  let window = DEFAULT_CONTEXT_WINDOW;
  for (const [prefix, size] of MODEL_CONTEXT_WINDOWS) {
    if (id.startsWith(prefix) && prefix.length > best) {
      best = prefix.length;
      window = size;
    }
  }
  return window;
}

/** Messages to keep at the tail (most recent), regardless of budget. */
const KEEP_RECENT = 20;

/**
 * Minimum number of user or tool messages we must preserve beyond the recent window so the model
 * retains conversation grounding.
 */
const MIN_USER_TURNS = 3;

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Estimate token count from a string or array of messages.
 *
 * @param {string | object[]} input
 * @returns {number}
 */
function estimateTokens(input: string | MessageArrayEntry[]): number {
  if (typeof input === "string") {
    return Math.ceil(input.length / CHARS_PER_TOKEN);
  }
  let total = 0;
  for (const msg of input) {
    total += estimateTokens(msg.content || "");
    // Tool calls carry extra tokens for the function name + arguments.
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        total +=
          estimateTokens(tc.function?.name || "") +
          estimateTokens(tc.function?.arguments || "") +
          4; // Framing overhead
      }
    }
    // Each message has ~4 tokens of framing overhead (role, etc.)
    total += 4;
  }
  return total;
}

// ─── Trim ───────────────────────────────────────────────────────────────────

/**
 * Trim chat history so the total estimated token count stays within the budget. Returns trimming
 * metadata, or null if no trimming was needed.
 *
 * Side effect: drops messages from chatState.messages (in-place via splice) and may insert a
 * summary note.
 *
 * @param {ReturnType<typeof import("@jxsuite/ai/chat-state").createChatState>} chatState
 * @param {string} systemPrompt
 * @returns {{ estimatedTokens: number; droppedCount: number } | null}
 */
export function trimContext(
  chatState: ReturnType<typeof createChatState>,
  systemPrompt: string,
): { estimatedTokens: number; droppedCount: number } | null {
  const window = contextWindowFor(chatState.model);
  const maxTokens = Math.floor(window * BUDGET_FRACTION);
  const warnTokens = Math.floor(window * WARN_FRACTION);

  const systemTokens = estimateTokens(systemPrompt);
  const allMessages = chatState.messages;
  const messageTokens = estimateTokens(chatState.toMessagesArray());
  const total = systemTokens + messageTokens;

  if (total <= maxTokens) {
    chatState.setTokenCount(total);
    // Warn once the conversation crosses half the window, even before we trim.
    chatState.setContextWarning(total >= warnTokens);
    return { estimatedTokens: total, droppedCount: 0 };
  }

  // Must trim. How many messages to drop?
  // Keep the most recent KEEP_RECENT messages.
  // But also ensure we keep at least MIN_USER_TURNS worth of user/tool context.
  let keepFrom = Math.max(0, allMessages.length - KEEP_RECENT);

  // Walk backward from keepFrom to find MIN_USER_TURNS user/tool messages to preserve.
  let preservedTurns = 0;
  for (let i = allMessages.length - 1; i >= keepFrom; i--) {
    const { role } = allMessages[i]!;
    if (role === "user" || role === "tool") {
      preservedTurns += 1;
    }
  }

  // If we don't have enough turns in the recent window, extend backward.
  if (preservedTurns < MIN_USER_TURNS) {
    for (let i = keepFrom - 1; i >= 0 && preservedTurns < MIN_USER_TURNS; i--) {
      keepFrom = i;
      const { role } = allMessages[i]!;
      if (role === "user" || role === "tool") {
        preservedTurns += 1;
      }
    }
  }

  // Never drop the system message (which is at index 0 if role === "system").
  // For the Jx assistant, there is no system message in the messages array —
  // The system prompt is passed separately. So keepFrom is safe.

  if (keepFrom <= 0) {
    // Can't trim further without losing everything. Warn but don't truncate.
    chatState.setTokenCount(total);
    chatState.setContextWarning(true);
    return { estimatedTokens: total, droppedCount: 0 };
  }

  const droppedCount = keepFrom;
  allMessages.splice(0, keepFrom);

  // Insert a summary note so the model knows context was trimmed.
  allMessages.unshift({
    id: `ctx_summary_${Date.now()}`,
    role: "user",
    content: `[Earlier conversation truncated. ${droppedCount} messages dropped to stay within token budget. The most recent ${allMessages.length - 1} messages are preserved.]`,
    timestamp: Date.now(),
  });

  const newTotal = systemTokens + estimateTokens(chatState.toMessagesArray());
  chatState.setTokenCount(newTotal);
  chatState.setContextWarning(true);

  return { estimatedTokens: newTotal, droppedCount };
}

// ─── Orphaned tool calls ────────────────────────────────────────────────────

/** What a synthesized result says, so a reader and the model see the same reason. */
const UNANSWERED_TOOL_RESULT = JSON.stringify({
  success: false,
  error:
    "This tool call was never completed — the session was reloaded or the history was trimmed.",
});

/**
 * Repair tool-call pairing in place, and report how many messages it touched.
 *
 * `toMessagesArray()` serializes the array verbatim: an assistant message with `tool_calls` becomes
 * a `tool_calls` request, and a `tool` message becomes a reply carrying `tool_call_id`. Providers
 * require the two to come in pairs, and **three ordinary things break the pairing**:
 *
 * 1. `saveSession` persists `msgs.slice(-MAX_PERSIST_MESSAGES)` and `restoreChat` pushes the result
 *    back, so a session longer than the cap can be restored starting mid-pair.
 * 2. {@link trimContext} splices from the front for the token budget, with no more regard for pairs.
 * 3. A turn that stopped while a tool was still running — which `ask_user` makes routine, because its
 *    tool is _designed_ to be outstanding — leaves a request with no reply.
 *
 * Each of those produced a 400 on the NEXT send, from a conversation the user could see was fine.
 * So the repair belongs on the send path, after trimming, rather than at any one of the three
 * sites: a request with no reply gets a synthesized failure (keeping the assistant's text, which
 * dropping the message would lose), and a reply with no request is dropped.
 *
 * @param {ReturnType<typeof createChatState>} chatState
 * @returns {{ sealed: number; dropped: number }}
 */
export function pruneOrphanToolMessages(chatState: ReturnType<typeof createChatState>): {
  sealed: number;
  dropped: number;
} {
  const { messages } = chatState;

  const requested = new Set<string>();
  const answered = new Set<string>();
  for (const msg of messages) {
    if (msg.role === "assistant" && msg.toolCalls) {
      for (const call of msg.toolCalls) {
        requested.add(call.id);
      }
    } else if (msg.role === "tool" && msg.toolCallId) {
      answered.add(msg.toolCallId);
    }
  }

  // Replies with no request, and replies with no id at all — neither can be serialized into a
  // Well-formed pair, and a reply is the half that carries no author text worth keeping.
  let dropped = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role === "tool" && (!msg.toolCallId || !requested.has(msg.toolCallId))) {
      messages.splice(i, 1);
      dropped += 1;
    }
  }

  /* Requests with no reply. Walk backwards so each insertion is past the indices still to visit,
     and seal immediately after the requesting message — `toMessagesArray` emits in array order, so
     that is the only position the pair is adjacent in. */
  let sealed = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role !== "assistant" || !msg.toolCalls) {
      continue;
    }
    const missing = msg.toolCalls.filter((call) => !answered.has(call.id));
    if (missing.length === 0) {
      continue;
    }
    messages.splice(
      i + 1,
      0,
      ...missing.map((call, n) => ({
        content: UNANSWERED_TOOL_RESULT,
        id: `sealed_${call.id}_${n}`,
        role: "tool" as const,
        timestamp: msg.timestamp,
        toolCallId: call.id,
      })),
    );
    sealed += missing.length;
  }

  return { dropped, sealed };
}
