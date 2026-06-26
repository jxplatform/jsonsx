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
import type { ProjectConfig } from "@jxsuite/schema/types";
import { getPlatform } from "../platform";
import { activeTab, workspace } from "../workspace/workspace";
import { toRaw } from "../reactivity";
import { componentRegistry } from "../files/components";
import { registerAiTools } from "./ai-tools";
import { runAgentLoop } from "./tool-executor";
import { buildSystemPrompt } from "./ai-system-prompt";
import { getBaseUrl, getModel, getOpenAiKey } from "./ai-settings";
import { trimContext } from "./context-manager";
import { renderCheck } from "./render-critic";
import { openFileInTab } from "../files/files";

const PERSIST_KEY_PREFIX = "jx-ai-chat-history";
const MAX_PERSIST_MESSAGES = 50;

/**
 * Project-scoped localStorage key (uses the project root) so conversations don't bleed across
 * projects (ADR §11.5 / §14.2). Falls back to a shared key when no project is open.
 *
 * @returns {string}
 */
function persistKey() {
  return workspace.projectRoot
    ? `${PERSIST_KEY_PREFIX}:${workspace.projectRoot}`
    : PERSIST_KEY_PREFIX;
}

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
  registerAiTools(toolRegistry, {
    getTab: () => activeTab.value,
    saveFile: async (relPath: string, content: string) => {
      const plat = getPlatform();
      await plat.writeFile(relPath, content);
    },
    renderCheck: renderCheck as (
      doc: unknown,
    ) => Promise<{ ok: true } | { ok: false; error: string }>,
    openDocument: openFileInTab,
    projectStyle: (workspace.projectConfig as ProjectConfig | null)?.style as
      | Record<string, string>
      | undefined,
  });

  let controller: AbortController | null = null;

  function buildPrompt() {
    const tab = activeTab.value;
    return buildSystemPrompt({
      document: tab ? toRaw(tab.doc.document) : undefined,
      projectConfig: (workspace.projectConfig as ProjectConfig | null) || undefined,
      components: componentRegistry.length > 0 ? componentRegistry : undefined,
      projectRoot: workspace.projectRoot || undefined,
    });
  }

  async function sendMessage(text: string) {
    if (!text.trim() || chatState.status === "streaming") {
      return;
    }

    chatState.sendMessage(text);

    // Trim context before streaming to keep the conversation within token limits.
    const trimmed = trimContext(chatState, buildPrompt());
    if (trimmed) {
      chatState.setTokenCount(trimmed.estimatedTokens);
    }

    // Persist after trimming so the saved history reflects what's actually sent.
    persistChat(chatState);

    try {
      const plat = getPlatform();
      const chatUrl = await Promise.resolve(plat.aiChatUrl());
      // Re-read the persisted model each send: the session is constructed once at module load
      // (before the user sets a key/model), so the picker's choice must be picked up here.
      chatState.setModel(getModel());
      const streamingClient = createProxyStreamingClient({
        chatUrl,
        model: chatState.model,
        // Sent as X-Api-Key; the proxy falls back to the server's OPENAI_API_KEY when empty.
        apiKey: getOpenAiKey() || undefined,
        // Optional OpenAI-compatible endpoint override; empty uses the proxy default.
        baseUrl: getBaseUrl() || undefined,
      });

      controller = new AbortController();
      await runAgentLoop({
        chatState,
        streamingClient,
        toolRegistry,
        systemPrompt: buildPrompt(),
        signal: controller.signal,
        getTab: () => activeTab.value,
      });
    } catch (error) {
      /*
       * Synchronous failure (e.g. platform not registered, network unreachable before the
       * stream starts). Set the error so the panel can display it.
       */
      chatState.setError(error instanceof Error ? error.message : String(error));
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
    persistChat(chatState);
  }

  // ── Persistence ───────────────────────────────────────────────────────

  /** Persist recent messages to localStorage (non-blocking). */
  function persistChat(cs: ReturnType<typeof createChatState>) {
    try {
      const msgs = cs.messages.slice(-MAX_PERSIST_MESSAGES);
      localStorage.setItem(persistKey(), JSON.stringify(msgs));
    } catch {
      // Storage full or unavailable — not critical.
    }
  }

  /** Restore messages from a previous session, if any. */
  function restoreChat() {
    try {
      const raw = localStorage.getItem(persistKey());
      if (!raw) {
        return;
      }
      const msgs = JSON.parse(raw) as typeof chatState.messages;
      if (!Array.isArray(msgs) || msgs.length === 0) {
        return;
      }
      // Push into chat state (skips streaming state)
      for (const m of msgs) {
        chatState.messages.push({
          ...m,
          id: m.id || `restored_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        });
      }
    } catch {
      // Corrupt or empty — ignore.
    }
  }

  // Restore once on creation.
  restoreChat();

  return { chatState, sendMessage, stop, newChat };
}
