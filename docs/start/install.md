---
title: "Install Jx Studio"
description: "Download the Jx Studio desktop app for macOS, Windows, or Linux: the only way to run the visual editor."
---

# Install Jx Studio

Jx Studio is a desktop application. There is no hosted, sign-in version; you run it on your own machine, against your own files.

## Download the app

Grab an installer for your platform from the [latest release](https://github.com/jxsuite/jx/releases/latest):

| Platform              | Download                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------- |
| macOS (Apple Silicon) | [`JxStudio.dmg`](https://github.com/jxsuite/jx/releases/latest/download/macos-arm64-JxStudio.dmg)             |
| Windows (x64)         | [`JxStudio.msi`](https://github.com/jxsuite/jx/releases/latest/download/JxStudio.msi)                         |
| Linux (x64)           | [`JxStudio.tar.gz`](https://github.com/jxsuite/jx/releases/latest/download/linux-x64-JxStudio-Setup.tar.gz)   |
| Linux (ARM64)         | [`JxStudio.tar.gz`](https://github.com/jxsuite/jx/releases/latest/download/linux-arm64-JxStudio-Setup.tar.gz) |

The macOS build is notarized, so it opens without a Gatekeeper prompt. The Windows installer is not yet code-signed, so SmartScreen warns on first run. Choose **More info → Run anyway**. The [Download page](/download) has the same links plus checksums and release notes.

:::doc-note
Jx Studio is Apple Silicon only. Intel Macs can still run the last release built before Jx Studio moved to Electrobun 2, which publishes no macOS x64 build; that older release no longer receives automatic updates.
:::

## NixOS

On NixOS the same desktop app is packaged as a Nix derivation rather than an installer, because its bundler cannot run in a Nix sandbox. It runs Studio in a Chromium app window and presents the identical editor.

```bash
nix run github:jxsuite/jx/release
```

Pin the `release` branch, not `main`: `release` holds only released code, and it advances to a release only after that release has built. `main` is the development trunk, so it will sometimes be ahead of anything that has shipped.

To install it rather than run it once:

```bash
nix profile install github:jxsuite/jx/release
```

Either form takes an optional project directory, as in `nix run github:jxsuite/jx/release -- ~/sites/my-site`, and opens the project picker without one.

### Fetch it instead of building it

Released builds are published to a public [Cachix](https://cachix.org) cache, so the commands above can download Studio rather than compile the monorepo on your machine. The rest of the closure, Chromium and Bun, already comes from `cache.nixos.org`.

The flake names the cache itself, so Nix offers to use it the first time you run one of the commands above. Answer `y`, or pass `--accept-flake-config` to skip the prompt:

```bash
nix run github:jxsuite/jx/release --accept-flake-config
```

:::doc-warning
Nix honours a flake's own substituter settings only for users listed in `trusted-users`, which on a stock NixOS install is `root` alone. If you see `ignoring untrusted substituter`, the prompt was accepted but the cache was not used, and Studio is being built from source.
:::

To make it stick regardless, add the cache to your system configuration:

```nix
nix.settings = {
  extra-substituters = [ "https://jxsuite.cachix.org" ];
  extra-trusted-public-keys = [
    "jxsuite.cachix.org-1:kwYafZ+qeKSsR7F9dxC2zLJjsJtGaBk012QoLhe4zMM="
  ];
};
```

Off NixOS, the same two keys go in `/etc/nix/nix.conf`, or run `cachix use jxsuite` to write them for you.

Once installed, open Studio and either **create a new project**, **open an existing folder**, or **clone a repository**. [Your first project](/docs/start/first-project) walks through it.

## Updating

Studio checks your project's `@jxsuite/*` dependencies against each package's own newest published version and offers to update them when one is behind, and prompts when a newer release of the app itself is available. Studio's own copy of those packages is separate. Your project's ranges govern `jx build` and your project's types rather than the running app, so there is no reason for them to match Studio's version.

## For developers: scaffolding from a terminal

The visual editor only runs as the desktop app above. The Nix commands build and launch that same app, and there is no way to serve Studio itself as a headless web app. If you'd rather generate a project's files from a terminal before opening them in Studio, see [CLI commands](/docs/framework/build/cli) for `bun create @jxsuite` and the `jx` CLI.

## Next

Continue to **[Your first project](/docs/start/first-project)**.
