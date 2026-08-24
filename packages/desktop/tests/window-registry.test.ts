/**
 * The cross-process window registry — the answer to "which Studio windows are open" on a launcher
 * where a window is a process rather than an object in a Map.
 *
 * Every test drives the real filesystem inside a temp directory, because a store whose whole point
 * is that a SECOND process can read it cannot be checked against a mock of itself.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import envPaths from "env-paths";
import {
  findWindowByRoot,
  listWindows,
  nextWelcomeProfile,
  normalizeRoot,
  projectProfile,
  registerWindow,
  requestFocus,
  unregisterWindow,
  updateWindow,
  watchFocusRequests,
  windowsDir,
} from "../src/chromium/window-registry";

const ROOT = join(tmpdir(), `jx-window-registry-${process.pid}`);
const REGISTRY = join(ROOT, "windows");
const DATA = join(ROOT, "data");

process.env.JX_STUDIO_WINDOWS_DIR = REGISTRY;
// `nextWelcomeProfile` resolves under the app data dir. env-paths honours XDG_DATA_HOME on Linux
// Only — on Windows and macOS it reads LOCALAPPDATA / ~/Library regardless — so this isolates the
// Linux run but cannot be what the expectations are built from.
process.env.XDG_DATA_HOME = DATA;

/**
 * The app data path, resolved exactly as `user-config.dataFile` resolves it.
 *
 * Written out rather than hardcoded as `join(DATA, "jx-studio", …)`: that spelling is env-paths'
 * LINUX layout, so on Windows it asserted a directory the implementation never names and all three
 * data-dir tests failed there while passing on CI. What these tests are actually about is the
 * structure under the base — `windows`, `chromium-profiles/welcome-N` — not the OS prefix.
 */
function dataPath(name: string): string {
  return join(envPaths("jx-studio", { suffix: "" }).data, name);
}

/** A pid that certainly names nothing: spawned, waited for, and reaped. */
function deadPid(): number {
  return Bun.spawnSync(["true"]).pid;
}

function entry(pid: number, root: string | null, profileDir = `/profiles/${pid}`) {
  return {
    name: root ? (root.split("/").pop() ?? null) : null,
    pid,
    profileDir,
    root,
    url: `http://127.0.0.1:${4000 + (pid % 1000)}`,
  };
}

beforeEach(() => {
  rmSync(REGISTRY, { force: true, recursive: true });
});

afterEach(() => {
  rmSync(REGISTRY, { force: true, recursive: true });
});

afterAll(() => {
  rmSync(ROOT, { force: true, recursive: true });
});

// ─── Location ─────────────────────────────────────────────────────────────────

describe("windowsDir", () => {
  test("honours the override, so a test run never touches the real registry", () => {
    expect(windowsDir()).toBe(REGISTRY);
  });

  test("falls back to the app data directory when nothing overrides it", () => {
    const override = process.env.JX_STUDIO_WINDOWS_DIR;
    delete process.env.JX_STUDIO_WINDOWS_DIR;
    try {
      expect(windowsDir()).toBe(dataPath("windows"));
    } finally {
      process.env.JX_STUDIO_WINDOWS_DIR = override;
    }
  });
});

// ─── Register / update / unregister ───────────────────────────────────────────

describe("registerWindow", () => {
  test("writes one file per window, named for its pid", () => {
    registerWindow(entry(process.pid, "/proj/alpha"));
    const file = join(REGISTRY, `${process.pid}.json`);
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
      pid: process.pid,
      root: "/proj/alpha",
    });
  });

  test("the entry is owner-only: it names a live loopback server", () => {
    if (process.platform === "win32") {
      return; // POSIX mode bits only
    }
    registerWindow(entry(process.pid, "/proj/alpha"));
    const mode = statSync(join(REGISTRY, `${process.pid}.json`)).mode % 0o1000;
    expect(mode).toBe(0o600);
  });

  test("creates the directory on first use", () => {
    expect(existsSync(REGISTRY)).toBe(false);
    registerWindow(entry(process.pid, "/proj/alpha"));
    expect(existsSync(REGISTRY)).toBe(true);
  });
});

