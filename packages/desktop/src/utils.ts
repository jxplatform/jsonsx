import { homedir } from "node:os";
import { spawn } from "node:child_process";

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
 * Studio's Preview mode routes link clicks through here (see `setPreviewNavigateHandler`), and so
 * do `View: Open in Browser` and the GitHub sign-in redirect: each of the three exists to leave the
 * editor's window, and a webview or a frameless `--app` window with no address bar, history or
 * devtools is not the browser any of them means.
 *
 * Electrobun's native helper first, the OS opener second. The fallback is not belt-and-braces: the
 * helper comes from `electrobun/bun`, which the chromium launcher never loads (it is the launcher
 * for the platform electrobun cannot be built on), so before it existed EVERY url this function was
 * given on that build was silently dropped — sign-in reported "Could not open a browser", and a
 * preview link did nothing at all.
 *
 * Returns false when neither path could hand the URL over, so the caller can fall back to
 * `window.open`.
 */
export function openExternal(url: string): boolean {
  if (Utils) {
    try {
      if (Utils.openExternal(url)) {
        return true;
      }
    } catch {
      // Fall through to the OS opener.
    }
  }
  return handToOsOpener(url);
}

/**
 * Hand a URL to the desktop environment's opener.
 *
 * **Web schemes only.** The opener resolves a scheme to whatever handler the desktop has registered
 * for it, so an unrestricted one turns "a link in a previewed page" into "run the program the OS
 * associates with this scheme" — and the page being previewed is a project's own content. `http`,
 * `https` and `mailto` are what the three callers actually produce.
 *
 * Spawned with an argument vector and no shell, so the URL is never parsed as a command line.
 */
function handToOsOpener(url: string): boolean {
  let scheme: string;
  try {
    ({ protocol: scheme } = new URL(url));
  } catch {
    return false;
  }
  if (scheme !== "http:" && scheme !== "https:" && scheme !== "mailto:") {
    return false;
  }
  const [command, args] =
    process.platform === "darwin"
      ? (["open", [url]] as const)
      : process.platform === "win32"
        ? // No shell: `start` is a cmd builtin and would need one, which is where URL text becomes
          // A command line. This entry point takes the URL as a single argument.
          (["rundll32", ["url.dll,FileProtocolHandler", url]] as const)
        : (["xdg-open", [url]] as const);
  try {
    const child = spawn(command, [...args], { detached: true, stdio: "ignore" });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
