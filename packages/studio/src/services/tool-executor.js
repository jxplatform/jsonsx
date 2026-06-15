/**
 * Tool-executor.js — Agentic loop driver for the document AI assistant
 *
 * Streams a chat round, executes any tool calls the model makes (via a ToolRegistry backed by
 * `transactDoc()`), feeds the results back as `tool` messages, and re-streams — up to a capped
 * number of rounds (spec §10.2, ADR docs/ai-assistant-decision.md §6a).
 *
 * @license MIT
 */

const MAX_ROUNDS = 5;

/**
 * Run one user turn through the agent loop: stream the model's response, execute any tool calls,
 * and repeat until the model stops calling tools or the round cap is hit.
 *
 * @param {object} opts
 * @param {ReturnType<typeof import("@jxsuite/ai/chat-state").createChatState>} opts.chatState
 * @param {import("@jxsuite/ai/streaming-client").StreamingClient} opts.streamingClient
 * @param {import("@jxsuite/ai/tools").ToolRegistry} opts.toolRegistry
 * @param {string} opts.systemPrompt
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<void>}
 */
export async function runAgentLoop({
  chatState,
  streamingClient,
  toolRegistry,
  systemPrompt,
  signal,
}) {
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const messages = chatState.toMessagesArray();
    const tools = toolRegistry.listForLLM();

    /** @type {Map<string, { name: string; arguments: string }>} */
    const toolCalls = new Map();
    let stopReason = "stop";
    let streamError = null;

    for await (const event of streamingClient.streamChat(messages, tools, systemPrompt, signal)) {
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
        const args = call.arguments ? JSON.parse(call.arguments) : {};
        result = await toolRegistry.execute(call.name, args);
      } catch (error) {
        result = {
          success: false,
          error: `Failed to parse arguments: ${/** @type {Error} */ (error).message}`,
        };
      }
      chatState.appendToolResult(id, result);
      chatState.pushToolResultMessage(id, JSON.stringify(result));
    }

    if (round < MAX_ROUNDS) {
      chatState.beginAssistantTurn();
    }
  }

  chatState.setError(
    "I wasn't able to complete this change after several attempts. You can try rephrasing your request.",
  );
}
