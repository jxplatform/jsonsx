/**
 * Tests for src/services/document-assistant.ts — the Stack B document AI session.
 *
 * Drives createDocumentAssistant().sendMessage() end-to-end with a scripted streaming client. The
 * AI barrel's createProxyStreamingClient is mocked while createChatState/createToolRegistry stay
 * real, so the full wiring — system prompt, context trim, tool registry, agent loop, persistence —
 * runs without a network. The tool path mutates the live document as one undo step.
 */
import { installMockPlatform, resetStudioState, resetWorkspaceWithTab } from "./harness";
import { createChatState, createToolRegistry } from "@jxsuite/ai";
import type { StreamingClient } from "@jxsuite/ai/streaming-client";
import type { JxMutableNode } from "@jxsuite/schema/types";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

/** The normalized stream event the StreamingClient emits (not exported, so derived here). */
type StreamEvent =
  ReturnType<StreamingClient["streamChat"]> extends AsyncGenerator<infer E> ? E : never;

let nextRounds: StreamEvent[][] = [];
let createErrorMessage: string | null = null;
let lastClientOpts: Record<string, unknown> | null = null;
let capturedTools: string[][] = [];
let capturedSystemPrompts: string[] = [];

function fakeClient(rounds: StreamEvent[][]): StreamingClient {
  let call = 0;
  return {
    async *streamChat(_messages: unknown, tools?: unknown, systemPrompt?: unknown) {
      capturedTools.push(
        ((tools as { function: { name: string } }[]) ?? []).map((t) => t.function.name),
      );
      capturedSystemPrompts.push(String(systemPrompt ?? ""));
      const events = rounds[call] ?? [{ stopReason: "stop", type: "done" }];
      call += 1;
      for (const e of events) {
        yield e;
      }
    },
  } as unknown as StreamingClient;
}

/** One tool call followed by a tool_calls stop. */
function toolCallRound(id: string, name: string, args: object): StreamEvent[] {
  return [
    { id, name, type: "tool_call_start" },
    { args: JSON.stringify(args), id, type: "tool_call_delta" },
    { id, type: "tool_call_end" },
    { stopReason: "tool_calls", type: "done" },
  ];
}

void mock.module("@jxsuite/ai", () => ({
  createChatState,
  createProxyStreamingClient: (opts: Record<string, unknown>) => {
    lastClientOpts = opts;
    if (createErrorMessage) {
      throw new Error(createErrorMessage);
    }
    return fakeClient(nextRounds);
  },
  createToolRegistry,
}));

const LEGACY_PERSIST_KEY = "jx-ai-chat-history";
const { createDocumentAssistant } = await import("../src/services/document-assistant");
const { getActiveSessionId, listSessions, loadSession } =
  await import("../src/services/ai-session-store");
const { setProjectAdopter } = await import("../src/services/project-adoption");
const { closeAllTabs, setWorkspaceProject, workspace } = await import("../src/workspace/workspace");
const store = await import("../src/store");

/** The messages persisted for the assistant's active session (tests run with no project root). */
function persistedMessages() {
  const activeId = getActiveSessionId("");
  return activeId ? loadSession("", activeId) : null;
}

beforeEach(() => {
  installMockPlatform();
  resetWorkspaceWithTab();
  setWorkspaceProject(null);
  setProjectAdopter(async () => {});
  globalThis.localStorage.clear();
  nextRounds = [];
  createErrorMessage = null;
  lastClientOpts = null;
  capturedTools = [];
  capturedSystemPrompts = [];
});

afterEach(() => {
  globalThis.localStorage.clear();
});

