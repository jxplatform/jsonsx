---
title: "The desktop app"
description: "Jx Studio as a native app — open projects with native dialogs, one window per project, automatic background updates, and no dev server to run."
spec:
  - desktop.md#1
  - desktop.md#4
code:
  - packages/desktop/src/index.ts
  - packages/desktop/src/menu.ts
  - packages/desktop/src/updater.ts
  - packages/desktop/src/platform.ts
---

# The desktop app

The desktop app is Jx Studio as a native application: the same Studio documented everywhere else in this section, wrapped in its own window with everything it needs bundled inside. You install it, open it, and build — no terminal, no dev server, no browser tab. It edits the plain files in your project folders directly.

![The Studio workspace — the same interface in the desktop app and the browser](/screenshots/hero.png)

## Install and update

Download the installer for macOS, Windows, or Linux from the **[install page](/docs/start/install)** — it covers each platform's package and what to expect on first launch.

Once installed, updates take care of themselves. The app checks for a new release shortly after launch and every few hours after that, downloads it in the background, and then shows a small notice — **Version x.y.z is ready** — with a **Restart to update** button. Update whenever suits you; nothing is applied until you restart.

To see where you stand, click the info button at the bottom of the activity bar. The About dialog shows the app version, its release channel, and the current update status.

## Open a project

A fresh window greets you with the **[welcome screen](/docs/studio/interface/welcome-screen)**: create a **[new project](/docs/studio/projects/create)**, open an existing one, or pick from your recent projects — the recent list is shared across all windows.

To open an existing project:

1. Choose _File > Open Project…_ or press :kbd[⌘O] (macOS) / :kbd[Ctrl+O] (Windows/Linux) — or click **Open Project...** on the welcome screen.
2. A native file dialog opens. Select the project's `project.json` file — the file that marks a folder as a Jx project.
3. The project opens in its own window, with the folder around `project.json` as the project root.

You can also open a project straight from your file manager: if your system associates it with Jx Studio, double-clicking a `project.json` opens that project.

:::doc-note
`project.json` is the project's settings file — Studio creates it for every new project. What's inside is described in **[Project settings](/docs/studio/projects/settings)**.
:::

## One window per project

Each window holds one project. Opening a second project opens a second window rather than replacing what you have, and the window's title tells you which is which. Opening a project that's already open doesn't duplicate it — the existing window comes to the front.

_File > New Window_ (:kbd[⇧⌘N] / :kbd[Ctrl+Shift+N]) opens a fresh welcome window when you want to start something else.

## How it differs from Studio in the browser

Studio itself is identical in both — every page in this documentation applies to each. The differences are around the edges:

- **Nothing to run.** In the browser, Studio is served by a local dev server you start from a terminal (see **[The dev server](/docs/framework/build/dev-server)**). The desktop app carries its own backend — launch it like any other application.
- **Native dialogs.** Opening projects and picking folders use your operating system's file dialogs instead of the browser's folder picker.
- **Windows, menus, and file associations.** One window per project, a real _File_ menu, and `project.json` opening from the file manager.
- **Built-in updates.** The app updates itself in the background; a dev-server setup updates with your package manager.

The AI assistant, publishing, and everything on the canvas behave the same in both.

## Platform notes

Installers are provided for macOS (Apple Silicon and Intel), Windows (x64), and Linux (x64) — see the **[install page](/docs/start/install)** for downloads. On NixOS the app is packaged differently (built with `nix build`, running Studio in a Chromium app window), but presents the same Studio.

## Next

- Get it installed: **[Install Jx Studio](/docs/start/install)**
- Build something: **[Your first project](/docs/start/first-project)**
- Find your way around: **[Studio tour](/docs/start/studio-tour)**
