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
import { projectState } from "../store";
import { adoptProjectConfig } from "../tabs/project-config";
import type { Tab } from "../tabs/tab";
import { componentRegistry } from "../files/components";
import { activeRegistry } from "../commands/active-registry";
import { registerAiTools } from "./ai-tools";
import { registerProjectTools } from "./ai-project-tools";
import { createGatedToolRegistry } from "./gated-registry";
import type { ToolAvailability } from "./gated-registry";
import { adoptProject } from "./project-adoption";
import { runAgentLoop } from "./tool-executor";
import { AI_TOOL_TIERS, buildSystemPrompt, tierActive } from "./ai-system-prompt";
import { getBaseUrl, getOpenAiKey } from "./ai-settings";
import { preferredModel } from "./ai-models";
import { pruneOrphanToolMessages, trimContext } from "./context-manager";
import { renderCheck } from "./render-critic";
import { openFileInTab, reloadFileInTab } from "../files/files";
import { refreshExtensionUi } from "../format/format-host";
import * as sessionStore from "./ai-session-store";

/**
 * Project root scoping the session store (ADR §11.5 / §14.2 — conversations don't bleed across
 * projects). Falls back to a shared unscoped store when no project is open.
 *
 * @returns {string}
 */
function projectRoot() {
  return workspace.projectRoot || "";
}

/**
 * Create a document-assistant session bound to the currently active tab.
 *
 * @returns {{
 *   chatState: ReturnType<typeof createChatState>;
 *   sendMessage: (text: string) => Promise<void>;
 *   stop: () => void;
 *   newChat: () => void;
 *   listSessions: () => import("./ai-session-store").SessionMeta[];
 *   openSession: (id: string) => void;
 *   deleteSession: (id: string) => void;
 *   activeSessionId: () => string | null;
 * }}
 */
