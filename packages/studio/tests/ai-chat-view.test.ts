/**
 * Tests for src/panels/ai-chat/chat-view.ts — the chat header and message-list templates: row
 * anatomy per role (user bubbles + context chips, assistant markdown + tool chips, failed-tool
 * surfacing, streaming tail, error row) and the moved helper functions.
 *
 * The three buttons this file draws are COMMANDS now (§11.1). So the header and the error row are
 * tested the way `tests/statusbar.test.ts` tests the bar: against a registry of bare stubs, because
 * the contract is "renders the record the registry holds, and nothing when it holds none" — what
 * the ids DO is `tests/ai-panel.test.ts`'s subject. The last test in the file closes the loop the
 * same way the status bar's does: every id named here is one the real app declares.
 */
import { pointer, renderInto } from "./harness";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  formatErrorAdvice,
  formatToolLabel,
  renderChatHeader,
  renderMessageList,
  parseAsk,
  toolOutcome,
  toolOutcomeText,
  tryParseToolResult,
} from "../src/panels/ai-chat/chat-view";
import type { AskHandlers } from "../src/panels/ai-chat/chat-view";
import { beginTurn, endTurn, recordWrite, resetAiWrites } from "../src/services/ai-writes";
import { ATTACHED_CONTEXT_DELIMITER } from "../src/panels/ai-chat/attached-context";
import { setActiveRegistry } from "../src/commands/active-registry";
import { createCommandRegistry } from "../src/commands/registry";
import { makeContext } from "../src/commands/context";
import type { CommandContext } from "../src/commands/context";
import type { AnyCommand } from "../src/commands/registry";
import type { Message } from "@jxsuite/ai/chat-state";

let idCounter = 0;
function msg(role: Message["role"], content: string, extra: Partial<Message> = {}): Message {
  idCounter += 1;
  return { content, id: `t_${idCounter}`, role, timestamp: idCounter, ...extra };
}

// ─── The registry the buttons render from ────────────────────────────────────

let ctx: CommandContext = makeContext();
const ran: string[] = [];

/** One record, as bare as the registry allows: the view must not care what it does. */
function stub(id: string, title: string, extra: Partial<AnyCommand> = {}): AnyCommand {
  return {
    category: "Assistant",
    id,
    level: "application",
    run: () => {
      ran.push(id);
    },
    title,
    ...extra,
  } as AnyCommand;
}

const ASSISTANT_STUBS: readonly AnyCommand[] = [
  stub("assistant.history", "Chat History", { keybinding: "mod+shift+h" }),
  stub("assistant.newChat", "New Chat"),
  stub("assistant.retry", "Retry Last Message", {
    enablement: (c: CommandContext) => c.ai.configured,
    requires: "a connected AI provider",
  }),
];

function buildRegistry(ids?: readonly string[]) {
  const registry = createCommandRegistry({ getContext: () => ctx, mac: true });
  registry.registerAll(ids ? ASSISTANT_STUBS.filter((c) => ids.includes(c.id)) : ASSISTANT_STUBS);
  return registry;
}

beforeEach(() => {
  ctx = makeContext({ ai: { configured: true } });
  ran.length = 0;
  setActiveRegistry(buildRegistry());
});

afterEach(() => {
  setActiveRegistry(null);
});

function header(opts: Partial<Parameters<typeof renderChatHeader>[0]> = {}) {
  return renderChatHeader({
    overBudget: false,
    streaming: false,
    title: null,
    tokens: 0,
    ...opts,
  });
}

function list(
  messages: Message[],
  opts: {
    status?: string;
    error?: string | null;
    onRestore?: (id: string) => void;
    ask?: AskHandlers;
  } = {},
) {
  return renderMessageList({
    error: opts.error ?? null,
    listRef: () => {},
    messages,
    onScroll: () => {},
    status: opts.status ?? "idle",
    ...(opts.ask ? { ask: opts.ask } : {}),
    ...(opts.onRestore ? { onRestore: opts.onRestore } : {}),
  });
}

