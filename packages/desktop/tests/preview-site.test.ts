/**
 * `session.previewSite()` and the overlay — the desktop half of `View: Open in Browser`, live.
 *
 * The origin is mocked away here; `@jxsuite/server`'s own suites drive the real one. What these pin
 * is what the SESSION decides: that the route travels to the retarget, that `reused` reaches the
 * caller untouched, that a preview arms the filesystem watcher even when no shell subscribed for
 * the sidebar, and that re-rooting lets go of the last project's unsaved bytes.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

void mock.module("electrobun/main", () => ({
  BrowserWindow: class {},
  Electrobun: { start: () => {} },
  Utils: { openFileDialog: async () => [] },
}));

void mock.module("@jxsuite/server/site-preview", () => ({
  startSitePreview: () => ({ origin: "http://127.0.0.1:4321", port: 4321 }),
}));

const startLivePreview = mock((_root: string) =>
  Promise.resolve({
    errors: ["pages/huge.json is too large to preview unsaved."],
    origin: "http://127.0.0.1:51000",
    port: 51_000,
    routes: 4,
  }),
);
const navigateLivePreview = mock((_root: string, _route: string) => Promise.resolve(false));
const setLivePreviewOverlay = mock((_root: string, _path: string, _contents: string) => {});
const clearLivePreviewOverlay = mock((_root: string, _path?: string) => {});
const notifyLivePreviewChange = mock((_root: string) => {});
let hasOrigin = false;

void mock.module("@jxsuite/server/live-preview", () => ({
  clearLivePreviewOverlay,
  livePreviewOrigin: (_root: string) => (hasOrigin ? "http://127.0.0.1:51000" : null),
  navigateLivePreview,
  notifyLivePreviewChange,
  setLivePreviewOverlay,
  startLivePreview,
}));

/** The watcher, so "did a preview arm it?" is observable without touching a real filesystem. */
const watchedRoots: string[] = [];
let emit: ((events: unknown[]) => void) | null = null;

void mock.module("@jxsuite/server/refactor", () => ({
  applyRename: () => Promise.resolve({}),
  createFsWatcher: (root: string, onEvents: (events: unknown[]) => void) => {
    watchedRoots.push(root);
    emit = onEvents;
    return { close: () => Promise.resolve() };
  },
  findReferences: () => Promise.resolve({}),
  invalidateReferenceCache: () => {},
}));

const { createProjectSession } = await import("../src/project-session");

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "jx-preview-site-"));
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "project.json"), JSON.stringify({ name: "p", version: "1.0.0" }));
  return root;
}

beforeEach(() => {
  startLivePreview.mockClear();
  navigateLivePreview.mockClear();
  setLivePreviewOverlay.mockClear();
  clearLivePreviewOverlay.mockClear();
  notifyLivePreviewChange.mockClear();
  watchedRoots.length = 0;
  hasOrigin = false;
  emit = null;
});

