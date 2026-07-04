# Studio screenshot runner

Declarative, repeatable screenshots of Jx Studio for jxsuite.com, READMEs, and docs. Shots are
defined in [manifest.json](./manifest.json); the runner boots (or reuses) the repo dev server,
drives Studio in headless Chromium via the gated `window.__jxAutomation` hook
([packages/studio/src/services/automation.ts](../../packages/studio/src/services/automation.ts)),
and writes PNGs to `sites/jxsuite.com/public/screenshots/` — where the site's Sharp/srcset image
pipeline and the root README consume them.

## Usage

```bash
bun run screenshots                 # regenerate every shot
bun run screenshots --only hero     # one shot (comma-separate for several)
bun run screenshots --headed        # visible browser + 15s linger, for tuning
bun run screenshots --manifest x.json
CHROMIUM_BIN=/path/to/chromium bun run screenshots   # explicit browser binary
```

Requires a system Chromium/Chrome (`CHROMIUM_BIN`, else `chromium`/`google-chrome`/… on PATH).
No browser is downloaded — this is what makes the runner work on NixOS and plain CI alike.
Screenshots are **committed to git**; regenerate them wholesale from one machine when Studio's UI
changes, and don't pixel-diff across machines (font rasterization differs per environment).

## Shot schema

Each shot opens `?project=<abs>/project.json&file=<rel>&automation=1` (Studio's own deep-link
support), waits for the canvas iframe to ack `renderComplete`, then applies actions:

```jsonc
{
  "name": "hero", // output file name (hero.png)
  "project": "sites/jxsuite.com", // repo-relative project dir (default from `defaults`)
  "file": "pages/index.md", // file to open in a tab
  "canvasMode": "design", // design | edit | preview | stylebook
  "viewport": { "width": 1920, "height": 1200 },
  "deviceScaleFactor": 2, // 2 → 3840×2400 PNG
  "theme": "dark", // flips <sp-theme color>
  "actions": [
    { "do": "setActivity", "value": "layers" }, // files|layers|imports|blocks|state|data|head|git
    { "do": "select", "path": ["children", 0] }, // select a node by JxPath
    { "do": "setRightTab", "value": "style" }, // properties|events|style
    { "do": "editDef", "defName": "addItem" }, // open Monaco on a state function
    { "do": "setZoom", "value": 0.9 },
    { "do": "setStatus", "value": "Ready" }, // normalize the status bar text
  ],
  "waitFor": [
    // runs AFTER actions (baseline readiness is built in)
    { "type": "canvasReady" },
    { "type": "selector", "selector": ".monaco-editor .view-lines" },
    { "type": "fonts" },
    { "type": "settle", "frames": 2 },
  ],
  "clip": { "selector": "#app" }, // or "fullPage" or {x,y,width,height}
  "variants": [{ "suffix": ".light", "theme": "light" }],
}
```

Determinism measures: animations/transitions/carets frozen via injected CSS in every frame,
`prefers-reduced-motion` emulated, `document.fonts.ready` awaited in parent + canvas frames,
`--force-color-profile=srgb --font-render-hinting=none`.

## Authoring tips

- Markdown pages show inline-edit placeholders in **design** mode — use `preview` for clean
  content shots, or a `.json` page for design-mode shots with selections.
- The design canvas lays breakpoint panels side by side; `setZoom` controls how much fits.
- `--headed` keeps each page open 15s so you can inspect what the shot definition produced.
