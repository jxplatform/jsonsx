/**
 * Guard the studio UI against hard-coded styling values and undefined CSS classes.
 *
 * The studio drives its styling from Spectrum design tokens (`--spectrum-*`) and a thin studio
 * semantic layer (`--bg`, `--accent`, `--radius`, `--font-mono`, …) declared on the `<sp-theme>`
 * element in `styles/tokens.css`. Raw hex colours bypass that system and stop the UI from
 * responding to the Spectrum theme, so this guard fails (exit 1) when it finds a hard-coded hex
 * that is not:
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
 * The second rule is the mirror image: a class name emitted by a `src/**` template that no
 * stylesheet in the package defines. An orphan class is a surface that opted out of the design
 * system — it is invariably being held together by inline `style=` attributes instead, which is how
 * half the app drifted away from the tokens in the first place. See ALLOWED_ORPHANS.
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
  /* Iframe-render.ts / iframe-host.ts: CSS injected into the canvas iframe document, a
     separate document context where the parent's --fg-dim/--radius/--accent custom
     properties don't exist — self-contained neutral-gray + white fallbacks, not a
     theme-responsive chrome colour. */
  "#808080",
  "#fff",
]);

/** Files where a hex is a colour _value_ (user data), not chrome styling. */
const DATA_FILES = [
  "src/ui/color-selector.ts",
  "src/settings/css-vars-editor.ts",
  /* Brand ramp source of truth: defines the Jx palette as Spectrum `-rgb`
     triplets; hexes appear only in the annotation comments. */
  "src/ui/jx-theme.ts",
  /* <input type="color"> needs a real hex default; same category as color-selector.ts. */
  "src/new-project/design-fields.ts",
  /* Example project.json style block shown to the LLM as prompt content, not actual
     chrome CSS — the hexes are illustrative data, like a colour picker's default. */
  "src/services/ai-system-prompt.ts",
];

/** Px values that have an exact Spectrum token and should be tokenized in new code. */
const TOKENIZABLE_FONT_PX = new Set(["11", "12", "14"]); // Spectrum font-size-50 / -75 / -100
const TOKENIZABLE_RADIUS_PX = new Set(["2", "4", "8"]); // Spectrum corner-radius-75 / -100 / -200

