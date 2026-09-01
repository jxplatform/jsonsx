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
 * The third rule is the FOCUS RING. UX-REDESIGN-PLAN §12 P0 workstream 7 replaced eight bare
 * `outline: none` declarations with `:focus-visible` pairs and promised "a stylelint rule bans bare
 * `outline: none`" — the sweep landed and the rule never did, so the next `outline: none` would
 * have gone in unremarked and taken a control off the keyboard with it. A ban alone would have been
 * the weaker gate, because the defect is not the suppression: it is a suppression whose RESTORE is
 * missing. So each allowance names the `:focus-visible` rule that puts the ring back, and the check
 * verifies that rule still exists and still sets an outline — deleting the restore turns the
 * allowance red at the line the suppression is on. See FOCUS_RING_ALLOWANCES.
 *
 * The fourth and fifth rules are about SILENCE rather than styling, and they live here because this
 * file is the package's idiom for "a wide, shallow property with a ratcheting allow-list" — the
 * shape UX-REDESIGN-PLAN §7.1 asks for by name:
 *
 * - **`statusMessage` is banned from `src/`.** It is deleted: 78 call sites — 26 failures and 52
 *   successes — printed the same 11px grey line and erased it after three seconds. Outcomes go to
 *   `services/notify.ts` (`notify.success/warn/error`), whose tier is chosen by the action the
 *   outcome requires. Without a mechanical guard a wide, shallow change like that silently regrows,
 *   one convenient call at a time; the rule has no allow-list because there is nothing to allow.
 * - **A bare empty `catch` is banned from `src/`.** 158 of 240 catch blocks reached no surface at all
 *   and 46 were entirely empty. A block with no statements AND no comment says nothing about
 *   whether the silence was decided or forgotten — so it must either notify, or carry an explicit
 *   `// intentionally ignored: <reason>`. SILENT_CATCH_BUDGET is the shrinking backlog, per file,
 *   and it fails BOTH ways: a new one fails, and a stale count fails too.
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
  /* Iframe-render.ts DIFF_MARK_CSS: the change marks on the git-diff artboards, in that same
     separate document. They cannot be --success/--danger, which are the near-white-on-dark chrome
     tints — `.canvas-panel-viewport` pins `background: white; color-scheme: light` whatever the
     chrome theme is, so the marks are always drawn on white and this pair is chosen against it.
     Colour is never the only encoding: each kind also carries its own border-left-style, which is
     what survives the forced-colours block beside them. */
  "#0a7c42",
  "#c9252d",
]);

