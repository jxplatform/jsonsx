/**
 * Tests for claude-session.ts — Claude Agent SDK session manager.
 *
 * The @anthropic-ai/claude-agent-sdk `query` export is mocked with a hand-controlled async
 * generator so no network calls or credentials are needed. Each call to `query()` consumes the next
 * queued generator factory (or an empty stream by default) and records its arguments for
 * assertions.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

interface QueryCall {
  options: Record<string, unknown>;
  prompt: string;
}

const queryCalls: QueryCall[] = [];
const pendingStreams: (() => AsyncGenerator<unknown>)[] = [];

async function* emptyStream() {
  // Yields nothing
}

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: QueryCall) => {
    queryCalls.push(args);
    const factory = pendingStreams.shift();
    return factory ? factory() : emptyStream();
  },
}));

const {
  createSession,
  sendMessage,
  stopSession,
  deleteSession,
  streamSession,
  getAuthStatus,
  getSession,
} = await import("../src/claude-session.ts");

/** Queue a generator that yields the given messages, then ends. */
function queueMessages(...messages: unknown[]) {
  pendingStreams.push(async function* messageStream() {
    for (const msg of messages) {
      yield msg;
    }
  });
}

type StreamCommand =
  | { kind: "end" }
  | { kind: "fail"; error: Error }
  | { kind: "message"; msg: unknown };

/** Queue a generator whose emission is controlled by the test. */
function queueControlled() {
  const commands: StreamCommand[] = [];
  let wake: (() => void) | null = null;

  function waitForWake(): Promise<void> {
    return new Promise<void>((resolve) => {
      wake = resolve;
    });
  }

  async function nextCommand(): Promise<StreamCommand> {
    while (commands.length === 0) {
      await waitForWake();
    }
    return commands.shift() as StreamCommand;
  }

  pendingStreams.push(async function* controlledStream() {
    for (;;) {
      const command = await nextCommand();
      if (command.kind === "fail") {
        throw command.error;
      }
      if (command.kind === "end") {
        return;
      }
      yield command.msg;
    }
  });

  const submit = (command: StreamCommand) => {
    commands.push(command);
    wake?.();
    wake = null;
  };

  return {
    end: () => submit({ kind: "end" }),
    fail: (error: Error) => submit({ error, kind: "fail" }),
    push: (msg: unknown) => submit({ kind: "message", msg }),
  };
}

/** Poll until the session settles into the given status. */
async function waitForStatus(id: string, status: string) {
  for (let i = 0; i < 500; i++) {
    const info = getSession(id);
    if (info && info.status === status) {
      return info;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 1);
    });
  }
  throw new Error(`Timed out waiting for session ${id} to reach status "${status}"`);
}

interface SseEvent {
  data: Record<string, unknown>;
  event: string;
}