/** An assistant turn whose only tool call is a question. */
function asking(
  id: string,
  args: object,
  result?: { success: boolean; data?: unknown; error?: string },
): Message {
  return msg("assistant", "", {
    toolCalls: [
      {
        arguments: JSON.stringify(args),
        id,
        name: "ask_user",
        ...(result ? { result: result as never } : {}),
      },
    ],
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
    const quiet = await renderInto(header({ tokens: 18_400 }));
    const badge = quiet.querySelector(".ai-tokens")!;
    expect(badge.textContent).toBe("18.4k");
    expect(badge.classList.contains("ai-tokens--warn")).toBe(false);
    expect(badge.getAttribute("title")).toContain("18,400 tokens");

    const loud = await renderInto(header({ overBudget: true, tokens: 96_000 }));
    const warned = loud.querySelector(".ai-tokens")!;
    expect(warned.classList.contains("ai-tokens--warn")).toBe(true);
    // The badge has to say what happens next, not just that a number is large.
    expect(warned.getAttribute("title")).toContain("oldest turns are dropped");
  });

  test("a fresh chat shows no budget at all — zero is not a fact worth a badge", async () => {
    const el = await renderInto(header());
    expect(el.querySelector(".ai-tokens")).toBeNull();
  });

  test("shows the session title, or New chat for unsaved chats", async () => {
    const withTitle = await renderInto(header({ title: "Landing page" }));
    expect(withTitle.querySelector(".ai-chat-title")!.textContent).toBe("Landing page");
    expect(withTitle.querySelector("sp-progress-circle")).toBeNull();

    const fresh = await renderInto(header({ streaming: true }));
    expect(fresh.querySelector(".ai-chat-title")!.textContent).toBe("New chat");
    expect(fresh.querySelector("sp-progress-circle")).not.toBeNull();
  });

  test("history and New Chat RUN their records, and wear the record's name and chord", async () => {
    // The two capabilities were closures this file invoked, so they existed only as buttons: the
    // `Assistant` category held no records and neither was in the palette or bindable.
    const el = await renderInto(header());
    const history = el.querySelector("sp-action-button[title^='Chat History']")!;
    expect(history.getAttribute("title")).toBe("Chat History (⌘⇧H)");
    pointer(history, "click");
    pointer(el.querySelector("sp-action-button[title='New Chat']")!, "click");
    expect(ran).toEqual(["assistant.history", "assistant.newChat"]);
  });

  test("a command the registry does not hold draws nothing — not a dead button", async () => {
    setActiveRegistry(buildRegistry(["assistant.history"]));
    const el = await renderInto(header());
    expect(el.querySelector("sp-action-button[title^='Chat History']")).not.toBeNull();
    expect(el.querySelector("sp-action-button[title='New Chat']")).toBeNull();

    // And with no registry at all — the frame the app paints before its bootstrap composes one —
    // The chat is still a readable chat.
    setActiveRegistry(null);
    const bare = await renderInto(header({ title: "Landing page" }));
    expect(bare.querySelector(".ai-chat-title")!.textContent).toBe("Landing page");
    expect(bare.querySelectorAll("sp-action-button")).toHaveLength(0);
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
  test("chatState.retryLast finally gets its button, and it is `assistant.retry`", async () => {
    const el = await renderInto(list([], { error: "429 rate limit" }));
    const button = el.querySelector(".ai-msg-retry")!;
    expect(button).not.toBeNull();
    pointer(button, "click");
    expect(ran).toEqual(["assistant.retry"]);
    // The existing advice is still there — Retry supplements it, it does not replace it.
    expect(el.querySelector(".ai-msg-error-advice")?.textContent).toContain("rate limit");
  });

  test("with no provider connected the button is disabled, and says why", async () => {
    // The one error Retry cannot recover from is the one whose advice line already says to add a
    // Key. Offering a send that fails identically would be the panel lying about what it can do.
    ctx = makeContext({ ai: { configured: false } });
    const el = await renderInto(list([], { error: "HTTP 401 unauthorized" }));
    const button = el.querySelector(".ai-msg-retry")!;
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.getAttribute("title")).toBe(
      "Retry Last Message — requires a connected AI provider",
    );
    pointer(button, "click");
    expect(ran).toEqual([]);
  });

  test("no record means no button", async () => {
    setActiveRegistry(buildRegistry([]));
    const el = await renderInto(list([], { error: "boom" }));
    expect(el.querySelector(".ai-msg-retry")).toBeNull();
  });
});