describe("previewSite", () => {
  test("reports the origin, the route count, and that it is not a build", async () => {
    const root = project();
    try {
      const session = createProjectSession(root);
      expect(await session.previewSite({ route: "/" })).toEqual({
        errors: ["pages/huge.json is too large to preview unsaved."],
        // A live preview writes nothing, so there are no files to count.
        files: 0,
        mode: "live",
        reused: false,
        routes: 4,
        url: "http://127.0.0.1:51000",
      });
      expect(startLivePreview.mock.calls.at(-1)).toEqual([root]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("the route travels to the retarget", async () => {
    const root = project();
    try {
      await createProjectSession(root).previewSite({ route: "/blog/hello/" });
      expect(navigateLivePreview.mock.calls.at(-1)).toEqual([root, "/blog/hello/"]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("`reused` reaches the caller untouched — it is what stops a second tab", async () => {
    const root = project();
    try {
      navigateLivePreview.mockImplementation(() => Promise.resolve(true));
      const result = await createProjectSession(root).previewSite({ route: "/blog/hello/" });
      expect(result.reused).toBe(true);
    } finally {
      navigateLivePreview.mockImplementation(() => Promise.resolve(false));
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("with no route asked for, nothing is retargeted", async () => {
    const root = project();
    try {
      const result = await createProjectSession(root).previewSite({ route: "" });
      expect(navigateLivePreview).not.toHaveBeenCalled();
      expect(result.reused).toBe(false);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("with no project open it refuses rather than previewing nothing", async () => {
    const session = createProjectSession(null);
    // oxlint-disable-next-line typescript/await-thenable -- .rejects is typed void, awaited at runtime
    await expect(session.previewSite({ route: "/" })).rejects.toThrow("No project open");
  });
});

describe("the watcher a preview needs", () => {
  test("a preview arms the watcher even with no sidebar subscribed", async () => {
    /* The sink was the watcher's only consumer, so a window whose shell never subscribed would
       have had a live preview that never noticed a git checkout or an external editor. */
    const root = project();
    try {
      const session = createProjectSession(root);
      expect(watchedRoots).toEqual([]);
      hasOrigin = true;
      await session.previewSite({ route: "/" });
      expect(watchedRoots).toEqual([root]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("one watcher, two consumers: a filesystem event reaches the preview AND the sink", () => {
    const root = project();
    try {
      const session = createProjectSession(root);
      const seen: unknown[][] = [];
      session.setFileEventSink((events) => seen.push(events));
      emit?.([{ kind: "change", path: "pages/index.json" }]);
      expect(notifyLivePreviewChange.mock.calls.at(-1)).toEqual([root]);
      expect(seen).toHaveLength(1);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("with a preview but no sink, an event still reaches the preview", async () => {
    const root = project();
    try {
      const session = createProjectSession(root);
      hasOrigin = true;
      await session.previewSite({ route: "/" });
      emit?.([{ kind: "change", path: "pages/index.json" }]);
      expect(notifyLivePreviewChange.mock.calls.at(-1)).toEqual([root]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

describe("the overlay", () => {
  test("publishes the bytes a save would write, against this session's project", () => {
    const root = project();
    try {
      createProjectSession(root).setPreviewOverlay({
        contents: '{"tagName":"main"}',
        path: "pages/index.json",
      });
      expect(setLivePreviewOverlay.mock.calls.at(-1)).toEqual([
        root,
        "pages/index.json",
        '{"tagName":"main"}',
      ]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("clears one document, or the whole project when it names none", () => {
    const root = project();
    try {
      const session = createProjectSession(root);
      session.clearPreviewOverlay({ path: "pages/index.json" });
      expect(clearLivePreviewOverlay.mock.calls.at(-1)).toEqual([root, "pages/index.json"]);
      session.clearPreviewOverlay({});
      expect(clearLivePreviewOverlay.mock.calls.at(-1)).toEqual([root, undefined]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("with no project open, publishing refuses rather than writing into nowhere", () => {
    const session = createProjectSession(null);
    expect(() => {
      session.setPreviewOverlay({ contents: "{}", path: "pages/index.json" });
    }).toThrow("No project open");
  });
});

describe("re-rooting", () => {
  test("lets go of the last project's unsaved bytes", () => {
    /* The overlay is keyed by project root and lives for the process, so a session that re-roots
       without clearing leaves one project's unsaved bytes for a later preview of it to read. */
    const first = project();
    const second = project();
    try {
      const session = createProjectSession(first);
      session.setProjectRoot(second);
      expect(clearLivePreviewOverlay.mock.calls.at(-1)).toEqual([first]);
    } finally {
      rmSync(first, { force: true, recursive: true });
      rmSync(second, { force: true, recursive: true });
    }
  });

  test("re-rooting to the SAME project keeps its unsaved bytes", () => {
    const root = project();
    try {
      const session = createProjectSession(root);
      session.setProjectRoot(root);
      expect(clearLivePreviewOverlay).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("a session that never held a project has nothing to let go of", () => {
    const root = project();
    try {
      createProjectSession(null).setProjectRoot(root);
      expect(clearLivePreviewOverlay).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
