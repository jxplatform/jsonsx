/**
 * Project-session-watch.test.ts — which roots the session agrees to watch.
 *
 * A root with no project.json is not a project: `probeRootProject` says so and the window shows the
 * welcome screen. Watching one recursively is a scan of somebody's directory tree for a project
 * that is never opened — `jx-studio ~` is how that was found. `createFsWatcher` is mocked so the
 * decision itself is what is under test, rather than a real inotify race.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const watched: string[] = [];
const closed = mock(() => Promise.resolve());

void mock.module("@jxsuite/server/refactor", () => ({
  applyRename: () => Promise.resolve({ edits: [] }),
  createFsWatcher: (root: string) => {
    watched.push(root);
    return { close: closed };
  },
  findReferences: () => Promise.resolve({ files: [] }),
}));

const { createProjectSession } = await import("../src/project-session");

const FIXTURES = resolve(import.meta.dir, "_fixtures_session_watch");
const PROJECT = resolve(FIXTURES, "a-project");
const BARE = resolve(FIXTURES, "just-a-directory");

rmSync(FIXTURES, { force: true, recursive: true });
mkdirSync(PROJECT, { recursive: true });
mkdirSync(BARE, { recursive: true });
writeFileSync(resolve(PROJECT, "project.json"), '{"name":"a-project"}');

afterAll(() => {
  rmSync(FIXTURES, { force: true, recursive: true });
});

/** Run `fn` with console.log captured, returning the lines it wrote. */
function capturingLogs(fn: () => void): string[] {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => lines.push(args.join(" "));
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines;
}

beforeEach(() => {
  watched.length = 0;
  closed.mockClear();
});

describe("the session watches a project", () => {
  test("registering the sink starts the watcher on a root holding a project.json", () => {
    const session = createProjectSession(PROJECT);
    const logs = capturingLogs(() => session.setFileEventSink(() => {}));
    expect(watched).toEqual([PROJECT]);
    expect(logs.filter((line) => line.includes("not watching"))).toEqual([]);
    session.dispose();
  });

  test("a sink is what starts it — a root alone watches nothing", () => {
    const session = createProjectSession(PROJECT);
    expect(watched).toEqual([]);
    session.dispose();
  });
});

describe("the session refuses a root that is not a project", () => {
  test("no project.json means no watcher, and a line saying why", () => {
    const session = createProjectSession(BARE);
    const logs = capturingLogs(() => session.setFileEventSink(() => {}));
    expect(watched).toEqual([]);
    expect(logs.some((line) => line.includes("not watching") && line.includes(BARE))).toBe(true);
    session.dispose();
  });

  test("the refusal is logged once per root, not once per attempt to arm", () => {
    const session = createProjectSession(BARE);
    const logs = capturingLogs(() => {
      session.setFileEventSink(() => {});
      // Re-arming the same root — what a second sink registration or a no-op re-root does.
      session.setFileEventSink(() => {});
      session.setProjectRoot(BARE);
    });
    expect(logs.filter((line) => line.includes("not watching"))).toHaveLength(1);
    session.dispose();
  });

  test("re-rooting onto a real project arms the watcher that the bare root did not", () => {
    const session = createProjectSession(BARE);
    capturingLogs(() => {
      session.setFileEventSink(() => {});
      expect(watched).toEqual([]);
      session.setProjectRoot(PROJECT);
    });
    expect(watched).toEqual([PROJECT]);
    session.dispose();
  });

  test("leaving a project for a bare root closes the watcher it had", () => {
    const session = createProjectSession(PROJECT);
    capturingLogs(() => {
      session.setFileEventSink(() => {});
      expect(watched).toEqual([PROJECT]);
      session.setProjectRoot(BARE);
    });
    expect(closed).toHaveBeenCalled();
    session.dispose();
  });
});
