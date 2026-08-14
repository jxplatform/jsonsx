/**
 * Tool-executor.js — Agentic loop driver for the document AI assistant
 *
 * Streams a chat round, executes any tool calls the model makes (via a ToolRegistry backed by
 * `transactDoc()`), feeds the results back as `tool` messages, and re-streams — up to a capped
 * number of rounds (spec §10.2, ADR docs/ai-assistant-decision.md §6a).
 *
 * Two §7.4 honesty rules live here rather than in the panel, because they are properties of the RUN
 * and a panel can only render what the run recorded:
 *
 * - **A partial success is not a failure.** Running out of rounds called `setError`, which paints
 *   the turn red and — in `chat-state.ts` — DELETES the streaming message, so a turn that applied
 *   four edits and then hit the cap reported as an error that had also erased its own account of
 *   the four edits. The cap is now an ordinary assistant message whenever anything was applied, and
 *   an error only when nothing was.
 * - **A batch belongs to the tab it edits.** `beginBatch(getTab())` ran once, against whichever tab
 *   happened to be active when the loop started. A turn that then moved to a second document closed
 *   its batch against the FIRST tab, so the second document's edits got neither a history snapshot
 *   nor a collab publish. The loop re-anchors the batch whenever the active tab changes under it.
 *
 * @license MIT
 */

import type { createChatState } from "@jxsuite/ai/chat-state";
import type { StreamingClient } from "@jxsuite/ai/streaming-client";
import type { ToolRegistry } from "@jxsuite/ai/tools";

import type { Tab } from "../tabs/tab";
import { batchTab, beginBatch, endBatch } from "../tabs/transact";
import { beginTurn, endTurn } from "./ai-writes";

const MAX_ROUNDS = 5;

interface RunAgentLoopOptions {
  chatState: ReturnType<typeof createChatState>;
  streamingClient: StreamingClient;
  toolRegistry: ToolRegistry;
  systemPrompt: string;
  signal?: AbortSignal;
  getTab?: () => Tab | null;
}

/**
 * Run one user turn through the agent loop: stream the model's response, execute any tool calls,
 * and repeat until the model stops calling tools or the round cap is hit.
 */
export async function runAgentLoop({
  chatState,
  streamingClient,
  toolRegistry,
  systemPrompt,
  signal,
  getTab,
}: RunAgentLoopOptions): Promise<void> {
  const allErrors: string[] = [];
  const appliedSummaries: string[] = [];

  /** The ledger is filed under the assistant message the turn ends on — see services/ai-writes. */
  const turnId = () => chatState.messages.at(-1)?.id ?? "";
  beginTurn(`turn:${chatState.messages.length}`);

  // Batch all tool-call mutations into a single undo step, anchored on the tab being edited.
  if (getTab) {
    beginBatch(getTab());
  }

  /**
   * Close the batch and re-open it when the tools have moved to a different document.
   *
   * Runs after every tool execution rather than only inside `open_document`, because a tool is not
   * the only thing that can change the active tab: project adoption replaces every tab in the
   * workspace, and the user is free to click another tab while the model is still streaming.
   */
  const reanchorBatch = () => {
    if (!getTab) {
      return;
    }
    const current = getTab();
    if (current !== batchTab()) {
      endBatch();
      beginBatch(current);
    }
  };

  try {
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const messages = chatState.toMessagesArray();
      const tools = toolRegistry.listForLLM();

      const toolCalls = new Map<string, { name: string; arguments: string }>();
      let stopReason = "stop";
      let streamError = null;

      for await (const event of streamingClient.streamChat(
        messages,
        tools,
        systemPrompt,
        signal as AbortSignal,
      )) {
        switch (event.type) {
          case "delta": {
            chatState.appendDelta(event.content);
            break;
          }
          case "tool_call_start": {
            chatState.appendToolCallStart(event.id, event.name);
            toolCalls.set(event.id, { name: event.name, arguments: "" });
            break;
          }
          case "tool_call_delta": {
            chatState.appendToolCallDelta(event.id, event.args);
            const tc = toolCalls.get(event.id);
            if (tc) {
              tc.arguments += event.args;
            }
            break;
          }
          case "tool_call_end": {
            chatState.appendToolCallEnd(event.id);
            break;
          }
          case "done": {
            ({ stopReason } = event);
            break;
          }
          case "error": {
            streamError = event.message;
            break;
          }
          default: {
            break;
          }
        }
      }

      chatState.finishStream(stopReason);

      if (streamError) {
        chatState.setError(streamError);
        return;
      }

      if (stopReason !== "tool_calls" || toolCalls.size === 0) {
        return;
      }

      for (const [id, call] of toolCalls) {
        let result;
        try {
          const args = call.arguments ? (JSON.parse(call.arguments) as object) : {};
          result = await toolRegistry.execute(call.name, args);
        } catch (error) {
          result = {
            success: false,
            error: `Failed to parse arguments: ${(error as Error).message}`,
          };
        }
        reanchorBatch();
        if (!result.success && result.error) {
          allErrors.push(result.error);
        }
        if (result.success && result.summary) {
          appliedSummaries.push(result.summary);
        }
        chatState.appendToolResult(id, result);
        chatState.pushToolResultMessage(id, JSON.stringify(result));
      }

      if (round < MAX_ROUNDS) {
        chatState.beginAssistantTurn();
      }
    }

    /*
     * The round cap. Surface the actual errors so the user knows what went wrong, not just a
     * generic "I couldn't do it" — and, when anything was applied, say it as the ASSISTANT rather
     * than as a failure (§7.4). A partial success is not a failure.
     */
    const uniqueErrors = [...new Set(allErrors)];
    const applied =
      appliedSummaries.length > 0
        ? `\n\nChanges applied so far:\n${appliedSummaries.map((s) => `- ${s}`).join("\n")}`
        : "";
    const errors =
      uniqueErrors.length > 0
        ? `\n\nErrors encountered:\n${uniqueErrors.map((e) => `- ${e}`).join("\n")}`
        : "";
    const tail =
      `I ran out of tool-call rounds (${MAX_ROUNDS}) before finishing.${applied}${errors}` +
      `\n\nYou can continue by sending another message, or try a more specific request.`;
    if (appliedSummaries.length > 0) {
      chatState.beginAssistantTurn();
      chatState.appendDelta(tail);
      chatState.finishStream("length");
      return;
    }
    chatState.setError(tail);
  } finally {
    endBatch();
    endTurn(turnId());
  }
}
