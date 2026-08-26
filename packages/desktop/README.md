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
against the release's published digest, and caches it under `~/.hutch` — so the Hutch, Cottontail
and Electrobun versions all ride the workspace lockfile instead of a machine-wide install.

The Electrobun SDK is not on npm either — the `electrobun` package resolves every specifier, types
included, to a module that throws. A **build** reads the SDK out of `.hutch/devkit`, a gitignored
directory Hutch projects out of the release archive; builds project it implicitly, and
`bun run sync` does it on demand.

**Typechecking reads it from somewhere a clone actually has.** `vendor/electrobun` is a git
submodule pinned to the exact release the `electrobun` devDependency names, and this package's
`tsconfig.json` maps `electrobun/*` straight into its sources. The root `bun install` checks it out;
after a clone without submodules, `bun run electrobun:sync` at the repo root does the same. Then
`bun run typecheck` passes offline, with no Hutch involved.

Both sysroots are the same release rather than two sources of truth, and `bun run electrobun:verify`
is what keeps them that way. **Bumping Electrobun therefore takes two moves**: Dependabot bumps the
version pin in `package.json`, the submodule does not follow, and the gate goes red until
`bun run electrobun:sync` moves it to the matching tag — commit the moved gitlink alongside the pin.

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

Electrobun is deliberately absent from that table: the `electrobun` entry under `devDependencies` is
a command bootstrap, not the SDK. The SDK comes from `.hutch/devkit` for builds and from the
`vendor/electrobun` submodule for typechecking — see [Prerequisites](#prerequisites).

## License

MIT
