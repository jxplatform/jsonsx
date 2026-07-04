---
title: "Get Studio — Jx Suite"
description: "Download the Jx Studio desktop app for macOS, Windows, or Linux, or install the CLI and run Studio locally."
---

# Get Studio

Jx Studio is a desktop application. There is no hosted, sign-in version — you run it on your own machine, against your own files. There are two ways to get it.

## Download the app (recommended)

Grab a signed installer for your platform from the [latest release](https://github.com/jxsuite/jx/releases/latest):

| Platform              | Download                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------ |
| macOS (Apple Silicon) | [`JxStudio.dmg`](https://github.com/jxsuite/jx/releases/latest/download/stable-macos-arm64-JxStudio.dmg)           |
| macOS (Intel)         | [`JxStudio.dmg`](https://github.com/jxsuite/jx/releases/latest/download/stable-macos-x64-JxStudio.dmg)             |
| Windows (x64)         | [`Jx.Studio.msi`](https://github.com/jxsuite/jx/releases/latest/download/Jx.Studio.msi)                            |
| Linux (x64)           | [`JxStudio.tar.gz`](https://github.com/jxsuite/jx/releases/latest/download/stable-linux-x64-JxStudio-Setup.tar.gz) |

The macOS builds are notarized and the Windows installer is signed, so they open without security warnings. The [Download page](/download) has the same links plus checksums and release notes.

Once installed, open Studio and either **create a new project**, **open an existing folder**, or **clone a repository** — see [Your first project](/docs/getting-started).

## Install via the CLI

If you already work in a terminal, scaffold a project and run Studio against it locally:

```bash
bun create @jxsuite my-site
cd my-site
bun run dev
```

`bun run dev` starts the dev server and serves Studio at `http://localhost:3000`. Studio edits the files in your project folder directly; the dev server rebuilds on save. This is the same Studio as the desktop app — it just runs through your browser against the local server instead of as a native window.

> Prefer npm or pnpm? Any package manager works; the examples use [Bun](https://bun.sh) because it's fastest. You'll need Bun installed for the dev server itself.

## Updating

Studio checks your project's `@jxsuite/*` dependencies against the version it ships with and offers to update them when they drift. Desktop builds prompt when a newer release is available; CLI projects update with your package manager.

## Next

Ready to build something? Continue to **[Your first project](/docs/getting-started)**.
