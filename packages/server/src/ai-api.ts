/**
 * Ai-api.js — AI proxy endpoints for Jx Studio
 *
 * Handles /__studio/ai/chat (SSE streaming proxy to OpenAI) and /__studio/ai/models.
 * The server acts as a thin proxy: validates the request shape, forwards to OpenAI,
 * normalizes the SSE stream into StreamEvent-compatible format, and pipes back.
 *
 * API key flow:
 *   1. Request header X-Api-Key or Authorization: Bearer <key>
 *   2. Fallback: OPENAI_API_KEY env var — attached ONLY to the env/default base URL, never to a
 *      caller-supplied X-Api-Base-URL (prevents exfiltrating the server key to a chosen endpoint)
 *   3. If neither → 401 with error message
 *
 * Base URL flow:
 *   1. Request header X-Api-Base-URL — allowed only alongside a header API key
 *   2. Fallback: OPENAI_BASE_URL env var
 *   3. Default: https://api.openai.com/v1
 *   A base URL resolving to a cloud metadata / link-local host is refused (SSRF defense).
 *
 * @license MIT
 */
import { problem, problemTypeForStatus } from "./problem.ts";
import { problemDetails } from "@jxsuite/protocol";

// ─── Configuration ───────────────────────────────────────────────────────────

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

/** A tool-call fragment inside an OpenAI streaming `delta`. */
interface ToolCallDelta {
  index: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

/** A single OpenAI chat-completions streaming chunk (the JSON after `data: `). */
interface OpenAIStreamChunk {
  choices?: {
    index?: number;
    delta?: { content?: string; tool_calls?: ToolCallDelta[] };
    finish_reason?: string | null;
  }[];
}

/** A model entry from the upstream `/models` listing. */
interface ModelEntry {
  id: string;
  context_window?: number;
  owned_by?: string;
}

/**
 * SSRF defense: refuse to proxy to a cloud metadata endpoint or a link-local host. Loopback and
 * private-LAN hosts are intentionally allowed — self-hosted / local LLMs run there. An unparseable
 * base URL is blocked. `169.254.169.254` (the AWS/GCP/Azure metadata IP) lives in the link-local
 * `169.254.0.0/16` range, which is the primary thing this stops.
 */
function isBlockedHost(rawUrl: string): boolean {
  let host: string;
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return true;
  }
  const h = host.startsWith("[") ? host.slice(1, -1) : host;
  if (h === "metadata.google.internal") {
    return true;
  }
  if (h.startsWith("169.254.")) {
    return true; // IPv4 link-local, incl. the cloud metadata IP
  }
  if (h.startsWith("fe80:")) {
    return true; // IPv6 link-local
  }
  return false;
}

interface AiConfig {
  apiKey: string | null;
  baseUrl: string;
  missingKey: boolean;
  reject?: { status: number; message: string };
}

