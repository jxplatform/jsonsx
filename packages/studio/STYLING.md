# Studio styling conventions

The studio UI is themed with [Spectrum](https://spectrum.adobe.com/) design tokens via Spectrum Web Components. All chrome styling should be driven from Spectrum tokens (or the thin studio semantic layer built on top of them), not from hard-coded values, so the interface stays consistent and can be re-themed.

## Token layers

There are three layers. Reach for the **most semantic** one that fits.

1.  **Spectrum tokens — `--spectrum-*`** Provided by `@spectrum-web-components/theme`. These are the source of truth for colour, spacing, radius, typography, etc. Examples: `--spectrum-accent-color-700`, `--spectrum-gray-300`, `--spectrum-spacing-100`, `--spectrum-corner-radius-100`, `--spectrum-font-size-75`, `--spectrum-sans-font-family-stack`.

    The stock dark theme is re-valued by the **Jx brand fragment** (`src/ui/jx-theme.ts`), registered as the Spectrum `'app'` theme fragment in `src/ui/spectrum.ts`. It overrides only the gray and blue palette `-rgb` triplets (plus the font stacks) with the canonical brand palette from `sites/jxsuite.com/project.json`, so every derived Spectrum token — accent, focus ring, background layers, alpha tints — follows the brand automatically. Change brand colours there, not in chrome CSS. Under this ramp `--spectrum-accent-color-700` is the exact brand blue (#3b82f6) and `-900` is the soft on-dark tint (#93c5fd).

2.  **Studio semantic layer — `--bg`, `--accent`, `--radius`, …** A small set of studio aliases declared **on the `sp-theme` element** in `index.html`. Each maps to a Spectrum token with a hex fallback:

    ```css
    --accent: var(--spectrum-accent-color-700, #3b82f6);
    ```

    Use these for everyday chrome (`var(--bg)`, `var(--fg)`, `var(--accent)`, `var(--border)`, `var(--danger)`, `var(--radius)`, `var(--font-mono)`, …).

3.  **Spectrum component tokens — `--mod-*` / `--spectrum-<component>-*`** Per-component overrides for SWC components (e.g. `--mod-actionbutton-height`). Use only to tune SWC components.

### Why the semantic layer lives on `sp-theme`, not `:root`

`<sp-theme>` exposes the `--spectrum-*` tokens to **itself and its descendants** (via its `:host` rules). `:root` (the `<html>` element) is an **ancestor** of `<sp-theme>`, so a `var(--spectrum-…)` evaluated at `:root` is undefined and silently falls back to the hex literal — the app would never respond to the Spectrum theme. The studio app (`#app`) and the overlay layers (`#layer-popover` / `-modal` / `-dialog`) all live inside `<sp-theme>`, so the semantic layer is declared there. **Do not move it to `:root`.**

## Where styles live

- `index.html` `<style>` block — the app chrome CSS and the token layer. Edit here. (`dist/studio.css` is build output; never edit it.)
- Inline `style=` / `styleMap` in `src/**.ts` — component-local styling.

## Rules

### Colour — required

Never write a raw hex/`rgb()` colour for chrome. Use a token, with an optional hex fallback:

```css
/* ✅ */
color: var(--fg);
/* ✅ */
background: var(--spectrum-gray-300, #3c3c3c);
/* ❌ */
color: #cccccc;
```

Translucent tints derive from a token with `color-mix`:

```css
/* ✅ */
background: color-mix(in srgb, var(--success) 15%, transparent);
```

### Typography

- Sans chrome inherits `--spectrum-sans-font-family-stack` from `sp-theme` (rebranded to the system-ui stack by the Jx brand fragment).
- Monospace uses `var(--font-mono)`: JetBrains Mono (the Jx brand mono, vendored as woff2 in `fonts/` with `@font-face` in `index.html`), then SF Mono / Fira Code, ahead of the Spectrum code stack. The Monaco editor keeps literal font strings — those are JS API values, not CSS — and `src/services/monaco-setup.ts` remeasures fonts once webfonts finish loading.
- `font-size`: use `--spectrum-font-size-50` (11px), `-75` (12px), `-100` (14px). Off-grid sizes (10px, 13px) have no Spectrum step; keep them as literals.

### Corner radius

Use `var(--radius)` (= `--spectrum-corner-radius-100`, 4px), or `--spectrum-corner-radius-75` (2px) / `-200` (8px).

### Spacing, structure, elevation — pragmatic

Spectrum's spacing scale is coarse, so structural px are acceptable and **not** policed:

- Prefer `--spectrum-spacing-*` for new padding/gap/margin where a step fits (75=4, 100=8, 200=12, 300=16, 400=24, 500=32, 700=48px).
- Off-grid spacing (6px, 10px), grid track sizes, fixed widths/heights, 1–2px borders, and `z-index` may stay as literals.
- Drop shadows and modal scrims use `rgba(0 0 0 / …)` — neutral and theme-agnostic; a full Spectrum elevation pass is a separate effort.

### Intentional exceptions

- macOS traffic-light window controls (`#ff5f57` / `#febc2e` / `#28c840`) are brand colours — allow-listed.
- Colour _values_ the user edits (the colour picker, the CSS-var editor) are data, not chrome.

### The light canvas

Document/preview surfaces (`.canvas-panel-viewport`, stylebook, element previews) always render light, even though the chrome is dark. The `--canvas-*` palette is derived from the theme-independent `--spectrum-white` / `--spectrum-black` tokens via `color-mix`, so it stays light and Spectrum-sourced without a nested theme. Those surfaces also set `color-scheme: light`.

## Guard

`scripts/check-styles.ts` (run via `bun run lint:styles`, and as part of `bun test`) **fails** on hard-coded hex colours and **warns** on `font-size` / `border-radius` px that have an exact Spectrum token. Add genuinely intentional colours to `ALLOWED_HEX` in that script, with a comment.

It also **fails** on a modal card opened beside an `<sp-underlay>` that no rule stacks. The scrim paints at `z-index: 1`, so a card left at `auto` sits _under_ its own overlay: visible through it, and unclickable — which is how the blocking progress modal shipped with its only exit button unpressable. Give the card a `z-index` (the underlay-bearing cards use `1000`).
