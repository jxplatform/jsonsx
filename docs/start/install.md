---
title: "Install Jx Studio"
description: "Download the Jx Studio desktop app for macOS, Windows, or Linux — the only way to run the visual editor."
---

# Get Studio

Jx Studio is a desktop application. There is no hosted, sign-in version — you run it on your own machine, against your own files.

## Download the app

Grab an installer for your platform from the [latest release](https://github.com/jxsuite/jx/releases/latest):

| Platform              | Download                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| macOS (Apple Silicon) | [`JxStudio.dmg`](https://github.com/jxsuite/jx/releases/latest/download/production-macos-arm64-JxStudio.dmg)             |
| Windows (x64)         | [`JxStudio.msi`](https://github.com/jxsuite/jx/releases/latest/download/JxStudio.msi)                                    |
| Linux (x64)           | [`JxStudio.tar.gz`](https://github.com/jxsuite/jx/releases/latest/download/production-linux-x64-JxStudio-Setup.tar.gz)   |
| Linux (ARM64)         | [`JxStudio.tar.gz`](https://github.com/jxsuite/jx/releases/latest/download/production-linux-arm64-JxStudio-Setup.tar.gz) |

The macOS build is notarized, so it opens without a Gatekeeper prompt. The Windows installer is not yet code-signed — SmartScreen will warn on first run; choose **More info → Run anyway**. The [Download page](/download) has the same links plus checksums and release notes.

:::doc-note
Jx Studio is Apple Silicon only. Intel Macs can still run the last release built before Jx Studio moved to Electrobun 2, which publishes no macOS x64 build; that older release no longer receives automatic updates.
:::

Once installed, open Studio and either **create a new project**, **open an existing folder**, or **clone a repository** — see [Your first project](/docs/start/first-project).

## Updating

Studio checks your project's `@jxsuite/*` dependencies against the version it ships with and offers to update them when they drift, and prompts when a newer release of the app itself is available.

## For developers: scaffolding from a terminal

The visual editor only runs as the desktop app above — there's no way to install or serve Studio itself from a command line. If you'd rather generate a project's files from a terminal before opening them in Studio, see [CLI commands](/docs/framework/build/cli) for `bun create @jxsuite` and the `jx` CLI.

## Next

Ready to build something? Continue to **[Your first project](/docs/start/first-project)**.