export function createDocumentAssistant() {
  const chatState = createChatState({ model: preferredModel() });

  /** The persisted session backing the live chat; null = fresh unsaved chat. */
  let sessionId: string | null = null;

  const getProjectStyle = () =>
    (workspace.projectConfig as ProjectConfig | null)?.style as Record<string, string> | undefined;

  const findOpenTab = (path: string): Tab | null => {
    for (const tab of workspace.tabs.values()) {
      if (tab.documentPath === path) {
        return tab;
      }
    }
    return null;
  };

  const innerRegistry = createToolRegistry();
  registerAiTools(innerRegistry, {
    getTab: () => activeTab.value,
    saveFile: async (relPath: string, content: string) => {
      const plat = getPlatform();
      await plat.writeFile(relPath, content);
    },
    renderCheck: renderCheck as (
      doc: unknown,
    ) => Promise<{ ok: true } | { ok: false; error: string }>,
    openDocument: openFileInTab,
    getProjectStyle,
    findOpenTab,
    reloadTab: reloadFileInTab,
  });
  registerProjectTools(innerRegistry, {
    getTab: () => activeTab.value,
    renderCheck: renderCheck as (
      doc: unknown,
    ) => Promise<{ ok: true } | { ok: false; error: string }>,
    getProjectStyle,
    findOpenTab,
    reloadTab: reloadFileInTab,
    adoptProject,
    // Re-key the live chat from the unscoped store to the adopted project so the bootstrap
    // Conversation keeps persisting (saveSession drops writes for ids missing from the index).
    onProjectAdopted: (root: string) => {
      if (sessionId) {
        sessionStore.moveSession("", root, sessionId);
      }
    },
    onProjectConfigWritten: async (config: ProjectConfig) => {
      /* Into the configuration document, not beside it. This used to assign a fresh object to
         `projectState.projectConfig`, leaving the document holding the previous configuration —
         and the next settings commit wrote that stale document back over the assistant's file.
         `adoptProjectConfig` is the one door for a config that reached disk another way. */
      await adoptProjectConfig(config);
      /* An `extensions` edit changes what the generated entry documents compose, and the backends
         regenerate them from project.json on demand — so without this the editor and the assistant
         both keep judging by the PREVIOUS project's schemas until the window reopens. */
      refreshExtensionUi(getPlatform());
    },
  });

  /*
   * Gate tool advertisement/execution on live studio state, derived from the same tier table the
   * system prompt renders — the model is never shown a tool it cannot execute. listForLLM() runs
   * every agent-loop round, so a mid-loop create_project unlocks the higher tiers immediately.
   */
  const TIER_REQUIREMENTS = {
    "no-project": "no project to be open (it bootstraps one)",
    project: "an open project",
    document: "an open document (use open_document first)",
    "document-tree":
      "an open document whose element tree the canvas is editing — Project Settings and the " +
      "grid editors are documents, but not trees to restructure",
  } as const;

  /**
   * The HUMAN's own gate, read rather than reimplemented.
   *
   * `Command.aiTool` promises "the human's gate and the agent's gate stay one predicate", and the
   * only way to keep that promise is for the agent to ask the same object: this is the
   * `CommandContext` `selection.delete` and the movers are evaluated against. Recomputing
   * `editor.kind` here would make two predicates that agree today and drift the first time either
   * is edited. Falls back to permissive when no registry is installed — the assistant runs in tests
   * that never build one, and refusing everything there would be a second wrong answer.
   */
  const treeEditable = () => {
    const registry = activeRegistry();
    // `=== "canvas"`, the human's exact test — not a looser cousin of it. Being more permissive for
    // The agent than for the person is the divergence this is here to remove.
    return registry ? registry.context().editor.kind === "canvas" : true;
  };
  const availability = new Map<string, ToolAvailability>(
    AI_TOOL_TIERS.map((t) => [
      t.name,
      {
        when: () =>
          tierActive(t.tier, {
            hasDocument: Boolean(activeTab.value),
            hasProject: Boolean(workspace.projectRoot),
            treeEditable: treeEditable(),
          }),
        requires: TIER_REQUIREMENTS[t.tier],
      },
    ]),
  );
  const toolRegistry = createGatedToolRegistry(innerRegistry, availability);

  let controller: AbortController | null = null;

  function buildPrompt() {
    const tab = activeTab.value;
    const inventory = projectState
      ? [...projectState.dirs.values()]
          .flat()
          .filter((e) => e.type === "file")
          .map((e) => e.path)
      : undefined;
    return buildSystemPrompt({
      document: tab ? toRaw(tab.doc.document) : undefined,
      projectConfig: (workspace.projectConfig as ProjectConfig | null) || undefined,
      components: componentRegistry.length > 0 ? componentRegistry : undefined,
      projectRoot: workspace.projectRoot || undefined,
      hasProject: Boolean(workspace.projectRoot),
      ...(inventory && inventory.length > 0 ? { fileInventory: inventory } : {}),
    });
  }

  async function sendMessage(text: string) {
    if (!text.trim() || chatState.status === "streaming") {
      return;
    }

    // Lazily create the backing session on the first message so empty "New Chat"
    // Clicks never pollute the session list.
    if (!sessionId) {
      sessionId = sessionStore.createSession(projectRoot(), text).id;
    }

    chatState.sendMessage(text);

    // Trim context before streaming to keep the conversation within token limits.
    const trimmed = trimContext(chatState, buildPrompt());
    if (trimmed) {
      chatState.setTokenCount(trimmed.estimatedTokens);
    }

    /* AFTER the trim, not before: the trim splices from the front and is itself one of the three
       ways a tool_calls request loses its reply (see pruneOrphanToolMessages). Repairing first
       would leave the very pair the trim then broke. */
    pruneOrphanToolMessages(chatState);

    // Persist after trimming so the saved history reflects what's actually sent.
    persistChat();

    try {
      const plat = getPlatform();
      const chatUrl = await Promise.resolve(plat.aiChatUrl());
      // Re-read the persisted model each send: the session is constructed once at module load
      // (before the user sets a key/model), so the picker's choice must be picked up here.
      chatState.setModel(preferredModel());
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
      // Persist again once the stream settled so the completed reply (or the state
      // After an error/abort cleanup) survives a reload without another send.
      persistChat();
    }
  }

  function stop() {
    controller?.abort();
    chatState.cancelStream();
  }

  function newChat() {
    stop();
    chatState.clearChat();
    sessionId = null;
    sessionStore.setActiveSession(projectRoot(), null);
  }

  // ── Sessions ──────────────────────────────────────────────────────────

  /** The project's persisted sessions, most recently updated first. */
  function listSessions() {
    return sessionStore.listSessions(projectRoot());
  }

  /** Replace the live chat with a persisted session's messages. */
  function openSession(id: string) {
    const msgs = sessionStore.loadSession(projectRoot(), id);
    if (!msgs) {
      return;
    }
    stop();
    chatState.clearChat();
    pushRestoredMessages(msgs);
    sessionId = id;
    sessionStore.setActiveSession(projectRoot(), id);
  }

  /** Delete a persisted session; deleting the open one leaves a fresh unsaved chat. */
  function deleteSession(id: string) {
    sessionStore.deleteSession(projectRoot(), id);
    if (sessionId === id) {
      stop();
      chatState.clearChat();
      sessionId = null;
    }
  }

  function activeSessionId() {
    return sessionId;
  }

  // ── Persistence ───────────────────────────────────────────────────────

  /** Persist the live conversation into its backing session (non-blocking). */
  function persistChat() {
    if (!sessionId) {
      return;
    }
    // Skip a still-empty streaming placeholder so reloads don't restore blank bubbles.
    const msgs = chatState.messages.filter(
      (m) => m.role !== "assistant" || m.content || (m.toolCalls?.length ?? 0) > 0,
    );
    sessionStore.saveSession(projectRoot(), sessionId, msgs);
  }

  /** Push persisted messages into chat state, synthesizing ids where missing. */
  function pushRestoredMessages(msgs: sessionStore.PersistedMessage[]) {
    for (const m of msgs) {
      chatState.messages.push({
        ...m,
        id: m.id || `restored_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      } as (typeof chatState.messages)[number]);
    }
  }

  /** Restore the last-active session once on creation, if any. */
  function restoreChat() {
    const root = projectRoot();
    const activeId = sessionStore.getActiveSessionId(root);
    if (!activeId) {
      return;
    }
    const msgs = sessionStore.loadSession(root, activeId);
    if (!msgs || msgs.length === 0) {
      return;
    }
    pushRestoredMessages(msgs);
    sessionId = activeId;
  }

  // Restore once on creation.
  restoreChat();

  return {
    chatState,
    sendMessage,
    stop,
    newChat,
    listSessions,
    openSession,
    deleteSession,
    activeSessionId,
  };
}
