/**
 * Jx brand theme fragment.
 *
 * Registered as the Spectrum 'app' fragment (see spectrum.ts), so it is adopted into every
 * <sp-theme> shadow root _after_ the system/color/scale fragments and wins the :host cascade. It
 * rebrands the stock Spectrum themes by overriding only the palette `-rgb` triplets: every derived
 * token in the published theme CSS (accent, focus ring, background layers, alpha-composed tints)
 * resolves through `rgba(var(--spectrum-*-rgb))`, so the whole theme follows coherently.
 *
 * Canonical brand values: sites/jxsuite.com/project.json (accent #3b82f6, accent-hover #60a5fa,
 * neutral surfaces #0a0a0a / #111111 / #1a1a1a / #222222). Intermediate stops interpolate along the
 * Tailwind blue/zinc ramps the brand palette derives from.
 *
 * **One fragment, two ramps.** The 'app' kind is registered once and adopted whatever `color` is,
 * so the brand values have to say which theme they are for or they re-invert the theme they were
 * adopted into — which is precisely what happened: this file's dark ramp used to sit on a bare
 * `:host`, so `color="light"` would have been re-darkened stop for stop even once the light
 * fragment was registered. The dark ramp stays on `:host` because it is the default the app boots
 * in (`index.html`, `DEFAULT_THEME`); light overrides it under `:host([color="light"])`, which
 * `<sp-theme>` reflects. Every stop overridden below is overridden in BOTH ramps — a stop present
 * in one and missing from the other reads the other theme's brand value.
 *
 * A Spectrum ramp is ordered by the theme's own background, not by luminance: in dark, gray 50 is
 * the darkest surface and 900 the lightest ink; in light the two ends swap. So the light ramp is
 * not the dark one reversed — it is the same brand zinc/blue scale re-anchored to the semantic
 * roles Spectrum's light theme assigns each stop.
 *
 * Dark-theme stop order: gray 50 (darkest) -> 900 (lightest); blue 100 (darkest) -> 1400
 * (lightest). Semantic anchors under this ramp:
 *
 * - Accent button fill = accent-500 (white text ~5.2:1)
 * - Focus ring = blue-800 (brand accent-hover)
 * - Studio --accent = accent-700 (exact brand blue)
 * - Accent content/visual = accent-900 (soft on-dark tint)
 */

import { css } from "@spectrum-web-components/base";