/** Files where a hex is a colour _value_ (user data), not chrome styling. */
const DATA_FILES = [
  "src/ui/color-selector.ts",
  "src/settings/css-vars-editor.ts",
  /* Brand ramp source of truth: defines the Jx palette as Spectrum `-rgb`
     triplets; hexes appear only in the annotation comments. */
  "src/ui/jx-theme.ts",
  /* <input type="color"> needs a real hex default; same category as color-selector.ts. */
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
  // Owner: canvas/iframe-host.ts
  "jx-canvas-iframe",
  // Owner: canvas/iframe-overlay.ts
  "jx-canvas-iframe-overlay",
  "overlay-presence",
  "overlay-presence-group",
  "overlay-presence-tag",
  /* Owner: collab/presence-chips.ts — jx-presence, -chip, -status and the two new flags now have
     rules in styles/shell.css. The flagship co-editing affordance shipped unstyled (§7.4). */
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
  /* Owner: panels/formula-workspace.ts — the seventeen `fw-*` classes that were here are styled in
     styles/panels.css now. The takeover held itself together with inline `style=` attributes; a
     dock tab cannot, because its height is the dock's rather than the stage's. Two remain: both
     are Spectrum action buttons the surface only needs a HANDLE on, and neither carries a rule. */
  "fw-browse-catalog",
  "fw-close",
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
  /* Owner: panels/properties-panel.ts — the breakpoint form these three belonged to is gone.
     $media is defined in Project Settings › Contexts and nowhere else (plan §4.2). */
  "link-target-field",
  "link-target-kind",
  "link-target-value",
  "link-target-window",
  "style-section-body",
  /* Owner: panels/statement-editor.ts — the whole surface (twenty names, including the two
     drag-feedback classes that had no rule anywhere) is styled in styles/inspector.css now. It
     held itself together with inline `style=` attributes, and an attribute cannot carry the
     `min-width: 0` a flex chain needs, so the Logic tab's operand controls were clipped by the
     right edge of the window at Inspector width. */
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
  /* "css-vars-enable-dark" retired with the button: this section overrides tokens per scheme, it
     no longer DEFINES a scheme — that is Settings › Contexts (§2 principle 5). */
  // Owner: settings/head-editor.ts
  "head-add-actions",
  "head-entries",
  "head-entry-body",
  "head-entry-fields",
  // Owner: settings/schema-field-ui.ts
  "schema-field-label",
  "schema-field-ref-target",
  // Owner: ui/dynamic-slot.ts
  "dynamic-slot",
  "dynamic-slot-mode",
  /* Owner: ui/expression-editor.ts — styled in styles/inspector.css beside the statement editor it
     is drawn inside. `array-object-*` and `expr-live-badge` are shared with ui/schema-form.ts and
     ui/formula-chips.ts, which still pass their own inline copies; the rule they now inherit is
     the wrap and the shrink. */
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

/* ------------------------------------------------------------------------- focus-ring rule --- */

/** One place a stylesheet takes the focus ring away, and the rule that gives it back. */
export interface FocusRingAllowance {
  /** Stylesheet holding the suppression, relative to the package root. */
  file: string;
  /** The suppressing rule's selector, exactly as written (whitespace is normalised for you). */
  selector: string;
  /**
   * The `:focus-visible` rule that restores the ring for that same selector. Checked: it must exist
   * in the same stylesheet AND still declare a real outline. This is the whole point of the entry.
   */
  restoredBy: string;
}

/**
 * Every `outline: none` the studio's stylesheets are allowed to contain, each paired with its
 * restore — a **closed list**, not a knob, and it fails in three directions.
 *
 * A suppression with no entry fails ("you took the ring away"). An entry whose `restoredBy` rule
 * has been deleted, renamed, or has stopped declaring an outline fails at the suppression's own
 * line ("you took the ring away and then took the replacement away too") — which is the failure a
 * plain ban could never see, because a ban only ever looks at the line it bans. An entry whose
 * suppression is gone fails as stale, so the list ratchets down exactly like ALLOWED_ORPHANS.
 *
 * Suppressing the ring for POINTER focus is legitimate — a clicked text field with a 2px ring
 * around it looks broken — and that is why this is a paired allowance rather than a prohibition.
 * Taking it away from the KEYBOARD makes the control untraversable, and nothing on screen says so,
 * which is why it needs a machine to notice.
 *
 * Scope is the package's stylesheets: `styles/*.css`, any `.css` under `src/`, and the `<style>`
 * blocks of `index.html` / `canvas.html`. An inline `style="…outline:none…"` attribute is out of
 * reach by construction — an attribute cannot carry a `:focus-visible` rule at all — so those
 * surfaces are the ORPHAN rule's business: give them a class with real CSS and this rule inherits
 * them.
 */
export const FOCUS_RING_ALLOWANCES: readonly FocusRingAllowance[] = [
  /* The AI composer's textarea. The only one of the six scoped to `:focus:not(:focus-visible)`
     rather than to the bare element, which is the same bargain said in CSS instead of in a pair. */
  {
    file: "styles/shell.css",
    restoredBy: ".ai-composer-input:focus-visible",
    selector: ".ai-composer-input:focus:not(:focus-visible)",
  },
  // The quick-search field: borderless inside its own framed popover.
  {
    file: "styles/overlays.css",
    restoredBy: ".quick-search-input:focus-visible",
    selector: ".quick-search-input",
  },
  // The Source view textarea, which fills its pane edge to edge.
  {
    file: "styles/overlays.css",
    restoredBy: "#source-view:focus-visible",
    selector: "#source-view",
  },
  /* The two grid cell editors, which share one suppressing rule and — until this check was
     written — did NOT share its restore: `.jx-grid-input` had no `:focus-visible` rule at all, so
     every text cell in the data grid was keyboard-focusable with nothing on screen to prove it. A
     grouped selector is the shape a per-line ban is blindest to, and the shape this list splits. */
  {
    file: "styles/overlays.css",
    restoredBy: ".jx-grid-editor .jx-grid-input:focus-visible",
    selector: ".jx-grid-editor .jx-grid-input",
  },
  {
    file: "styles/overlays.css",
    restoredBy: ".jx-grid-editor .jx-grid-select:focus-visible",
    selector: ".jx-grid-editor .jx-grid-select",
  },
  // The pill editor's inline input, which draws its border on the surrounding chip row.
  {
    file: "styles/overlays.css",
    restoredBy: ".jx-grid-pill-input:focus-visible",
    selector: ".jx-grid-pill-input",
  },
];

/* --------------------------------------------------------------------------- silence rules --- */

/**
 * Identifiers `src/**` may not name. One entry, and it is meant to stay one.
 *
 * `statusMessage` was Studio's whole feedback system: a 24px strip, one line of 11px grey, gone in
 * 3000 ms, identical for a failed save and a successful copy. Every one of its 78 call sites now
 * names a severity and, where recovery exists, a COMMAND ID — so the toast's Retry button and the
 * Problems row's Fix button come off the command record instead of being invented per call site.
 */
const BANNED_IDENTIFIERS: readonly { name: string; instead: string }[] = [
  {
    instead: "notify.success / notify.warn / notify.error from src/services/notify.ts",
    name: "statusMessage",
  },
];

/**
 * Bare empty catches that predate the rule, per file — a shrinking backlog, not a knob.
 *
 * Each entry is a place the app decides to ignore a failure without saying so. The fix is one of
 * two lines: a `notify.*` call, or `// intentionally ignored: <reason>` inside the block. Every
 * entry names the owning module, and the check fails if a count is too HIGH or too LOW, so the list
 * can only ratchet down.
 */
export const SILENT_CATCH_BUDGET: Readonly<Record<string, number>> = {
  // Owner: platforms/devserver.ts — a probe whose failure means "no path", already returned below.
  "src/platforms/devserver.ts": 1,
  // Owner: panels/signals-panel.ts — a JSON default typed one character at a time.
  "src/panels/signals-panel.ts": 1,
  // Owner: ui/schema-form.ts — two debounced JSON fields, mid-keystroke parse failures.
  "src/ui/schema-form.ts": 2,
};

/**
 * A `catch` whose block contains NOTHING — not a statement, not even a comment.
 *
 * A comment is enough to pass, deliberately: the rule is not "handle every error", it is "say which
 * silences you chose". `// intentionally ignored: the picker was dismissed` is a complete answer.
 */
const BARE_CATCH_RE = /catch\s*(?:\([^)]*\)\s*)?\{\s*\}/g;

