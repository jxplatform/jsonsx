/// <reference lib="dom" />
import { getPlatform, hasPlatform } from "./platform";
import type { RecentProjectEntry } from "./types";

interface RecentFile {
  path: string;
  name: string;
  /** The project root the file belongs to, so recents can be scoped to the open project. */
  root: string;
  timestamp: number;
}

const STORAGE_KEY = "jx-studio-recent-projects";
const FILES_STORAGE_KEY = "jx-studio-recent-files";
const MAX_RECENT = 8;
const MAX_RECENT_FILES = 10;

/**
 * In-memory mirror of the backend recent-projects store, hydrated once at startup. Render is
 * synchronous, so reads come from here (or directly from localStorage on the dev server) rather
 * than awaiting the backend.
 */
let cache: RecentProjectEntry[] = [];

/**
 * The active backend store, or null when none is available (dev server). Desktop and chromium
 * persist a user-level file shared across all projects/windows; the dev server falls back to
 * per-origin localStorage, which already survives reloads.
 */
function backend(): StudioRecentStore | null {
  if (!hasPlatform()) {
    return null;
  }
  const platform = getPlatform();
  return platform.getRecentProjects && platform.saveRecentProjects
    ? (platform as StudioRecentStore)
    : null;
}

interface StudioRecentStore {
  getRecentProjects: () => Promise<RecentProjectEntry[]>;
  saveRecentProjects: (projects: RecentProjectEntry[]) => Promise<void>;
}

function loadFromLocalStorage(): RecentProjectEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as RecentProjectEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** The current list from whichever store is active (cache for backend, localStorage otherwise). */
function currentList(): RecentProjectEntry[] {
  return backend() ? cache : loadFromLocalStorage();
}

/** Persist a new list to the active store and keep the in-memory cache in sync. */
function commit(list: RecentProjectEntry[]): void {
  cache = list;
  const store = backend();
  if (store) {
    void store.saveRecentProjects(list);
  } else {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    } catch {
      /* Storage unavailable — best effort */
    }
  }
}

/**
 * Load the recent-projects list into the in-memory cache. Call once after the platform is
 * registered; a no-op (other than priming the cache) on the dev server, where reads hit
 * localStorage directly.
 */
export async function hydrateRecentProjects(): Promise<void> {
  const store = backend();
  if (!store) {
    return;
  }
  try {
    cache = await store.getRecentProjects();
  } catch {
    cache = [];
  }
}

/** @returns {RecentProjectEntry[]} Newest-first */
export function getRecentProjects(): RecentProjectEntry[] {
  return currentList().toSorted((a, b) => b.timestamp - a.timestamp);
}

/**
 * @param {string} name
 * @param {string} root
 */
export function addRecentProject(name: string, root: string) {
  const projects = currentList().filter((p) => p.root !== root);
  projects.unshift({ name, root, timestamp: Date.now() });
  if (projects.length > MAX_RECENT) {
    projects.length = MAX_RECENT;
  }
  commit(projects);
}

/** Drop a single project from the recent list (used by the UI remove action + auto-prune). */
export function removeRecentProject(root: string) {
  commit(currentList().filter((p) => p.root !== root));
}

export function clearRecentProjects() {
  cache = [];
  const store = backend();
  if (store) {
    void store.saveRecentProjects([]);
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }
}

function loadRecentFiles(): RecentFile[] {
  try {
    const raw = localStorage.getItem(FILES_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as RecentFile[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Recently-opened files, newest-first. Pass a project `root` to scope the list to that project (the
 * Quick Access modal does this so it only ever shows files from the open project).
 *
 * @param {string} [root]
 * @returns {RecentFile[]}
 */
export function getRecentFiles(root?: string) {
  const all = loadRecentFiles().toSorted((a, b) => b.timestamp - a.timestamp);
  return root == null ? all : all.filter((f) => f.root === root);
}

/** @param {{ path: string; name: string; root: string }} file */
export function trackRecentFile(file: { path: string; name: string; root: string }) {
  const all = loadRecentFiles().filter((f) => !(f.root === file.root && f.path === file.path));
  all.unshift({ name: file.name, path: file.path, root: file.root, timestamp: Date.now() });
  // Cap per project so a busy project can't evict another project's history.
  const perRoot = new Map<string, number>();
  const kept: RecentFile[] = [];
  for (const f of all.toSorted((a, b) => b.timestamp - a.timestamp)) {
    const n = (perRoot.get(f.root) ?? 0) + 1;
    perRoot.set(f.root, n);
    if (n <= MAX_RECENT_FILES) {
      kept.push(f);
    }
  }
  localStorage.setItem(FILES_STORAGE_KEY, JSON.stringify(kept));
}
