/**
 * Guard the studio UI against hard-coded styling values.
 *
 * The studio drives its styling from Spectrum design tokens (`--spectrum-*`) and a thin studio
 * semantic layer (`--bg`, `--accent`, `--radius`, `--font-mono`, …) declared on the `<sp-theme>`
 * element in `index.html`. Raw hex colours bypass that system and stop the UI from responding to
 * the Spectrum theme, so this guard fails (exit 1) when it finds a hard-coded hex that is not:
 *
 * - A fallback inside a token reference: var(--token, #hex)
 * - An explicitly allow-listed brand/structural colour (see ALLOWED_HEX)
 * - A colour _value_ in a data file (colour pickers, the CSS-var editor)
 *
 * It also _warns_ (without failing) on `font-size` / `border-radius` px literals that have an exact
 * Spectrum token equivalent, to nudge new code toward tokens. Spacing, structural dimensions,
 * z-index, and rgba() shadow/scrim values are intentionally not policed — Spectrum's scale is
 * coarse and a dense editor UI legitimately uses off-grid structural px. See STYLING.md for the
 * full policy.
 *
 * Run: bun run scripts/check-styles.ts (also wired into `bun test` via package.json)
 */

import { Glob } from "bun";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

/** Intentional non-token colours (brand/structural). Keep this list short and commented. */
const ALLOWED_HEX = new Set([
  "#ff5f57", // Close (macOS traffic-light)
  "#febc2e", // Minimize (macOS traffic-light)
  "#28c840", // Maximize (macOS traffic-light)
]);

/** Files where a hex is a colour _value_ (user data), not chrome styling. */
const DATA_FILES = [
  "src/ui/color-selector.ts",
  "src/settings/css-vars-editor.ts",
  /* Brand ramp source of truth: defines the Jx palette as Spectrum `-rgb`
     triplets; hexes appear only in the annotation comments. */
  "src/ui/jx-theme.ts",
];

/** Px values that have an exact Spectrum token and should be tokenized in new code. */
const TOKENIZABLE_FONT_PX = new Set(["11", "12", "14"]); // Spectrum font-size-50 / -75 / -100
const TOKENIZABLE_RADIUS_PX = new Set(["2", "4", "8"]); // Spectrum corner-radius-75 / -100 / -200

const HEX_RE = /#[0-9a-fA-F]{3,8}\b/g;
const VAR_FALLBACK_RE = /var\(\s*--[a-z0-9-]+\s*,\s*#[0-9a-fA-F]{3,8}\s*\)/gi;
const FONT_PX_RE = /font-size:\s*(\d+)px/g;
const RADIUS_PX_RE = /border-radius:\s*(\d+)px/g;

interface Finding {
  file: string;
  line: number;
  text: string;
}

const errors: Finding[] = [];
const warnings: Finding[] = [];

function scan(rel: string, source: string): void {
  const isData = DATA_FILES.some((f) => rel.endsWith(f));
  const lines = source.split("\n");
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx]!;
    // Drop `var(--token, #hex)` fallbacks so their inner hex isn't flagged.
    const stripped = line.replace(VAR_FALLBACK_RE, "");

    if (!isData) {
      const matches = stripped.match(HEX_RE) ?? [];
      const bad = matches.filter((h) => !ALLOWED_HEX.has(h.toLowerCase()));
      if (bad.length > 0) {
        errors.push({ file: rel, line: idx + 1, text: line.trim() });
      }
    }

    for (const [re, set] of [
      [FONT_PX_RE, TOKENIZABLE_FONT_PX],
      [RADIUS_PX_RE, TOKENIZABLE_RADIUS_PX],
    ] as const) {
      re.lastIndex = 0;
      let match: RegExpExecArray | null = re.exec(stripped);
      while (match !== null) {
        if (set.has(match[1]!)) {
          warnings.push({ file: rel, line: idx + 1, text: line.trim() });
        }
        match = re.exec(stripped);
      }
    }
  }
}

scan("index.html", await Bun.file(join(ROOT, "index.html")).text());
for await (const rel of new Glob("src/**/*.ts").scan(ROOT)) {
  scan(rel, await Bun.file(join(ROOT, rel)).text());
}

if (warnings.length > 0) {
  console.warn(
    `\n⚠️  ${warnings.length} px literal(s) with a Spectrum token equivalent ` +
      `(prefer --spectrum-font-size-* / --spectrum-corner-radius-*):`,
  );
  for (const w of warnings.slice(0, 20)) {
    console.warn(`   ${w.file}:${w.line}  ${w.text}`);
  }
  if (warnings.length > 20) {
    console.warn(`   …and ${warnings.length - 20} more`);
  }
}

if (errors.length > 0) {
  console.error(
    `\n❌ ${errors.length} hard-coded colour(s) found. Use a Spectrum token ` +
      `(--spectrum-*) or a studio semantic token (--bg, --accent, …), optionally ` +
      `with a hex fallback: var(--token, #hex).`,
  );
  for (const e of errors) {
    console.error(`   ${e.file}:${e.line}  ${e.text}`);
  }
  console.error(
    `\nIf a colour is genuinely intentional (brand/structural), add it to ` +
      `ALLOWED_HEX in scripts/check-styles.ts with a comment.`,
  );
  process.exit(1);
}

const pxNote = warnings.length > 0 ? ` (${warnings.length} px token nudge(s) above).` : ".";
console.log(`✓ check-styles: no hard-coded colours${pxNote}`);
