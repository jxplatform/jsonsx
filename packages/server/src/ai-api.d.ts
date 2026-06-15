/**
 * Type declarations for ai-api.js — the Stack B OpenAI-compatible AI proxy (`/__studio/ai/chat`,
 * `/__studio/ai/models`). Keep in sync with `ai-api.js`.
 */

export function handleChat(req: Request): Promise<Response>;
export function handleModels(req: Request): Promise<Response>;
export function handleAiApi(req: Request, url: URL): Promise<Response | null>;
