/**
 * Claude-session.js — Claude Agent SDK session manager
 *
 * Manages Claude Code sessions via @anthropic-ai/claude-agent-sdk, providing: - Session creation
 * with streaming output - Follow-up messages via session resume - SSE broadcasting to connected
 * frontend clients - Session interruption and cleanup
 */

import { query } from "@anthropic-ai/claude-agent-sdk";

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Options as AgentOptions } from "@anthropic-ai/claude-agent-sdk";

interface Session {
  id: string;
  sessionId: string | null;
  projectRoot: string;
  messages: SDKMessage[];
  sseClients: Set<(event: string, data: unknown) => void>;
  status: "active" | "idle" | "stopped";
  abortController: AbortController | null;
  query: AsyncGenerator | null;
}

/**
 * Build a clean env for SDK child processes. Strips session-specific vars from a parent Claude Code
 * instance that would override the SDK's own credential resolution (OAuth from ~/.claude/).
 */
function buildSdkEnv() {
  const env = { ...process.env };
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_BASE_URL;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.CLAUDE_CODE_EXECPATH;
  delete env.CLAUDE_AGENT_SDK_VERSION;
  delete env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
  delete env.CLAUDECODE;
  env.CLAUDE_AGENT_SDK_CLIENT_APP = "jx-studio/0.17.0";
  return env;
}

const sessions = new Map<string, Session>();

let idCounter = 0;

function genId() {
  return `ai_${Date.now().toString(36)}_${(++idCounter).toString(36)}`;
}

/**
 * Broadcast an SSE event to all connected clients for a session.
 *
 * @param {Session} session
 * @param {string} event
 * @param {unknown} data
 */
function broadcast(session: Session, event: string, data: unknown) {
  session.messages.push(data as SDKMessage);
  for (const send of session.sseClients) {
    send(event, data);
  }
}

/**
 * Process the async message stream from a query.
 *
 * @param {Session} session
 * @param {AsyncGenerator<SDKMessage>} stream
 */
async function processStream(session: Session, stream: AsyncGenerator<SDKMessage>) {
  session.status = "active";
  try {
    for await (const message of stream) {
      if ((session.status as string) === "stopped") {
        break;
      }
      if (message.session_id && !session.sessionId) {
        session.sessionId = message.session_id;
      }
      broadcast(session, message.type, message);
    }
  } catch (error) {
    if (error instanceof Error && error.name !== "AbortError") {
      broadcast(session, "error", { error: String(error), type: "error" });
    }
  } finally {
    session.status = "idle";
    session.query = null;
    session.abortController = null;
    broadcast(session, "done", { type: "done" });
  }
}

/**
 * Create a new AI session and begin streaming.
 *
 * @param {string} projectRoot
 * @param {string} message
 * @param {{ systemPrompt?: string }} [opts]
 * @returns {{ id: string }}
 */
export function createSession(
  projectRoot: string,
  message: string,
  opts: { systemPrompt?: string } = {},
) {
  const id = genId();
  const abortController = new AbortController();

  const session: Session = {
    abortController,
    id,
    messages: [],
    projectRoot,
    query: null,
    sessionId: null,
    sseClients: new Set(),
    status: "active",
  };

  sessions.set(id, session);

  const queryOpts: AgentOptions = {
    abortController,
    allowedTools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep"],
    cwd: projectRoot,
    env: buildSdkEnv(),
    includePartialMessages: true,
    maxTurns: 30,
    permissionMode: "acceptEdits",
    persistSession: true,
  };

  if (opts.systemPrompt) {
    queryOpts.systemPrompt = opts.systemPrompt;
  }

  const stream = query({ options: queryOpts, prompt: message });
  session.query = stream;
  processStream(session, stream);

  return { id };
}

/**
 * Send a follow-up message to an existing session.
 *
 * @param {string} id
 * @param {string} message
 */
