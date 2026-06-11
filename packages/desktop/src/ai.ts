/**
 * AI route handler — shared between desktop platforms (ElectroBun + Chromium). Delegates to Jx
 * Suite server claude-session module for all AI session management.
 */

import {
  createSession,
  deleteSession,
  getAuthStatus,
  getSession,
  sendMessage,
  stopSession,
  streamSession,
} from "@jxsuite/server/claude-session";

/**
 * Handle an AI-related HTTP request. Returns a Response if the path matches an AI route, or null if
 * not an AI route.
 */
export async function handleAiRoute(
  req: Request,
  path: string,
  projectRoot: string,
): Promise<Response | null> {
  if (!path.startsWith("/studio/ai/")) {
    return null;
  }

  if (path === "/studio/ai/auth-status" && req.method === "GET") {
    const status = await getAuthStatus();
    return Response.json(status);
  }

  if (path === "/studio/ai/session" && req.method === "POST") {
    try {
      const body = (await req.json()) as {
        message: string;
        systemPrompt?: string;
      };
      const result = createSession(projectRoot, body.message, {
        ...(body.systemPrompt != null && { systemPrompt: body.systemPrompt }),
      });
      return Response.json(result);
    } catch (error: unknown) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    }
  }

  if (path.startsWith("/studio/ai/session/") && path.endsWith("/stream") && req.method === "GET") {
    const id = path.split("/")[4];
    return streamSession(id);
  }

  if (
    path.startsWith("/studio/ai/session/") &&
    path.endsWith("/message") &&
    req.method === "POST"
  ) {
    try {
      const id = path.split("/")[4];
      const body = (await req.json()) as { message: string };
      sendMessage(id, body.message);
      return Response.json({ ok: true });
    } catch (error: unknown) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    }
  }

  if (path.startsWith("/studio/ai/session/") && path.endsWith("/stop") && req.method === "POST") {
    const id = path.split("/")[4];
    stopSession(id);
    return Response.json({ ok: true });
  }

  if (path.startsWith("/studio/ai/session/") && req.method === "DELETE") {
    const id = path.split("/")[4];
    deleteSession(id);
    return Response.json({ ok: true });
  }

  if (path.startsWith("/studio/ai/session/") && req.method === "GET") {
    const id = path.split("/")[4];
    const info = getSession(id);
    if (!info) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    return Response.json(info);
  }

  return null;
}