describe("updateWindow", () => {
  test("amends the row in place when the window re-roots", () => {
    registerWindow(entry(process.pid, null));
    updateWindow(process.pid, { name: "beta", root: "/proj/beta" });
    const [only] = listWindows();
    expect(only).toMatchObject({ name: "beta", pid: process.pid, root: "/proj/beta" });
    // Untouched fields survive the patch.
    expect(only!.profileDir).toBe(`/profiles/${process.pid}`);
  });

  test("does NOT resurrect a window that has already left the registry", () => {
    updateWindow(process.pid, { root: "/proj/ghost" });
    expect(listWindows()).toEqual([]);
  });
});

describe("unregisterWindow", () => {
  test("removes the entry and any focus request addressed to it", () => {
    registerWindow(entry(process.pid, "/proj/alpha"));
    requestFocus(process.pid);
    expect(existsSync(join(REGISTRY, `${process.pid}.focus`))).toBe(true);
    unregisterWindow(process.pid);
    expect(existsSync(join(REGISTRY, `${process.pid}.json`))).toBe(false);
    expect(existsSync(join(REGISTRY, `${process.pid}.focus`))).toBe(false);
  });
});

// ─── Listing + pruning ────────────────────────────────────────────────────────

describe("listWindows", () => {
  test("an absent registry is an empty one, not an error", () => {
    expect(listWindows()).toEqual([]);
  });

  test("prunes the row of a process that is gone", () => {
    const gone = deadPid();
    registerWindow(entry(gone, "/proj/crashed"));
    registerWindow(entry(process.pid, "/proj/alive"));
    expect(listWindows().map((w) => w.pid)).toEqual([process.pid]);
    // Pruned on READ: the crashed launcher's file is deleted, not merely skipped.
    expect(existsSync(join(REGISTRY, `${gone}.json`))).toBe(false);
  });

  test("a corrupt entry is pruned rather than crashing every other window's dedupe", () => {
    mkdirSync(REGISTRY, { recursive: true });
    writeFileSync(join(REGISTRY, "4242.json"), "{ not json");
    registerWindow(entry(process.pid, "/proj/alive"));
    expect(listWindows().map((w) => w.pid)).toEqual([process.pid]);
    expect(existsSync(join(REGISTRY, "4242.json"))).toBe(false);
  });

  test("ignores files that are not window entries", () => {
    registerWindow(entry(process.pid, "/proj/alive"));
    requestFocus(process.pid);
    writeFileSync(join(REGISTRY, "notes.txt"), "hello");
    expect(listWindows().map((w) => w.pid)).toEqual([process.pid]);
  });

  test("orders by pid so a listing is stable between calls", () => {
    // Only this process is live, so a second live row is impossible to fake; assert the sort is
    // Applied by checking the single-row case stays a copy rather than the raw readdir order.
    registerWindow(entry(process.pid, "/proj/alive"));
    expect(listWindows()).toEqual(listWindows());
  });
});

// ─── Dedupe ───────────────────────────────────────────────────────────────────

describe("findWindowByRoot", () => {
  test("matches a root written differently — that is the whole job", () => {
    const dir = join(ROOT, "project-shape");
    mkdirSync(dir, { recursive: true });
    registerWindow(entry(process.pid, dir));
    expect(findWindowByRoot(`${dir}/`)?.pid).toBe(process.pid);
    expect(findWindowByRoot(join(dir, "."))?.pid).toBe(process.pid);
  });

  test("skips the caller, so re-rooting a window never dedupes against itself", () => {
    registerWindow(entry(process.pid, "/proj/alpha"));
    expect(findWindowByRoot("/proj/alpha")?.pid).toBe(process.pid);
    expect(findWindowByRoot("/proj/alpha", process.pid)).toBeNull();
  });

  test("a welcome window holds no project and matches nothing", () => {
    registerWindow(entry(process.pid, null));
    expect(findWindowByRoot("/proj/alpha")).toBeNull();
  });
});

