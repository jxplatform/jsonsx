/**
 * The identity this launcher's window presents to the desktop.
 *
 * A taskbar or dock does not read the process, the title or the `--class` flag: it takes the
 * window's Wayland `app_id` (X11: `WM_CLASS`) and looks for a desktop entry that claims it. So the
 * entry and the window have to agree on one string, and **Chromium chooses that string, not us**.
 *
 * For `--app=<url>` windows it derives the name from the URL and the profile directory and IGNORES
 * `--class` — measured on Chrome 151 and on the packaged build, over four launches spanning two
 * ports and two `--user-data-dir` values, all four producing the identical id. Chromium has no
 * switch to override it either; `--wm-class-name` / `--wm-class-class` are Electron's, and are
 * absent from the Chromium binary.
 *
 * That leaves one lever: `jx-studio.desktop` declares the derived string in `StartupWMClass`. Which
 * makes the desktop entry depend on the shell URL — so {@link JX_STUDIO_APP_ID} is computed here
 * from the same constant the launcher builds that URL with, and a test asserts the entry carries
 * exactly it. Move the shell path or the bind address and the test names both sides, instead of the
 * icon quietly reverting to a generic square.
 */

/**
 * Where the launcher serves the studio shell, and therefore the path Chromium bakes into the id.
 *
 * `chromium/index.ts` composes `--app=` from this; nothing else may spell it.
 */
export const STUDIO_SHELL_PATH = "/__studio__/index.html";

/**
 * Loopback address `createProjectServer` binds by default — the host half of the derived id.
 *
 * The port is NOT part of it (the id is identical across ports, which is what makes an ephemeral
 * port survivable here), and neither is the query string.
 */
export const STUDIO_SHELL_HOST = "127.0.0.1";

/**
 * Chromium's `app_id` for an `--app=<url>` window.
 *
 * Reproduces `GenerateApplicationNameFromURL` (`host + "_" + path`) followed by
 * `GetWMClassFromAppName` (anything outside `[A-Za-z0-9_.-]` becomes `_`), then the `chrome-` /
 * `-<profile>` bracketing. Dots and dashes survive; slashes do not.
 *
 * @param shellUrl The URL passed to `--app=`. Scheme, port and query are not part of the id.
 * @param profileDirectory The profile INSIDE `--user-data-dir`, which is `Default` unless
 *   `--profile-directory` says otherwise — so a per-window user-data-dir does not change it.
 */
export function chromiumAppId(shellUrl: string, profileDirectory = "Default"): string {
  const { hostname, pathname } = new URL(shellUrl);
  const appName = `${hostname}_${pathname}`.replaceAll(/[^\w.-]/g, "_");
  return `chrome-${appName}-${profileDirectory}`;
}

/** The id every window of this launcher reports, and the one `jx-studio.desktop` must claim. */
export const JX_STUDIO_APP_ID = chromiumAppId(`http://${STUDIO_SHELL_HOST}${STUDIO_SHELL_PATH}`);
