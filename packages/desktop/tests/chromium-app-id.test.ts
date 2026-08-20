/**
 * The window identity, and the desktop entry that has to claim it.
 *
 * A taskbar shows an app's icon by matching the window's `app_id` to a desktop entry. Chromium
 * derives that id from the `--app` URL and ignores `--class`, so the entry names the derived string
 * in `StartupWMClass` — which makes a file in `packages/desktop/` depend on a URL composed in
 * `chromium/index.ts`. Nothing about that dependency is visible at either end, and its failure mode
 * is silent: the icon reverts to a generic square and every other thing about the app still works.
 *
 * So it is asserted from both ends here.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  chromiumAppId,
  JX_STUDIO_APP_ID,
  STUDIO_SHELL_HOST,
  STUDIO_SHELL_PATH,
} from "../src/chromium/app-id";

const DESKTOP_ENTRY = join(import.meta.dir, "../jx-studio.desktop");

function entryField(name: string): string | undefined {
  for (const line of readFileSync(DESKTOP_ENTRY, "utf8").split("\n")) {
    if (line.startsWith(`${name}=`)) {
      return line.slice(name.length + 1);
    }
  }
  return undefined;
}

describe("chromiumAppId", () => {
  /*
   * The expected value is not a guess. It was read off a live window — `niri msg windows` against
   * both a stock Chrome and the packaged build — and is what the compositor reports today.
   */
  test("reproduces the id a real window reports", () => {
    expect(JX_STUDIO_APP_ID).toBe("chrome-127.0.0.1____studio___index.html-Default");
  });

  test("the port and the query are not part of it — which is what makes an ephemeral port safe", () => {
    const withPort = chromiumAppId("http://127.0.0.1:41234/__studio__/index.html?token=secret");
    const withOther = chromiumAppId("http://127.0.0.1:9/__studio__/index.html");
    expect(withPort).toBe(JX_STUDIO_APP_ID);
    expect(withOther).toBe(JX_STUDIO_APP_ID);
  });

  /* Host and path are joined with an underscore AND the path keeps its leading slash, which is why
     a one-segment path already yields two — the doubling is the rule, not a typo. */
  test("slashes become underscores; dots and dashes survive", () => {
    expect(chromiumAppId("http://example.com/a/b-c.d")).toBe("chrome-example.com__a_b-c.d-Default");
  });

  test("a non-default profile directory changes the suffix", () => {
    expect(chromiumAppId("http://127.0.0.1/x", "Profile 2")).toBe("chrome-127.0.0.1__x-Profile 2");
  });
});

describe("jx-studio.desktop", () => {
  test("claims the id its own windows actually report", () => {
    expect(entryField("StartupWMClass")).toBe(JX_STUDIO_APP_ID);
  });

  /*
   * The icon resolves through the name in `Icon=`, and the two files package.nix installs into
   * hicolor are named for it. A rename on one side alone is a generic square.
   */
  test("names an icon the package installs", () => {
    expect(entryField("Icon")).toBe("jx-studio");
    const nix = readFileSync(join(import.meta.dir, "../package.nix"), "utf8");
    expect(nix).toContain("apps/jx-studio.png");
    expect(nix).toContain("apps/jx-studio.svg");
  });

  /*
   * Installed by hand, at a fixed name. `desktopItems` took the store path's basename, so the entry
   * shipped as `<hash>-jx-studio.desktop` — an id that changed every rebuild.
   */
  test("is installed under a stable id, not a store-path basename", () => {
    const nix = readFileSync(join(import.meta.dir, "../package.nix"), "utf8");
    expect(nix).toContain("$out/share/applications/jx-studio.desktop");
    // The hook itself, not the sentence explaining why it is gone.
    expect(nix).not.toMatch(/^\s*desktopItems\s*=/m);
    expect(nix).not.toMatch(/^\s*copyDesktopItems,?\s*$/m);
  });
});

describe("the launcher's shell URL", () => {
  test("is what the id is derived from", () => {
    // Both halves of the URL Chromium sees, and neither may drift from app-id.ts unnoticed.
    const launcher = readFileSync(join(import.meta.dir, "../src/chromium/index.ts"), "utf8");
    expect(launcher).toContain("`--app=${serverUrl}${STUDIO_SHELL_PATH}?token=${rpcToken}`");
    expect(STUDIO_SHELL_PATH).toBe("/__studio__/index.html");
    // The bind address `createProjectServer` defaults to — the host half of the derived id.
    expect(STUDIO_SHELL_HOST).toBe("127.0.0.1");
  });
});
