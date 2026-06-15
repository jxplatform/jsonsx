/// <reference lib="dom" />
/**
 * Document-assistant.js — Stack B (canonical) document AI assistant session
 *
 * Wires the @jxsuite/ai infrastructure (chat-state, proxy streaming client, tool registry) to
 * the active Jx document via `transactDoc()`-backed tools, and drives the error-correction
 * agent loop. See docs/ai-assistant-decision.md.
 *
 * @license MIT
 */

import { createChatState, createProxyStreamingClient, createToolRegistry } from "@jxsuite/ai";
import { getPlatform } from "../platform";
import { activeTab, workspace } from "../workspace/workspace";
import { toRaw } from "../reactivity";
import { registerAiTools } from "./ai-tools";
import { runAgentLoop } from "./tool-executor";
import { buildSystemPrompt } from "./ai-system-prompt";
import { getBaseUrl, getModel, getOpenAiKey } from "./ai-settings";

/**
 * Create a document-assistant session bound to the currently active tab.
 *
 * @returns {{
 *   chatState: ReturnType<typeof createChatState>;
 *   sendMessage: (text: string) => Promise<void>;
 *   stop: () => void;
 *   newChat: () => void;
 * }}
 */
export function createDocumentAssistant() {
  const chatState = createChatState({ model: getModel() });

  const toolRegistry = createToolRegistry();
  registerAiTools(toolRegistry, { getTab: () => activeTab.value });

  /** @type {AbortController | null} */
  let controller = null;

  function buildPrompt() {
    const tab = activeTab.value;
    return buildSystemPrompt({
      document: tab ? toRaw(tab.doc.document) : undefined,
      projectConfig: workspace.projectConfig || undefined,
      projectRoot: workspace.projectRoot || undefined,
    });
  }

  /** @param {string} text */
  async function sendMessage(text) {
    if (!text.trim() || chatState.status === "streaming") {
      return;
    }

    const plat = getPlatform();
    const chatUrl = await Promise.resolve(plat.aiChatUrl());
    const streamingClient = createProxyStreamingClient({
      chatUrl,
      model: chatState.model,
      // Sent as X-Api-Key; the proxy falls back to the server's OPENAI_API_KEY when empty.
      apiKey: getOpenAiKey() || undefined,
      // Optional OpenAI-compatible endpoint override; empty uses the proxy default.
      baseUrl: getBaseUrl() || undefined,
    });

    chatState.sendMessage(text);

    controller = new AbortController();
    try {
      await runAgentLoop({
        chatState,
        streamingClient,
        toolRegistry,
        systemPrompt: buildPrompt(),
        signal: controller.signal,
      });
    } finally {
      controller = null;
    }
  }

  function stop() {
    controller?.abort();
    chatState.cancelStream();
  }

  function newChat() {
    stop();
    chatState.clearChat();
  }

  return { chatState, sendMessage, stop, newChat };
}