export const jxTheme = css`
  :host {
    /* Neutral (gray) ramp — Jx near-black surfaces and zinc text tones */
    --spectrum-gray-50-rgb: 10, 10, 10; /* #0a0a0a bg-primary / base */
    --spectrum-gray-75-rgb: 17, 17, 17; /* #111111 bg-secondary / layer-1 */
    --spectrum-gray-100-rgb: 26, 26, 26; /* #1a1a1a surface / layer-2 */
    --spectrum-gray-200-rgb: 34, 34, 34; /* #222222 border / surface-hover */
    --spectrum-gray-300-rgb: 63, 63, 70; /* #3f3f46 strong border */
    --spectrum-gray-400-rgb: 82, 82, 91; /* #52525b component border */
    --spectrum-gray-500-rgb: 113, 113, 122; /* #71717a text-muted */
    --spectrum-gray-600-rgb: 161, 161, 170; /* #a1a1aa text-secondary */
    --spectrum-gray-700-rgb: 212, 212, 216; /* #d4d4d8 subtle text */
    --spectrum-gray-800-rgb: 228, 228, 231; /* #e4e4e7 primary text */
    --spectrum-gray-900-rgb: 250, 250, 250; /* #fafafa ink / headings */

    /* Blue ramp — drives accent, informative, and the focus indicator */
    --spectrum-blue-100-rgb: 23, 37, 84; /* #172554 */
    --spectrum-blue-200-rgb: 30, 58, 138; /* #1e3a8a */
    --spectrum-blue-300-rgb: 30, 64, 175; /* #1e40af */
    --spectrum-blue-400-rgb: 29, 78, 216; /* #1d4ed8 */
    --spectrum-blue-500-rgb: 37, 99, 235; /* #2563eb accent button fill */
    --spectrum-blue-600-rgb: 48, 112, 241; /* #3070f1 */
    --spectrum-blue-700-rgb: 59, 130, 246; /* #3b82f6 brand accent */
    --spectrum-blue-800-rgb: 96, 165, 250; /* #60a5fa accent-hover / focus */
    --spectrum-blue-900-rgb: 147, 197, 253; /* #93c5fd soft on-dark accent */
    --spectrum-blue-1000-rgb: 191, 219, 254; /* #bfdbfe */
    --spectrum-blue-1100-rgb: 219, 234, 254; /* #dbeafe */
    --spectrum-blue-1200-rgb: 239, 246, 255; /* #eff6ff */
    --spectrum-blue-1300-rgb: 248, 250, 252; /* #f8fafc */
    --spectrum-blue-1400-rgb: 255, 255, 255; /* #ffffff */

    /* Brand font stacks. Sans drops adobe-clean so Adobe Clean never renders
       on machines that have it installed; mono leads with the vendored
       JetBrains Mono (see index.html @font-face). Theme-independent — they
       stay outside the per-colour blocks below. */
    --spectrum-sans-font-family-stack: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    --spectrum-code-font-family-stack:
      "JetBrains Mono", "SF Mono", Consolas, "Liberation Mono", Menlo, monospace;
  }

  /*
   * Light-theme stop order: gray 50 (lightest) -> 900 (darkest); blue 100 (lightest) -> 1400
   * (darkest). Semantic anchors under this ramp, and how they differ from dark:
   *
   * - Studio --bg = layer-1 = gray-100, --bg-panel = layer-2 = gray-50. Spectrum's light theme
   *   maps the layers the other way up from its dark one, so a panel is LIGHTER than the app
   *   behind it here and darker there. The semantic layer in tokens.css needs no branch for that.
   * - Studio --fg = neutral-content-color-default = gray-800; --fg-dim = gray-600.
   * - Studio --accent = accent-700 = #2563eb, one stop down the brand ramp from #3b82f6. The brand
   *   blue itself is blue-600 here, still the hue everything reads as. The step is a CONTRAST
   *   decision: the exact brand blue is 3.1:1 on the light app background — it clears the 3:1 WCAG
   *   2.2 SC 1.4.11 asks of a control boundary and misses the 4.5:1 SC 1.4.3 asks of the label on
   *   an accent button by more than the dark theme does. #2563eb is 4.7:1 on the background and
   *   carries white text at 5.2:1, so the light theme ships without the debt the dark one carries.
   * - Focus ring / accent-hover = blue-800 = #1d4ed8: on light a hover DARKENS, where on dark it
   *   lightens, so this is not the same hex as the dark theme's hover and should not be.
   *
   * Every other hue (red, green, orange, purple, indigo, seafoam, celery) is left to Spectrum's
   * own light ramp, which already inverts: --danger, --success, --warning and the data-explorer
   * syntax colours become dark-on-light with nothing to do here.
   */
  :host([color="light"]) {
    /* Neutral (gray) ramp — the brand zinc tones, re-anchored to light surfaces */
    --spectrum-gray-50-rgb: 255, 255, 255; /* #ffffff panel / layer-2 */
    --spectrum-gray-75-rgb: 250, 250, 250; /* #fafafa */
    --spectrum-gray-100-rgb: 244, 244, 245; /* #f4f4f5 app background / layer-1 */
    --spectrum-gray-200-rgb: 228, 228, 231; /* #e4e4e7 border / surface-hover */
    --spectrum-gray-300-rgb: 212, 212, 216; /* #d4d4d8 strong border */
    --spectrum-gray-400-rgb: 161, 161, 170; /* #a1a1aa component border */
    --spectrum-gray-500-rgb: 113, 113, 122; /* #71717a text-muted */
    --spectrum-gray-600-rgb: 82, 82, 91; /* #52525b text-secondary */
    --spectrum-gray-700-rgb: 63, 63, 70; /* #3f3f46 subtle text */
    --spectrum-gray-800-rgb: 39, 39, 42; /* #27272a primary text */
    --spectrum-gray-900-rgb: 10, 10, 10; /* #0a0a0a ink / headings */

    /* Blue ramp — drives accent, informative, and the focus indicator */
    --spectrum-blue-100-rgb: 239, 246, 255; /* #eff6ff */
    --spectrum-blue-200-rgb: 219, 234, 254; /* #dbeafe */
    --spectrum-blue-300-rgb: 191, 219, 254; /* #bfdbfe */
    --spectrum-blue-400-rgb: 147, 197, 253; /* #93c5fd */
    --spectrum-blue-500-rgb: 96, 165, 250; /* #60a5fa */
    --spectrum-blue-600-rgb: 59, 130, 246; /* #3b82f6 brand accent */
    --spectrum-blue-700-rgb: 37, 99, 235; /* #2563eb studio --accent */
    --spectrum-blue-800-rgb: 29, 78, 216; /* #1d4ed8 accent-hover / focus */
    --spectrum-blue-900-rgb: 30, 64, 175; /* #1e40af strong on-light accent */
    --spectrum-blue-1000-rgb: 30, 58, 138; /* #1e3a8a */
    --spectrum-blue-1100-rgb: 23, 37, 84; /* #172554 */
    --spectrum-blue-1200-rgb: 16, 26, 60; /* #101a3c */
    --spectrum-blue-1300-rgb: 10, 17, 38; /* #0a1126 */
    --spectrum-blue-1400-rgb: 5, 8, 19; /* #050813 */
  }
`;