const HEX_RE = /#[0-9a-fA-F]{3,8}\b/g;
const VAR_FALLBACK_RE = /var\(\s*--[a-z0-9-]+\s*,\s*#[0-9a-fA-F]{3,8}\s*\)/gi;
const FONT_PX_RE = /font-size:\s*(\d+)px/g;
const RADIUS_PX_RE = /border-radius:\s*(\d+)px/g;

/**
 * Class-name prefixes owned by a third party whose stylesheet is bundled at build time and so is
 * never in the tree (`dist/` is generated and git-ignored). Emitting one of these is not a design
 * system escape, it is talking to somebody else's component.
 */
const VENDOR_CLASS_PREFIXES = [
  "monaco-", // Monaco-editor
  "mtk", // Monaco token classes
  "codicon", // Monaco / VS Code icon font
  "tabulator", // Tabulator-tables
  "sp-", // Spectrum Web Components
  "spectrum-", // Spectrum CSS
];

/**
 * Classes emitted by `src/**` that no stylesheet defines — a **shrinking backlog**, not a
 * configuration knob. Every entry here is a surface held together by inline `style=` attributes
 * instead of the design system; the fix is to give it real CSS in `styles/*.css` and delete the
 * entry. The check fails both ways: adding a new orphan fails, and leaving a name here after it has
 * been given a stylesheet rule fails too, so the list can only ratchet down.
 *
 * Grouped by the file that first emits each name. `collect()` returns `allOrphans` (the list
 * including these) if you ever need to regenerate the grouping wholesale.
 */
export const ALLOWED_ORPHANS = new Set<string>([
  // Owner: about/about-modal.ts
  "about-section",
  // Owner: browse/browse.ts
  "browse-upload-input",
  // Owner: canvas/iframe-host.ts
  "jx-canvas-iframe",
  // Owner: canvas/iframe-overlay.ts
  "jx-canvas-iframe-overlay",
  "overlay-presence",
  "overlay-presence-group",
  "overlay-presence-tag",
  // Owner: collab/presence-chips.ts
  "jx-presence",
  "jx-presence-chip",
  "jx-presence-status",
  // Owner: editor/slash-menu.ts
  "slash-filter",
  // Owner: grid/grid-open.ts
  "jx-grid-picker",
  // Owner: grid/grid-panel.ts
  "jx-grid-replace-popover",
  // Owner: new-project/add-repo-modal.ts
  "add-repo-filter",
  // Owner: new-project/location-fields.ts
  "new-project-error--destination",
  "new-project-owner",
  "new-project-slug",
  "new-project-visibility",
  // Owner: new-project/new-project-modal.ts
  "new-project-name",
  // Owner: panels/ai-chat/composer.ts
  "ai-send-btn",
  // Owner: panels/data-grid.ts
  "data-action-grid",
  "data-action-push",
  "data-action-test",
  "data-section-actions",
  "data-test-result",
  "push-apply",
  "push-cancel",
  "push-dialog",
  "push-dialog-actions",
  "push-dialog-error",
  "push-dialog-plan",
  "push-dialog-status",
  "push-dialog-steps",
  "push-dialog-warning",
  "push-step",
  // Owner: panels/drag-ghost.ts
  "jx-drag-ghost",
  // Owner: panels/events-panel.ts
  "body-mode-code",
  "body-mode-statements",
  "body-mode-toggle",
  "event-body-mode",
  // Owner: panels/formula-workspace.ts
  "formula-workspace",
  "fw-body",
  "fw-browse-catalog",
  "fw-chips",
  "fw-close",
  "fw-context",
  "fw-context-entry",
  "fw-context-name",
  "fw-context-title",
  "fw-editor",
  "fw-header",
  "fw-kind",
  "fw-result",
  "fw-result--error",
  "fw-result--pending",
  "fw-selected",
  "fw-title",
  // Owner: panels/head-panel.ts
  "head-add-attr",
  "head-add-tag",
  "head-add-val",
  "imports-section-title",
  // Owner: panels/imports-panel.ts
  "import-add-name",
  "import-add-path",
  "import-component-label",
  "import-component-row",
  "imports-component-list",
  // Owner: panels/layers-panel.ts
  "layers-container",
  "layers-tree",
  // Owner: panels/properties-panel.ts
  "add-bp-query",
  "bp-query-input",
  "bp-raw-label",
  "link-target-field",
  "link-target-kind",
  "link-target-value",
  "link-target-window",
  "style-section-body",
  // Owner: panels/statement-editor.ts
  "drop-above",
  "drop-below",
  "statement-add",
  "statement-add-case",
  "statement-add-else",
  "statement-card",
  "statement-card-body",
  "statement-card-header",
  "statement-case-key",
  "statement-delete",
  "statement-dispatch-bubbles",
  "statement-dispatch-composed",
  "statement-dispatch-name",
  "statement-drag-handle",
  "statement-editor",
  "statement-kind-label",
  "statement-lane",
  "statement-lane-header",
  "statement-lane-remove",
  "statement-list",
  // Owner: panels/style-panel.ts
  "style-scheme-badge",
  // Owner: panels/tab-bar.ts
  "tab-bar-prop",
  "tb-scheme",
  "tb-zoom",
  // Owner: panels/welcome-screen.ts
  "welcome-catalogue",
  // Owner: publish/publish-panel.ts
  "publish-actions",
  "publish-error",
  "publish-field",
  "publish-hint",
  "publish-modal",
  // Owner: settings/contributed-section.ts
  "contributed-section",
  "entry-name-input",
  "settings-form-panel",
  "settings-section",
  // Owner: settings/css-vars-editor.ts
  "css-var-scheme-row",
  "css-vars-enable-dark",
  // Owner: settings/head-editor.ts
  "head-add-actions",
  "head-entries",
  "head-entry-body",
  "head-entry-fields",
  // Owner: settings/schema-field-ui.ts
  "schema-field-label",
  "schema-field-ref-target",
  // Owner: ui/ai-credentials-form.ts
  "ai-creds-form",
  // Owner: ui/dynamic-slot.ts
  "dynamic-slot",
  "dynamic-slot-mode",
  // Owner: ui/expression-editor.ts
  "array-object-field",
  "array-object-row",
  "expr-browse-catalog",
  "expr-live-badge",
  "expression-editor",
  "switch-cases",
  // Owner: ui/form-controls.ts
  "schema-builder",
  "secret-field",
  // Owner: ui/formula-chips.ts
  "formula-chip",
  "formula-chip--group",
  "formula-chips",
  // Owner: ui/formula-palette.ts
  "formula-palette",
  "formula-palette-input",
  "formula-palette-overlay",
  // Owner: ui/layers.ts
  "dialog-destructive",
  // Owner: ui/media-picker.ts
  "media-picker-browse",
  "media-picker-filter",
  "media-picker-upload",
  // Owner: ui/progress-modal.ts
  "progress-modal",
  // Owner: ui/schema-form.ts
  "schema-param-editor",
  // Owner: ui/value-selector.ts
  "jx-combobox-picker",
  "jx-combobox-popover",
]);

export interface Finding {
  file: string;
  line: number;
  text: string;
}

/* ------------------------------------------------------------------ hard-coded colour rule --- */

/** Hex + tokenizable-px findings for one file. */
export function scanHex(rel: string, source: string): { errors: Finding[]; warnings: Finding[] } {
  const errors: Finding[] = [];
  const warnings: Finding[] = [];
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
  return { errors, warnings };
}

/* --------------------------------------------------------------------- source-text scanning --- */

/** Stands in for a `${…}` span so a partially-interpolated token can be recognised and dropped. */
const INTERP = "\u0000";

/** Index just past the `}` closing the `${` that starts at `i` (which points at the `$`). */
function skipInterpolation(src: string, i: number): number {
  let depth = 0;
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j];
    if (c === "{") {
      depth += 1;
    } else if (c === "}") {
      depth -= 1;
      if (depth === 0) {
        return j + 1;
      }
    }
  }
  return src.length;
}

