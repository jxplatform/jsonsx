/**
 * Tests for src/services/ai-session-store.ts — the project-scoped multi-session chat store:
 * index/payload round-trips, title derivation, ordering, caps/eviction, migration from the legacy
 * single-conversation key, and the defensive corrupt/quota paths.
 */
import "./harness";
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import {
  createSession,
  deleteSession,
  deriveTitle,
  getActiveSessionId,
  listSessions,
  loadSession,
  MAX_PERSIST_MESSAGES,
  MAX_SESSIONS,
  saveSession,
  setActiveSession,
} from "../src/services/ai-session-store";
import type { PersistedMessage } from "../src/services/ai-session-store";

const ROOT = "/proj/demo";
const INDEX_KEY = `jx-ai-chat-sessions:${ROOT}`;
const LEGACY_KEY = `jx-ai-chat-history:${ROOT}`;

function msg(role: string, content: string, timestamp?: number): PersistedMessage {
  return {
    id: `m_${role}_${content.length}`,
    role,
    content,
    ...(timestamp !== undefined && { timestamp }),
  };
}

beforeEach(() => {
  localStorage.clear();
  setSystemTime(new Date("2026-07-06T12:00:00Z"));
});

afterEach(() => {
  setSystemTime();
});

describe("deriveTitle", () => {
  test("uses the first non-empty line, whitespace-collapsed", () => {
    expect(deriveTitle("\n\n  Fix   the\theader \nsecond line")).toBe("Fix the header");
  });

  test("caps long titles with an ellipsis", () => {
    const title = deriveTitle("x".repeat(80));
    expect(title.length).toBe(60);
    expect(title.endsWith("…")).toBe(true);
  });

  test("falls back for empty/blank text", () => {
    expect(deriveTitle("")).toBe("New chat");
    expect(deriveTitle("  \n \n")).toBe("New chat");
  });
});

describe("session CRUD", () => {
  test("createSession adds an active session with derived title", () => {
    const meta = createSession(ROOT, "Build me a landing page");
    expect(meta.title).toBe("Build me a landing page");
    expect(getActiveSessionId(ROOT)).toBe(meta.id);
    expect(listSessions(ROOT)).toHaveLength(1);
    expect(listSessions(ROOT)[0]!.id).toBe(meta.id);
  });

  test("saveSession/loadSession round-trip and meta refresh", () => {
    const meta = createSession(ROOT);
    setSystemTime(new Date("2026-07-06T12:05:00Z"));
    const messages = [msg("user", "hello"), msg("assistant", "hi there")];
    saveSession(ROOT, meta.id, messages);

    expect(loadSession(ROOT, meta.id)).toEqual(messages);
    const [listed] = listSessions(ROOT);
    expect(listed!.messageCount).toBe(2);
    expect(listed!.updatedAt).toBeGreaterThan(meta.createdAt);
    // Default title upgraded from the first user message on save.
    expect(listed!.title).toBe("hello");
  });

  test("saveSession keeps a non-default title", () => {
    const meta = createSession(ROOT, "Original ask");
    saveSession(ROOT, meta.id, [msg("user", "something else entirely")]);
    expect(listSessions(ROOT)[0]!.title).toBe("Original ask");
  });

  test("saveSession trims to MAX_PERSIST_MESSAGES", () => {
    const meta = createSession(ROOT);
    const many = Array.from({ length: MAX_PERSIST_MESSAGES + 10 }, (_, i) => msg("user", `m${i}`));
    saveSession(ROOT, meta.id, many);
    const loaded = loadSession(ROOT, meta.id)!;
    expect(loaded).toHaveLength(MAX_PERSIST_MESSAGES);
    expect(loaded[0]!.content).toBe("m10");
  });

  test("saveSession with unknown id writes the payload but no index entry", () => {
    saveSession(ROOT, "ghost", [msg("user", "boo")]);
    expect(loadSession(ROOT, "ghost")).toHaveLength(1);
    expect(listSessions(ROOT)).toHaveLength(0);
  });

  test("loadSession returns null for missing or corrupt payloads", () => {
    expect(loadSession(ROOT, "nope")).toBeNull();
    localStorage.setItem(`jx-ai-chat-session:${ROOT}:bad`, "{not json");
    expect(loadSession(ROOT, "bad")).toBeNull();
    localStorage.setItem(`jx-ai-chat-session:${ROOT}:obj`, '{"a":1}');
    expect(loadSession(ROOT, "obj")).toBeNull();
  });

  test("listSessions orders by updatedAt descending", () => {
    const a = createSession(ROOT, "a");
    setSystemTime(new Date("2026-07-06T12:01:00Z"));
    const b = createSession(ROOT, "b");
    setSystemTime(new Date("2026-07-06T12:02:00Z"));
    saveSession(ROOT, a.id, [msg("user", "a again")]);
    expect(listSessions(ROOT).map((s) => s.id)).toEqual([a.id, b.id]);
  });

  test("deleteSession removes payload + entry and clears activeId when active", () => {
    const a = createSession(ROOT, "a");
    saveSession(ROOT, a.id, [msg("user", "hi")]);
    deleteSession(ROOT, a.id);
    expect(listSessions(ROOT)).toHaveLength(0);
    expect(loadSession(ROOT, a.id)).toBeNull();
    expect(getActiveSessionId(ROOT)).toBeNull();
  });

  test("deleteSession keeps activeId when deleting another session", () => {
    const a = createSession(ROOT, "a");
    setSystemTime(new Date("2026-07-06T12:01:00Z"));
    const b = createSession(ROOT, "b");
    deleteSession(ROOT, a.id);
    expect(getActiveSessionId(ROOT)).toBe(b.id);
  });

  test("setActiveSession round-trips including null", () => {
    const a = createSession(ROOT, "a");
    setActiveSession(ROOT, null);
    expect(getActiveSessionId(ROOT)).toBeNull();
    setActiveSession(ROOT, a.id);
    expect(getActiveSessionId(ROOT)).toBe(a.id);
  });

  test("evicts the oldest session beyond MAX_SESSIONS", () => {
    const first = createSession(ROOT, "first");
    saveSession(ROOT, first.id, [msg("user", "first")]);
    for (let i = 1; i < MAX_SESSIONS; i++) {
      setSystemTime(new Date(Date.parse("2026-07-06T12:00:00Z") + i * 60_000));
      createSession(ROOT, `chat ${i}`);
    }
    expect(listSessions(ROOT)).toHaveLength(MAX_SESSIONS);

    setSystemTime(new Date("2026-07-06T13:00:00Z"));
    createSession(ROOT, "one too many");
    const sessions = listSessions(ROOT);
    expect(sessions).toHaveLength(MAX_SESSIONS);
    expect(sessions.some((s) => s.id === first.id)).toBe(false);
    expect(loadSession(ROOT, first.id)).toBeNull();
  });
});

