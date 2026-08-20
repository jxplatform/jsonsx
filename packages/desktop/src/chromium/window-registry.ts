/**
 * Cross-process registry of open Studio windows.
 *
 * On electrobun a window is a `BrowserWindow` inside one Bun process, so the window manager is a
 * `Map` and every question about "which windows are open" is answered from memory. This launcher
 * has no such process: a Chromium `--app` window belongs to a browser Chromium owns, and the only
 * thing that reliably lives exactly as long as one window is the launcher that started it. **A
 * window here IS a process.** Multi-window therefore needs the one thing a Map cannot give — an
 * answer that spans processes — and this file is it.
 *
 * The store is a directory of one small JSON file per window, named for its pid:
 *
 *     <data>/jx-studio/windows/<pid>.json     ← written and deleted by that window, nobody else
 *     <data>/jx-studio/windows/<pid>.focus    ← written by ANOTHER window to ask this one forward
 *
 * One writer per file is the whole concurrency design. Nothing read-modify-writes a shared
 * document, so two launchers starting at the same instant cannot lose each other's entry, and a
 * launcher that dies without cleaning up leaves a file whose pid no longer resolves — which
 * {@link listWindows} prunes on the next read. (A pid the OS has since recycled reads as alive; the
 * cost is a stale row and a focus request some unrelated process never reads, never a signal
 * delivered to it — nothing here signals anything.)
 *
 * `JX_STUDIO_WINDOWS_DIR` overrides the location, which is what keeps a test run out of the real
 * user's registry.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  watch,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { dataFile } from "../user-config";

/** One open window, as the process that owns it describes itself. */
export interface WindowEntry {
  /** The launcher process id — the file's name, and the window's identity. */
  pid: number;
  /** Project root the window currently holds, or null for a welcome window. */
  root: string | null;
  /** Display name of that project, for `listOpenWindows`. */
  name: string | null;
  /** The Chromium profile this window's browser was launched with (see `nextWelcomeProfile`). */
  profileDir: string;
  /** The window's own project-server origin. Informational: nothing here connects to it. */
  url: string;
}

/** Directory holding the per-window files. Overridable so tests never touch the real registry. */
export function windowsDir(): string {
  return process.env.JX_STUDIO_WINDOWS_DIR || dataFile("windows");
}

function entryFile(pid: number): string {
  return join(windowsDir(), `${pid}.json`);
}

function focusFile(pid: number): string {
  return join(windowsDir(), `${pid}.focus`);
}

/**
 * Normalize a project root for comparison: absolute, symlinks resolved, case-folded on Windows.
 *
 * Dedupe is only as good as this. `/home/me/site` and `/home/me/./site/` and a symlink into it are
 * one project, and opening a second window for it because the strings differ is exactly the bug
 * multi-window is supposed to avoid.
 */
