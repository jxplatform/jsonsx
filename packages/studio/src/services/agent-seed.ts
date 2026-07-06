/// <reference lib="dom" />
/**
 * Agent-seed.ts — cross-window handoff of a pending AI assistant prompt.
 *
 * The New Project flow stores the user's project brief here; the Studio window that opens the
 * project consumes it and seeds the Assistant tab. localStorage (not module state) is deliberate:
 * on desktop the new project opens in a NEW window, and the per-root localStorage key is the
 * cross-window channel (precedent: the chat-history key `jx-ai-chat-history:<root>`).
 *
 * @license MIT
 */

const PENDING_PROMPT_PREFIX = "jx.ai.pendingAgentPrompt";

/** Entries older than this are considered stale and dropped on read. */
const MAX_AGE_MS = 15 * 60 * 1000;

function storageKey(root: string) {
  return `${PENDING_PROMPT_PREFIX}:${root}`;
}

/**
 * Read the pending entry for a project root, dropping stale or malformed entries.
 *
 * @param {string} root
 * @returns {{ prompt: string; ts: number } | null}
 */
function readEntry(root: string): { prompt: string; ts: number } | null {
  try {
    const raw = globalThis.localStorage?.getItem(storageKey(root));
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as { prompt?: unknown; ts?: unknown };
    const valid =
      typeof parsed.prompt === "string" &&
      typeof parsed.ts === "number" &&
      Date.now() - parsed.ts <= MAX_AGE_MS;
    if (!valid) {
      // Stale or malformed — remove so it never seeds a later session.
      globalThis.localStorage?.removeItem(storageKey(root));
      return null;
    }
    return { prompt: parsed.prompt as string, ts: parsed.ts as number };
  } catch {
    return null;
  }
}

/**
 * Store a pending assistant prompt for the project at `root`.
 *
 * @param {string} root
 * @param {string} prompt
 */
export function setPendingAgentPrompt(root: string, prompt: string): void {
  try {
    globalThis.localStorage?.setItem(storageKey(root), JSON.stringify({ prompt, ts: Date.now() }));
  } catch {
    /* LocalStorage unavailable — the prompt is simply not handed off. */
  }
}

/**
 * Whether a fresh (younger than 15 min) pending prompt exists for `root`.
 *
 * @param {string} root
 */
export function hasPendingAgentPrompt(root: string): boolean {
  return readEntry(root) !== null;
}

/**
 * Read AND delete the pending prompt for `root` (consume-on-read keeps repeated renders
 * idempotent). Returns null when there is no fresh entry.
 *
 * @param {string} root
 * @returns {string | null}
 */
export function consumePendingAgentPrompt(root: string): string | null {
  const entry = readEntry(root);
  if (!entry) {
    return null;
  }
  try {
    globalThis.localStorage?.removeItem(storageKey(root));
  } catch {
    /* LocalStorage unavailable — nothing to delete. */
  }
  return entry.prompt;
}