export function sendMessage(id: string, message: string) {
  const session = sessions.get(id);
  if (!session) {
    throw new Error(`Session not found: ${id}`);
  }
  if (session.status === "active") {
    throw new Error("Session is still processing");
  }

  const abortController = new AbortController();
  session.abortController = abortController;

  const queryOpts: AgentOptions = {
    abortController,
    allowedTools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep"],
    continue: true,
    cwd: session.projectRoot,
    env: buildSdkEnv(),
    includePartialMessages: true,
    maxTurns: 30,
    permissionMode: "acceptEdits",
  };

  if (session.sessionId) {
    queryOpts.resume = session.sessionId;
    delete queryOpts.continue;
  }

  const stream = query({ options: queryOpts, prompt: message });
  session.query = stream;
  processStream(session, stream);
}

/**
 * Stop a running session (interrupt the current query).
 *
 * @param {string} id
 */
export function stopSession(id: string) {
  const session = sessions.get(id);
  if (!session) {
    return;
  }
  session.status = "stopped";
  if (session.abortController) {
    session.abortController.abort();
  }
}

/**
 * Remove a session entirely.
 *
 * @param {string} id
 */
export function deleteSession(id: string) {
  stopSession(id);
  sessions.delete(id);
}

/**
 * Get an SSE Response stream for a session.
 *
 * @param {string} id
 * @returns {Response}
 */
export function streamSession(id: string) {
  const session = sessions.get(id);
  if (!session) {
    return new Response("Session not found", { status: 404 });
  }

  const encoder = new TextEncoder();
  let sendRef: (event: string, data: unknown) => void = () => {};
  const stream = new ReadableStream({
    cancel() {
      session.sseClients.delete(sendRef);
    },
    start(controller) {
      /** @param {string} event @param {unknown} data */
      sendRef = (event: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          // Stream closed
        }
      };

      session.sseClients.add(sendRef);

      for (const msg of session.messages) {
        sendRef(((msg as Record<string, unknown>).type as string) || "message", msg);
      }

      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        } catch {
          clearInterval(heartbeat);
          session.sseClients.delete(sendRef);
        }
      }, 15_000);
    },
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream",
    },
  });
}

/**
 * Check if the claude agent SDK can authenticate.
 *
 * @returns {Promise<{ authenticated: boolean; error?: string }>}
 */
export async function getAuthStatus() {
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 15_000);
    const testStream = query({
      options: {
        abortController: ctrl,
        env: buildSdkEnv(),
        includePartialMessages: true,
        maxTurns: 1,
        persistSession: false,
      },
      prompt: "Say OK",
    });

    for await (const msg of testStream) {
      if (msg.type === "assistant") {
        const content = (msg as Record<string, unknown>).message as
          | { content?: unknown[] }
          | undefined;
        if (Array.isArray(content?.content)) {
          const text = content.content.find(
            (b: unknown) => (b as { type?: string }).type === "text",
          ) as { text?: string } | undefined;
          if (text?.text?.toLowerCase().includes("error")) {
            clearTimeout(timeout);
            ctrl.abort();
            return { authenticated: false, error: text.text };
          }
        }
        clearTimeout(timeout);
        ctrl.abort();
        return { authenticated: true };
      }
      if (msg.type === "result") {
        const result = msg as Record<string, unknown>;
        clearTimeout(timeout);
        ctrl.abort();
        if (result.is_error) {
          return {
            authenticated: false,
            error: (result.result as string) || "API error",
          };
        }
        return { authenticated: true };
      }
    }

    clearTimeout(timeout);
    return { authenticated: true };
  } catch (error) {
    return { authenticated: false, error: String(error) };
  }
}

/**
 * Get session info.
 *
 * @param {string} id
 */
export function getSession(id: string) {
  const session = sessions.get(id);
  if (!session) {
    return null;
  }
  return {
    id: session.id,
    messageCount: session.messages.length,
    status: session.status,
  };
}
