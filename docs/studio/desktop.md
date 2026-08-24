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
  - packages/desktop/src/window-manager.ts
---

# The desktop app

The desktop app is Jx Studio as a native application: the same Studio documented everywhere else in this section, wrapped in its own window with everything it needs bundled inside. You install it, open it, and build — no terminal, no dev server, no browser tab. It edits the plain files in your project folders directly.

![The Studio workspace — the same interface in the desktop app and the browser](../images/hero.png)

## Install and update

Download the installer for macOS, Windows, or Linux from the **[install page](/docs/start/install)** — it covers each platform's package and what to expect on first launch.

Once installed, updates take care of themselves. The app checks for a new release shortly after launch and every few hours after that, downloads it in the background, and then shows a small notice — **Version x.y.z is ready** — with a **Restart to update** button. Update whenever suits you; nothing is applied until you restart.

To see where you stand, click **About** at the foot of the Navigator rail. The dialog shows the app version, its release channel, and the current update status.

## Open a project

A fresh window greets you with the **[welcome screen](/docs/studio/interface/welcome-screen)**: create a **[new project](/docs/studio/projects/create)**, open an existing one, or pick from your recent projects — the recent list is shared across all windows.

To open an existing project:

1. Choose _File > Open Project…_ or press :kbd[⌘O] (macOS) / :kbd[Ctrl+O] (Windows/Linux) — or click **Open Project...** on the welcome screen.
2. If a project is already open, Studio asks where the next one should go: **This Window** or **New Window**.
3. A native file dialog opens. Select the project's `project.json` file — the file that marks a folder as a Jx project.
4. The project opens with the folder around `project.json` as the project root.

You can also open a project straight from your file manager: if your system associates it with Jx Studio, double-clicking a `project.json` opens that project.

:::doc-note
`project.json` is the project's settings file — Studio creates it for every new project. What's inside is described in **[Project settings](/docs/studio/projects/settings)**.
:::

## One window per project

Each window holds one project, and the window's title tells you which. When you open another project from a window that already has one, Studio asks where it should go:

- **New Window** leaves this window untouched — its project, its tabs, its unsaved work — and the project you pick opens beside it.
- **This Window** replaces the project here. Anything unsaved is confirmed first.

Opening a project that's already open never duplicates it: whichever you chose, the window that has it comes to the front instead.

_File > Open Project…_ from the app menu always opens into a window of its own, and **New Window** (:kbd[⇧⌘N] / :kbd[Ctrl+Shift+N]) opens a fresh welcome window when you want to start something else — from the _File_ menu, or by name from the **[command list](/docs/studio/interface/commands)**.

## How it differs from Studio in the browser

Studio itself is identical in both — every page in this documentation applies to each. The differences are around the edges:

- **Nothing to run.** In the browser, Studio is served by a local dev server you start from a terminal (see **[The dev server](/docs/framework/build/dev-server)**). The desktop app carries its own backend — launch it like any other application.
- **Native dialogs.** Opening projects and picking folders use your operating system's file dialogs instead of the browser's folder picker.
- **Windows, menus, and file associations.** One window per project, a real _File_ menu, and `project.json` opening from the file manager.
- **Built-in updates.** The app updates itself in the background; a dev-server setup — and the NixOS build below — updates with your package manager.

The AI assistant, publishing, and everything on the canvas behave the same in both.

## Platform notes

Installers are provided for macOS (Apple Silicon), Windows (x64), and Linux (x64 and ARM64) — see the **[install page](/docs/start/install)** for downloads. Intel Macs are no longer among the builds. On NixOS the app is packaged differently: `nix build` produces it, and it runs Studio in a Chromium app window rather than a native one.

Everything on this page applies to it. Projects open the same way, through the same native dialogs; each project gets a window of its own, and opening one that is already open brings that window forward. Two things differ, and both follow from who packaged it:

- **Your package manager updates it**, so there is no in-app updater and _About_ shows no update status.
- **Your desktop draws the window frame**, so the minimize/maximize/close buttons are your system's rather than Studio's.

Windows there come from the _File_ menu's **New Window**, from the **This Window / New Window** question above, or from running `jx-studio <project>` again — and running it for a project that is already open raises that window instead of opening a second one.

## Next

- Get it installed: **[Install Jx Studio](/docs/start/install)**
- Build something: **[Your first project](/docs/start/first-project)**
- Find your way around: **[Studio tour](/docs/start/studio-tour)**