describe("document-assistant", () => {
  test("streams a text reply and persists the conversation", async () => {
    globalThis.localStorage.setItem("jx.ai.openaiKey", "sk-secret");
    globalThis.localStorage.setItem("jx.ai.baseUrl", "http://localhost:11434/v1");
    nextRounds = [
      [
        { content: "Hello there", type: "delta" },
        { stopReason: "stop", type: "done" },
      ],
    ];

    const a = createDocumentAssistant();
    await a.sendMessage("hi");

    expect(a.chatState.status).toBe("idle");
    expect(
      a.chatState.messages.some((m) => m.role === "assistant" && m.content.includes("Hello")),
    ).toBe(true);
    // The streaming client received the stored credentials.
    expect(lastClientOpts?.apiKey).toBe("sk-secret");
    expect(lastClientOpts?.baseUrl).toBe("http://localhost:11434/v1");
    // A session was lazily created on first send, and the completed reply was
    // Persisted after the stream settled (not just the pre-stream user message).
    const persisted = persistedMessages();
    expect(persisted?.some((m) => m.role === "user" && m.content === "hi")).toBe(true);
    expect(persisted?.some((m) => m.role === "assistant" && m.content.includes("Hello"))).toBe(
      true,
    );
    expect(listSessions("")[0]!.title).toBe("hi");
  });

  test("executes a tool call that mutates the document as a single undo step", async () => {
    nextRounds = [
      toolCallRound("c1", "add_child", {
        index: 1,
        node: { tagName: "span", textContent: "added" },
        parentPath: [],
      }),
      [{ stopReason: "stop", type: "done" }],
    ];

    const a = createDocumentAssistant();
    const tab = resetWorkspaceWithTab({
      children: [{ tagName: "p", textContent: "Hello" }],
      tagName: "div",
    });
    await a.sendMessage("add a span");

    const children = tab.doc.document.children as (JxMutableNode | string)[];
    expect(children).toHaveLength(2);
    expect((children[1] as JxMutableNode).tagName).toBe("span");
    expect(tab.history.index).toBe(1); // One undoable transaction (batched)
    expect(a.chatState.status).toBe("idle");
  });

  test("create_page writes the file through the platform saveFile wiring", async () => {
    const { state } = installMockPlatform();
    // Create_page sits in the "project" tool tier — it needs an open project to be executable.
    setWorkspaceProject("/proj");
    nextRounds = [
      toolCallRound("c1", "create_page", {
        content: { children: [{ tagName: "p", textContent: "About us" }], tagName: "div" },
        path: "pages/about.json",
      }),
      [{ stopReason: "stop", type: "done" }],
    ];

    const a = createDocumentAssistant();
    await a.sendMessage("make an about page");

    const writes = state.calls.filter(([name]) => name === "writeFile");
    expect(writes).toHaveLength(1);
    expect(writes[0]![1]).toBe("pages/about.json");
    expect(String(writes[0]![2])).toContain("About us");
    expect(a.chatState.status).toBe("idle");
    // ListSessions surfaces the lazily created session, newest first.
    const sessions = a.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.title).toBe("make an about page");
    expect(sessions[0]!.id).toBe(a.activeSessionId()!);
  });

  test("ignores empty input and re-entrant sends while streaming", async () => {
    const a = createDocumentAssistant();
    await a.sendMessage("   ");
    expect(a.chatState.messages).toHaveLength(0);
    // Rejected sends never create a session.
    expect(listSessions("")).toHaveLength(0);

    a.chatState.status = "streaming";
    await a.sendMessage("blocked");
    expect(a.chatState.messages).toHaveLength(0);
    expect(listSessions("")).toHaveLength(0);
  });

  test("surfaces a streaming-client construction failure as an error", async () => {
    createErrorMessage = "network down";
    const a = createDocumentAssistant();
    await a.sendMessage("hi");
    expect(a.chatState.status).toBe("error");
    expect(a.chatState.error).toContain("network down");
  });

  test("stop() and newChat() detach from the session without deleting it", async () => {
    nextRounds = [
      [
        { content: "x", type: "delta" },
        { stopReason: "stop", type: "done" },
      ],
    ];
    const a = createDocumentAssistant();
    await a.sendMessage("hi");
    expect(a.chatState.messages.length).toBeGreaterThan(0);
    const sessionId = a.activeSessionId();
    expect(sessionId).toBeTruthy();

    a.stop(); // No active controller → just cancels stream state
    a.newChat();
    expect(a.chatState.messages).toHaveLength(0);
    expect(a.activeSessionId()).toBeNull();
    expect(getActiveSessionId("")).toBeNull();
    // The previous conversation stays in the session list.
    expect(listSessions("").some((s) => s.id === sessionId)).toBe(true);
    expect(loadSession("", sessionId!)?.some((m) => m.content === "hi")).toBe(true);
  });

  test("openSession swaps the live chat; deleteSession of the open one clears it", async () => {
    nextRounds = [
      [
        { content: "first reply", type: "delta" },
        { stopReason: "stop", type: "done" },
      ],
      [
        { content: "second reply", type: "delta" },
        { stopReason: "stop", type: "done" },
      ],
    ];
    const a = createDocumentAssistant();
    await a.sendMessage("first chat");
    const firstId = a.activeSessionId()!;
    a.newChat();
    await a.sendMessage("second chat");
    const secondId = a.activeSessionId()!;
    expect(secondId).not.toBe(firstId);

    a.openSession(firstId);
    expect(a.activeSessionId()).toBe(firstId);
    expect(getActiveSessionId("")).toBe(firstId);
    expect(a.chatState.messages.some((m) => m.content === "first chat")).toBe(true);
    expect(a.chatState.messages.some((m) => m.content === "second chat")).toBe(false);

    // Opening an unknown session is a no-op.
    a.openSession("nope");
    expect(a.activeSessionId()).toBe(firstId);

    a.deleteSession(firstId);
    expect(a.chatState.messages).toHaveLength(0);
    expect(a.activeSessionId()).toBeNull();
    expect(listSessions("").map((s) => s.id)).toEqual([secondId]);

    // Deleting a non-open session leaves the live chat alone.
    a.openSession(secondId);
    a.deleteSession("already-gone");
    expect(a.activeSessionId()).toBe(secondId);
  });

  test("restores the last-active session on creation", () => {
    globalThis.localStorage.setItem(
      LEGACY_PERSIST_KEY,
      JSON.stringify([
        { content: "earlier", id: "m1", role: "user", timestamp: 1 },
        { content: "reply", role: "assistant", timestamp: 2 }, // Missing id → synthesized
      ]),
    );
    // The legacy single-conversation store migrates into the first session…
    const a = createDocumentAssistant();
    expect(a.chatState.messages).toHaveLength(2);
    expect(a.chatState.messages[0]!.content).toBe("earlier");
    expect(a.chatState.messages[1]!.id).toBeTruthy();
    expect(a.activeSessionId()).toBe(getActiveSessionId(""));

    // …and a second assistant restores that same active session.
    const b = createDocumentAssistant();
    expect(b.chatState.messages).toHaveLength(2);
  });

  test("ignores corrupt or empty persisted history", () => {
    globalThis.localStorage.setItem(LEGACY_PERSIST_KEY, "{not json");
    expect(createDocumentAssistant().chatState.messages).toHaveLength(0);

    globalThis.localStorage.setItem(LEGACY_PERSIST_KEY, "[]");
    expect(createDocumentAssistant().chatState.messages).toHaveLength(0);
  });
});

