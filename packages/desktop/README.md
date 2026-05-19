# `@jxsuite/desktop`

> Jx Studio as a standalone desktop application, built with [Electrobun](https://electrobun.dev).

## Overview

`@jxsuite/desktop` wraps `@jxsuite/studio` in a native desktop window. It exposes the Studio UI via Electrobun's webview and connects it to a Bun-process backend that handles filesystem I/O, Git, and package management through a typed RPC layer.

## Platform targets

| Target | Runtime | Status |
|--------|---------|--------|
| macOS, Windows, Linux (non-NixOS) | Electrobun (Bun + native webview) | Active |
| NixOS | Chromium `--app` + `@jxsuite/server` | Via `nix build` |
| Dev mode | Chrome + `@jxsuite/server` | Active (Studio development) |

## Development

```bash
bun run dev          # Launch Electrobun dev window
bun run chromium     # Launch in Chrome app-mode (NixOS / dev mode)
```

## Building

```bash
bun run build           # Debug build
bun run build:release   # Canary release build
bun run build:stable    # Stable release build
```

## Architecture

```
Electrobun webview  ←→  BrowserView RPC  ←→  Bun process (src/index.ts)
   (@jxsuite/studio)                          (filesystem, Git, packages)
```

The Bun backend registers all RPC handlers at startup. Studio communicates with it through the [Platform Abstraction Layer](../studio/README.md) — the same interface used by `@jxsuite/server` in dev mode and cloud APIs in the future.

### RPC categories

| Category | Handlers |
|----------|----------|
| Filesystem | `readFile`, `writeFile`, `deleteFile`, `renameFile`, `createDirectory`, `uploadFile` |
| Project | `openProject`, `listDirectory`, `discoverComponents`, `resolveSiteContext` |
| Git | `status`, `branches`, `log`, `stage`, `commit`, `push`, `pull`, `diff`, `discard` |
| Packages | `addPackage`, `removePackage`, `listPackages` |
| Code | `codeService`, `locateFile`, `fetchPluginSchema` |

## Dependencies

| Package | Purpose |
|---------|---------|
| `electrobun` | Native webview + Bun process host |
| `@jxsuite/studio` | Studio UI |
| `dbus-ts` | D-Bus integration (Linux) |

## License

MIT
