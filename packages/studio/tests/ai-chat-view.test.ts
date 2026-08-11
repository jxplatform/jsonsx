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
  toolOutcome,
  toolOutcomeText,
  tryParseToolResult,
} from "../src/panels/ai-chat/chat-view";
import { beginTurn, endTurn, recordWrite, resetAiWrites } from "../src/services/ai-writes";
import { ATTACHED_CONTEXT_DELIMITER } from "../src/panels/ai-chat/attached-context";
import type { Message } from "@jxsuite/ai/chat-state";

let idCounter = 0;
function msg(role: Message["role"], content: string, extra: Partial<Message> = {}): Message {
  idCounter += 1;
  return { content, id: `t_${idCounter}`, role, timestamp: idCounter, ...extra };
}

function list(
  messages: Message[],
  opts: {
    status?: string;
    error?: string | null;
    onRetry?: () => void;
    onRestore?: (id: string) => void;
  } = {},
) {
  return renderMessageList({
    error: opts.error ?? null,
    listRef: () => {},
    messages,
    onScroll: () => {},
    status: opts.status ?? "idle",
    ...(opts.onRetry ? { onRetry: opts.onRetry } : {}),
    ...(opts.onRestore ? { onRestore: opts.onRestore } : {}),
  });
}

/** File a ledger entry against a message id, the way the agent loop does. */
function ledger(id: string, writes: { disk: boolean; ok: boolean; path: string }[]) {
  beginTurn(`for:${id}`);
  for (const w of writes) {
    recordWrite({ ...w, tool: "write_file" });
  }
  endTurn(id);
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
  /*
   * `services/context-manager.ts` has computed the token count and the warning flag on every turn
   * since it was written, and `chat-state.ts` has stored them, and NOTHING read either. Plan §11.6:
   * "Context budget manager → tokenCount / contextWarning actually rendered". A conversation was
   * silently trimmed, the assistant forgot what you told it ten turns ago, and the two numbers that
   * would have explained why sat in the store.
   */
  test("the context budget is shown, compactly, and warns when it is past half", async () => {
    const quiet = await renderInto(
      renderChatHeader({
        onNewChat: () => {},
        onShowSessions: () => {},
        overBudget: false,
        streaming: false,
        title: null,
        tokens: 18_400,
      }),
    );
    const badge = quiet.querySelector(".ai-tokens")!;
    expect(badge.textContent).toBe("18.4k");
    expect(badge.classList.contains("ai-tokens--warn")).toBe(false);
    expect(badge.getAttribute("title")).toContain("18,400 tokens");

    const loud = await renderInto(
      renderChatHeader({
        onNewChat: () => {},
        onShowSessions: () => {},
        overBudget: true,
        streaming: false,
        title: null,
        tokens: 96_000,
      }),
    );
    const warned = loud.querySelector(".ai-tokens")!;
    expect(warned.classList.contains("ai-tokens--warn")).toBe(true);
    // The badge has to say what happens next, not just that a number is large.
    expect(warned.getAttribute("title")).toContain("oldest turns are dropped");
  });

  test("a fresh chat shows no budget at all — zero is not a fact worth a badge", async () => {
    const el = await renderInto(
      renderChatHeader({
        onNewChat: () => {},
        onShowSessions: () => {},
        overBudget: false,
        streaming: false,
        title: null,
        tokens: 0,
      }),
    );
    expect(el.querySelector(".ai-tokens")).toBeNull();
  });

  test("shows the session title, or New chat for unsaved chats", async () => {
    const withTitle = await renderInto(
      renderChatHeader({
        overBudget: false,
        tokens: 0,
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
        overBudget: false,
        tokens: 0,
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
      renderChatHeader({
        onNewChat,
        onShowSessions,
        overBudget: false,
        streaming: false,
        title: null,
        tokens: 0,
      }),
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

// ─── §7.4: the three things the renderer would not say ───────────────────────

describe("tool chips render outcomes", () => {
  test("toolOutcome/toolOutcomeText read the result the loop has always populated", () => {
    expect(toolOutcome({ arguments: "{}", id: "1", name: "x" })).toBe("pending");
    expect(toolOutcomeText({ arguments: "{}", id: "1", name: "x" })).toBe("");
    const ok = { arguments: "{}", id: "1", name: "x", result: { success: true, summary: "Done." } };
    expect(toolOutcome(ok)).toBe("ok");
    expect(toolOutcomeText(ok)).toBe("Done.");
    const bad = { arguments: "{}", id: "1", name: "x", result: { error: "Nope.", success: false } };
    expect(toolOutcome(bad)).toBe("failed");
    expect(toolOutcomeText(bad)).toBe("Nope.");
  });

  test("a chip says what became of the call, not only what was called", async () => {
    resetAiWrites();
    const el = await renderInto(
      list([
        msg("assistant", "", {
          toolCalls: [
            {
              arguments: "{}",
              id: "a",
              name: "update_style",
              result: { success: true, summary: "Set padding." },
            },
            {
              arguments: "{}",
              id: "b",
              name: "remove_node",
              result: { error: "No such path.", success: false },
            },
            { arguments: "{}", id: "c", name: "read_file" },
          ],
        }),
      ]),
    );
    const chips = [...el.querySelectorAll(".ai-tool-chip")];
    expect(chips.map((c) => (c as HTMLElement).dataset.outcome)).toEqual([
      "ok",
      "failed",
      "pending",
    ]);
    expect(chips[0]!.textContent).toContain("Set padding.");
    expect(chips[1]!.textContent).toContain("No such path.");
    // A call still in flight claims nothing.
    expect(chips[2]!.querySelector(".ai-tool-chip-outcome")).toBeNull();
  });
});

describe("changed-files summary", () => {
  test('a turn that changed nothing renders no summary — never "Changed 0 files"', async () => {
    resetAiWrites();
    const m = msg("assistant", "I looked at the page.");
    const el = await renderInto(list([m]));
    expect(el.querySelector(".ai-msg-changes")).toBeNull();
  });

  test("the summary counts distinct files and names the disk writes undo cannot reach", async () => {
    resetAiWrites();
    const m = msg("assistant", "Done.");
    ledger(m.id, [
      { disk: false, ok: true, path: "pages/index.json" },
      { disk: true, ok: true, path: "layouts/base.json" },
    ]);
    const el = await renderInto(list([m]));
    const summary = el.querySelector(".ai-msg-changes > summary")!;
    expect(summary.textContent).toContain("Changed 2 files");
    expect(summary.textContent).toContain("undo cannot reach it");
    const diskRow = el.querySelector('.ai-msg-changes-list li[data-disk="true"]')!;
    expect(diskRow.textContent).toContain("layouts/base.json");
    expect(diskRow.querySelector("em")?.textContent).toContain("undo cannot reach it");
  });

  test("Restore to here is offered only when every change was transactional", async () => {
    resetAiWrites();
    const transactional = msg("assistant", "A.");
    ledger(transactional.id, [{ disk: false, ok: true, path: "pages/index.json" }]);
    const withDisk = msg("assistant", "B.");
    ledger(withDisk.id, [{ disk: true, ok: true, path: "pages/other.json" }]);

    const restored: string[] = [];
    const el = await renderInto(
      list([transactional, withDisk], { onRestore: (id) => restored.push(id) }),
    );
    const buttons = [...el.querySelectorAll(".ai-msg-changes sp-action-button")];
    expect(buttons).toHaveLength(1);
    pointer(buttons[0]!, "click");
    expect(restored).toEqual([transactional.id]);
  });

  test("no onRestore handler means no button, and the summary still renders", async () => {
    resetAiWrites();
    const m = msg("assistant", "A.");
    ledger(m.id, [{ disk: false, ok: true, path: "pages/index.json" }]);
    const el = await renderInto(list([m]));
    expect(el.querySelector(".ai-msg-changes")).not.toBeNull();
    expect(el.querySelector(".ai-msg-changes sp-action-button")).toBeNull();
  });

  test("a turn where every write failed says so instead of claiming files", async () => {
    resetAiWrites();
    const m = msg("assistant", "A.");
    ledger(m.id, [{ disk: true, ok: false, path: "pages/index.json" }]);
    const el = await renderInto(list([m]));
    expect(el.querySelector(".ai-msg-changes > summary")!.textContent).toContain("1 change failed");
  });
});

describe("the error row offers Retry", () => {
  test("chatState.retryLast finally gets its button", async () => {
    let retried = 0;
    const el = await renderInto(
      list([], { error: "429 rate limit", onRetry: () => (retried += 1) }),
    );
    const button = el.querySelector(".ai-msg-retry")!;
    expect(button).not.toBeNull();
    pointer(button, "click");
    expect(retried).toBe(1);
    // The existing advice is still there — Retry supplements it, it does not replace it.
    expect(el.querySelector(".ai-msg-error-advice")?.textContent).toContain("rate limit");
  });

  test("no handler means no button", async () => {
    const el = await renderInto(list([], { error: "boom" }));
    expect(el.querySelector(".ai-msg-retry")).toBeNull();
  });
});
