/// <reference lib="dom" />
/**
 * Ai-session-store.js — project-scoped multi-session chat history in localStorage.
 *
 * Pure storage CRUD for the assistant's conversations: a small index of session
 * metadata plus one payload key per session, so per-send writes touch a single
 * conversation. No reactivity and no chat-state knowledge — document-assistant
 * owns the live session; this module only loads/saves plain message arrays.
 *
 * Cross-window note: multiple studio windows share these keys; index writes are
 * last-write-wins, which is accepted for chat history.
 *
 * @license MIT
 */

const INDEX_KEY_PREFIX = "jx-ai-chat-sessions";
const PAYLOAD_KEY_PREFIX = "jx-ai-chat-session";
const LEGACY_KEY_PREFIX = "jx-ai-chat-history";

/** Most sessions kept per project — oldest by updatedAt evicted beyond this. */
export const MAX_SESSIONS = 20;
/** Most messages persisted per session (matches the pre-session store's cap). */
export const MAX_PERSIST_MESSAGES = 50;

const DEFAULT_TITLE = "New chat";
const MAX_TITLE_LENGTH = 60;

export interface SessionMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

interface SessionIndex {
  version: 1;
  activeId: string | null;
  /** Sorted by updatedAt descending. */
  sessions: SessionMeta[];
}

/** The persisted message shape — structurally the chat-state Message JSON. */
export interface PersistedMessage {
  id?: string;
  role: string;
  content: string;
  toolCalls?: unknown[];
  toolCallId?: string;
  timestamp?: number;
}

// ─── Keys ───────────────────────────────────────────────────────────────────

/** Project-scoped index key; falls back to a shared key when no project is open. */
function indexKey(root: string) {
  return root ? `${INDEX_KEY_PREFIX}:${root}` : INDEX_KEY_PREFIX;
}

function payloadKey(root: string, id: string) {
  return root ? `${PAYLOAD_KEY_PREFIX}:${root}:${id}` : `${PAYLOAD_KEY_PREFIX}:${id}`;
}

function legacyKey(root: string) {
  return root ? `${LEGACY_KEY_PREFIX}:${root}` : LEGACY_KEY_PREFIX;
}

// ─── Storage helpers (defensive: quota/unavailable/corrupt → absent) ────────

function readJson<T>(key: string): T | null {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or unavailable — chat history is not critical.
  }
}

function removeKey(key: string) {
  try {
    globalThis.localStorage?.removeItem(key);
  } catch {
    /* Ignore */
  }
}

// ─── Index ──────────────────────────────────────────────────────────────────

function emptyIndex(): SessionIndex {
  return { version: 1, activeId: null, sessions: [] };
}

/**
 * Read the session index for a project, migrating the pre-session single-conversation store
 * (`jx-ai-chat-history:<root>`) into the first session on first access.
 */
function readIndex(root: string): SessionIndex {
  const stored = readJson<SessionIndex>(indexKey(root));
  if (stored && Array.isArray(stored.sessions)) {
    return { ...emptyIndex(), ...stored };
  }
  return migrateLegacy(root) ?? emptyIndex();
}

function writeIndex(root: string, index: SessionIndex) {
  index.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  writeJson(indexKey(root), index);
}

/** Convert a legacy single-conversation store into a one-session index, if present. */
function migrateLegacy(root: string): SessionIndex | null {
  const msgs = readJson<PersistedMessage[]>(legacyKey(root));
  removeKey(legacyKey(root));
  if (!Array.isArray(msgs) || msgs.length === 0) {
    return null;
  }
  const timestamps = msgs.map((m) => m.timestamp).filter((t): t is number => typeof t === "number");
  const firstUser = msgs.find((m) => m.role === "user");
  const meta: SessionMeta = {
    id: newSessionId(),
    title: deriveTitle(firstUser?.content ?? ""),
    createdAt: timestamps.length > 0 ? Math.min(...timestamps) : Date.now(),
    updatedAt: timestamps.length > 0 ? Math.max(...timestamps) : Date.now(),
    messageCount: msgs.length,
  };
  writeJson(payloadKey(root, meta.id), msgs.slice(-MAX_PERSIST_MESSAGES));
  const index: SessionIndex = { version: 1, activeId: meta.id, sessions: [meta] };
  writeIndex(root, index);
  return index;
}

