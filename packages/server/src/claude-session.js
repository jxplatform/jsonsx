/**
 * Claude-session.js — Claude Agent SDK session manager
 *
 * Manages Claude Code sessions via @anthropic-ai/claude-agent-sdk, providing: - Session creation
 * with streaming output - Follow-up messages via session resume - SSE broadcasting to connected
 * frontend clients - Session interruption and cleanup
 */

import { query } from "@anthropic-ai/claude-agent-sdk";

/** @typedef {import("@anthropic-ai/claude-agent-sdk").SDKMessage} SDKMessage */
/** @typedef {import("@anthropic-ai/claude-agent-sdk").Options} AgentOptions */

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

/**
 * @typedef {{
 *   id: string;
 *   sessionId: string | null;
 *   projectRoot: string;
 *   messages: SDKMessage[];
 *   sseClients: Set<(event: string, data: unknown) => void>;
 *   status: "active" | "idle" | "stopped";
 *   abortController: AbortController | null;
 *   query: AsyncGenerator | null;
 * }} Session
 */

/** @type {Map<string, Session>} */
const sessions = new Map();

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
function broadcast(session, event, data) {
  session.messages.push(/** @type {any} */ (data));
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
async function processStream(session, stream) {
  session.status = "active";
  try {
    for await (const message of stream) {
      if (/** @type {string} */ (session.status) === "stopped") break;
      if (message.session_id && !session.sessionId) {
        session.sessionId = message.session_id;
      }
      broadcast(session, message.type, message);
    }
  } catch (err) {
    if (/** @type {any} */ (err).name !== "AbortError") {
      broadcast(session, "error", { type: "error", error: String(err) });
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
export function createSession(projectRoot, message, opts = {}) {
  const id = genId();
  const abortController = new AbortController();

  /** @type {Session} */
  const session = {
    id,
    sessionId: null,
    projectRoot,
    messages: [],
    sseClients: new Set(),
    status: "active",
    abortController,
    query: null,
  };

  sessions.set(id, session);

  /** @type {AgentOptions} */
  const queryOpts = {
    cwd: projectRoot,
    abortController,
    permissionMode: "acceptEdits",
    allowedTools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep"],
    maxTurns: 30,
    includePartialMessages: true,
    persistSession: true,
    env: buildSdkEnv(),
  };

  if (opts.systemPrompt) {
    queryOpts.systemPrompt = opts.systemPrompt;
  }

  const stream = query({ prompt: message, options: queryOpts });
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
export function sendMessage(id, message) {
  const session = sessions.get(id);
  if (!session) throw new Error(`Session not found: ${id}`);
  if (session.status === "active") throw new Error("Session is still processing");

  const abortController = new AbortController();
  session.abortController = abortController;

  /** @type {AgentOptions} */
  const queryOpts = {
    cwd: session.projectRoot,
    abortController,
    permissionMode: "acceptEdits",
    allowedTools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep"],
    maxTurns: 30,
    includePartialMessages: true,
    continue: true,
    env: buildSdkEnv(),
  };

  if (session.sessionId) {
    queryOpts.resume = session.sessionId;
    delete queryOpts.continue;
  }

  const stream = query({ prompt: message, options: queryOpts });
  session.query = stream;
  processStream(session, stream);
}

/**
 * Stop a running session (interrupt the current query).
 *
 * @param {string} id
 */
export function stopSession(id) {
  const session = sessions.get(id);
  if (!session) return;
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
export function deleteSession(id) {
  stopSession(id);
  sessions.delete(id);
}

/**
 * Get an SSE Response stream for a session.
 *
 * @param {string} id
 * @returns {Response}
 */
export function streamSession(id) {
  const session = sessions.get(id);
  if (!session) {
    return new Response("Session not found", { status: 404 });
  }

  const encoder = new TextEncoder();
  /** @type {(event: string, data: unknown) => void} */
  let sendRef = () => {};
  const stream = new ReadableStream({
    start(controller) {
      /** @param {string} event @param {unknown} data */
      sendRef = (event, data) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          // Stream closed
        }
      };

      session.sseClients.add(sendRef);

      for (const msg of session.messages) {
        sendRef(/** @type {any} */ (msg).type || "message", msg);
      }

      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        } catch {
          clearInterval(heartbeat);
          session.sseClients.delete(sendRef);
        }
      }, 15000);
    },
    cancel() {
      session.sseClients.delete(sendRef);
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

/**
 * Check if the claude agent SDK can authenticate.
 *
 * @returns {Promise<{ authenticated: boolean; error?: string }>}
 */
export async function getAuthStatus() {
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 15000);
    const testStream = query({
      prompt: "Say OK",
      options: {
        abortController: ctrl,
        maxTurns: 1,
        persistSession: false,
        includePartialMessages: true,
        env: buildSdkEnv(),
      },
    });

    for await (const msg of testStream) {
      if (msg.type === "assistant") {
        const content = /** @type {any} */ (msg).message?.content;
        if (Array.isArray(content)) {
          const text = content.find((b) => b.type === "text");
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
        const result = /** @type {any} */ (msg);
        clearTimeout(timeout);
        ctrl.abort();
        if (result.is_error) {
          return { authenticated: false, error: result.result || "API error" };
        }
        return { authenticated: true };
      }
    }

    clearTimeout(timeout);
    return { authenticated: true };
  } catch (err) {
    return { authenticated: false, error: String(err) };
  }
}

/**
 * Get session info.
 *
 * @param {string} id
 */
export function getSession(id) {
  const session = sessions.get(id);
  if (!session) return null;
  return { id: session.id, status: session.status, messageCount: session.messages.length };
}