/** Read `count` SSE events from a streamSession Response body. */
async function readSseEvents(response: Response, count: number): Promise<SseEvent[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const events: SseEvent[] = [];
  let buffer = "";
  try {
    while (events.length < count) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const chunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (!chunk.startsWith(":")) {
          const eventMatch = /^event: (.*)$/m.exec(chunk);
          const dataMatch = /^data: (.*)$/m.exec(chunk);
          if (eventMatch && dataMatch) {
            events.push({
              data: JSON.parse(dataMatch[1] as string) as Record<string, unknown>,
              event: eventMatch[1] as string,
            });
          }
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    await reader.cancel();
  }
  return events;
}

beforeEach(() => {
  queryCalls.length = 0;
  pendingStreams.length = 0;
});

// ─── Session creation ────────────────────────────────────────────────────────

describe("createSession", () => {
  test("returns a generated id with the ai_ prefix", async () => {
    queueMessages();
    const { id } = createSession("/tmp/project", "hello");
    expect(id).toMatch(/^ai_[0-9a-z]+_[0-9a-z]+$/);
    await waitForStatus(id, "idle");
    deleteSession(id);
  });

  test("generates unique ids across sessions", async () => {
    queueMessages();
    queueMessages();
    const a = createSession("/tmp/a", "one");
    const b = createSession("/tmp/b", "two");
    expect(a.id).not.toBe(b.id);
    await waitForStatus(a.id, "idle");
    await waitForStatus(b.id, "idle");
    deleteSession(a.id);
    deleteSession(b.id);
  });

  test("passes prompt and query options to the SDK", async () => {
    queueMessages();
    const { id } = createSession("/tmp/my-root", "do the thing");
    await waitForStatus(id, "idle");

    expect(queryCalls).toHaveLength(1);
    const call = queryCalls[0]!;
    expect(call.prompt).toBe("do the thing");
    expect(call.options.cwd).toBe("/tmp/my-root");
    expect(call.options.allowedTools).toEqual(["Read", "Edit", "Write", "Bash", "Glob", "Grep"]);
    expect(call.options.maxTurns).toBe(30);
    expect(call.options.permissionMode).toBe("acceptEdits");
    expect(call.options.persistSession).toBe(true);
    expect(call.options.includePartialMessages).toBe(true);
    expect(call.options.abortController).toBeInstanceOf(AbortController);
    deleteSession(id);
  });

  test("includes systemPrompt only when provided", async () => {
    queueMessages();
    queueMessages();
    const withPrompt = createSession("/tmp/p", "hi", { systemPrompt: "be terse" });
    const withoutPrompt = createSession("/tmp/p", "hi");
    await waitForStatus(withPrompt.id, "idle");
    await waitForStatus(withoutPrompt.id, "idle");

    expect(queryCalls[0]!.options.systemPrompt).toBe("be terse");
    expect("systemPrompt" in queryCalls[1]!.options).toBe(false);
    deleteSession(withPrompt.id);
    deleteSession(withoutPrompt.id);
  });

  test("is active while streaming, idle after the stream ends", async () => {
    const controlled = queueControlled();
    const { id } = createSession("/tmp/project", "hello");
    expect(getSession(id)!.status).toBe("active");
    controlled.end();
    await waitForStatus(id, "idle");
    deleteSession(id);
  });

  test("records streamed messages plus the final done marker", async () => {
    queueMessages({ session_id: "s1", type: "system" }, { session_id: "s1", type: "assistant" });
    const { id } = createSession("/tmp/project", "hello");
    const info = await waitForStatus(id, "idle");
    // Two SDK messages + the done broadcast
    expect(info.messageCount).toBe(3);
    deleteSession(id);
  });
});

// ─── Env handling ────────────────────────────────────────────────────────────

describe("SDK env construction", () => {
  test("strips parent Claude Code vars and sets the client app", async () => {
    const saved: Record<string, string | undefined> = {};
    const stripped = [
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "CLAUDE_CODE_ENTRYPOINT",
      "CLAUDE_CODE_EXECPATH",
      "CLAUDE_AGENT_SDK_VERSION",
      "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
      "CLAUDECODE",
    ];
    for (const key of stripped) {
      saved[key] = process.env[key];
      process.env[key] = "should-be-removed";
    }
    saved.JX_TEST_KEEP_ME = process.env.JX_TEST_KEEP_ME;
    process.env.JX_TEST_KEEP_ME = "kept";

    try {
      queueMessages();
      const { id } = createSession("/tmp/project", "hello");
      await waitForStatus(id, "idle");
      deleteSession(id);

      const env = queryCalls[0]!.options.env as Record<string, string | undefined>;
      for (const key of stripped) {
        expect(env[key]).toBeUndefined();
      }
      expect(env.JX_TEST_KEEP_ME).toBe("kept");
      expect(env.CLAUDE_AGENT_SDK_CLIENT_APP).toBe("jx-studio/0.17.0");
      // Process.env itself must not be mutated
      expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe("should-be-removed");
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});

// ─── Resume / follow-up messages ─────────────────────────────────────────────

describe("sendMessage", () => {
  test("throws for an unknown session id", () => {
    expect(() => sendMessage("ai_nope_1", "hello")).toThrow("Session not found: ai_nope_1");
  });

  test("throws while the session is still processing", async () => {
    const controlled = queueControlled();
    const { id } = createSession("/tmp/project", "hello");
    expect(() => sendMessage(id, "follow-up")).toThrow("Session is still processing");
    controlled.end();
    await waitForStatus(id, "idle");
    deleteSession(id);
  });

  test("resumes with the captured SDK session id", async () => {
    queueMessages({ session_id: "sdk-session-42", type: "system" });
    const { id } = createSession("/tmp/project", "hello");
    await waitForStatus(id, "idle");

    queueMessages({ session_id: "sdk-session-42", type: "assistant" });
    sendMessage(id, "follow-up");
    await waitForStatus(id, "idle");

    expect(queryCalls).toHaveLength(2);
    const call = queryCalls[1]!;
    expect(call.prompt).toBe("follow-up");
    expect(call.options.resume).toBe("sdk-session-42");
    expect("continue" in call.options).toBe(false);
    expect(call.options.cwd).toBe("/tmp/project");
    deleteSession(id);
  });

  test("falls back to continue:true when no SDK session id was captured", async () => {
    queueMessages({ type: "system" });
    const { id } = createSession("/tmp/project", "hello");
    await waitForStatus(id, "idle");

    queueMessages();
    sendMessage(id, "follow-up");
    await waitForStatus(id, "idle");

    const call = queryCalls[1]!;
    expect(call.options.continue).toBe(true);
    expect("resume" in call.options).toBe(false);
    deleteSession(id);
  });

  test("keeps the first captured session id", async () => {
    queueMessages(
      { session_id: "first", type: "system" },
      { session_id: "second", type: "assistant" },
    );
    const { id } = createSession("/tmp/project", "hello");
    await waitForStatus(id, "idle");

    queueMessages();
    sendMessage(id, "follow-up");
    await waitForStatus(id, "idle");

    expect(queryCalls[1]!.options.resume).toBe("first");
    deleteSession(id);
  });
});

// ─── Interrupt / cleanup ─────────────────────────────────────────────────────

describe("stopSession", () => {
  test("is a no-op for an unknown id", () => {
    expect(() => stopSession("ai_missing_1")).not.toThrow();
  });

  test("aborts the in-flight query and drops later messages", async () => {
    const controlled = queueControlled();
    const { id } = createSession("/tmp/project", "hello");

    controlled.push({ session_id: "s", type: "assistant" });
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });

    stopSession(id);
    const abortController = queryCalls[0]!.options.abortController as AbortController;
    expect(abortController.signal.aborted).toBe(true);

    controlled.push({ session_id: "s", type: "assistant" });
    controlled.end();
    const info = await waitForStatus(id, "idle");
    // Only the first message + done; the post-stop message is dropped
    expect(info.messageCount).toBe(2);
    deleteSession(id);
  });
});

describe("deleteSession", () => {
  test("removes the session entirely", async () => {
    queueMessages();
    const { id } = createSession("/tmp/project", "hello");
    await waitForStatus(id, "idle");
    deleteSession(id);
    expect(getSession(id)).toBeNull();
  });

  test("stops an active session before removal", () => {
    queueControlled();
    const { id } = createSession("/tmp/project", "hello");
    deleteSession(id);
    expect(getSession(id)).toBeNull();
    const abortController = queryCalls[0]!.options.abortController as AbortController;
    expect(abortController.signal.aborted).toBe(true);
  });
});

// ─── Error paths ─────────────────────────────────────────────────────────────

describe("stream error handling", () => {
  test("broadcasts an error event when the generator throws", async () => {
    const controlled = queueControlled();
    const { id } = createSession("/tmp/project", "hello");
    controlled.fail(new Error("boom"));
    await waitForStatus(id, "idle");

    const events = await readSseEvents(streamSession(id) as Response, 2);
    expect(events[0]!.event).toBe("error");
    expect(events[0]!.data.error).toContain("boom");
    expect(events[1]!.event).toBe("done");
    deleteSession(id);
  });

  test("suppresses AbortError but still broadcasts done", async () => {
    const controlled = queueControlled();
    const { id } = createSession("/tmp/project", "hello");
    const abort = new Error("aborted");
    abort.name = "AbortError";
    controlled.fail(abort);
    const info = await waitForStatus(id, "idle");

    expect(info.messageCount).toBe(1);
    const events = await readSseEvents(streamSession(id) as Response, 1);
    expect(events[0]!.event).toBe("done");
    deleteSession(id);
  });
});

// ─── SSE streaming ───────────────────────────────────────────────────────────

describe("streamSession", () => {
  test("returns 404 for an unknown session", async () => {
    const response = streamSession("ai_unknown_1") as Response;
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Session not found");
  });

  test("returns an event-stream response with replayed history", async () => {
    queueMessages({ session_id: "s", type: "assistant" }, { session_id: "s", type: "result" });
    const { id } = createSession("/tmp/project", "hello");
    await waitForStatus(id, "idle");

    const response = streamSession(id) as Response;
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
    expect(response.headers.get("Connection")).toBe("keep-alive");

    const events = await readSseEvents(response, 3);
    expect(events.map((e) => e.event)).toEqual(["assistant", "result", "done"]);
    expect(events[0]!.data.session_id).toBe("s");
    deleteSession(id);
  });

  test("fans out live messages to multiple subscribers", async () => {
    const controlled = queueControlled();
    const { id } = createSession("/tmp/project", "hello");

    const responseA = streamSession(id) as Response;
    const responseB = streamSession(id) as Response;

    controlled.push({ session_id: "s", text: "first", type: "assistant" });
    // oxlint-disable-next-line unicorn/prefer-single-call -- controlled.push() is a queue helper taking one message, not Array#push
    controlled.push({ session_id: "s", text: "second", type: "assistant" });
    controlled.end();
    await waitForStatus(id, "idle");

    const [eventsA, eventsB] = await Promise.all([
      readSseEvents(responseA, 3),
      readSseEvents(responseB, 3),
    ]);
    for (const events of [eventsA, eventsB]) {
      expect(events.map((e) => e.event)).toEqual(["assistant", "assistant", "done"]);
      expect(events[0]!.data.text).toBe("first");
      expect(events[1]!.data.text).toBe("second");
    }
    deleteSession(id);
  });

  test("a cancelled subscriber stops receiving broadcasts", async () => {
    const controlled = queueControlled();
    const { id } = createSession("/tmp/project", "hello");

    const response = streamSession(id) as Response;
    await response.body!.cancel();

    controlled.push({ session_id: "s", type: "assistant" });
    controlled.end();
    const info = await waitForStatus(id, "idle");
    // Message still recorded even though the only subscriber disconnected
    expect(info.messageCount).toBe(2);
    deleteSession(id);
  });

  test("uses a fallback event name for messages without a type", async () => {
    queueMessages({ session_id: "s" });
    const { id } = createSession("/tmp/project", "hello");
    await waitForStatus(id, "idle");

    const events = await readSseEvents(streamSession(id) as Response, 2);
    expect(events[0]!.event).toBe("message");
    expect(events[1]!.event).toBe("done");
    deleteSession(id);
  });
});

// ─── getSession ──────────────────────────────────────────────────────────────

describe("getSession", () => {
  test("returns null for an unknown id", () => {
    expect(getSession("ai_unknown_2")).toBeNull();
  });

  test("returns id, status and message count", async () => {
    queueMessages({ session_id: "s", type: "assistant" });
    const { id } = createSession("/tmp/project", "hello");
    const info = await waitForStatus(id, "idle");
    expect(info.id).toBe(id);
    expect(info.status).toBe("idle");
    expect(info.messageCount).toBe(2);
    deleteSession(id);
  });
});

// ─── Auth probe ──────────────────────────────────────────────────────────────

describe("getAuthStatus", () => {
  test("sends a probe prompt with maxTurns 1 and no persistence", async () => {
    queueMessages({ message: { content: [{ text: "OK", type: "text" }] }, type: "assistant" });
    await getAuthStatus();
    const call = queryCalls[0]!;
    expect(call.prompt).toBe("Say OK");
    expect(call.options.maxTurns).toBe(1);
    expect(call.options.persistSession).toBe(false);
  });

  test("authenticated on a clean assistant reply", async () => {
    queueMessages({ message: { content: [{ text: "OK", type: "text" }] }, type: "assistant" });
    expect(await getAuthStatus()).toEqual({ authenticated: true });
  });

  test("not authenticated when the assistant text mentions an error", async () => {
    queueMessages({
      message: { content: [{ text: "API Error: invalid key", type: "text" }] },
      type: "assistant",
    });
    expect(await getAuthStatus()).toEqual({
      authenticated: false,
      error: "API Error: invalid key",
    });
  });

  test("authenticated when the assistant has no text block", async () => {
    queueMessages({ message: { content: [{ type: "tool_use" }] }, type: "assistant" });
    expect(await getAuthStatus()).toEqual({ authenticated: true });
  });

  test("authenticated on a non-error result message", async () => {
    queueMessages({ is_error: false, type: "result" });
    expect(await getAuthStatus()).toEqual({ authenticated: true });
  });

  test("not authenticated on an error result with a message", async () => {
    queueMessages({ is_error: true, result: "Not logged in", type: "result" });
    expect(await getAuthStatus()).toEqual({ authenticated: false, error: "Not logged in" });
  });

  test("falls back to a generic error label on an empty error result", async () => {
    queueMessages({ is_error: true, type: "result" });
    expect(await getAuthStatus()).toEqual({ authenticated: false, error: "API error" });
  });

  test("authenticated when the stream ends without assistant or result", async () => {
    queueMessages({ type: "system" });
    expect(await getAuthStatus()).toEqual({ authenticated: true });
  });

  test("not authenticated when the query throws", async () => {
    pendingStreams.push(async function* failingStream() {
      yield* [];
      throw new Error("spawn failed");
    });
    expect(await getAuthStatus()).toEqual({
      authenticated: false,
      error: "Error: spawn failed",
    });
  });
});