describe("every id this file names is one the real app declares", () => {
  /* The status bar's bargain (`tests/statusbar.test.ts`), for the assistant: `commandButton`
     renders NOTHING for an id the registry does not hold, so a rename on the other side would leave
     these three buttons permanently blank with no test failing — which is exactly how
     `collab.showStatus` sat unrendered behind a comment claiming it was fine. */
  test("the header's and the error row's command ids resolve", async () => {
    const { appCommandSet } = await import("../src/commands/app-commands");
    const declared = new Set(appCommandSet().map((c) => c.id));
    const source = readFileSync(
      new URL("../src/panels/ai-chat/chat-view.ts", import.meta.url),
      "utf8",
    );
    const named = [...source.matchAll(/commandButton\("([\w.]+)"/g)].map((m) => m[1] as string);
    expect(named).toEqual(["assistant.history", "assistant.newChat", "assistant.retry"]);
    expect(named.filter((id) => !declared.has(id))).toEqual([]);
  });
});

describe("the question card", () => {
  test("renders the question, its context and its options", async () => {
    const el = await renderInto(
      list(
        [asking("q1", { context: "3 look alike", options: ["Merge", "Keep"], question: "Which?" })],
        {
          ask: { pendingId: "q1" },
        },
      ),
    );
    expect(el.querySelector(".ai-ask-question")?.textContent?.trim()).toBe("Which?");
    expect(el.querySelector(".ai-ask-context")?.textContent?.trim()).toBe("3 look alike");
    const buttons = [...el.querySelectorAll(".ai-ask-options sp-button")];
    expect(buttons.map((b) => b.textContent?.trim())).toEqual(["Merge", "Keep"]);
    // A gears chip would be the wrong shape for the one row that will not proceed without a reader.
    expect(el.querySelector(".ai-tool-chip")).toBeNull();
  });

  test("an option button answers with its own text", async () => {
    const onAnswer = mock((_t: string) => {});
    const el = await renderInto(
      list([asking("q1", { options: ["Merge", "Keep"], question: "Which?" })], {
        ask: { onAnswer, pendingId: "q1" },
      }),
    );
    pointer(el.querySelectorAll(".ai-ask-options sp-button")[1] as HTMLElement, "click");
    expect(onAnswer).toHaveBeenCalledWith("Keep");
  });

  test("You decide is always offered, even with no options", async () => {
    const onSkip = mock(() => {});
    const el = await renderInto(
      list([asking("q1", { question: "Which?" })], { ask: { onSkip, pendingId: "q1" } }),
    );
    expect(el.querySelectorAll(".ai-ask-options sp-button")).toHaveLength(0);
    pointer(el.querySelector(".ai-ask-skip") as HTMLElement, "click");
    expect(onSkip).toHaveBeenCalled();
  });

  test("an answered question shows the answer and offers no buttons", async () => {
    const el = await renderInto(
      list([
        asking(
          "q1",
          { options: ["Merge"], question: "Which?" },
          { data: { answer: "Neither", skipped: false }, success: true },
        ),
      ]),
    );
    expect(el.querySelector(".ai-ask-answer")?.textContent?.trim()).toBe("Neither");
    expect(el.querySelector(".ai-ask-options")).toBeNull();
  });

  test("a skipped question says so rather than showing an empty answer", async () => {
    const el = await renderInto(
      list([
        asking(
          "q1",
          { question: "Which?" },
          { data: { answer: null, skipped: true }, success: true },
        ),
      ]),
    );
    expect(el.querySelector(".ai-ask-answer")?.textContent?.trim()).toBe("You decide");
  });

  test("a failed question renders its reason", async () => {
    const el = await renderInto(
      list([
        asking("q1", { question: "Which?" }, { error: "the turn was stopped", success: false }),
      ]),
    );
    expect(el.querySelector(".ai-ask-outcome")?.textContent).toContain("the turn was stopped");
  });

  test("a question left open by a reload is inert, and says why", async () => {
    /* The promise lives in memory and the transcript does not. Without this the restored card is
       indistinguishable from a live one and waits on a loop that is gone. */
    const el = await renderInto(
      list([asking("q1", { options: ["Merge"], question: "Which?" })], {
        ask: { pendingId: null },
      }),
    );
    expect((el.querySelector(".ai-ask") as HTMLElement | null)?.dataset.outcome).toBe("unanswered");
    expect(el.querySelector(".ai-ask-options")).toBeNull();
    expect(el.querySelector(".ai-ask-outcome")?.textContent).toContain("reloaded");
  });

  test("a half-streamed question falls back to an ordinary chip", async () => {
    // Arguments arrive as fragments, so a chip can be asked to draw a call whose JSON is unfinished.
    const half = msg("assistant", "Let me check", {
      toolCalls: [{ arguments: '{"question":"Whi', id: "q1", name: "ask_user" }],
    });
    const el = await renderInto(list([half], { status: "streaming" }));
    expect(el.querySelector(".ai-ask")).toBeNull();
    expect(el.querySelector(".ai-tool-chip")).not.toBeNull();
  });

  test("the streaming tail draws a completed question too", async () => {
    /* In the real loop `finishStream` runs BEFORE tools execute, so a live question is drawn by the
       settled-message path. The tail still has to handle one: the model may write text, emit the
       call, and have the round end while this row is the tail. */
    const tail = msg("assistant", "One thing first.", {
      toolCalls: [
        { arguments: JSON.stringify({ question: "Which?" }), id: "q1", name: "ask_user" },
      ],
    });
    const el = await renderInto(list([tail], { ask: { pendingId: "q1" }, status: "streaming" }));
    expect(el.querySelector(".ai-ask-question")?.textContent?.trim()).toBe("Which?");
  });
});

describe("parseAsk", () => {
  /** Read a question out of the arguments an `ask_user` call would carry. */
  function ask(args: object | string) {
    const encoded = typeof args === "string" ? args : JSON.stringify(args);
    return parseAsk({ arguments: encoded, id: "q", name: "ask_user" });
  }

  test("reads a question, its options and its context", () => {
    expect(ask({ context: "c", options: ["a"], question: "Q" })).toEqual({
      context: "c",
      options: ["a"],
      question: "Q",
    });
  });

  test("tolerates unfinished and malformed JSON", () => {
    expect(ask('{"question":"Q')).toBeNull();
    expect(ask("")).toBeNull();
  });

  test("refuses a call with no question to show", () => {
    expect(ask({})).toBeNull();
    expect(ask({ question: "   " })).toBeNull();
    expect(ask({ question: 42 })).toBeNull();
  });

  test("drops non-string options and a non-array options field", () => {
    expect(ask({ options: ["a", 1, ""], question: "Q" })?.options).toEqual(["a"]);
    expect(ask({ options: "nope", question: "Q" })?.options).toEqual([]);
    expect(ask({ context: 9, question: "Q" })?.context).toBe("");
  });
});