/**
 * Blank out comments and string bodies, preserving every newline so line numbers survive.
 *
 * Needed because the banned identifier is legitimately NAMED in prose — `services/notify.ts` and
 * `panels/statusbar.ts` both explain what they replaced, and a rule that could not tell code from
 * commentary would force those two files to be coy about it.
 */
export function stripCommentsAndStrings(src: string): string {
  let out = "";
  let i = 0;
  const blank = (text: string) => text.replaceAll(/[^\n]/g, " ");
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === "//") {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? src.length : end;
      out += blank(src.slice(i, stop));
      i = stop;
      continue;
    }
    if (two === "/*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      out += blank(src.slice(i, stop));
      i = stop;
      continue;
    }
    const quote = src[i];
    if (quote === '"' || quote === "'" || quote === "`") {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === quote) {
          j += 1;
          break;
        }
        j += 1;
      }
      out += quote + blank(src.slice(i + 1, j - 1)) + (src[j - 1] ?? "");
      i = j;
      continue;
    }
    out += src[i];
    i += 1;
  }
  return out;
}

/** Every banned-identifier mention in one file's CODE (comments and strings already blanked). */
export function scanBannedIdentifiers(rel: string, code: string): Finding[] {
  const findings: Finding[] = [];
  const lines = code.split("\n");
  for (const [idx, line] of lines.entries()) {
    for (const banned of BANNED_IDENTIFIERS) {
      if (new RegExp(`\\b${banned.name}\\b`).test(line)) {
        findings.push({
          file: rel,
          line: idx + 1,
          text: `${banned.name} — use ${banned.instead}`,
        });
      }
    }
  }
  return findings;
}

/**
 * How many bare empty catches one file contains.
 *
 * Runs on the RAW source, not on {@link stripCommentsAndStrings}'s output, and that is the whole
 * point of the rule: a comment inside the block is the justification, so blanking comments first
 * would flag exactly the files that had already answered.
 */
export function countBareCatches(code: string): number {
  BARE_CATCH_RE.lastIndex = 0;
  return (code.match(BARE_CATCH_RE) ?? []).length;
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
 * An HTML document with every byte outside a `<style>` element blanked, newlines kept.
 *
 * {@link extractStyleBlocks} throws away where each block sat, which is fine for collecting class
 * names and useless for the focus-ring rule, whose whole output is "line N of this file". Blanking
 * in place means the result IS the document's line numbering, so one CSS parser serves the
 * stylesheets and the two HTML shells without either of them carrying an offset.
 */
export function cssOfHtml(html: string): string {
  const blank = (text: string): string => text.replaceAll(/[^\n]/g, " ");
  let out = "";
  let cursor = 0;
  for (const m of html.matchAll(STYLE_BLOCK_RE)) {
    const bodyStart = m.index + m[0].indexOf(">") + 1;
    out += blank(html.slice(cursor, bodyStart)) + m[1]!;
    cursor = bodyStart + m[1]!.length;
  }
  return out + blank(html.slice(cursor));
}

/* ------------------------------------------------------------------------- focus-ring rule --- */

/** One `{ … }` block of a stylesheet. At-rules are not rules and are never returned. */
export interface CssRule {
  /** The prelude's comma-separated selectors, each whitespace-normalised. */
  selectors: string[];
  /** The declarations between the braces. Never contains a nested block. */
  body: string;
  /** 1-based line the prelude starts on. */
  line: number;
}

/** Blank every comment in place, preserving newlines so line numbers survive. */
function blankCssComments(css: string): string {
  return css.replaceAll(COMMENT_RE, (match) => match.replaceAll(/[^\n]/g, " "));
}

/** Collapse runs of whitespace so `.a .b` and `.a\n.b` are the same selector. */
export function normalizeSelector(selector: string): string {
  return selector.trim().replaceAll(/\s+/g, " ");
}

/** A prelude's selectors — split on top-level commas, so `:not(.a, .b)` stays one selector. */
function splitSelectors(prelude: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const c of prelude) {
    if (c === "(" || c === "[") {
      depth += 1;
    } else if (c === ")" || c === "]") {
      depth -= 1;
    } else if (c === "," && depth === 0) {
      out.push(current);
      current = "";
      continue;
    }
    current += c;
  }
  out.push(current);
  return out.map((s) => normalizeSelector(s)).filter((s) => s.length > 0);
}

/**
 * Every rule of a stylesheet, with the line its selector starts on.
 *
 * {@link extractSelectorPreludes} answers a different question — which classes are DEFINED anywhere
 * — and deliberately discards both bodies and positions. The focus-ring rule needs to pair a
 * selector with the declarations under it, so it needs the block; a brace stack gives that and
 * drops at-rules on the way (a `@media` prelude is not a selector, and its nested rules are emitted
 * in their own right).
 */