export function normalizeRoot(root: string): string {
  let normalized = resolve(root);
  try {
    normalized = realpathSync.native(normalized);
  } catch {
    // A root that does not exist yet (a project being created) keeps its resolved form.
  }
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/**
 * Whether a pid still names a live process.
 *
 * Signal 0 performs the permission and existence check without delivering anything. `EPERM` means
 * the process is there but owned by someone else, which is still "alive" for our purposes.
 */
function isAlive(pid: number): boolean {
  if (pid === process.pid) {
    return true;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Record this window. Overwrites any file left by a previous process with the same pid. */
export function registerWindow(entry: WindowEntry): void {
  const dir = windowsDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(entryFile(entry.pid), JSON.stringify(entry), { encoding: "utf8", mode: 0o600 });
}

/**
 * Amend this window's entry in place — the project it holds changed.
 *
 * A no-op when the entry is gone: the window is on its way out, and re-creating its row here would
 * leave a permanent ghost in the registry.
 */
export function updateWindow(pid: number, patch: Partial<Omit<WindowEntry, "pid">>): void {
  const current = readEntry(pid);
  if (!current) {
    return;
  }
  registerWindow({ ...current, ...patch, pid });
}

/** Forget this window (and any unread focus request addressed to it). */
export function unregisterWindow(pid: number): void {
  for (const file of [entryFile(pid), focusFile(pid)]) {
    try {
      rmSync(file, { force: true });
    } catch {
      // A registry we cannot write to costs a stale row, which the next read prunes.
    }
  }
}

function readEntry(pid: number): WindowEntry | null {
  try {
    const parsed = JSON.parse(readFileSync(entryFile(pid), "utf8")) as WindowEntry;
    return typeof parsed?.pid === "number" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Every live window, pruning the rows whose process is gone.
 *
 * Pruning on READ rather than on a timer is what makes a crashed launcher self-healing: the next
 * window to ask a question cleans up after it, and there is no daemon to have missed the death.
 */
export function listWindows(): WindowEntry[] {
  const dir = windowsDir();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const entries: WindowEntry[] = [];
  for (const name of names) {
    const match = /^(\d+)\.json$/.exec(name);
    if (!match) {
      continue;
    }
    const pid = Number(match[1]);
    const entry = readEntry(pid);
    if (!entry || !isAlive(pid)) {
      unregisterWindow(pid);
      continue;
    }
    entries.push(entry);
  }
  return entries.toSorted((a, b) => a.pid - b.pid);
}

/**
 * The live window holding `root`, if any.
 *
 * @param exceptPid Skip this window — the caller asking whether ANOTHER window has the project.
 */
export function findWindowByRoot(root: string, exceptPid?: number): WindowEntry | null {
  const key = normalizeRoot(root);
  for (const entry of listWindows()) {
    if (entry.pid === exceptPid || !entry.root) {
      continue;
    }
    if (normalizeRoot(entry.root) === key) {
      return entry;
    }
  }
  return null;
}

/**
 * Ask the window owning `pid` to come forward.
 *
 * A file rather than a signal, deliberately. A pid the OS recycled would receive a signal meant for
 * a process that no longer exists — `SIGUSR2` terminates a process that has not installed a handler
 * — whereas a file only the real launcher watches for is inert to anyone else.
 */
export function requestFocus(pid: number): void {
  try {
    mkdirSync(windowsDir(), { recursive: true });
    writeFileSync(focusFile(pid), "", { encoding: "utf8", mode: 0o600 });
  } catch {
    // Best-effort: a raise that cannot be requested just leaves the window where it is.
  }
}

/**
 * Run `onFocus` whenever another window asks this one forward; returns an unsubscribe function.
 *
 * The request file is consumed (deleted) before the callback runs, so a window that is asked twice
 * comes forward twice rather than latching on a file nobody clears.
 */
export function watchFocusRequests(pid: number, onFocus: () => void): () => void {
  const dir = windowsDir();
  const target = `${pid}.focus`;
  const consume = () => {
    if (!existsSync(focusFile(pid))) {
      return;
    }
    try {
      rmSync(focusFile(pid), { force: true });
    } catch {
      // If it cannot be cleared, raising once and ignoring the repeat is the better failure.
    }
    onFocus();
  };
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return () => {};
  }
  // A request that arrived while this window was still booting is still a request.
  consume();
  let watcher: ReturnType<typeof watch>;
  try {
    watcher = watch(dir, (_event, filename) => {
      if (filename === target) {
        consume();
      }
    });
  } catch {
    // No watch capability (some network filesystems): the window simply never raises itself.
    return () => {};
  }
  return () => watcher.close();
}

/**
 * A Chromium profile directory for a window with no project.
 *
 * Every window needs a profile of its own — Chromium's process singleton is keyed on it, so two
 * windows sharing one directory would be one browser process, and the second launcher's window
 * would be handed to the first launcher's browser pointing at a server that is about to die. A
 * project's window uses a directory under the project (so its Studio layout, theme and open tabs
 * survive a restart); a welcome window has no project to key on, so it takes the lowest slot no
 * live window is already using.
 */
export function nextWelcomeProfile(): string {
  const base = dataFile("chromium-profiles");
  const used = new Set(listWindows().map((entry) => entry.profileDir));
  for (let index = 0; ; index += 1) {
    const dir = join(base, `welcome-${index}`);
    if (!used.has(dir)) {
      return dir;
    }
  }
}

/** The Chromium profile directory for a window holding `root` — beside the project it belongs to. */
export function projectProfile(root: string): string {
  return resolve(root, ".jx", "chromium-profile");
}
