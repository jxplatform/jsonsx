---
title: "Styling in Studio — Jx Suite"
description: "Master styling in JX Studio: CSS custom properties, design tokens, $media breakpoints, responsive patterns, stylebook, and the token-first approach."
---

# Styling & Design Tokens in Studio

> For the underlying JSON format, see [Styling](/docs/styling).

JX uses a token-first styling system. Define your design tokens once in project.json, reference them everywhere via `var(--token)`, and override per breakpoint with `$media`.

## Design Tokens (CSS Custom Properties)

Design tokens are CSS custom properties defined in your project.json's `style` object. They create a consistent design system across your entire site. Define them once, reference them everywhere.

```json
// project.json
{
  "style": {
    "--color-bg-primary": "#0a0a0a",
    "--color-bg-surface": "#1a1a1a",
    "--color-accent": "#3b82f6",
    "--color-text-primary": "#fafafa",
    "--color-text-secondary": "#a1a1aa",
    "--color-border": "#222222",
    "--font-mono": "'JetBrains Mono', monospace",
    "--radius": "8px",
    "--radius-lg": "12px",
    "--max-width": "1200px"
  }
}

// Any component can reference these:
{
  "style": {
    "backgroundColor": "var(--color-bg-surface)",
    "color": "var(--color-text-primary)",
    "borderRadius": "var(--radius)",
    "fontFamily": "var(--font-mono)"
  }
}
```

- **Token Naming Convention** — Use `--category-role-variant`: `--color-bg-primary`, `--font-mono`, `--radius-lg`. Categories: color, font, radius, spacing, shadow, max-width.
- **Token Inheritance** — Tokens defined in project.json apply globally. Component-level style objects can add new tokens or override global ones for that component only.
- **Stylebook Integration** — Switch to Stylebook mode to see all your tokens visually. Edit values inline. See a component gallery showing every component with the current tokens applied.
- **Hardcoded Value Detection** — The AI assistant warns when you use hardcoded hex colors or px values that have corresponding tokens. The token-lint system helps you stay token-first.

## CSS Properties in JX

- **CamelCase Properties** — All CSS property names use camelCase: `backgroundColor`, `fontSize`, `borderRadius`, `textAlign`. This matches the DOM API convention. Never use kebab-case in style objects.
- **String Values** — CSS values are always strings in JX: `"10px"`, `"center"`, `"block"`, `"1px solid var(--color-border)"`. Never use bare numbers for CSS values.
- **Style Panel Categories** — The Style inspector organizes properties by category: Layout (display, flex, grid), Typography (font, text), Background, Border, Spacing (padding, margin), and Effects.
- **Template Expressions** — Style values support template expressions: `"backgroundColor": "${state.isPrimary ? 'var(--color-accent)' : 'transparent'}"`. The style updates reactively.

## $media — Responsive Breakpoints

`$media` breakpoints let you define responsive style overrides. Define breakpoints in project.json, then use `@--breakpoint` keys in any element's style object.

```json
// project.json
{
  "$media": {
    "--": "1280px",
    "--lg": "(max-width: 1024px)",
    "--md": "(max-width: 768px)",
    "--sm": "(max-width: 640px)"
  }
}

// Component with responsive overrides
{
  "tagName": "div",
  "style": {
    "display": "grid",
    "gridTemplateColumns": "repeat(3, 1fr)",
    "gap": "1.5rem",
    "@--md": { "gridTemplateColumns": "repeat(2, 1fr)" },
    "@--sm": { "gridTemplateColumns": "1fr" }
  }
}
```

- **Breakpoint Tabs** — When breakpoints are defined, tabs appear in the toolbar. Click a breakpoint tab to resize the canvas viewport and preview responsive behavior instantly.
- **Media-Based Style Editing** — Select a breakpoint tab, then edit styles in the inspector. Changes apply only to that breakpoint's `@--` override. The base styles remain unchanged.
- **Default Breakpoint (--)** — The `--` breakpoint is the default/base width. It sets the canvas viewport width. All other breakpoints activate when the viewport matches their media query.

## Stylebook Mode

Stylebook mode (toolbar → Stylebook button) gives you a bird's-eye view of your entire design system:

- Token list: Every CSS custom property with its current value. Edit inline.
- Component gallery: Every component in your project rendered with the current tokens applied.
- Color swatches: Visual preview of every color token. See the palette at a glance.
- Typography preview: See how font tokens render at different sizes and weights.

---

**Next:** [State & Reactivity](/docs/studio-state)
