import { describe, expect, mock, test } from "bun:test";

// Index.ts is now a thin app-level bootstrap: it wires shared services (AI server, updater, menu)
// And opens the initial window via the window-manager. Per-window RPC + window controls live in
// Window-manager.ts (see window-manager.test.ts).

// ─── Mock electrobun/bun (default export: events) ────────────────────────────

const eventHandlers = new Map<string, (e: { data: { url: string } }) => void>();
void mock.module("electrobun/bun", () => ({
  default: {
    events: {
      on: (name: string, handler: (e: { data: { url: string } }) => void) => {
        eventHandlers.set(name, handler);
      },
    },
  },
}));

// ─── Mock local modules ──────────────────────────────────────────────────────

const openProjectWindow = mock((_root: string | null) => ({}) as unknown);
const setAiServerUrl = mock((_url: string) => {});
const broadcastUpdateReady = mock((_version: string) => {});
const parseProjectDirFromUrl = mock((url: string) =>
  url.includes("project.json") ? "/parsed/dir" : null,
);
void mock.module("../src/window-manager", () => ({
  broadcastUpdateReady,
  openProjectWindow,
  parseProjectDirFromUrl,
  setAiServerUrl,
}));

const installApplicationMenu = mock(() => {});
void mock.module("../src/menu", () => ({ installApplicationMenu }));

const setFileDialog = mock((_fn: unknown) => {});
void mock.module("../src/project-session", () => ({ setFileDialog }));

let notifyWebview: ((version: string) => void) | null = null;
const startBackgroundChecks = mock(() => {});
const setNotifyWebview = mock((fn: (version: string) => void) => {
  notifyWebview = fn;
});
void mock.module("../src/updater", () => ({ setNotifyWebview, startBackgroundChecks }));

const openFileDialogSentinel = mock(async () => null);
const initUtils = mock(async () => {});
void mock.module("../src/utils", () => ({
  init: initUtils,
  openFileDialog: openFileDialogSentinel,
}));

const handleAiRoute = mock(async (_req: Request, path: string, _root: string | null) => {
  if (path === "/studio/ai/hit") {
    return new Response("ai-ok", { status: 200 });
  }
  return null;
});
void mock.module("../src/ai", () => ({ handleAiRoute }));

// ─── Stub Bun.serve, then import the module under test ───────────────────────

const realServe = Bun.serve;
let serveOpts: { fetch: (req: Request) => Promise<Response>; port: number } | null = null;
// @ts-expect-error replacing Bun.serve with a capture stub for import-time boot
Bun.serve = (opts: { fetch: (req: Request) => Promise<Response>; port: number }) => {
  serveOpts = opts;
  return { port: 43_210, stop: () => {} };
};

await import("../src/index");

// @ts-expect-error restore the real Bun.serve
Bun.serve = realServe;

const expectedBoot = process.argv[2] || process.env.JSONSX_PROJECT_ROOT || null;

// ─── Boot sequence ────────────────────────────────────────────────────────────

describe("boot sequence", () => {
  test("initializes utils and wires the file dialog", () => {
    expect(initUtils).toHaveBeenCalledTimes(1);
    expect(setFileDialog).toHaveBeenCalledWith(openFileDialogSentinel);
  });

  test("starts the AI server on an ephemeral port and publishes its url", () => {
    expect(serveOpts).not.toBeNull();
    expect(serveOpts!.port).toBe(0);
    expect(typeof serveOpts!.fetch).toBe("function");
    expect(setAiServerUrl).toHaveBeenCalledWith("http://localhost:43210");
  });

  test("installs the application menu", () => {
    expect(installApplicationMenu).toHaveBeenCalledTimes(1);
  });

  test("starts background update checks and broadcasts updates to all windows", () => {
    expect(startBackgroundChecks).toHaveBeenCalledTimes(1);
    expect(notifyWebview).not.toBeNull();
    notifyWebview!("3.1.4");
    expect(broadcastUpdateReady).toHaveBeenCalledWith("3.1.4");
  });

  test("opens the initial window from argv/env (null → welcome)", () => {
    expect(openProjectWindow).toHaveBeenCalledTimes(1);
    expect(openProjectWindow.mock.calls[0]?.[0]).toBe(expectedBoot as never);
  });
});

// ─── AI HTTP server fetch handler ───────────────────────────────────────────

describe("AI server fetch handler", () => {
  test("delegates matching routes to handleAiRoute with a null root", async () => {
    const res = await serveOpts!.fetch(new Request("http://localhost/studio/ai/hit"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ai-ok");
    const [, path, root] = handleAiRoute.mock.calls.at(-1)!;
    expect(path).toBe("/studio/ai/hit");
    expect(root).toBeNull();
  });

  test("normalizes duplicate leading slashes", async () => {
    const res = await serveOpts!.fetch(new Request("http://localhost//studio/ai/hit"));
    expect(res.status).toBe(200);
    expect(handleAiRoute.mock.calls.at(-1)![1]).toBe("/studio/ai/hit");
  });

  test("returns 404 for unhandled routes", async () => {
    const res = await serveOpts!.fetch(new Request("http://localhost/nope"));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not Found");
  });
});

// ─── open-url file association ──────────────────────────────────────────────

describe("open-url event", () => {
  const handler = () => eventHandlers.get("open-url")!;

  test("registers an open-url listener", () => {
    expect(eventHandlers.has("open-url")).toBe(true);
  });

  test("opens a window for the parsed project directory", () => {
    const before = openProjectWindow.mock.calls.length;
    handler()({ data: { url: "file:///home/me/proj/project.json" } });
    expect(parseProjectDirFromUrl).toHaveBeenCalledWith("file:///home/me/proj/project.json");
    expect(openProjectWindow.mock.calls.length).toBe(before + 1);
    expect(openProjectWindow.mock.calls.at(-1)?.[0]).toBe("/parsed/dir");
  });

  test("ignores urls that do not parse to a project directory", () => {
    const before = openProjectWindow.mock.calls.length;
    handler()({ data: { url: "file:///home/me/proj/readme.md" } });
    expect(openProjectWindow.mock.calls.length).toBe(before);
  });
});