describe("legacy migration", () => {
  test("migrates the single-conversation key into the first session", () => {
    const legacy = [msg("user", "old question", 1000), msg("assistant", "old answer", 2000)];
    localStorage.setItem(LEGACY_KEY, JSON.stringify(legacy));

    const sessions = listSessions(ROOT);
    expect(sessions).toHaveLength(1);
    const [meta] = sessions;
    expect(meta!.title).toBe("old question");
    expect(meta!.createdAt).toBe(1000);
    expect(meta!.updatedAt).toBe(2000);
    expect(meta!.messageCount).toBe(2);
    expect(getActiveSessionId(ROOT)).toBe(meta!.id);
    expect(loadSession(ROOT, meta!.id)).toEqual(legacy);
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
  });

  test("ignores an empty or corrupt legacy store (and still removes it)", () => {
    localStorage.setItem(LEGACY_KEY, "[]");
    expect(listSessions(ROOT)).toHaveLength(0);
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();

    localStorage.setItem(LEGACY_KEY, "{corrupt");
    expect(listSessions(ROOT)).toHaveLength(0);
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
  });

  test("does not migrate once an index exists", () => {
    createSession(ROOT, "current");
    localStorage.setItem(LEGACY_KEY, JSON.stringify([msg("user", "stale", 1)]));
    expect(listSessions(ROOT)).toHaveLength(1);
    expect(listSessions(ROOT)[0]!.title).toBe("current");
    // Legacy key is left alone until an index-miss read; harmless either way.
  });

  test("legacy messages without timestamps fall back to now", () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify([msg("user", "untimed")]));
    const [meta] = listSessions(ROOT);
    expect(meta!.createdAt).toBe(Date.now());
    expect(meta!.updatedAt).toBe(Date.now());
  });
});

describe("defensive paths", () => {
  test("corrupt index JSON is treated as absent", () => {
    localStorage.setItem(INDEX_KEY, "{corrupt");
    expect(listSessions(ROOT)).toHaveLength(0);
    const meta = createSession(ROOT, "fresh start");
    expect(listSessions(ROOT)[0]!.id).toBe(meta.id);
  });

  test("index without a sessions array is treated as absent", () => {
    localStorage.setItem(INDEX_KEY, '{"version":1}');
    expect(listSessions(ROOT)).toHaveLength(0);
  });

  test("no-root fallback uses unscoped keys", () => {
    const meta = createSession("", "rootless");
    saveSession("", meta.id, [msg("user", "hi")]);
    expect(localStorage.getItem("jx-ai-chat-sessions")).toBeTruthy();
    expect(localStorage.getItem(`jx-ai-chat-session:${meta.id}`)).toBeTruthy();
    expect(loadSession("", meta.id)).toHaveLength(1);
  });

  test("throwing storage is swallowed", () => {
    const real = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem() {
          throw new Error("quota");
        },
        setItem() {
          throw new Error("quota");
        },
        removeItem() {
          throw new Error("quota");
        },
        clear() {
          throw new Error("quota");
        },
      },
      writable: true,
    });
    try {
      expect(listSessions(ROOT)).toHaveLength(0);
      const meta = createSession(ROOT, "quota");
      saveSession(ROOT, meta.id, [msg("user", "hi")]);
      deleteSession(ROOT, meta.id);
      expect(loadSession(ROOT, meta.id)).toBeNull();
    } finally {
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: real,
        writable: true,
      });
    }
  });
});
