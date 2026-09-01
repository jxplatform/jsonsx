---
name: verify
description: Drive Jx Studio in a real browser to verify a studio change end-to-end (dev server + Chrome DevTools MCP recipe).
---

# Verifying studio changes in a real browser

1. Dev server: `bun run dev` at the repo root serves on port 3000 (often already running; its watcher rebuilds the parent studio bundle on save). Check with `curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/packages/studio/index.html`. Canvas-side changes (`src/canvas/*`) additionally need `bun run build` in packages/studio — the iframe bundle is prebuilt and NOT watched.
2. Open `http://localhost:3000/packages/studio/index.html` via the Chrome DevTools MCP (`mcp__chrome-devtools-nixos__*`), then seed and enter a project:
   - `localStorage.setItem("jx-studio-recent-projects", JSON.stringify([{ name: "examples", root: "examples", timestamp: <ms> }]))`, reload.
   - Click the "Recent projects" toolbar button → the "examples" menu item.
3. The left file tree is plain DOM (`.file-tree-item` with `.file-tree-name`), but it is NOT exposed in the a11y snapshot — find/click nodes via `evaluate_script`. Quick Open (⌘P button) types-then-Enter is flaky under MCP; prefer the tree.
4. The editor tab strip is `.tab-strip` (child of `#tab-strip`), tabs are `.tab-strip-tab` with `.tab-strip-label`. It is the `overflow-x: auto` scroll container; read/write `scrollLeft` directly.
5. Synthetic events via `evaluate_script` (`new WheelEvent(...)`, `el.click()`) exercise the real lit handlers — the app does not check `isTrusted`. Note an app-level ancestor handler calls `preventDefault()` on ctrl+wheel (zoom), so test per-element handlers with `bubbles: false` when isolating.
6. Default MCP viewport is 780px wide; `resize_page` to ~1400px for readable screenshots and to keep CDP clicks from missing off-viewport targets.
