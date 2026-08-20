/**
 * Application menu — process-shared. Provides the multi-window entry points: File → New Window
 * (Cmd/Ctrl+Shift+N) → opens a welcome window File → Open Project… (Cmd/Ctrl+O) → picks a
 * project.json, opens/focuses its window
 */

import { ApplicationMenu } from "electrobun/main";
import type { ApplicationMenuItemConfig } from "electrobun/main";
import { dirname } from "node:path";
import { openFileDialog } from "./utils";
import { openProjectWindow } from "./window-manager";

export function installApplicationMenu() {
  const menu: ApplicationMenuItemConfig[] = [
    {
      label: "File",
      submenu: [
        { accelerator: "CmdOrCtrl+Shift+N", action: "new-window", label: "New Window" },
        { accelerator: "CmdOrCtrl+O", action: "open-project", label: "Open Project…" },
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
