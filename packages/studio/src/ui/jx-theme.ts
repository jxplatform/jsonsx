/**
 * Jx brand theme fragment.
 *
 * Registered as the Spectrum 'app' fragment (see spectrum.ts), so it is adopted into every
 * <sp-theme> shadow root _after_ the system/color/scale fragments and wins the :host cascade. It
 * rebrands the stock Spectrum dark theme by overriding only the palette `-rgb` triplets: every
 * derived token in the published theme CSS (accent, focus ring, background layers, alpha-composed
 * tints) resolves through `rgba(var(--spectrum-*-rgb))`, so the whole theme follows coherently.
 *
 * Canonical brand values: sites/jxsuite.com/project.json (accent #3b82f6, accent-hover #60a5fa,
 * neutral surfaces #0a0a0a / #111111 / #1a1a1a / #222222). Intermediate stops interpolate along the
 * Tailwind blue/zinc ramps the brand palette derives from.
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
       JetBrains Mono (see index.html @font-face). */
    --spectrum-sans-font-family-stack: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    --spectrum-code-font-family-stack:
      "JetBrains Mono", "SF Mono", Consolas, "Liberation Mono", Menlo, monospace;
  }
`;