// ─── Public API ─────────────────────────────────────────────────────────────

function newSessionId() {
  return `s_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Derive a session title from its first user message: first non-empty line, whitespace-collapsed,
 * capped at {@link MAX_TITLE_LENGTH} characters.
 *
 * @param {string} text
 * @returns {string}
 */
export function deriveTitle(text: string): string {
  const line =
    text
      .split("\n")
      .map((l) => l.replaceAll(/\s+/g, " ").trim())
      .find((l) => l.length > 0) ?? "";
  if (!line) {
    return DEFAULT_TITLE;
  }
  return line.length > MAX_TITLE_LENGTH ? `${line.slice(0, MAX_TITLE_LENGTH - 1)}…` : line;
}

/** List a project's sessions, most recently updated first. */
export function listSessions(root: string): SessionMeta[] {
  return readIndex(root).sessions;
}

/** The session restored on startup, or null for a fresh unsaved chat. */
export function getActiveSessionId(root: string): string | null {
  return readIndex(root).activeId;
}

/** Point the index at the session to restore next startup (null = fresh chat). */
export function setActiveSession(root: string, id: string | null) {
  const index = readIndex(root);
  index.activeId = id;
  writeIndex(root, index);
}

/**
 * Create a new session (as the active one), evicting the oldest sessions beyond
 * {@link MAX_SESSIONS}. The title derives from the first user message when given.
 */
export function createSession(root: string, firstUserText?: string): SessionMeta {
  const index = readIndex(root);
  const now = Date.now();
  const meta: SessionMeta = {
    id: newSessionId(),
    title: deriveTitle(firstUserText ?? ""),
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
  };
  index.sessions.unshift(meta);
  while (index.sessions.length > MAX_SESSIONS) {
    let oldest = 0;
    for (let i = 1; i < index.sessions.length; i++) {
      if (index.sessions[i]!.updatedAt < index.sessions[oldest]!.updatedAt) {
        oldest = i;
      }
    }
    const [evicted] = index.sessions.splice(oldest, 1);
    removeKey(payloadKey(root, evicted!.id));
  }
  index.activeId = meta.id;
  writeIndex(root, index);
  return meta;
}

/** Load a session's messages, or null when it doesn't exist / is corrupt. */
export function loadSession(root: string, id: string): PersistedMessage[] | null {
  const msgs = readJson<PersistedMessage[]>(payloadKey(root, id));
  return Array.isArray(msgs) ? msgs : null;
}

/**
 * Persist a session's messages (trimmed to {@link MAX_PERSIST_MESSAGES}) and refresh its index
 * entry (updatedAt, messageCount, and the title while still the default).
 */
export function saveSession(root: string, id: string, messages: PersistedMessage[]) {
  const trimmed = messages.slice(-MAX_PERSIST_MESSAGES);
  writeJson(payloadKey(root, id), trimmed);
  const index = readIndex(root);
  const meta = index.sessions.find((s) => s.id === id);
  if (!meta) {
    return;
  }
  meta.updatedAt = Date.now();
  meta.messageCount = trimmed.length;
  if (meta.title === DEFAULT_TITLE) {
    const firstUser = trimmed.find((m) => m.role === "user");
    if (firstUser) {
      meta.title = deriveTitle(firstUser.content);
    }
  }
  writeIndex(root, index);
}

/** Delete a session's payload and index entry; clears activeId when it was active. */
export function deleteSession(root: string, id: string) {
  removeKey(payloadKey(root, id));
  const index = readIndex(root);
  index.sessions = index.sessions.filter((s) => s.id !== id);
  if (index.activeId === id) {
    index.activeId = null;
  }
  writeIndex(root, index);
}