export function extractRules(css: string): CssRule[] {
  const text = blankCssComments(css);
  const newlines = newlineOffsets(text);
  const out: CssRule[] = [];
  const open: { prelude: string; at: number; from: number }[] = [];
  let buf = "";
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "{") {
      open.push({ at: start, from: i + 1, prelude: buf });
      buf = "";
      continue;
    }
    // `;` ends a statement at-rule (`@import …;`) as surely as `}` ends a block, so both reset the
    // Prelude under construction. Inside a declaration block the buffer is discarded anyway.
    if (c === "}" || c === ";") {
      if (c === "}") {
        const rule = open.pop();
        if (rule && !rule.prelude.startsWith("@")) {
          out.push({
            body: text.slice(rule.from, i),
            line: lineOf(newlines, rule.at),
            selectors: splitSelectors(rule.prelude),
          });
        }
      }
      buf = "";
      continue;
    }
    if (buf.length === 0) {
      if (/\s/.test(c)) {
        continue;
      }
      start = i;
    }
    buf += c;
  }
  return out;
}

/** `outline: …` declarations only — `outline-offset` and `-webkit-outline` are different props. */
const OUTLINE_DECL_RE = /(?:^|;)\s*outline\s*:\s*([^;]*)/g;

/** Every `outline` value a rule body declares, lowercased and stripped of `!important`. */
function outlineValues(body: string): string[] {
  return [...body.matchAll(OUTLINE_DECL_RE)].map((m) =>
    m[1]!
      .replace(/!important/i, "")
      .trim()
      .toLowerCase(),
  );
}

/** Whether a rule takes the ring away. `0` is the same removal spelled shorter. */
function suppressesRing(body: string): boolean {
  return outlineValues(body).some((value) => value === "none" || value === "0");
}

/** Whether a rule draws a ring — an `outline` with a value that is not a removal. */
function restoresRing(body: string): boolean {
  return outlineValues(body).some((value) => value.length > 0 && value !== "none" && value !== "0");
}

/** How an allowance is named in output, and how a suppression is matched back to one. */
export function focusKey(file: string, selector: string): string {
  return `${file} → ${selector}`;
}

/**
 * One stylesheet's focus-ring findings, plus the suppressions it actually contains.
 *
 * The second half is what makes the list ratchet: `collect()` subtracts it from
 * {@link FOCUS_RING_ALLOWANCES} and reports whatever is left as stale.
 */
export function checkFocusRings(
  rel: string,
  css: string,
  allowances: readonly FocusRingAllowance[] = FOCUS_RING_ALLOWANCES,
): { findings: Finding[]; suppressed: string[] } {
  const rules = extractRules(css);
  const restores = new Set<string>();
  for (const rule of rules) {
    if (restoresRing(rule.body)) {
      for (const selector of rule.selectors) {
        restores.add(selector);
      }
    }
  }

  const mine = allowances.filter((a) => a.file === rel);
  const findings: Finding[] = [];
  const suppressed: string[] = [];
  for (const rule of rules) {
    if (!suppressesRing(rule.body)) {
      continue;
    }
    for (const selector of rule.selectors) {
      suppressed.push(focusKey(rel, selector));
      const allowance = mine.find((a) => normalizeSelector(a.selector) === selector);
      const restoredBy = allowance ? normalizeSelector(allowance.restoredBy) : "";
      if (!allowance) {
        findings.push({
          file: rel,
          line: rule.line,
          text:
            `${selector} — the focus ring is removed with no allowance. Restore it in a ` +
            `:focus-visible rule and add a FOCUS_RING_ALLOWANCES entry naming that rule.`,
        });
      } else if (!restoredBy.includes(":focus-visible")) {
        findings.push({
          file: rel,
          line: rule.line,
          text:
            `${selector} — its allowance names "${allowance.restoredBy}", which is not a ` +
            `:focus-visible rule. A ring that pointer focus also draws is not a keyboard ring.`,
        });
      } else if (!restores.has(restoredBy)) {
        findings.push({
          file: rel,
          line: rule.line,
          text:
            `${selector} — its allowance names "${allowance.restoredBy}", which no longer sets ` +
            `an outline in this stylesheet. Nothing puts the keyboard ring back.`,
        });
      }
    }
  }
  return { findings, suppressed };
}

/**
 * Stylesheet text embedded in a TypeScript source — the CSS the canvas iframe modules inject into
 * their own document, plus any `<style>` a lit template carries. Template literals that don't look
 * like a stylesheet are ignored, so a lit `html` template isn't mined for selectors.
 */
export function extractCssTemplates(source: string): string[] {
  return templateLiterals(source).filter((t) => CSS_SHAPE_RE.test(t));
}

/* ------------------------------------------------------------------------ underlay-stacking rule --- */

/**
 * The card an `<sp-underlay>` is opened beside, and the line it sits on.
 *
 * A modal body in this app is two siblings: the scrim and the surface. Only the FIRST element with
 * a class after the underlay is taken — that is the card; everything below it is inside it.
 */
export function extractUnderlayCards(source: string): { classes: string[]; line: number }[] {
  const newlines = newlineOffsets(source);
  const out: { classes: string[]; line: number }[] = [];
  const underlay = /<sp-underlay\b/g;
  let match: RegExpExecArray | null;
  while ((match = underlay.exec(source))) {
    const after = source.slice(match.index, match.index + 600);
    const card = /<(?!sp-underlay\b)[a-z][\w-]*[^>]*?\bclass\s*=\s*"([^"]*)"/i.exec(after);
    if (!card) {
      continue;
    }
    const classes = card[1]!.split(/\s+/).filter((c) => c.length > 0 && !c.includes("$"));
    if (classes.length > 0) {
      out.push({ classes, line: lineOf(newlines, match.index) });
    }
  }
  return out;
}

