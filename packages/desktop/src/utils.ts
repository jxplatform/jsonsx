import { homedir } from "node:os";

interface ElectrobunUtils {
  /** Hand a URL to the OS — the user's real browser, not a chrome-less webview. */
  openExternal: (url: string) => boolean;
  openFileDialog: (options: {
    startingFolder?: string;
    allowedFileTypes?: string;
    canChooseFiles?: boolean;
    canChooseDirectory?: boolean;
    allowsMultipleSelection?: boolean;
  }) => Promise<string[]>;
}

let Utils: ElectrobunUtils | null = null;

export async function init() {
  try {
    ({ Utils } = await import("electrobun/bun"));
  } catch {}
}

export async function openFileDialog(): Promise<string | null> {
  if (!Utils) {
    return null;
  }
  const paths = await Utils.openFileDialog({
    allowedFileTypes: "json",
    allowsMultipleSelection: false,
    canChooseDirectory: false,
    canChooseFiles: true,
    startingFolder: homedir(),
  });
  if (!paths || paths.length === 0 || (paths.length === 1 && !paths[0])) {
    return null;
  }
  return paths[0].trim() || null;
}

/** Pick a folder — used by New Project to choose where to scaffold the project. */
export async function openDirectoryDialog(): Promise<string | null> {
  if (!Utils) {
    return null;
  }
  const paths = await Utils.openFileDialog({
    allowsMultipleSelection: false,
    canChooseDirectory: true,
    canChooseFiles: false,
    startingFolder: homedir(),
  });
  if (!paths || paths.length === 0 || (paths.length === 1 && !paths[0])) {
    return null;
  }
  return paths[0].trim() || null;
}

/**
 * Open a URL in the user's default browser.
 *
 * Studio's Preview mode routes link clicks through here (see `setPreviewNavigateHandler`):
 * following a link in Preview exists to see the real page behave like the real thing, and a webview
 * with no address bar, history or devtools is not that. Returns false when the shell is unavailable
 * or the OS refused, so the caller can fall back to `window.open`.
 */
export function openExternal(url: string): boolean {
  if (!Utils) {
    return false;
  }
  try {
    return Utils.openExternal(url);
  } catch {
    return false;
  }
}