function getConfig(req: Request): AiConfig {
  const authHeader = req.headers.get("Authorization") || "";
  const apiKeyHeader = req.headers.get("X-Api-Key") || "";
  const baseUrlHeader = req.headers.get("X-Api-Base-URL") || "";

  // Track the PROVENANCE of the key: a header-supplied key may ride a caller's custom base URL; the
  // Server's env key never leaves for a caller-chosen endpoint (key-exfiltration defense).
  let apiKey: string | null = null;
  let keyFromHeader = false;
  if (authHeader.startsWith("Bearer ")) {
    apiKey = authHeader.slice(7).trim();
    keyFromHeader = true;
  }
  if (apiKeyHeader) {
    apiKey = apiKeyHeader.trim(); // X-Api-Key overrides Bearer
    keyFromHeader = true;
  }

  const baseFromHeader = Boolean(baseUrlHeader);
  const baseUrl = baseUrlHeader || process.env.OPENAI_BASE_URL || DEFAULT_BASE_URL;

  if (isBlockedHost(baseUrl)) {
    return {
      apiKey: null,
      baseUrl,
      missingKey: true,
      reject: { status: 403, message: "Base URL host is not permitted." },
    };
  }

  // A caller-supplied base URL requires a caller-supplied key. Refuse to forward the env
  // OPENAI_API_KEY to an endpoint the request chose.
  if (baseFromHeader && !keyFromHeader) {
    return {
      apiKey: null,
      baseUrl,
      missingKey: true,
      reject: {
        status: 401,
        message: "A custom base URL requires an explicit API key (X-Api-Key).",
      },
    };
  }

  // Env key is only ever attached to the env/default base URL.
  if (!apiKey && process.env.OPENAI_API_KEY) {
    apiKey = process.env.OPENAI_API_KEY;
  }

  return { apiKey, baseUrl, missingKey: !apiKey };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Write an SSE event to the response stream. */
function writeSSE(controller: ReadableStreamDefaultController, event: unknown): void {
  const data = JSON.stringify(event);
  controller.enqueue(new TextEncoder().encode(`data: ${data}\n\n`));
}

/**
 * Write a failure response for the non-streaming endpoints.
 *
 * The status is chosen by the caller here rather than by the type, because this file's callers
 * forward an upstream provider's status — which is information, and collapsing it to the type's own
 * would throw it away.
 */
function jsonError(status: number, message: string): Response {
  return problem(problemTypeForStatus(status), message);
}

// ─── /__studio/ai/chat — SSE streaming proxy ───────────────────────────────

/** Handle POST /__studio/ai/chat — proxy chat completions to OpenAI via SSE. */
export async function handleChat(req: Request): Promise<Response> {
  const { apiKey, baseUrl, missingKey, reject } = getConfig(req);
  if (reject) {
    return jsonError(reject.status, reject.message);
  }
  if (missingKey) {
    return jsonError(
      401,
      "No API key configured. Set OPENAI_API_KEY env var or send X-Api-Key header.",
    );
  }

  // Parse request body
  let body: {
    messages?: unknown[];
    tools?: unknown[];
    systemPrompt?: string;
    model?: string;
  };
  try {
    body = (await req.json()) as {
      messages?: unknown[];
      tools?: unknown[];
      systemPrompt?: string;
      model?: string;
    };
  } catch {
    return jsonError(400, "Invalid JSON body");
  }

  const { messages = [], tools = [], systemPrompt = "", model = "gpt-4o" } = body;

  if (!Array.isArray(messages)) {
    return jsonError(400, "messages must be an array");
  }

  // Build OpenAI request
  const openaiBody: {
    model: string;
    messages: unknown[];
    stream: boolean;
    stream_options: { include_usage: boolean };
    tools?: unknown[];
    tool_choice?: string;
    parallel_tool_calls?: boolean;
  } = {
    model,
    messages: [{ role: "system", content: systemPrompt }, ...messages],
    stream: true,
    stream_options: { include_usage: true },
  };

  if (tools && tools.length > 0) {
    openaiBody.tools = tools;
    openaiBody.tool_choice = "auto";
    openaiBody.parallel_tool_calls = true;
  }

  const upstreamUrl = `${baseUrl}/chat/completions`;

  // Create the SSE stream
  const stream = new ReadableStream({
    async start(controller) {
      let response;
      try {
        response = await fetch(upstreamUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(openaiBody),
          signal: req.signal,
        });
      } catch (error) {
        if ((error as Error).name === "AbortError") {
          writeSSE(controller, { type: "done", stopReason: "cancelled" });
        } else {
          const message = `Network error: ${(error as Error).message}`;
          writeSSE(controller, {
            message,
            /*
             * The frame carries a problem rather than being one: the response began with a 200
             * long before this failed, so nothing can change the status now. `message` stays for
             * the readers that already show it (server.md §4.3).
             */
            problem: problemDetails("upstreamFailure", message),
            type: "error",
          });
        }
        controller.close();
        return;
      }

      if (!response.ok) {
        let errorBody = "";
        try {
          errorBody = await response.text();
        } catch {
          /* Ignore */
        }
        // Parse the upstream JSON error body (OpenAI returns { error: { message: "..." } },
        // While some compatible providers return { error: "..." }). Extract a clean message
        // Instead of embedding the raw JSON in the error text.
        let cleanMessage = errorBody || response.statusText;
        try {
          const parsed = JSON.parse(errorBody) as { error?: string | { message?: string } };
          if (typeof parsed.error === "string") {
            cleanMessage = parsed.error;
          } else if (parsed.error?.message) {
            cleanMessage = parsed.error.message;
          }
        } catch {
          /* Not JSON — use the raw body. */
        }
        writeSSE(controller, {
          code: String(response.status),
          message: cleanMessage,
          // The upstream's own status is preserved in `code`; the problem names the KIND.
          problem: problemDetails(problemTypeForStatus(response.status), cleanMessage),
          type: "error",
        });
        controller.close();
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        writeSSE(controller, {
          message: "No response body from upstream",
          problem: problemDetails("upstreamFailure", "No response body from upstream"),
          type: "error",
        });
        controller.close();
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";

      const pendingToolCalls = new Map<number, { id: string; name: string; args: string }>();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith("data: ")) {
              continue;
            }

            const dataStr = trimmed.slice(6);
            if (dataStr === "[DONE]") {
              // Emit pending tool call ends
              for (const [, tc] of pendingToolCalls) {
                writeSSE(controller, { type: "tool_call_end", id: tc.id });
              }
              pendingToolCalls.clear();
              writeSSE(controller, { type: "done", stopReason: "stop" });
              controller.close();
              return;
            }

            let parsed: OpenAIStreamChunk;
            try {
              parsed = JSON.parse(dataStr) as OpenAIStreamChunk;
            } catch {
              continue;
            }

            const choice = parsed.choices?.[0];
            if (!choice) {
              continue;
            }

            const { delta } = choice;
            if (!delta) {
              continue;
            }

            // Text content
            if (delta.content) {
              writeSSE(controller, { type: "delta", content: delta.content });
            }

            // Tool calls
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                if (tc.id) {
                  // First appearance
                  const entry = {
                    id: tc.id,
                    name: tc.function?.name || "",
                    args: tc.function?.arguments || "",
                  };
                  pendingToolCalls.set(tc.index, entry);

                  writeSSE(controller, { type: "tool_call_start", id: tc.id, name: entry.name });

                  if (entry.args) {
                    writeSSE(controller, { type: "tool_call_delta", id: tc.id, args: entry.args });
                  }
                } else if (tc.function?.arguments) {
                  // Subsequent fragment
                  const existing = pendingToolCalls.get(tc.index);
                  if (existing) {
                    existing.args += tc.function.arguments;
                    writeSSE(controller, {
                      type: "tool_call_delta",
                      id: existing.id,
                      args: tc.function.arguments,
                    });
                  }
                }
              }
            }

            // Finish reason
            if (choice.finish_reason === "tool_calls") {
              for (const [, tc] of pendingToolCalls) {
                writeSSE(controller, { type: "tool_call_end", id: tc.id });
              }
              pendingToolCalls.clear();
              writeSSE(controller, { type: "done", stopReason: "tool_calls" });
              controller.close();
              return;
            }

            if (choice.finish_reason === "stop" || choice.finish_reason === "length") {
              for (const [, tc] of pendingToolCalls) {
                writeSSE(controller, { type: "tool_call_end", id: tc.id });
              }
              pendingToolCalls.clear();
              writeSSE(controller, {
                type: "done",
                stopReason: choice.finish_reason === "length" ? "length" : "stop",
              });
              controller.close();
              return;
            }
          }
        }

        // Stream ended without explicit finish_reason
        for (const [, tc] of pendingToolCalls) {
          writeSSE(controller, { type: "tool_call_end", id: tc.id });
        }
        pendingToolCalls.clear();
        writeSSE(controller, { type: "done", stopReason: "stop" });
        controller.close();
      } catch (error) {
        void reader.cancel();
        if ((error as Error).name === "AbortError") {
          writeSSE(controller, { type: "done", stopReason: "cancelled" });
          controller.close();
          return;
        }
        const message = `Stream error: ${(error as Error).message}`;
        writeSSE(controller, {
          message,
          problem: problemDetails("upstreamFailure", message),
          type: "error",
        });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

// ─── /__studio/ai/models — model listing ────────────────────────────────────

/**
 * Handle GET /__studio/ai/models — return available models.
 *
 * When the caller has configured an API key (header or env), the request is proxied to the upstream
 * provider's /models endpoint so any OpenAI-compatible endpoint (OpenRouter, local LLM, OpenCode
 * Zen, Azure, etc.) returns its actual model list. Falls back to a hardcoded default list when no
 * key is available.
 */
export async function handleModels(req: Request): Promise<Response> {
  const { apiKey, baseUrl, missingKey, reject } = getConfig(req);
  if (reject) {
    return jsonError(reject.status, reject.message);
  }

  // No key available → return hardcoded defaults so the UI can at least render.
  if (missingKey) {
    const defaults = [
      { id: "gpt-4o", name: "GPT-4o", contextWindow: 128_000 },
      { id: "gpt-4.1", name: "GPT-4.1", contextWindow: 1_000_000 },
      { id: "gpt-4.1-mini", name: "GPT-4.1 Mini", contextWindow: 1_000_000 },
      { id: "gpt-4o-mini", name: "GPT-4o Mini", contextWindow: 128_000 },
    ];
    return Response.json(
      { models: defaults, configured: false, managed: false },
      {
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  // Key is available — proxy to the upstream /models endpoint.
  try {
    const upstreamUrl = `${baseUrl}/models`;
    const upstreamResp = await fetch(upstreamUrl, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!upstreamResp.ok) {
      // Upstream failed — return defaults with configured flag so user can still try.
      const defaults = [{ id: "gpt-4o", name: "GPT-4o", contextWindow: 128_000 }];
      return Response.json(
        { models: defaults, configured: true, managed: false, upstreamError: upstreamResp.status },
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const data = (await upstreamResp.json()) as { data?: ModelEntry[] } | ModelEntry[];
    // OpenAI /models returns { object: "list", data: [{ id, ... }] }
    // Map to our simpler format.
    const rawModels: ModelEntry[] = Array.isArray(data)
      ? data
      : Array.isArray(data.data)
        ? data.data
        : [];
    const models = rawModels.map(({ id, context_window, owned_by }) => ({
      id,
      name: id,
      contextWindow: context_window || 0,
      ownedBy: owned_by,
    }));

    return Response.json(
      { models, configured: true, managed: false },
      {
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch {
    // Network error → return defaults.
    const defaults = [{ id: "gpt-4o", name: "GPT-4o", contextWindow: 128_000 }];
    return Response.json(
      { models: defaults, configured: true, managed: false, upstreamError: "network" },
      {
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}

// ─── Route handler ───────────────────────────────────────────────────────────

/**
 * Main handler for /__studio/ai/* requests.
 *
 * @returns Response if handled, null if route doesn't match
 */
export async function handleAiApi(req: Request, url: URL): Promise<Response | null> {
  const { pathname } = url;

  if (pathname === "/__studio/ai/chat" && req.method === "POST") {
    return handleChat(req);
  }

  if (pathname === "/__studio/ai/models" && req.method === "GET") {
    return handleModels(req);
  }

  return null;
}
