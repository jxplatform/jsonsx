/**
 * Tests for src/services/tool-executor.ts — the one stream error that makes the app's OWN reading
 * of the backend wrong, and what the loop does about it.
 *
 * Separate from `ai-loop.test.ts` because this is the only case in the loop whose evidence is
 * outside the chat state: the assertion is that the capability probe was re-run, not that a message
 * was written. The real `ai-models` is used rather than a double — the defect being pinned here is
 * that the probe SETTLES ONCE, and a double of it would have no such property to break.
 */
import { clearSeededSettings, flush, installMockPlatform } from "./harness";
import { beforeEach, describe, expect, test } from "bun:test";
import { createChatState, createToolRegistry } from "@jxsuite/ai";
import type { ToolRegistry } from "@jxsuite/ai/tools";
import type { StreamEvent, StreamingClient } from "@jxsuite/ai/streaming-client";
import { runAgentLoop } from "../src/services/tool-executor";
import {
  ensureProxyProbe,
  isProxyConfigured,
  proxyStateCode,
  resetModelCache,
} from "../src/services/ai-models";

installMockPlatform();

let fetchImpl: () => Promise<Response> = async () => Response.json({ models: [] }, { status: 200 });
const fetchCalls: string[] = [];
(globalThis as Record<string, unknown>).fetch = (url: string) => {
  fetchCalls.push(url);
  return fetchImpl();
};

/** A client whose single round is one error frame. */
function erroringClient(event: StreamEvent): StreamingClient {
  return {
    async *streamChat() {
      yield event;
    },
  };
}

/** Run one turn against `event` and hand back the state it left behind. */
async function runWith(event: StreamEvent) {
  const chatState = createChatState({ model: "@cf/meta/llama-4" });
  chatState.sendMessage("make the heading bigger");
  await runAgentLoop({
    chatState,
    streamingClient: erroringClient(event),
    systemPrompt: "",
    toolRegistry: createToolRegistry() as ToolRegistry,
  });
  await flush();
  return chatState;
}

beforeEach(async () => {
  localStorage.clear();
  clearSeededSettings();
  resetModelCache();
  fetchCalls.length = 0;
  // A managed backend that reported itself working, the way boot found it.
  fetchImpl = async () =>
    Response.json({ models: [], configured: true, managed: true }, { status: 200 });
  ensureProxyProbe();
  await flush();
});

describe("tool-executor — a lapsed hosted grant", () => {
  test("a cf_reconnect_required stream error re-probes, so the gates flip to Reconnect", async () => {
    /* The probe is one-shot, and the settings subscription that re-arms it never fires for a grant
       held by the broker rather than by this browser. Without this, every gate keeps offering an
       assistant that cannot answer, and the send that just failed is the only evidence anyone has. */
    expect(isProxyConfigured()).toBe(true);
    expect(fetchCalls).toHaveLength(1);

    fetchImpl = async () =>
      Response.json(
        { models: [], configured: false, managed: true, code: "cf_reconnect_required" },
        { status: 200 },
      );
    const chatState = await runWith({
      type: "error",
      message: "Reconnect Cloudflare to keep using the assistant.",
      code: "cf_reconnect_required",
    });

    expect(fetchCalls).toHaveLength(2);
    expect(isProxyConfigured()).toBe(false);
    expect(proxyStateCode()).toBe("cf_reconnect_required");
    // The existing behaviour is untouched: the turn still reports the failure it was given.
    expect(chatState.status).toBe("error");
    expect(chatState.error).toBe("Reconnect Cloudflare to keep using the assistant.");
  });

  test("an ordinary failure leaves the reading alone", async () => {
    // A 500 says nothing about whether the grant is still good, so re-probing would be noise.
    const chatState = await runWith({ type: "error", message: "upstream 500", code: "500" });

    expect(fetchCalls).toHaveLength(1);
    expect(isProxyConfigured()).toBe(true);
    expect(chatState.error).toBe("upstream 500");
  });

  test("an error frame carrying no code at all leaves the reading alone", async () => {
    const chatState = await runWith({ type: "error", message: "Network error: offline" });

    expect(fetchCalls).toHaveLength(1);
    expect(isProxyConfigured()).toBe(true);
    expect(chatState.error).toBe("Network error: offline");
  });
});
