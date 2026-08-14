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

Electrobun 2 builds through **Hutch**, its native build CLI. Hutch is not an npm dependency and
`bun install` cannot supply it — install it once per machine:

```bash
curl -fsSL https://hutch.blackboard.sh/hutch/install.sh | sh
```

On Windows:

```powershell
& ([scriptblock]::Create((irm https://hutch.blackboard.sh/hutch/install.ps1)))
```

Hutch reads the exact Electrobun release from [`hutch.config.ts`](hutch.config.ts), caches that
release's platform archive under `~/.hutch`, and projects its SDK into a generated `.hutch/devkit`
directory — which is where every `electrobun/*` import resolves from, and why there is no
`electrobun` entry in `package.json`. Builds sync it implicitly; `bun run sync` does it on demand,
which is what a fresh clone needs before `bun run typecheck` will pass.

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

The Bun backend registers all RPC handlers at startup. Studio communicates with it through the [Platform Abstraction Layer](../studio/README.md) — the same interface used by `@jxsuite/server` in dev mode and cloud APIs in the future.

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
pinned in `hutch.config.ts` — see [Prerequisites](#prerequisites).

## License

MIT