/** Index just past the `)` closing the `(` at `i`. */
function skipParens(src: string, i: number): number {
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === "(") {
      depth += 1;
    } else if (c === ")") {
      depth -= 1;
      if (depth === 0) {
        return j + 1;
      }
    }
  }
  return src.length;
}

/**
 * Read the quoted string starting at `i` (which points at the opening quote), returning its body
 * with every `${…}` span collapsed to {@link INTERP}, plus the index just past the closing quote.
 */
function readQuoted(src: string, i: number): { body: string; end: number } {
  const quote = src[i]!;
  let body = "";
  let j = i + 1;
  while (j < src.length) {
    const c = src[j]!;
    if (c === "\\") {
      body += src.slice(j, j + 2);
      j += 2;
      continue;
    }
    if (c === quote) {
      break;
    }
    if (c === "$" && src[j + 1] === "{") {
      body += INTERP;
      j = skipInterpolation(src, j);
      continue;
    }
    body += c;
    j += 1;
  }
  return { body, end: j + 1 };
}

/** Whitespace-separated class tokens of an attribute value, dropping interpolated fragments. */
function attrTokens(value: string): string[] {
  return value.split(/\s+/).filter((t) => t.length > 0 && !t.includes(INTERP));
}

/** Bodies of every template literal in `src`, with `${…}` spans collapsed to {@link INTERP}. */
export function templateLiterals(src: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < src.length; i++) {
    if (src[i] !== "`") {
      continue;
    }
    const { body, end } = readQuoted(src, i);
    out.push(body);
    i = end - 1;
  }
  return out;
}

/**
 * Every `'…'` / `"…"` / `` `…` `` body in `expr`, with interpolated fragments collapsed.
 *
 * With `valuePositionOnly`, a literal counts only where it is the value an expression evaluates to
 * — after `?`, `:`, `&&`, `||` or `??`. That is the difference between the two halves of
 * `class=${kind === "grid" ? "layout-grid" : ""}`: `"layout-grid"` reaches the DOM, `"grid"` is a
 * value being compared against and is nobody's class name.
 */
function stringLiterals(expr: string, valuePositionOnly = false): string[] {
  const out: string[] = [];
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (c !== '"' && c !== "'" && c !== "`") {
      continue;
    }
    const { body, end } = readQuoted(expr, i);
    if (!valuePositionOnly || /[?:]\s*$|&&\s*$|\|\|\s*$|\?\?\s*$/.test(expr.slice(0, i))) {
      out.push(body);
    }
    i = end - 1;
  }
  return out;
}