/** Class names that some rule in this stylesheet gives a positive `z-index`. */
export function stackedClasses(css: string): Set<string> {
  const out = new Set<string>();
  for (const rule of extractRules(css)) {
    if (!/(?:^|[;{\s])z-index\s*:\s*(?:[1-9]\d*|var\()/.test(rule.body)) {
      continue;
    }
    for (const selector of rule.selectors) {
      for (const [, name] of selector.matchAll(SELECTOR_CLASS_RE)) {
        out.add(name!);
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------------------ the run itself --- */

/**
 * The token pairs a person has to be able to read, and the ratio each one owes.
 *
 * WCAG 2.2 SC 1.4.3 asks 4.5:1 of body text and 3:1 of large text; SC 1.4.11 asks 3:1 of the
 * boundary of a control or a piece of state. The pairs below are the ones the app actually paints —
 * a table of every possible combination would be a table nobody maintains.
 *
 * **The fallback hex is what is checked, not the resolved Spectrum token.** Resolving a token means
 * running a browser, and the fallback is what a reader sees whenever the theme has not loaded — and
 * whenever the token is renamed out from under it. Checking the value that ships is the check that
 * catches the failure.
 */
const CONTRAST_PAIRS: readonly { fg: string; bg: string; ratio: number; why: string }[] = [
  { bg: "--bg", fg: "--fg", ratio: 4.5, why: "body text on the app background" },
  { bg: "--bg-panel", fg: "--fg", ratio: 4.5, why: "body text in a panel" },
  { bg: "--bg-input", fg: "--fg", ratio: 4.5, why: "typed text in a field" },
  { bg: "--bg", fg: "--fg-dim", ratio: 4.5, why: "labels and hints — still body text" },
  { bg: "--bg-panel", fg: "--fg-dim", ratio: 4.5, why: "panel labels and hints" },
  { bg: "--accent", fg: "--accent-fg", ratio: 4.5, why: "text on an accent button" },
  { bg: "--bg", fg: "--accent", ratio: 3, why: "the focus ring and other state boundaries" },
  { bg: "--bg-panel", fg: "--danger", ratio: 3, why: "an error marker in a panel" },
  { bg: "--bg-panel", fg: "--success", ratio: 3, why: "a success marker in a panel" },
  { bg: "--bg-panel", fg: "--warning", ratio: 3, why: "a caution marker in a panel" },
];

/**
 * Pairs that do not meet their ratio today, each with the measured value.
 *
 * A ratchet, like every other allowance in this file: an entry may be deleted when the colour is
 * fixed, and adding one needs the same written justification as lowering a coverage threshold.
 */
const CONTRAST_DEBT: Readonly<Record<string, string>> = {
  /*
   * 3.68:1. White on the Jx brand blue (`--spectrum-accent-color-700`, #3b82f6) misses the 4.5:1
   * that normal-size text owes. It clears the 3:1 that SC 1.4.3 allows large text and SC 1.4.11
   * asks of a control's boundary, so an accent button's outline and any 18px+ label on it conform;
   * a 14px label on one does not.
   *
   * Left as debt rather than fixed here because the fix is a DESIGN decision with a visible
   * consequence — darkening the accent changes the brand colour everywhere it appears, and picking
   * a different foreground for accent surfaces changes what a button looks like. Neither belongs in
   * a change whose subject is the gate.
   */
  "--accent-fg on --accent": "3.68:1 — white on the brand blue; see the comment above.",
};

/** `--token: var(--spectrum-x, #hex)` — the fallback is the value this rule reads. */
const TOKEN_FALLBACK_RE =
  /^\s*(--[a-z0-9-]+):\s*var\(\s*--[a-z0-9-]+\s*,\s*(#[0-9a-fA-F]{3,8})\s*\)/gm;

/** Every studio semantic token whose declaration carries a hex fallback, from tokens.css. */
export function tokenFallbacks(css: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of css.matchAll(TOKEN_FALLBACK_RE)) {
    out.set(match[1]!, match[2]!.toLowerCase());
  }
  return out;
}

/** Expand `#abc` to `#aabbcc` and drop an alpha channel — contrast is over the composited colour. */
function normalizeHex(hex: string): string {
  const body = hex.slice(1);
  if (body.length === 3) {
    return [...body].map((c) => c + c).join("");
  }
  return body.slice(0, 6);
}

/** Relative luminance (WCAG 2.x §relative-luminance). */
function luminance(hex: string): number {
  const body = normalizeHex(hex);
  const channel = (offset: number): number => {
    const value = Number.parseInt(body.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

/**
 * Contrast ratio between two hex colours (WCAG 2.x §contrast-ratio).
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} 1 to 21.
 */
export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].toSorted((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
}

/** Check every required pair, honouring CONTRAST_DEBT. */
export function contrastFindings(css: string): Finding[] {
  const tokens = tokenFallbacks(css);
  const findings: Finding[] = [];
  for (const pair of CONTRAST_PAIRS) {
    const fg = tokens.get(pair.fg);
    const bg = tokens.get(pair.bg);
    const key = `${pair.fg} on ${pair.bg}`;
    if (!fg || !bg) {
      findings.push({
        file: "styles/tokens.css",
        line: 0,
        text: `${key} — ${!fg ? pair.fg : pair.bg} has no hex fallback, so nothing can be checked.`,
      });
      continue;
    }
    const ratio = contrastRatio(fg, bg);
    const debt = CONTRAST_DEBT[key];
    if (ratio >= pair.ratio) {
      if (debt !== undefined) {
        findings.push({
          file: "styles/tokens.css",
          line: 0,
          text: `${key} now meets ${pair.ratio}:1 (${ratio.toFixed(2)}) — delete its CONTRAST_DEBT entry.`,
        });
      }
      continue;
    }
    if (debt === undefined) {
      findings.push({
        file: "styles/tokens.css",
        line: 0,
        text: `${key} is ${ratio.toFixed(2)}:1, below the ${pair.ratio}:1 WCAG 2.2 asks of ${pair.why} (${fg} on ${bg}).`,
      });
    }
  }
  return findings;
}

/**
 * The token table in `specs/studio-ui-guidelines.md` §1.1, against `tokens.css`.
 *
 * **This is the rule that matters more than the contrast one.** The spec's table listed eight hex
 * values that no longer existed anywhere in the app — `#1e1e1e` for `--bg` where the app ships
 * `#111111`, `#007acc` for `--accent` where it ships `#3b82f6` — so anyone designing against the
 * documented palette was designing against a palette that had been gone for months. Correcting them
 * without a gate only resets the clock, which is why the correction and the check land together.
 */
export function guidelineTokenFindings(specMd: string, css: string): Finding[] {
  const tokens = tokenFallbacks(css);
  const findings: Finding[] = [];
  const rowRe = /^\|\s*`(--[a-z0-9-]+)`\s*\|[^|]*\|\s*`([^`]+)`\s*\|/gm;
  let rows = 0;
  for (const match of specMd.matchAll(rowRe)) {
    const [, token, documented] = match;
    rows += 1;
    const actual = tokens.get(token!);
    if (actual === undefined) {
      /*
       * Not every documented token carries a hex fallback — `--radius` is a Spectrum token with a
       * `3px` fallback and `--hover-bg` is a literal `rgba()`. The documented value is compared
       * against the declaration OR the fallback inside it, whitespace-insensitively: a spec that
       * writes `3px` for `var(--spectrum-corner-radius-100, 3px)` is telling the truth about what a
       * reader gets, and holding it to the declaration's exact text would only teach people to
       * ignore this rule.
       */
      const declared = new RegExp(`${token}:\\s*([^;]+);`).exec(css)?.[1]?.trim();
      if (declared === undefined) {
        continue;
      }
      const fallback = /var\(\s*--[a-z0-9-]+\s*,\s*([^)]+)\)/.exec(declared)?.[1]?.trim();
      const squash = (value: string) => value.replaceAll(/\s+/g, "");
      const wanted = squash(documented!);
      if (squash(declared) !== wanted && (fallback === undefined || squash(fallback) !== wanted)) {
        findings.push({
          file: "specs/studio-ui-guidelines.md",
          line: 0,
          text: `${token} is documented as \`${documented}\` but tokens.css declares \`${declared}\`.`,
        });
      }
      continue;
    }
    if (actual !== documented!.toLowerCase()) {
      findings.push({
        file: "specs/studio-ui-guidelines.md",
        line: 0,
        text: `${token} is documented as ${documented} but tokens.css ships ${actual}.`,
      });
    }
  }
  if (rows === 0) {
    findings.push({
      file: "specs/studio-ui-guidelines.md",
      line: 0,
      text: "§1.1's token table parsed to zero rows — the table moved, and this rule stopped checking anything.",
    });
  }
  return findings;
}

export interface StyleCheckResult {
  hexErrors: Finding[];
  pxWarnings: Finding[];
  /** Emitted-but-undefined classes, first emission site, excluding ALLOWED_ORPHANS. */
  orphans: Finding[];
  /** ALLOWED_ORPHANS entries that are now defined (or no longer emitted) — the ratchet. */
  staleAllowed: string[];
  /** Every orphan including the allow-listed ones, for regenerating the list. */
  allOrphans: Finding[];
  /** `src/` mentions of a BANNED_IDENTIFIERS name, in code (not prose). */
  banned: Finding[];
  /** Files whose bare-empty-catch count disagrees with SILENT_CATCH_BUDGET, either way. */
  silentCatches: { file: string; found: number; allowed: number }[];
  /** Unallowed `outline: none`, and allowances whose `:focus-visible` restore has gone. */
  focusRings: Finding[];
  /** FOCUS_RING_ALLOWANCES entries that suppress nothing any more — the ratchet. */
  staleFocusRings: string[];
  /** Modal cards opened beside an `sp-underlay` that no rule lifts above it. */
  underScrim: Finding[];
  /** Required token pairs that miss the ratio WCAG 2.2 asks of them. */
  contrast: Finding[];
  /** Rows of `studio-ui-guidelines.md` §1.1 that disagree with `tokens.css`. */
  guidelineTokens: Finding[];
}

function isVendorClass(name: string): boolean {
  return VENDOR_CLASS_PREFIXES.some((p) => name.startsWith(p));
}

/** Run both rules over a studio package directory. */
/**
 * Every repo-relative path this module reports or looks up, forward-slashed.
 *
 * `Glob.scan` yields the platform separator, so on Windows the walks below produced
 * `src\panels\x.ts` while every budget and allow-list in this file is written with `/` — each file
 * read as unlisted and each budget entry as stale, so the gate was noise there while staying
 * correct on CI's Linux.
 */
function scanned(rel: string): string {
  return rel.replaceAll("\\", "/");
}

export async function collect(root: string): Promise<StyleCheckResult> {
  const hexErrors: Finding[] = [];
  const pxWarnings: Finding[] = [];
  const defined = new Set<string>();
  /** Class → first emission site. */
  const emitted = new Map<string, Finding>();

  const read = (rel: string): Promise<string> => Bun.file(join(root, rel)).text();

  const focusRings: Finding[] = [];
  const suppressedRings = new Set<string>();
  /** Classes some rule gives a positive z-index — the underlay-stacking rule's evidence. */
  const stacked = new Set<string>();
  /** Every card opened beside an `sp-underlay`, with where it was opened. */
  const underlayCards: { file: string; line: number; classes: string[] }[] = [];
  const scanStacking = (css: string): void => {
    for (const name of stackedClasses(css)) {
      stacked.add(name);
    }
  };
  /** Run the focus-ring rule over one stylesheet, accumulating both halves of its answer. */
  const scanRings = (rel: string, css: string): void => {
    const { findings, suppressed } = checkFocusRings(rel, css);
    focusRings.push(...findings);
    for (const key of suppressed) {
      suppressedRings.add(key);
    }
  };

  for (const rel of ["index.html", "canvas.html"]) {
    const source = await read(rel);
    const { errors, warnings } = scanHex(rel, source);
    hexErrors.push(...errors);
    pxWarnings.push(...warnings);
    scanRings(rel, cssOfHtml(source));
    scanStacking(cssOfHtml(source));
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
  for await (const raw of new Glob("styles/*.css").scan(root)) {
    const rel = scanned(raw);
    const source = await read(rel);
    const { errors, warnings } = scanHex(rel, source);
    hexErrors.push(...errors);
    pxWarnings.push(...warnings);
    scanRings(rel, source);
    scanStacking(source);
    for (const name of extractDefinedClasses(source)) {
      defined.add(name);
    }
  }

  for await (const raw of new Glob("src/**/*.css").scan(root)) {
    const rel = scanned(raw);
    const source = await read(rel);
    scanRings(rel, source);
    scanStacking(source);
    for (const name of extractDefinedClasses(source)) {
      defined.add(name);
    }
  }

  const banned: Finding[] = [];
  /** Path → bare empty catches actually present. Compared with the budget after the walk. */
  const bareCatches = new Map<string, number>();

  for await (const raw of new Glob("src/**/*.ts").scan(root)) {
    const rel = scanned(raw);
    const source = await read(rel);
    const { errors, warnings } = scanHex(rel, source);
    hexErrors.push(...errors);
    pxWarnings.push(...warnings);

    // The identifier rule reads CODE only — `services/notify.ts` and `panels/statusbar.ts` both
    // Explain in prose what they replaced, and a rule that could not tell code from commentary
    // Would force those two files to be coy about it. The catch rule reads the RAW source, because
    // There a comment is the answer rather than noise.
    banned.push(...scanBannedIdentifiers(rel, stripCommentsAndStrings(source)));
    const bare = countBareCatches(source);
    if (bare > 0) {
      bareCatches.set(rel, bare);
    }

    for (const css of extractCssTemplates(source)) {
      scanStacking(css);
      for (const name of extractDefinedClasses(css)) {
        defined.add(name);
      }
    }
    for (const card of extractUnderlayCards(source)) {
      underlayCards.push({ classes: card.classes, file: rel, line: card.line });
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

  const silentCatches: StyleCheckResult["silentCatches"] = [];
  for (const file of new Set([...bareCatches.keys(), ...Object.keys(SILENT_CATCH_BUDGET)])) {
    const found = bareCatches.get(file) ?? 0;
    const allowed = SILENT_CATCH_BUDGET[file] ?? 0;
    if (found !== allowed) {
      silentCatches.push({ allowed, file, found });
    }
  }

  /* An `sp-underlay` paints at `z-index: 1`. A card beside it at `auto` is therefore UNDER its own
     scrim — visible through it, and unclickable, which is how a blocking progress modal shipped
     with its only exit button unpressable. One rule anywhere giving one of the card's classes a
     positive z-index is enough; this asks for evidence, not for a particular number. */
  const underScrim: Finding[] = underlayCards
    .filter((card) => !card.classes.some((name) => stacked.has(name)))
    .map((card) => ({
      file: card.file,
      line: card.line,
      text:
        `.${card.classes.join(".")} is opened beside an <sp-underlay> but no rule stacks it. ` +
        `The scrim paints at z-index 1, so the surface is under it: visible, and every click ` +
        `lands on the underlay. Give the card a z-index.`,
    }));

  const staleFocusRings = FOCUS_RING_ALLOWANCES.filter(
    (a) => !suppressedRings.has(focusKey(a.file, normalizeSelector(a.selector))),
  )
    .map((a) => focusKey(a.file, a.selector))
    .toSorted();

  const tokensCss = await Bun.file(join(root, "styles", "tokens.css"))
    .text()
    .catch(() => "");
  const guidelinesMd = await Bun.file(join(root, "..", "..", "specs", "studio-ui-guidelines.md"))
    .text()
    .catch(() => "");

  return {
    contrast: tokensCss === "" ? [] : contrastFindings(tokensCss),
    guidelineTokens:
      tokensCss === "" || guidelinesMd === ""
        ? []
        : guidelineTokenFindings(guidelinesMd, tokensCss),
    hexErrors,
    pxWarnings,
    orphans: allOrphans.filter((o) => !ALLOWED_ORPHANS.has(o.text)),
    staleAllowed,
    allOrphans,
    banned,
    silentCatches: silentCatches.toSorted((a, b) => a.file.localeCompare(b.file)),
    focusRings,
    staleFocusRings,
    underScrim,
  };
}

/** Print the findings and return the process exit code. */
export function report(result: StyleCheckResult): number {
  const { hexErrors, pxWarnings, orphans, staleAllowed, banned, silentCatches } = result;
  const { focusRings, staleFocusRings, underScrim, contrast, guidelineTokens } = result;

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

  if (banned.length > 0) {
    console.error(
      `\n❌ ${banned.length} use(s) of an identifier src/ may not name. An outcome is a ` +
        `notification with a severity and (where recovery exists) a command id — not a line of ` +
        `grey text that erases itself.`,
    );
    for (const b of banned) {
      console.error(`   ${b.file}:${b.line}  ${b.text}`);
    }
  }

  if (silentCatches.length > 0) {
    console.error(
      `\n❌ ${silentCatches.length} file(s) disagree with SILENT_CATCH_BUDGET. An empty catch ` +
        `must either reach a surface (notify.*) or say out loud that it will not ` +
        `(// intentionally ignored: <reason>).`,
    );
    for (const c of silentCatches) {
      console.error(
        c.found > c.allowed
          ? `   ${c.file}  ${c.found} bare empty catch(es), ${c.allowed} allowed`
          : `   ${c.file}  down to ${c.found} — lower its SILENT_CATCH_BUDGET entry from ${c.allowed}`,
      );
    }
  }

  if (focusRings.length > 0) {
    console.error(
      `\n❌ ${focusRings.length} focus-ring problem(s). A control whose outline is removed must ` +
        `get it back under :focus-visible, and FOCUS_RING_ALLOWANCES must name the rule that ` +
        `does — that pairing is what keeps deleting the restore from being silent.`,
    );
    for (const f of focusRings) {
      console.error(`   ${f.file}:${f.line}  ${f.text}`);
    }
  }

  if (staleFocusRings.length > 0) {
    console.error(
      `\n❌ ${staleFocusRings.length} stale FOCUS_RING_ALLOWANCES entry(ies) — these selectors no ` +
        `longer remove the ring, so delete them from the list (it only ratchets down):`,
    );
    for (const name of staleFocusRings) {
      console.error(`   ${name}`);
    }
  }

  if (underScrim.length > 0) {
    console.error(
      `\n❌ ${underScrim.length} modal card(s) opened under their own scrim. <sp-underlay> paints ` +
        `at z-index 1, so a card beside it at auto is visible THROUGH the scrim and unclickable — ` +
        `which shipped a blocking progress modal whose only exit could not be pressed.`,
    );
    for (const u of underScrim) {
      console.error(`   ${u.file}:${u.line}  ${u.text}`);
    }
  }

  if (contrast.length > 0) {
    console.error(
      `\n❌ ${contrast.length} token pair(s) below the contrast WCAG 2.2 asks of them:`,
    );
    for (const c of contrast) {
      console.error(`   ${c.text}`);
    }
    console.error(
      `\nFix the colour, or add the pair to CONTRAST_DEBT with the measured ratio and a reason.`,
    );
  }

  if (guidelineTokens.length > 0) {
    console.error(
      `\n❌ ${guidelineTokens.length} row(s) of studio-ui-guidelines.md §1.1 disagree with ` +
        `styles/tokens.css. Anyone designing against the documented palette is designing against ` +
        `one the app does not ship:`,
    );
    for (const g of guidelineTokens) {
      console.error(`   ${g.text}`);
    }
  }

  if (
    underScrim.length > 0 ||
    contrast.length > 0 ||
    guidelineTokens.length > 0 ||
    hexErrors.length > 0 ||
    orphans.length > 0 ||
    staleAllowed.length > 0 ||
    banned.length > 0 ||
    silentCatches.length > 0 ||
    focusRings.length > 0 ||
    staleFocusRings.length > 0
  ) {
    return 1;
  }

  const pxNote = pxWarnings.length > 0 ? ` (${pxWarnings.length} px token nudge(s) above)` : "";
  const silentTotal = Object.values(SILENT_CATCH_BUDGET).reduce((a, b) => a + b, 0);
  console.log(
    `✓ check-styles: no hard-coded colours, no undefined classes ` +
      `(${ALLOWED_ORPHANS.size} allow-listed orphan(s) remaining), no banned identifiers, ` +
      `${silentTotal} allow-listed silent catch(es) remaining, ` +
      `${FOCUS_RING_ALLOWANCES.length} focus-ring suppression(s) each paired with its ` +
      `:focus-visible restore, every underlay-bearing card stacked above its scrim, ` +
      `${CONTRAST_PAIRS.length} contrast pair(s) checked ` +
      `(${Object.keys(CONTRAST_DEBT).length} on the debt list), ` +
      `and studio-ui-guidelines.md §1.1 agrees with tokens.css${pxNote}.`,
  );
  return 0;
}

if (import.meta.main) {
  process.exit(report(await collect(ROOT)));
}