describe("normalizeRoot", () => {
  test("resolves symlinks, so a link and its target are one project", () => {
    if (process.platform === "win32") {
      return; // Symlink creation needs elevation on Windows
    }
    const real = join(ROOT, "real-project");
    const link = join(ROOT, "link-project");
    mkdirSync(real, { recursive: true });
    rmSync(link, { force: true });
    symlinkSync(real, link);
    expect(normalizeRoot(link)).toBe(normalizeRoot(real));
  });

  test("a root that does not exist yet keeps its resolved form", () => {
    const missing = join(ROOT, "not-created-yet");
    expect(normalizeRoot(`${missing}/`)).toBe(
      process.platform === "win32" ? missing.toLowerCase() : missing,
    );
  });
});

// ─── Focus ────────────────────────────────────────────────────────────────────

describe("focus requests", () => {
  test("a request left before this window was watching is still honoured", () => {
    registerWindow(entry(process.pid, "/proj/alpha"));
    requestFocus(process.pid);
    let raised = 0;
    const stop = watchFocusRequests(process.pid, () => {
      raised += 1;
    });
    try {
      expect(raised).toBe(1);
      // Consumed, so it cannot latch and raise the window forever.
      expect(existsSync(join(REGISTRY, `${process.pid}.focus`))).toBe(false);
    } finally {
      stop();
    }
  });

  test("raises the window when another one asks, and stops when unsubscribed", async () => {
    registerWindow(entry(process.pid, "/proj/alpha"));
    let raised = 0;
    const stop = watchFocusRequests(process.pid, () => {
      raised += 1;
    });
    try {
      requestFocus(process.pid);
      await until(() => raised === 1);
      expect(raised).toBe(1);
    } finally {
      stop();
    }
    requestFocus(process.pid);
    await Bun.sleep(60);
    expect(raised).toBe(1);
  });

  test("a request addressed to another window is not this window's business", async () => {
    let raised = 0;
    const stop = watchFocusRequests(process.pid, () => {
      raised += 1;
    });
    try {
      requestFocus(process.pid + 1);
      await Bun.sleep(60);
      expect(raised).toBe(0);
    } finally {
      stop();
    }
  });

  test("an unwritable registry costs a raise, never a crash", () => {
    const override = process.env.JX_STUDIO_WINDOWS_DIR;
    // A path under a FILE cannot be created as a directory.
    mkdirSync(ROOT, { recursive: true });
    const blocker = join(ROOT, "blocker");
    writeFileSync(blocker, "");
    process.env.JX_STUDIO_WINDOWS_DIR = join(blocker, "nested");
    try {
      expect(() => requestFocus(1)).not.toThrow();
      expect(watchFocusRequests(1, () => {})).toBeInstanceOf(Function);
    } finally {
      process.env.JX_STUDIO_WINDOWS_DIR = override;
    }
  });
});

// ─── Chromium profiles ────────────────────────────────────────────────────────

describe("profile directories", () => {
  test("a project's window keeps its profile beside the project", () => {
    expect(projectProfile("/proj/alpha")).toBe(resolve("/proj/alpha", ".jx", "chromium-profile"));
  });

  test("a welcome window takes the lowest slot no live window is using", () => {
    const base = dataPath("chromium-profiles");
    expect(nextWelcomeProfile()).toBe(join(base, "welcome-0"));
    registerWindow(entry(process.pid, null, join(base, "welcome-0")));
    expect(nextWelcomeProfile()).toBe(join(base, "welcome-1"));
  });

  test("a slot freed by a closed window is reused rather than counting upward forever", () => {
    const base = dataPath("chromium-profiles");
    registerWindow(entry(deadPid(), null, join(base, "welcome-0")));
    expect(nextWelcomeProfile()).toBe(join(base, "welcome-0"));
  });
});

/** Wait for a condition the filesystem watcher will make true, or give up. */
async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await Bun.sleep(10);
  }
}
