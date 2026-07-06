/**
 * Tests for src/panels/ai-chat/chat-view.ts — the chat header and message-list templates: row
 * anatomy per role (user bubbles + context chips, assistant markdown + tool chips, failed-tool
 * surfacing, streaming tail, error row) and the moved helper functions.
 */
import { pointer, renderInto } from "./harness";
import { describe, expect, mock, test } from "bun:test";
import {
  formatErrorAdvice,
  formatToolLabel,
  renderChatHeader,
  renderMessageList,
  tryParseToolResult,
} from "../src/panels/ai-chat/chat-view";
import { ATTACHED_CONTEXT_DELIMITER } from "../src/panels/ai-chat/attached-context";
import type { Message } from "@jxsuite/ai/chat-state";

let idCounter = 0;
function msg(role: Message["role"], content: string, extra: Partial<Message> = {}): Message {
  idCounter += 1;
  return { content, id: `t_${idCounter}`, role, timestamp: idCounter, ...extra };
}

function list(messages: Message[], opts: { status?: string; error?: string | null } = {}) {
  return renderMessageList({
    error: opts.error ?? null,
    listRef: () => {},
    messages,
    onScroll: () => {},
    status: opts.status ?? "idle",
  });
}

describe("helpers", () => {
  test("tryParseToolResult parses only tool-result JSON", () => {
    expect(tryParseToolResult('{"success":true}')).toEqual({ success: true });
    expect(tryParseToolResult('{"success":false,"error":"bad path"}')).toEqual({
      error: "bad path",
      success: false,
    });
    expect(tryParseToolResult("not json")).toBeNull();
    expect(tryParseToolResult('{"other":1}')).toBeNull();
  });

  test("formatToolLabel includes the target path when present", () => {
    expect(formatToolLabel({ arguments: '{"path":["children",0]}', name: "set_prop" })).toBe(
      'set_prop: ["children",0]',
    );
    expect(formatToolLabel({ arguments: '{"parentPath":[]}', name: "add_child" })).toBe(
      "add_child: []",
    );
    expect(formatToolLabel({ arguments: "{partial", name: "add_child" })).toBe("add_child");
    expect(formatToolLabel({ arguments: "", name: "list" })).toBe("list");
  });

  test("formatErrorAdvice maps common failures to recovery hints", () => {
    expect(formatErrorAdvice("HTTP 401 unauthorized")).toContain("API key");
    expect(formatErrorAdvice("Network error while fetching")).toContain("dev server");
    expect(formatErrorAdvice("429 rate limit exceeded")).toContain("rate limit");
    expect(formatErrorAdvice("500 internal server error")).toContain("server error");
    expect(formatErrorAdvice("something exotic")).toBe("");
  });
});

describe("renderChatHeader", () => {
  test("shows the session title, or New chat for unsaved chats", async () => {
    const withTitle = await renderInto(
      renderChatHeader({
        onNewChat: () => {},
        onShowSessions: () => {},
        streaming: false,
        title: "Landing page",
      }),
    );
    expect(withTitle.querySelector(".ai-chat-title")!.textContent).toBe("Landing page");
    expect(withTitle.querySelector("sp-progress-circle")).toBeNull();

    const fresh = await renderInto(
      renderChatHeader({
        onNewChat: () => {},
        onShowSessions: () => {},
        streaming: true,
        title: null,
      }),
    );
    expect(fresh.querySelector(".ai-chat-title")!.textContent).toBe("New chat");
    expect(fresh.querySelector("sp-progress-circle")).not.toBeNull();
  });

  test("history and New Chat buttons fire their callbacks", async () => {
    const onShowSessions = mock(() => {});
    const onNewChat = mock(() => {});
    const el = await renderInto(
      renderChatHeader({ onNewChat, onShowSessions, streaming: false, title: null }),
    );
    pointer(el.querySelector("sp-action-button[title='Chat history']")!, "click");
    pointer(el.querySelector("sp-action-button[title='New chat']")!, "click");
    expect(onShowSessions).toHaveBeenCalledTimes(1);
    expect(onNewChat).toHaveBeenCalledTimes(1);
  });
});