describe("document-assistant — state-gated tools & bootstrap", () => {
  test("sends with no document and no project, advertising only bootstrap tools", async () => {
    closeAllTabs();
    nextRounds = [
      [
        { content: "Let's start a project", type: "delta" },
        { stopReason: "stop", type: "done" },
      ],
    ];
    const a = createDocumentAssistant();
    await a.sendMessage("I want a portfolio site");

    expect(a.chatState.status).toBe("idle");
    expect(capturedTools[0]).toContain("create_project");
    expect(capturedTools[0]).toContain("list_starters");
    expect(capturedTools[0]).not.toContain("list_files");
    expect(capturedTools[0]).not.toContain("set_property");
    expect(capturedSystemPrompts[0]).toContain("No project is open yet");
  });

  test("with a project and a document, file and document tools are advertised together", async () => {
    setWorkspaceProject("/proj");
    nextRounds = [[{ stopReason: "stop", type: "done" }]];
    const a = createDocumentAssistant();
    await a.sendMessage("hi");

    expect(capturedTools[0]).toContain("set_property");
    expect(capturedTools[0]).toContain("write_file");
    expect(capturedTools[0]).not.toContain("create_project");
  });

  test("create_project adopts the scaffold and re-keys the pre-project session", async () => {
    closeAllTabs();
    // The registered adopter stands in for openRecentProject: it "opens" the project.
    setProjectAdopter(async (root: string) => {
      setWorkspaceProject(root, { name: "Fresh" });
    });
    nextRounds = [
      // The model must name a destination — create_project refuses without one.
      toolCallRound("c1", "create_project", { location: "/home/dev/Sites", name: "Fresh Site" }),
      [
        { content: "Project ready", type: "delta" },
        { stopReason: "stop", type: "done" },
      ],
    ];

    const a = createDocumentAssistant();
    await a.sendMessage("bootstrap a site");

    const root = workspace.projectRoot!;
    expect(root).toBeTruthy();
    // The live session moved from the unscoped store to the adopted root and stayed active.
    expect(listSessions("").some((s) => s.id === a.activeSessionId())).toBe(false);
    const moved = listSessions(root).find((s) => s.id === a.activeSessionId());
    expect(moved?.title).toBe("bootstrap a site");
    expect(getActiveSessionId(root)).toBe(a.activeSessionId());
    // Post-adoption persistence lands in the re-keyed store.
    expect(
      loadSession(root, a.activeSessionId()!)?.some((m) => m.content === "Project ready"),
    ).toBe(true);
    // The second round re-advertised the unlocked tiers (mid-loop re-listing).
    expect(capturedTools[1]).toContain("list_files");
    expect(capturedTools[1]).not.toContain("create_project");
  });
});