/** 1-based line number of `index`, via the newline offsets of the source. */
function lineOf(newlines: number[], index: number): number {
  let lo = 0;
  let hi = newlines.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (newlines[mid]! < index) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo + 1;
}

function newlineOffsets(src: string): number[] {
  const out: number[] = [];
  for (let i = src.indexOf("\n"); i !== -1; i = src.indexOf("\n", i + 1)) {
    out.push(i);
  }
  return out;
}

/* --------------------------------------------------------------------------- emitted classes --- */

const CLASS_ATTR_RE = /\bclass\s*=\s*/g;
const CLASS_MAP_RE = /\bclassMap\s*\(/g;
const CLASS_LIST_RE = /\bclassList\s*\.\s*(add|remove|toggle)\s*\(/g;
const CLASS_NAME_RE = /\.className\s*\+?=\s*/g;
const SET_ATTR_CLASS_RE = /\.setAttribute\(\s*["']class["']\s*,\s*/g;
/** `{ "a-b": …` / `{ active: …` — anchored on `{` or `,` so ternary branches aren't read as keys. */
const OBJECT_KEY_RE = /[{,]\s*(?:"([^"\n]+)"|'([^'\n]+)'|([A-Za-z_$][\w$]*))\s*:/g;

/**
 * Class tokens a TypeScript source emits into the DOM, mapped to the line of their first use.
 *
 * Covers the five shapes the studio actually uses — a literal `class="…"` in a lit template,
 * `class=${…}` whose branches are literals, `classMap({…})` keys, `classList.add/remove/toggle`,
 * and `el.className =`. Anything whose name is composed at runtime (`` `tab-${kind}` ``, a class
 * held in a variable) is skipped rather than guessed at: a gate that reports names nobody wrote
 * gets switched off.
 */
export function extractEmittedClasses(source: string): Map<string, number> {
  const found = new Map<string, number>();
  const newlines = newlineOffsets(source);
  const add = (token: string, index: number): void => {
    if (token.length === 0 || found.has(token)) {
      return;
    }
    found.set(token, lineOf(newlines, index));
  };
  const addAll = (tokens: string[], index: number): void => {
    for (const t of tokens) {
      add(t, index);
    }
  };

  // Class="a b" | class='a b' | class=${expr}
  for (const m of source.matchAll(CLASS_ATTR_RE)) {
    const p = m.index + m[0].length;
    const c = source[p];
    if (c === '"' || c === "'" || c === "`") {
      addAll(attrTokens(readQuoted(source, p).body), m.index);
    } else if (c === "$" && source[p + 1] === "{") {
      const expr = source.slice(p + 2, skipInterpolation(source, p) - 1);
      for (const lit of stringLiterals(expr, true)) {
        addAll(attrTokens(lit), m.index);
      }
    }
  }

  // ClassMap({ "a-b": cond, active: cond })
  for (const m of source.matchAll(CLASS_MAP_RE)) {
    const open = m.index + m[0].length - 1;
    const body = source.slice(open, skipParens(source, open));
    for (const k of body.matchAll(OBJECT_KEY_RE)) {
      const key = k[1] ?? k[2] ?? k[3]!;
      if (!key.includes(INTERP)) {
        addAll(attrTokens(key), m.index);
      }
    }
  }

  // ClassList.add("a", "b") — variables in the argument list resolve to nothing, as intended.
  // `toggle(name, force)` takes exactly one class: its second argument is a condition, and reading
  // It as a class name invents one out of every `toggle("stale", state === "stale")`.
  for (const m of source.matchAll(CLASS_LIST_RE)) {
    const open = m.index + m[0].length - 1;
    const args = source.slice(open + 1, skipParens(source, open) - 1);
    const lits = stringLiterals(args);
    for (const lit of m[1] === "toggle" ? lits.slice(0, 1) : lits) {
      addAll(attrTokens(lit), m.index);
    }
  }

  // El.className = "a b" | el.setAttribute("class", "a b")
  for (const re of [CLASS_NAME_RE, SET_ATTR_CLASS_RE]) {
    for (const m of source.matchAll(re)) {
      const p = m.index + m[0].length;
      const c = source[p];
      if (c === '"' || c === "'" || c === "`") {
        addAll(attrTokens(readQuoted(source, p).body), m.index);
      }
    }
  }

  return found;
}

/* --------------------------------------------------------------------------- defined classes --- */

const COMMENT_RE = /\/\*[\s\S]*?\*\//g;
const SELECTOR_CLASS_RE = /\.(-?[_a-zA-Z][\w-]*)/g;
const STYLE_BLOCK_RE = /<style[^>]*>([\s\S]*?)<\/style>/gi;
/** A `{ … }` block holding at least one `prop: value` declaration — i.e. this text is a stylesheet. */
const CSS_SHAPE_RE = /\{[^{}]*[a-z-]{2,}\s*:\s*[^{}]+\}/;

/**
 * The selector preludes of a stylesheet: every run of text that ends at a `{`. Tracking the braces
 * rather than splitting on them keeps nested rules (`@media … { .x { … } }`) and drops declaration
 * bodies, where a `.` is part of a number or a `url(./…)` rather than a class.
 */
export function extractSelectorPreludes(css: string): string[] {
  const out: string[] = [];
  const text = css.replace(COMMENT_RE, " ");
  let buf = "";
  for (const c of text) {
    if (c === "{") {
      out.push(buf);
      buf = "";
    } else if (c === "}") {
      buf = "";
    } else {
      buf += c;
    }
  }
  return out;
}

/** Class names a stylesheet defines a rule for. */
export function extractDefinedClasses(css: string): Set<string> {
  const out = new Set<string>();
  for (const prelude of extractSelectorPreludes(css)) {
    for (const m of prelude.matchAll(SELECTOR_CLASS_RE)) {
      out.add(m[1]!);
    }
  }
  return out;
}

/** Contents of every `<style>` element in an HTML document. */
export function extractStyleBlocks(html: string): string[] {
  return [...html.matchAll(STYLE_BLOCK_RE)].map((m) => m[1]!);
}

/**
 * Stylesheet text embedded in a TypeScript source — the CSS the canvas iframe modules inject into
 * their own document, plus any `<style>` a lit template carries. Template literals that don't look
 * like a stylesheet are ignored, so a lit `html` template isn't mined for selectors.
 */
export function extractCssTemplates(source: string): string[] {
  return templateLiterals(source).filter((t) => CSS_SHAPE_RE.test(t));
}

/* ------------------------------------------------------------------------------ the run itself --- */

export interface StyleCheckResult {
  hexErrors: Finding[];
  pxWarnings: Finding[];
  /** Emitted-but-undefined classes, first emission site, excluding ALLOWED_ORPHANS. */
  orphans: Finding[];
  /** ALLOWED_ORPHANS entries that are now defined (or no longer emitted) — the ratchet. */
  staleAllowed: string[];
  /** Every orphan including the allow-listed ones, for regenerating the list. */
  allOrphans: Finding[];
}

function isVendorClass(name: string): boolean {
  return VENDOR_CLASS_PREFIXES.some((p) => name.startsWith(p));
}

/** Run both rules over a studio package directory. */
export async function collect(root: string): Promise<StyleCheckResult> {
  const hexErrors: Finding[] = [];
  const pxWarnings: Finding[] = [];
  const defined = new Set<string>();
  /** Class → first emission site. */
  const emitted = new Map<string, Finding>();

  const read = (rel: string): Promise<string> => Bun.file(join(root, rel)).text();

  for (const rel of ["index.html", "canvas.html"]) {
    const source = await read(rel);
    const { errors, warnings } = scanHex(rel, source);
    hexErrors.push(...errors);
    pxWarnings.push(...warnings);
    for (const block of extractStyleBlocks(source)) {
      for (const name of extractDefinedClasses(block)) {
        defined.add(name);
      }
    }
  }

  /*
   * The studio chrome stylesheet: `styles/tokens.css` plus the five region files that used to be
   * one `<style>` block inside index.html. They are real chrome CSS, so they carry both roles the
   * inline block did — definition source for the orphan rule, and subject of the hex/px rules.
   */
  for await (const rel of new Glob("styles/*.css").scan(root)) {
    const source = await read(rel);
    const { errors, warnings } = scanHex(rel, source);
    hexErrors.push(...errors);
    pxWarnings.push(...warnings);
    for (const name of extractDefinedClasses(source)) {
      defined.add(name);
    }
  }

  for await (const rel of new Glob("src/**/*.css").scan(root)) {
    for (const name of extractDefinedClasses(await read(rel))) {
      defined.add(name);
    }
  }

  for await (const rel of new Glob("src/**/*.ts").scan(root)) {
    const source = await read(rel);
    const { errors, warnings } = scanHex(rel, source);
    hexErrors.push(...errors);
    pxWarnings.push(...warnings);

    for (const css of extractCssTemplates(source)) {
      for (const name of extractDefinedClasses(css)) {
        defined.add(name);
      }
    }
    for (const [name, line] of extractEmittedClasses(source)) {
      if (!emitted.has(name)) {
        emitted.set(name, { file: rel, line, text: name });
      }
    }
  }

  const unstyled: Finding[] = [];
  for (const [name, site] of emitted) {
    if (defined.has(name) || isVendorClass(name)) {
      continue;
    }
    unstyled.push(site);
  }
  const allOrphans = unstyled.toSorted((a, b) => a.text.localeCompare(b.text));

  const orphaned = new Set(allOrphans.map((o) => o.text));
  const staleAllowed = [...ALLOWED_ORPHANS].filter((name) => !orphaned.has(name)).toSorted();

  return {
    hexErrors,
    pxWarnings,
    orphans: allOrphans.filter((o) => !ALLOWED_ORPHANS.has(o.text)),
    staleAllowed,
    allOrphans,
  };
}

/** Print the findings and return the process exit code. */
export function report(result: StyleCheckResult): number {
  const { hexErrors, pxWarnings, orphans, staleAllowed } = result;

  if (pxWarnings.length > 0) {
    console.warn(
      `\n⚠️  ${pxWarnings.length} px literal(s) with a Spectrum token equivalent ` +
        `(prefer --spectrum-font-size-* / --spectrum-corner-radius-*):`,
    );
    for (const w of pxWarnings.slice(0, 20)) {
      console.warn(`   ${w.file}:${w.line}  ${w.text}`);
    }
    if (pxWarnings.length > 20) {
      console.warn(`   …and ${pxWarnings.length - 20} more`);
    }
  }

  if (hexErrors.length > 0) {
    console.error(
      `\n❌ ${hexErrors.length} hard-coded colour(s) found. Use a Spectrum token ` +
        `(--spectrum-*) or a studio semantic token (--bg, --accent, …), optionally ` +
        `with a hex fallback: var(--token, #hex).`,
    );
    for (const e of hexErrors) {
      console.error(`   ${e.file}:${e.line}  ${e.text}`);
    }
    console.error(
      `\nIf a colour is genuinely intentional (brand/structural), add it to ` +
        `ALLOWED_HEX in scripts/check-styles.ts with a comment.`,
    );
  }

  if (orphans.length > 0) {
    console.error(
      `\n❌ ${orphans.length} class(es) emitted by src/ that no stylesheet defines. ` +
        `Give them rules in styles/*.css rather than inline style= attributes.`,
    );
    for (const o of orphans) {
      console.error(`   ${o.text}  (${o.file}:${o.line})`);
    }
  }

  if (staleAllowed.length > 0) {
    console.error(
      `\n❌ ${staleAllowed.length} stale ALLOWED_ORPHANS entry(ies) — these classes are no ` +
        `longer orphaned, so delete them from the list (it only ratchets down):`,
    );
    for (const name of staleAllowed) {
      console.error(`   ${name}`);
    }
  }

  if (hexErrors.length > 0 || orphans.length > 0 || staleAllowed.length > 0) {
    return 1;
  }

  const pxNote = pxWarnings.length > 0 ? ` (${pxWarnings.length} px token nudge(s) above)` : "";
  console.log(
    `✓ check-styles: no hard-coded colours, no undefined classes ` +
      `(${ALLOWED_ORPHANS.size} allow-listed orphan(s) remaining)${pxNote}.`,
  );
  return 0;
}

if (import.meta.main) {
  process.exit(report(await collect(ROOT)));
}
