import { beforeEach, describe, expect, mock, test } from "bun:test";

// Mock the claude-session module before importing ai.ts so no SDK code loads.
const mockGetAuthStatus = mock(async () => ({ authenticated: true }));
const mockCreateSession = mock(
  (_root: string, _message: string, _opts: { systemPrompt?: string }) => ({ id: "sess-1" }),
);
const mockStreamSession = mock((_id: string) => new Response("stream", { status: 200 }));
const mockSendMessage = mock((_id: string, _message: string) => {});
const mockStopSession = mock((_id: string) => {});
const mockDeleteSession = mock((_id: string) => {});
const mockGetSession = mock((_id: string): Record<string, unknown> | null => ({
  id: "sess-1",
  status: "active",
}));

mock.module("@jxsuite/server/claude-session", () => ({
  createSession: mockCreateSession,
  deleteSession: mockDeleteSession,
  getAuthStatus: mockGetAuthStatus,
  getSession: mockGetSession,
  sendMessage: mockSendMessage,
  stopSession: mockStopSession,
  streamSession: mockStreamSession,
}));

const { handleAiRoute } = await import("../src/ai");

const ROOT = "/tmp/project";

function makeReq(path: string, method: string, body?: unknown): Request {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
    init.headers = { "Content-Type": "application/json" };
  }
  return new Request(`http://localhost${path}`, init);
}

beforeEach(() => {
  mockGetAuthStatus.mockClear();
  mockCreateSession.mockClear();
  mockStreamSession.mockClear();
  mockSendMessage.mockClear();
  mockStopSession.mockClear();
  mockDeleteSession.mockClear();
  mockGetSession.mockClear();
});

describe("handleAiRoute — routing", () => {
  test("returns null for non-AI paths", async () => {
    const res = await handleAiRoute(makeReq("/studio/files", "GET"), "/studio/files", ROOT);
    expect(res).toBeNull();
  });

  test("returns null for unmatched AI sub-paths", async () => {
    const res = await handleAiRoute(
      makeReq("/studio/ai/unknown", "PUT"),
      "/studio/ai/unknown",
      ROOT,
    );
    expect(res).toBeNull();
  });

  test("returns null for auth-status with wrong method", async () => {
    const res = await handleAiRoute(
      makeReq("/studio/ai/auth-status", "POST"),
      "/studio/ai/auth-status",
      ROOT,
    );
    expect(res).toBeNull();
  });
});

