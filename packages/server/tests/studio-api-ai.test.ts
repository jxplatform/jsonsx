import { describe, expect, mock, test } from "bun:test";

// Mock the claude-session module BEFORE importing studio-api (it is owned by a
// Separate subsystem; these tests only exercise the HTTP routing in studio-api).
const calls: Record<string, unknown[]> = {};
const record = (name: string, args: unknown[]) => {
  calls[name] = args;
};

void mock.module("../src/claude-session.ts", () => ({
  createSession: (projectDir: string, message: string, opts: unknown) => {
    record("createSession", [projectDir, message, opts]);
    if (message === "explode") {
      throw new Error("session boom");
    }
    return { id: "sess-1" };
  },
  deleteSession: (id: string) => {
    record("deleteSession", [id]);
  },
  getAuthStatus: async () => ({ authenticated: true, method: "oauth" }),
  getSession: (id: string) => {
    record("getSession", [id]);
    return id === "sess-1" ? { id: "sess-1", status: "running" } : null;
  },
  sendMessage: (id: string, message: string) => {
    record("sendMessage", [id, message]);
    if (message === "explode") {
      throw new Error("message boom");
    }
  },
  stopSession: (id: string) => {
    record("stopSession", [id]);
  },
  streamSession: (id: string) => {
    record("streamSession", [id]);
    return new Response("stream-body", {
      headers: { "Content-Type": "text/event-stream" },
    });
  },
}));

const { handleStudioApi } = await import("../src/studio-api.ts");

const ROOT = "/tmp/jx-ai-root";

async function aiReq(path: string, method = "GET", body?: unknown) {
  const url = new URL(`http://localhost${path}`);
  const req = new Request(url, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const res = await handleStudioApi(req, url, ROOT, "/tmp/jx-ai-active");
  if (!res) {
    throw new Error("handleStudioApi returned null");
  }
  return res;
}

describe("AI assistant endpoints", () => {
  test("GET auth-status returns the auth state", async () => {
    const res = await aiReq("/__studio/ai/auth-status");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authenticated: true, method: "oauth" });
  });

  test("POST session creates a session in the active project dir", async () => {
    const res = await aiReq("/__studio/ai/session", "POST", {
      message: "hello",
      systemPrompt: "be nice",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "sess-1" });
    expect(calls.createSession).toEqual([
      "/tmp/jx-ai-active",
      "hello",
      { systemPrompt: "be nice" },
    ]);
  });

  test("POST session returns 500 when creation throws", async () => {
    const res = await aiReq("/__studio/ai/session", "POST", { message: "explode" });
    expect(res.status).toBe(500);
    const payload = await res.json();
    expect(payload.error).toBe("session boom");
  });

  test("GET session stream proxies to streamSession", async () => {
    const res = await aiReq("/__studio/ai/session/sess-1/stream");
    expect(await res.text()).toBe("stream-body");
    expect(calls.streamSession).toEqual(["sess-1"]);
  });

  test("POST session message forwards to sendMessage", async () => {
    const res = await aiReq("/__studio/ai/session/sess-1/message", "POST", { message: "more" });
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.ok).toBe(true);
    expect(calls.sendMessage).toEqual(["sess-1", "more"]);
  });

  test("POST session message returns 500 when sendMessage throws", async () => {
    const res = await aiReq("/__studio/ai/session/sess-1/message", "POST", {
      message: "explode",
    });
    expect(res.status).toBe(500);
    const payload = await res.json();
    expect(payload.error).toBe("message boom");
  });

  test("POST session stop calls stopSession", async () => {
    const res = await aiReq("/__studio/ai/session/sess-1/stop", "POST", {});
    const payload = await res.json();
    expect(payload.ok).toBe(true);
    expect(calls.stopSession).toEqual(["sess-1"]);
  });

  test("DELETE session calls deleteSession", async () => {
    const res = await aiReq("/__studio/ai/session/sess-1", "DELETE");
    const payload = await res.json();
    expect(payload.ok).toBe(true);
    expect(calls.deleteSession).toEqual(["sess-1"]);
  });

  test("GET session returns the session info", async () => {
    const res = await aiReq("/__studio/ai/session/sess-1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "sess-1", status: "running" });
  });

  test("GET session returns 404 for unknown ids", async () => {
    const res = await aiReq("/__studio/ai/session/nope");
    expect(res.status).toBe(404);
  });
});
