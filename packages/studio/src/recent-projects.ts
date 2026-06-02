/// <reference lib="dom" />
interface RecentProject {
  name: string;
  root: string;
  timestamp: number;
}

interface RecentFile {
  path: string;
  name: string;
  timestamp: number;
}

const STORAGE_KEY = "jx-studio-recent-projects";
const FILES_STORAGE_KEY = "jx-studio-recent-files";
const MAX_RECENT = 8;
const MAX_RECENT_FILES = 10;

/** @returns {RecentProject[]} */
export function getRecentProjects() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return (JSON.parse(raw) as RecentProject[]).sort((a, b) => b.timestamp - a.timestamp);
  } catch {
    return [];
  }
}

/**
 * @param {string} name
 * @param {string} root
 */
export function addRecentProject(name: string, root: string) {
  const projects = getRecentProjects().filter((p) => p.root !== root);
  projects.unshift({ name, root, timestamp: Date.now() });
  if (projects.length > MAX_RECENT) projects.length = MAX_RECENT;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(projects));
}

export function clearRecentProjects() {
  localStorage.removeItem(STORAGE_KEY);
}

/** @returns {RecentFile[]} */
export function getRecentFiles() {
  try {
    const raw = localStorage.getItem(FILES_STORAGE_KEY);
    if (!raw) return [];
    return (JSON.parse(raw) as RecentFile[]).sort((a, b) => b.timestamp - a.timestamp);
  } catch {
    return [];
  }
}

/** @param {{ path: string; name: string }} file */
export function trackRecentFile(file: { path: string; name: string }) {
  const recent = getRecentFiles().filter((f) => f.path !== file.path);
  recent.unshift({ path: file.path, name: file.name, timestamp: Date.now() });
  if (recent.length > MAX_RECENT_FILES) recent.length = MAX_RECENT_FILES;
  localStorage.setItem(FILES_STORAGE_KEY, JSON.stringify(recent));
}