describe("renderMessageList", () => {
  test("empty chat shows the getting-started hint", async () => {
    const el = await renderInto(list([]));
    expect(el.querySelector(".ai-chat-empty")).not.toBeNull();
  });

  test("user messages render as bubbles; attached context becomes chips", async () => {
    const plain = msg("user", "hello there");
    const withContext = msg(
      "user",
      `restyle this\n\n${ATTACHED_CONTEXT_DELIMITER}\nPage: pages/index.json\nSelected element at ["children",0]: <h1> "Hi"`,
    );
    const el = await renderInto(list([plain, withContext]));
    const bubbles = el.querySelectorAll(".ai-msg-user");
    expect(bubbles).toHaveLength(2);
    expect(bubbles[0]!.querySelector(".ai-msg-user-body")!.textContent).toBe("hello there");
    expect(bubbles[1]!.querySelector(".ai-msg-user-body")!.textContent).toBe("restyle this");
    const chips = bubbles[1]!.querySelectorAll(".ai-context-chip");
    expect(chips).toHaveLength(2);
    expect(chips[0]!.textContent).toContain("Page: pages/index.json");
  });

  test("assistant messages render markdown and tool chips; empty ones are skipped", async () => {
    const withText = msg("assistant", "Use **bold** text");
    const withTool = msg("assistant", "", {
      toolCalls: [{ arguments: '{"path":["children",1]}', id: "c1", name: "set_prop" }],
    });
    const empty = msg("assistant", "");
    const el = await renderInto(list([withText, withTool, empty]));
    const rows = el.querySelectorAll(".ai-msg-assistant");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.querySelector(".ai-msg-md strong")!.textContent).toBe("bold");
    expect(rows[1]!.querySelector(".ai-tool-chip")!.textContent).toContain(
      'set_prop: ["children",1]',
    );
  });

  test("tool messages surface failures only", async () => {
    const ok = msg("tool", '{"success":true}', { toolCallId: "c1" });
    const failed = msg("tool", '{"success":false,"error":"path not found"}', {
      toolCallId: "c2",
    });
    const el = await renderInto(list([ok, failed]));
    const errors = el.querySelectorAll(".ai-msg-tool-error");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.textContent).toContain("path not found");
  });

  test("streaming tail renders plain text (no markdown) with earlier messages finalized", async () => {
    const finalized = msg("assistant", "**done**");
    const tail = msg("assistant", "**partial");
    const el = await renderInto(list([finalized, tail], { status: "streaming" }));
    // The finalized message parsed markdown; the tail stayed literal.
    expect(el.querySelector(".ai-msg-md strong")!.textContent).toBe("done");
    expect(el.querySelector(".ai-msg-streaming")!.textContent).toBe("**partial");
  });

  test("an empty streaming tail shows the typing indicator", async () => {
    const el = await renderInto(
      list([msg("user", "hi"), msg("assistant", "")], {
        status: "streaming",
      }),
    );
    expect(el.querySelector(".ai-msg-typing")).not.toBeNull();
    // And the empty-assistant row is not rendered as a message.
    expect(el.querySelector(".ai-msg-assistant")).toBeNull();
  });

  test("errors render with advice once the stream has settled", async () => {
    const el = await renderInto(list([msg("user", "hi")], { error: "429 rate limit" }));
    const row = el.querySelector(".ai-msg-error")!;
    expect(row.textContent).toContain("429 rate limit");
    expect(row.querySelector(".ai-msg-error-advice")!.textContent).toContain("rate limit");

    // While streaming, the error row stays hidden.
    const streaming = await renderInto(
      list([msg("user", "hi"), msg("assistant", "x")], {
        error: "stale",
        status: "streaming",
      }),
    );
    expect(streaming.querySelector(".ai-msg-error")).toBeNull();
  });

  test("wires the scroll handler and list ref", async () => {
    const onScroll = mock(() => {});
    let referenced: Element | undefined;
    const el = await renderInto(
      renderMessageList({
        error: null,
        listRef: (node) => {
          referenced = node;
        },
        messages: [],
        onScroll,
        status: "idle",
      }),
    );
    const scroller = el.querySelector(".ai-chat-messages")!;
    expect(referenced).toBe(scroller);
    scroller.dispatchEvent(new Event("scroll"));
    expect(onScroll).toHaveBeenCalledTimes(1);
  });
});
