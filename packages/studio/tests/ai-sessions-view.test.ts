/**
 * Tests for src/panels/ai-chat/sessions-view.ts — the full-pane chat history list: relativeTime
 * formatting, row rendering, open/delete callbacks (delete must not bubble into the row's open
 * handler), and the empty state.
 *
 * New Chat is no longer a callback: it is `assistant.newChat`, the record the chat header runs too
 * (§11.1), so the header renders it from the registry or renders nothing at all.
 */
import { pointer, renderInto } from "./harness";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { relativeTime, renderSessionsList } from "../src/panels/ai-chat/sessions-view";
import { setActiveRegistry } from "../src/commands/active-registry";
import { createCommandRegistry } from "../src/commands/registry";
import { emptyContext } from "../src/commands/context";
import type { SessionMeta } from "../src/services/ai-session-store";

const NOW = Date.parse("2026-07-06T12:00:00Z");

function meta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    createdAt: NOW - 60_000,
    id: "s1",
    messageCount: 3,
    title: "Build a landing page",
    updatedAt: NOW - 60_000,
    ...overrides,
  };
}

describe("relativeTime", () => {
  const MIN = 60_000;
  const cases: [number, string][] = [
    [0, "just now"],
    [30_000, "just now"],
    [MIN, "1m ago"],
    [5 * MIN, "5m ago"],
    [60 * MIN, "1h ago"],
    [23 * 60 * MIN, "23h ago"],
    [25 * 60 * MIN, "yesterday"],
    [3 * 24 * 60 * MIN, "3d ago"],
  ];
  for (const [delta, expected] of cases) {
    test(`${delta}ms ago → "${expected}"`, () => {
      expect(relativeTime(NOW - delta, NOW)).toBe(expected);
    });
  }

  test("older than a week → locale date", () => {
    const ts = NOW - 10 * 24 * 60 * MIN;
    expect(relativeTime(ts, NOW)).toBe(new Date(ts).toLocaleDateString());
  });

  test("future timestamps clamp to just now", () => {
    expect(relativeTime(NOW + 5000, NOW)).toBe("just now");
  });
});

const ran: string[] = [];

beforeEach(() => {
  ran.length = 0;
  const registry = createCommandRegistry({ getContext: emptyContext });
  registry.register({
    category: "Assistant",
    id: "assistant.newChat",
    level: "application",
    run: () => {
      ran.push("assistant.newChat");
    },
    title: "New Chat",
  });
  setActiveRegistry(registry);
});

afterEach(() => {
  setActiveRegistry(null);
});

describe("renderSessionsList", () => {
  test("renders rows with title, relative time, and message count", async () => {
    const el = await renderInto(
      renderSessionsList({
        onDelete: () => {},
        onOpen: () => {},
        sessions: [meta(), meta({ id: "s2", messageCount: 1, title: "Second chat" })],
      }),
    );
    const rows = el.querySelectorAll(".ai-session-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.querySelector(".ai-session-title")!.textContent).toBe("Build a landing page");
    expect(rows[0]!.querySelector(".ai-session-meta")!.textContent).toContain("messages");
    expect(rows[1]!.querySelector(".ai-session-meta")!.textContent).toContain("1");
    expect(rows[1]!.querySelector(".ai-session-meta")!.textContent).not.toContain("messages");
    expect(rows[1]!.querySelector(".ai-session-meta")!.textContent).toContain("message");
  });

  test("row click opens; delete button deletes without opening", async () => {
    const onOpen = mock((_id: string) => {});
    const onDelete = mock((_id: string) => {});
    const el = await renderInto(renderSessionsList({ onDelete, onOpen, sessions: [meta()] }));
    const row = el.querySelector(".ai-session-row")!;
    pointer(row, "click");
    expect(onOpen).toHaveBeenCalledWith("s1");

    pointer(row.querySelector(".ai-session-delete")!, "click");
    expect(onDelete).toHaveBeenCalledWith("s1");
    // StopPropagation kept the delete click from also opening the row.
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  test("New Chat runs the record; empty list shows the empty state", async () => {
    const el = await renderInto(
      renderSessionsList({ onDelete: () => {}, onOpen: () => {}, sessions: [] }),
    );
    expect(el.querySelector(".ai-sessions-empty")!.textContent).toContain("No previous chats");
    pointer(el.querySelector("sp-action-button[title='New Chat']")!, "click");
    expect(ran).toEqual(["assistant.newChat"]);
  });

  test("no record, no button — this header is a rendering of the registry too", async () => {
    setActiveRegistry(null);
    const el = await renderInto(
      renderSessionsList({ onDelete: () => {}, onOpen: () => {}, sessions: [meta()] }),
    );
    // The list itself is untouched: reading your history never depended on a registry.
    expect(el.querySelectorAll(".ai-session-row")).toHaveLength(1);
    expect(el.querySelector("sp-action-button[title='New Chat']")).toBeNull();
  });
});