describe("document-assistant — cross-file wiring", () => {
  test("a project.json write syncs workspace + project config, and the inventory feeds the prompt", async () => {
    setWorkspaceProject("/proj", { name: "Old Name" });
    resetStudioState({
      dirs: new Map([
        [
          ".",
          [
            { name: "index.json", path: "pages/index.json", type: "file" },
            { name: "pages", path: "pages", type: "directory" },
          ],
        ],
      ]),
    });
    nextRounds = [
      toolCallRound("c1", "write_file", {
        content: JSON.stringify({ name: "New Name" }),
        path: "project.json",
      }),
      [{ stopReason: "stop", type: "done" }],
    ];

    const a = createDocumentAssistant();
    await a.sendMessage("rename the project");

    expect((workspace.projectConfig as { name?: string } | null)?.name).toBe("New Name");
    expect((store.projectState?.projectConfig as { name?: string } | null)?.name).toBe("New Name");
    // The file inventory section rode along in the system prompt, files only (no directories).
    const filesSection = capturedSystemPrompts[0]!.split("## Project Files")[1]!;
    expect(filesSection.split("\n\n---\n\n")[0]!.trim()).toBe("pages/index.json");
  });

  test("write_file over the open clean tab reloads the document from disk", async () => {
    setWorkspaceProject("/proj");
    installMockPlatform();
    const tab = resetWorkspaceWithTab(undefined, { documentPath: "pages/index.json" });
    nextRounds = [
      toolCallRound("c1", "write_file", {
        content: JSON.stringify({ children: [], tagName: "section" }),
        path: "pages/index.json",
      }),
      [{ stopReason: "stop", type: "done" }],
    ];

    const a = createDocumentAssistant();
    await a.sendMessage("rewrite the home page");

    // The write landed AND the open tab reconciled to the on-disk content.
    expect(tab.doc.document.tagName).toBe("section");
    expect(tab.doc.dirty).toBe(false);
    expect(a.chatState.status).toBe("idle");
  });
});