describe("handleAiRoute — auth-status", () => {
  test("GET returns auth status from session module", async () => {
    const res = await handleAiRoute(
      makeReq("/studio/ai/auth-status", "GET"),
      "/studio/ai/auth-status",
      ROOT,
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual({ authenticated: true });
    expect(mockGetAuthStatus).toHaveBeenCalledTimes(1);
  });
});

describe("handleAiRoute — create session", () => {
  test("POST creates session and returns id", async () => {
    const res = await handleAiRoute(
      makeReq("/studio/ai/session", "POST", { message: "hello" }),
      "/studio/ai/session",
      ROOT,
    );
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual({ id: "sess-1" });
    expect(mockCreateSession).toHaveBeenCalledTimes(1);
    const [root, message, opts] = mockCreateSession.mock.calls[0]!;
    expect(root).toBe(ROOT);
    expect(message).toBe("hello");
    expect(opts).toEqual({});
  });

  test("POST forwards systemPrompt when provided", async () => {
    await handleAiRoute(
      makeReq("/studio/ai/session", "POST", {
        message: "hi",
        systemPrompt: "be terse",
      }),
      "/studio/ai/session",
      ROOT,
    );
    const call = mockCreateSession.mock.calls[0]!;
    expect(call[2]).toEqual({ systemPrompt: "be terse" });
  });

  test("POST with invalid JSON body returns 500 with error message", async () => {
    const res = await handleAiRoute(
      makeReq("/studio/ai/session", "POST", "{not json"),
      "/studio/ai/session",
      ROOT,
    );
    expect(res!.status).toBe(500);
    const body = (await res!.json()) as { error: string };
    expect(typeof body.error).toBe("string");
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  test("POST returns 500 when createSession throws non-Error", async () => {
    mockCreateSession.mockImplementationOnce(() => {
      // Exercising the non-Error rejection branch is the point of this test
      // oxlint-disable-next-line eslint/no-throw-literal
      throw "raw failure";
    });
    const res = await handleAiRoute(
      makeReq("/studio/ai/session", "POST", { message: "boom" }),
      "/studio/ai/session",
      ROOT,
    );
    expect(res!.status).toBe(500);
    expect(await res!.json()).toEqual({ error: "raw failure" });
  });
});

describe("handleAiRoute — stream", () => {
  test("GET .../stream delegates to streamSession with id", async () => {
    const res = await handleAiRoute(
      makeReq("/studio/ai/session/abc123/stream", "GET"),
      "/studio/ai/session/abc123/stream",
      ROOT,
    );
    expect(res).not.toBeNull();
    expect(await res!.text()).toBe("stream");
    expect(mockStreamSession).toHaveBeenCalledWith("abc123");
  });
});

describe("handleAiRoute — send message", () => {
  test("POST .../message forwards to sendMessage", async () => {
    const res = await handleAiRoute(
      makeReq("/studio/ai/session/abc123/message", "POST", { message: "next step" }),
      "/studio/ai/session/abc123/message",
      ROOT,
    );
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual({ ok: true });
    expect(mockSendMessage).toHaveBeenCalledWith("abc123", "next step");
  });

  test("POST .../message with invalid JSON returns 500", async () => {
    const res = await handleAiRoute(
      makeReq("/studio/ai/session/abc123/message", "POST", "%%%"),
      "/studio/ai/session/abc123/message",
      ROOT,
    );
    expect(res!.status).toBe(500);
    const body = (await res!.json()) as { error: string };
    expect(typeof body.error).toBe("string");
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  test("POST .../message returns 500 when sendMessage throws Error", async () => {
    mockSendMessage.mockImplementationOnce(() => {
      throw new Error("session gone");
    });
    const res = await handleAiRoute(
      makeReq("/studio/ai/session/abc123/message", "POST", { message: "x" }),
      "/studio/ai/session/abc123/message",
      ROOT,
    );
    expect(res!.status).toBe(500);
    expect(await res!.json()).toEqual({ error: "session gone" });
  });
});

describe("handleAiRoute — stop", () => {
  test("POST .../stop calls stopSession", async () => {
    const res = await handleAiRoute(
      makeReq("/studio/ai/session/abc123/stop", "POST"),
      "/studio/ai/session/abc123/stop",
      ROOT,
    );
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual({ ok: true });
    expect(mockStopSession).toHaveBeenCalledWith("abc123");
  });
});

describe("handleAiRoute — delete", () => {
  test("DELETE .../session/:id calls deleteSession", async () => {
    const res = await handleAiRoute(
      makeReq("/studio/ai/session/abc123", "DELETE"),
      "/studio/ai/session/abc123",
      ROOT,
    );
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual({ ok: true });
    expect(mockDeleteSession).toHaveBeenCalledWith("abc123");
  });
});

describe("handleAiRoute — get session info", () => {
  test("GET .../session/:id returns session info", async () => {
    const res = await handleAiRoute(
      makeReq("/studio/ai/session/abc123", "GET"),
      "/studio/ai/session/abc123",
      ROOT,
    );
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual({ id: "sess-1", status: "active" });
    expect(mockGetSession).toHaveBeenCalledWith("abc123");
  });

  test("GET .../session/:id returns 404 when not found", async () => {
    mockGetSession.mockImplementationOnce(() => null);
    const res = await handleAiRoute(
      makeReq("/studio/ai/session/missing", "GET"),
      "/studio/ai/session/missing",
      ROOT,
    );
    expect(res!.status).toBe(404);
    expect(await res!.json()).toEqual({ error: "Not found" });
  });
});
