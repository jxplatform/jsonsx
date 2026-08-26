# `@jxsuite/desktop`

> Jx Studio as a standalone desktop application, built with [Electrobun](https://electrobun.dev).

## Overview

`@jxsuite/desktop` wraps `@jxsuite/studio` in a native desktop window. It exposes the Studio UI via Electrobun's webview and connects it to a Bun-process backend that handles filesystem I/O, Git, and package management through a typed RPC layer.

## Platform targets

| Target                            | Runtime                              | Status                      |
| --------------------------------- | ------------------------------------ | --------------------------- |
| macOS, Windows, Linux (non-NixOS) | Electrobun (Bun + native webview)    | Active                      |
| NixOS                             | Chromium `--app` + `@jxsuite/server` | Via `nix build`             |
| Dev mode                          | Chrome + `@jxsuite/server`           | Active (Studio development) |

## Prerequisites

Just `bun install` at the repo root. Electrobun 2 builds through **Hutch**, its native build CLI,
but nothing needs installing by hand: the `electrobun` devDependency is a dependency-free bootstrap
whose version selects the whole toolchain. Its first command downloads the paired Hutch, verifies it
against the release's published digest, and caches it under `~/.hutch`, so the Hutch, Cottontail
and Electrobun versions all ride the workspace lockfile instead of a machine-wide install.

The Electrobun SDK is not on npm either. It is projected out of the release archive into a
generated, gitignored `.hutch/devkit` directory, which is where every `electrobun/*` import
resolves from, and why there is no `electrobun` entry under `dependencies`. Builds project it
implicitly; a fresh clone needs `bun run sync` once before `bun run typecheck` will pass.

## Development

```bash
bun run dev          # Launch Electrobun dev window
bun run chromium     # Launch in Chrome app-mode (NixOS / dev mode)
```

## Building

```bash
bun run build           # Debug build
bun run build:release   # Canary release build
bun run build:stable    # Production release build (+ Windows MSI)
```

## Architecture

```
Electrobun webview  ←→  BrowserView RPC  ←→  Bun process (src/index.ts)
   (@jxsuite/studio)                          (filesystem, Git, packages)
```

The Bun backend registers all RPC handlers at startup. Studio communicates with it through the [Platform Abstraction Layer](../studio/README.md). That is the same interface `@jxsuite/server` uses in dev mode, and the one cloud APIs will use in the future.

### RPC categories

| Category   | Handlers                                                                             |
| ---------- | ------------------------------------------------------------------------------------ |
| Filesystem | `readFile`, `writeFile`, `deleteFile`, `renameFile`, `createDirectory`, `uploadFile` |
| Project    | `openProject`, `listDirectory`, `discoverComponents`, `resolveSiteContext`           |
| Git        | `status`, `branches`, `log`, `stage`, `commit`, `push`, `pull`, `diff`, `discard`    |
| Packages   | `addPackage`, `removePackage`, `listPackages`                                        |
| Code       | `codeService`, `locateFile`, `fetchPluginSchema`                                     |

## Dependencies

| Package           | Purpose                   |
| ----------------- | ------------------------- |
| `@jxsuite/studio` | Studio UI                 |
| `dbus-ts`         | D-Bus integration (Linux) |

Electrobun itself is deliberately absent: it is not an npm package here but a Hutch-managed product
pinned in `hutch.config.ts`. See [Prerequisites](#prerequisites).

## License

MIT
