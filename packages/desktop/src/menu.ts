/**
 * Application menu — process-shared. Provides the multi-window entry points: File → New Window →
 * opens a welcome window; File → Open Project… → picks a project.json, opens/focuses its window.
 *
 * **No accelerators.** Both chords are the command records' `keybinding` — `view.newWindow` and
 * `project.open` — which every launcher's shell dispatches, and a chord with two owners fires
 * twice: two welcome windows from one ⌘⇧N. The menu keeps the items, because a native menu is where
 * a macOS user looks for them; it does not keep a second claim on the keyboard.
 */

import { ApplicationMenu } from "electrobun/bun";
import type { ApplicationMenuItemConfig } from "electrobun/bun";
import { dirname } from "node:path";
import { openFileDialog } from "./utils";
import { openProjectWindow } from "./window-manager";

export function installApplicationMenu() {
  const menu: ApplicationMenuItemConfig[] = [
    {
      label: "File",
      submenu: [
        { action: "new-window", label: "New Window" },
        { action: "open-project", label: "Open Project…" },
        { type: "divider" },
        { label: "Close Window", role: "close" },
      ],
    },
  ];

  ApplicationMenu.setApplicationMenu(menu);

  ApplicationMenu.on("application-menu-clicked", async (event) => {
    const action = (event as { data?: { action?: string } })?.data?.action;
    if (action === "new-window") {
      openProjectWindow(null);
    } else if (action === "open-project") {
      const selected = await openFileDialog();
      if (selected && selected.endsWith("project.json")) {
        openProjectWindow(dirname(selected));
      }
    }
  });
}
