/**
 * Guard the template layer against the two ways a lit binding stops being the truth.
 *
 * Studio is already a lit app — 92 render roots, `data-jx-region` stamped from templates,
 * `classMap` and `ref` throughout. What it lacked was a rule about where the template's authority
 * ends, and both failures this file checks shipped because of that:
 *
 * - A Spectrum control bound by ATTRIBUTE. `sp-textfield`, `sp-picker` and friends do not reflect
 *   `value` (nor `sp-accordion-item` its `open`), and they mutate that property themselves when the
 *   reader touches them. So lit commits an attribute, the component moves the property, and the
 *   next render carrying the value lit already wrote is dirty-checked away — the write it needed to
 *   make is the one it skips. `.value=${live(x)}` compares against the live property and cannot be
 *   fooled. The bug is invisible: nothing throws, the control simply keeps a value the document
 *   does not have.
 * - A module reaching a node it renders itself, by selector. The node is real until the next render
 *   replaces it, and then the handle is detached or the query finds a sibling pane's copy instead.
 *   `packages/studio/src/panels/target-line.ts` states the rule in its own header — "a module-local
 *   handle rather than a querySelector at call time" — and `ref()` is how you get one.
 *
 * Both rules FAIL BOTH WAYS, in this package's idiom (see `scripts/check-pane-singletons.ts` and
 * `scripts/check-styles.ts`'s ALLOWED_ORPHANS): a new occurrence fails, and an allow-list entry
 * that has been fixed fails too. The lists can only ratchet down, and every entry carries a reason
 * rather than a bare count, because a bare number cannot be told apart from an oversight.
 *
 * What is deliberately NOT checked, and why, is {@link EXCLUDED} — the canvas. Those modules are
 * imperative by design, not by neglect, and an allow-list entry is how that gets said out loud
 * instead of looking like a gap.
 *
 * Source-only: no build, no type-checker, runs in about a second. Wired into the CI `checks` job.
 */

import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");

// ─── Rule 1: Spectrum controls bind their self-mutated state as a live property ──────────────

/**
 * Spectrum elements that own a piece of state the reader can change directly. The list is not
 * "every SWC element" — it is the ones whose own interaction writes a property lit also writes.
 */
const SWC_SELF_MUTATING =
  /sp-(?:picker|textfield|textarea|search|number-field|combobox|checkbox|switch|slider|radio|accordion-item)/
    .source;

/** The properties those elements move behind lit's back. */
const GUARDED_PROPS = ["value", "checked", "open"] as const;

export interface Finding {
  /** Workspace-relative path, POSIX. */
  file: string;
  line: number;
  detail: string;
}

/** Walk a `${` at `i`, returning the expression text and the index just past its `}`. */
function readExpression(source: string, i: number): { expr: string; end: number } | null {
  if (source.slice(i, i + 2) !== "${") {
    return null;
  }
  let depth = 0;
  let j = i + 1;
  while (j < source.length) {
    const c = source[j]!;
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      j += 1;
      while (j < source.length && source[j] !== quote) {
        j += source[j] === "\\" ? 2 : 1;
      }
    } else if (c === "{") {
      depth += 1;
    } else if (c === "}") {
      depth -= 1;
      if (depth === 0) {
        return { expr: source.slice(i + 2, j), end: j + 1 };
      }
    }
    j += 1;
  }
  return null;
}

/** The opening-tag text of every self-mutating Spectrum element in `source`, with its line. */
function spectrumOpenTags(source: string): { tag: string; attrs: string; line: number }[] {
  const out: { tag: string; attrs: string; line: number }[] = [];
  for (const m of source.matchAll(new RegExp(String.raw`<(${SWC_SELF_MUTATING})\b`, "g"))) {
    let k = m.index + m[0].length;
    let depth = 0;
    while (k < source.length) {
      const c = source[k]!;
      if (c === "{") {
        depth += 1;
      } else if (c === "}") {
        depth -= 1;
      } else if (c === ">" && depth <= 0) {
        break;
      }
      k += 1;
    }
    out.push({
      attrs: source.slice(m.index + m[0].length, k),
      line: source.slice(0, m.index).split("\n").length,
      tag: m[1]!,
    });
  }
  return out;
}

/**
 * Bindings on a self-mutating Spectrum control that lit cannot be trusted to re-commit: an
 * attribute binding, or a property binding without {@link live}.
 *
 * A constant (`.open=${false}`) is not a finding — there is nothing for the component to diverge
 * from.
 */
export function unguardedSpectrumBindings(file: string, source: string): Finding[] {
  const found: Finding[] = [];
  for (const { tag, attrs, line } of spectrumOpenTags(source)) {
    for (const prop of GUARDED_PROPS) {
      const asProperty = new RegExp(String.raw`\.` + prop + String.raw`=(?=\$\{)`).exec(attrs);
      const asAttribute = new RegExp(String.raw`(?<![.\w])\??` + prop + String.raw`=(?=\$\{)`).exec(
        attrs,
      );
      const at = asProperty ?? asAttribute;
      if (!at) {
        continue;
      }
      const read = readExpression(attrs, at.index + at[0].length);
      const expr = (read?.expr ?? "").trim();
      if (expr === "true" || expr === "false" || expr === "nothing") {
        continue;
      }
      if (asProperty && expr.startsWith("live(")) {
        continue;
      }
      found.push({
        detail: asProperty
          ? `<${tag}> binds .${prop} without live()`
          : `<${tag}> binds ${prop} as an attribute`,
        file,
        line,
      });
    }
  }
  return found;
}

// ─── Rule 2: a module does not reach its own rendered nodes by selector ──────────────────────

/** Class names this module emits from a template — `class="a b"`, and `classMap` keys. */
export function emittedClasses(source: string): Set<string> {
  const names = new Set<string>();
  for (const m of source.matchAll(/\bclass=(["'`])([^"'`$]*)\1/g)) {
    for (const token of m[2]!.split(/\s+/)) {
      if (token) {
        names.add(token);
      }
    }
  }
  for (const m of source.matchAll(/classMap\(\{([^}]*)\}/g)) {
    for (const k of m[1]!.matchAll(
      /[{,]?\s*(?:"([^"\n]+)"|'([^'\n]+)'|([A-Za-z_$][\w$-]*))\s*:/g,
    )) {
      const name = k[1] ?? k[2] ?? k[3];
      if (name) {
        names.add(name);
      }
    }
  }
  return names;
}

/**
 * `querySelector`/`querySelectorAll` calls naming a class this same module renders.
 *
 * Scoped to a literal `.class` selector on purpose. An attribute or tag selector is usually
 * reaching into something else's DOM (Spectrum's shadow root, Tabulator's cells, the canvas
 * iframe), which is a different act and not this rule's business.
 */
export function selfQueries(file: string, source: string): Finding[] {
  const mine = emittedClasses(source);
  if (mine.size === 0) {
    return [];
  }
  const found: Finding[] = [];
  for (const m of source.matchAll(/querySelector(?:All)?(?:<[^>]*>)?\(\s*(["'`])([^"'`$]+)\1/g)) {
    for (const cls of m[2]!.matchAll(/\.([A-Za-z_][\w-]*)/g)) {
      if (mine.has(cls[1]!)) {
        found.push({
          detail: `queries .${cls[1]} — a class this module renders; use ref()`,
          file,
          line: source.slice(0, m.index).split("\n").length,
        });
        break;
      }
    }
  }
  return found;
}

// ─── The excluded zone, said out loud ────────────────────────────────────────────────────────

/**
 * Modules the rules do not apply to, each with the reason.
 *
 * These are imperative BY DESIGN. The canvas patcher exists so that nothing re-renders on an edit;
 * the overlay and drag-ghost place boxes per pointer-move against measured geometry; the iframe
 * modules run in another realm that lit does not reach at all. Applying a template rule to them
 * would not improve them, and leaving them merely unmentioned would read as an oversight.
 */
export const EXCLUDED: Record<string, string> = {
  "canvas/canvas-patcher.ts":
    "classifies document ops so that nothing re-renders; contains no DOM and no markup",
  "canvas/canvas-utils.ts":
    "measure-then-write pan/zoom geometry, including the hard invariant that applyEditZoom must " +
    "never trigger a canvas re-render (it would destroy a live inline-edit session)",
  "canvas/iframe-host.ts":
    "owns the canvas iframe and its overlay children through replaceChildren, on per-pointer-move " +
    "hot paths, behind a token and origin handshake",
  "canvas/iframe-overlay.ts":
    "places selection, hover and drop boxes per pointer-move; one pointer-events:auto button whose " +
    "listeners are bound once and whose hover flag vetoes a later-arriving hide",
  "panels/drag-ghost.ts":
    "one reused position:fixed element moved every pointermove, deliberately outside the scaled wrap",
  "utils/geometry.ts": "the measurement funnel; tests/geometry.test.ts already guards it",
};

/** Everything under these prefixes is excluded for the reason on the prefix. */
const EXCLUDED_PREFIXES: Record<string, string> = {
  "canvas/iframe-": "runs in the canvas realm, rendered by the runtime rather than by lit",
};

function isExcluded(file: string): boolean {
  return (
    file in EXCLUDED || Object.keys(EXCLUDED_PREFIXES).some((prefix) => file.startsWith(prefix))
  );
}

// ─── The debt, which only shrinks ────────────────────────────────────────────────────────────

/**
 * Spectrum bindings not yet moved onto the live property — a **shrinking backlog**, not a
 * configuration knob.
 *
 * Every entry is a surface where the reader can move a control the template also writes, and the
 * count is what stops a new one being added quietly beside an existing one. The check fails both
 * ways: a count that grows fails, and a count left high after a site is fixed fails too, so the
 * list can only ratchet down. Discharge an entry by binding `.prop=${live(expr)}` and lowering the
 * number in the same change.
 *
 * Most are here because divergence has not been DEMONSTRATED, not because it is impossible — a
 * one-shot dialog has no re-render for the dirty-check to skip. Inline comments mark the files
 * where there is something more specific to say.
 */
export const SPECTRUM_DEBT: Record<string, number> = {
  "browse/library-pane.ts": 2,
  "editor/convert-to-component.ts": 1,
  "editor/convert-to-repeater.ts": 4,
  "files/files.ts": 1,
  "new-project/add-repo-modal.ts": 1,
  "new-project/location-fields.ts": 5,
  "new-project/new-project-modal.ts": 2,
  "panels/block-action-bar.ts": 1,
  "panels/elements-panel.ts": 3,
  "panels/events-panel.ts": 3,
  "panels/head-panel.ts": 1,
  "panels/imports-panel.ts": 2,
  "panels/pane-context.ts": 5,
  "panels/properties-panel.ts": 4,
  "panels/signals-panel.ts": 3,
  "panels/statement-editor.ts": 2,
  /* The five connect-form fields over a mutable module `_form`, re-rendered from loadConnection,
     hostedConnect and the error paths. Converting is safe, but this file also carries the rule that
     a surface never renders back the secret it describes, so it is triaged with that in view. */
  "publish/publish-panel.ts": 5,
  "settings/contexts-section.ts": 1,
  "settings/contributed-section.ts": 2,
  "settings/css-vars-editor.ts": 2,
  "settings/defs-editor.ts": 1,
  "settings/dependencies-editor.ts": 1,
  "settings/head-editor.ts": 5,
  "settings/locales-section.ts": 3,
  "settings/preferences-dialog.ts": 1,
  "settings/project-sections.ts": 2,
  /* Content-type field cards. Rebuilt wholesale on every edit today, so the reader has no window
     in which to diverge — which is why they are here rather than fixed. */
  "settings/schema-field-ui.ts": 9,
  "ui/color-selector.ts": 1,
  /* `value=${refVal || nothing}` — the attribute form is load-bearing here: `nothing` REMOVES the
     attribute, and sp-picker shows its placeholder. A property binding sets undefined instead,
     which needs checking against the real component before it is called equivalent. */
  "ui/dynamic-slot.ts": 1,
  "ui/expression-editor.ts": 1,
  "ui/field-row.ts": 2,
  "ui/form-controls.ts": 2,
  "ui/layers.ts": 1,
  /* The generic schema-driven form: ten controls whose shapes come from a JSON Schema rather than
     from this file, so each needs its own answer about what the reader can diverge. */
  "ui/schema-form.ts": 10,
};

/**
 * Selector reads of a module's own rendered nodes — same discipline, same ratchet.
 *
 * Discharge an entry by taking a handle with `ref()` at the site that renders the node, as
 * `src/panels/target-line.ts` describes, and lowering the number. Note that a legitimately
 * imperative USE — a measurement, a scrollIntoView, a focus move — is not what this rule objects
 * to; it objects to re-finding the node by selector every time instead of holding it.
 */
export const SELF_QUERY_DEBT: Record<string, number> = {
  "browse/library-pane.ts": 1,
  /* Four windowed-row lookups and drag guards. The fifth was the WeakSet-guarded keydown, which
     existed only because the unguarded version accumulated a listener per render — "after ten
     repaints a single Down keystroke walked ten rows". `@keydown` on the tree deleted the
     workaround, the deps entry that carried it, and the query, all at once. */
  "files/files.ts": 4,
  "new-project/new-project-modal.ts": 1,
  "panels/block-action-bar.ts": 3,
  "panels/bottom-dock.ts": 1,
  "panels/editors.ts": 1,
  /* The per-row `.layer-actions` sub-root is a deliberate second render tree so hovering does not
     repaint the whole outline; the others are drag guards and windowed-row lookups. */
  "panels/layers-panel.ts": 4,
  "panels/left-panel.ts": 1,
  "panels/pane-context.ts": 1,
  "panels/statement-editor.ts": 1,
  /* Four reads of the strip and its chips, all for MEASUREMENT (scrollWidth, offsetLeft) or
     scrollIntoView. The uses stay imperative; it is the acquisition that wants one per-pane ref. */
  "panels/tab-strip.ts": 4,
  "settings/schema-field-ui.ts": 1,
  /* `isColorPopoverOpen()` derives modality from the live DOM, document-wide, and right-panel
     calls it as a blockWhile on every scheduled render. State read back out of markup. */
  "ui/color-selector.ts": 1,
  "ui/field-row.ts": 1,
  "ui/value-selector.ts": 1,
};

// ─── Runner ──────────────────────────────────────────────────────────────────────────────────

export interface Report {
  spectrum: Finding[];
  selfQuery: Finding[];
  staleSpectrum: string[];
  staleSelfQuery: string[];
  unknownExclusions: string[];
}

export function analyze(root = SRC): Report {
  const files = [...new Glob("**/*.ts").scanSync(root)]
    .map((f) => f.replaceAll("\\", "/"))
    .toSorted();
  const spectrum: Finding[] = [];
  const selfQuery: Finding[] = [];
  const spectrumBy = new Map<string, number>();
  const selfQueryBy = new Map<string, number>();

  for (const file of files) {
    if (isExcluded(file)) {
      continue;
    }
    const source = readFileSync(join(root, file), "utf8");
    const s = unguardedSpectrumBindings(file, source);
    const q = selfQueries(file, source);
    if (s.length > 0) {
      spectrumBy.set(file, s.length);
    }
    if (q.length > 0) {
      selfQueryBy.set(file, q.length);
    }
    spectrum.push(...s.filter(() => (SPECTRUM_DEBT[file] ?? 0) === 0));
    selfQuery.push(...q.filter(() => (SELF_QUERY_DEBT[file] ?? 0) === 0));
  }

  // Over budget in a file that has one: report the excess, named.
  for (const [file, actual] of spectrumBy) {
    const allowed = SPECTRUM_DEBT[file] ?? 0;
    if (allowed > 0 && actual > allowed) {
      spectrum.push({
        detail: `${actual} unguarded Spectrum binding(s), ${allowed} allowed`,
        file,
        line: 0,
      });
    }
  }
  for (const [file, actual] of selfQueryBy) {
    const allowed = SELF_QUERY_DEBT[file] ?? 0;
    if (allowed > 0 && actual > allowed) {
      selfQuery.push({ detail: `${actual} self-queries, ${allowed} allowed`, file, line: 0 });
    }
  }

  const known = new Set(files);
  return {
    selfQuery,
    spectrum,
    staleSelfQuery: Object.entries(SELF_QUERY_DEBT)
      .filter(([f, n]) => (selfQueryBy.get(f) ?? 0) < n)
      .map(([f, n]) => `${f} (allows ${n}, found ${selfQueryBy.get(f) ?? 0})`),
    staleSpectrum: Object.entries(SPECTRUM_DEBT)
      .filter(([f, n]) => (spectrumBy.get(f) ?? 0) < n)
      .map(([f, n]) => `${f} (allows ${n}, found ${spectrumBy.get(f) ?? 0})`),
    unknownExclusions: Object.keys(EXCLUDED).filter((f) => !known.has(f)),
  };
}

/** One rule's report, as lines. Pure, so the runner is a join and the tests need no console spy. */
export function reportLines(
  findings: readonly Finding[],
  heading: string,
  advice: string,
): string[] {
  if (findings.length === 0) {
    return [];
  }
  return [
    "",
    heading,
    "",
    ...findings
      .toSorted((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
      .map((f) => `  src/${f.file}${f.line > 0 ? `:${f.line}` : ""} — ${f.detail}`),
    "",
    `  ${advice}`,
  ];
}

/** The whole report, and whether it is a failure. */
export function report(r: Report): { lines: string[]; failed: boolean } {
  const lines = [
    ...reportLines(
      r.spectrum,
      "Spectrum controls bound so that lit cannot re-commit them:",
      "These components move `value` / `checked` / `open` themselves and do not reflect them, so " +
        "an attribute binding — or a property binding without live() — is dirty-checked away " +
        "exactly when it was needed. Bind `.prop=${live(expr)}`, or add the file to SPECTRUM_DEBT " +
        "with the reason it cannot be.",
    ),
    ...reportLines(
      r.selfQuery,
      "Modules reaching their own rendered nodes by selector:",
      "The node is only real until the next render, and with a second pane the query can find " +
        "someone else's. Take a handle with ref(), as src/panels/target-line.ts describes, or add " +
        "the file to SELF_QUERY_DEBT with the reason.",
    ),
  ];
  for (const [label, stale] of [
    ["SPECTRUM_DEBT", r.staleSpectrum],
    ["SELF_QUERY_DEBT", r.staleSelfQuery],
  ] as const) {
    if (stale.length > 0) {
      lines.push(
        "",
        `Stale ${label} entr(ies) — the list only ratchets down:`,
        "",
        ...stale.map((s) => `  ${s}`),
        "",
        "  Lower the count, or delete the entry.",
      );
    }
  }
  if (r.unknownExclusions.length > 0) {
    lines.push(
      "",
      "EXCLUDED names files that no longer exist:",
      "",
      ...r.unknownExclusions.map((f) => `  ${f}`),
    );
  }
  if (lines.length > 0) {
    return { failed: true, lines };
  }
  const debt =
    Object.values(SPECTRUM_DEBT).reduce((a, n) => a + n, 0) +
    Object.values(SELF_QUERY_DEBT).reduce((a, n) => a + n, 0);
  return {
    failed: false,
    lines: [
      `✓ check-lit-conventions: Spectrum state binds live, no module queries its own nodes ` +
        `(${debt} allow-listed site(s) remaining, ${Object.keys(EXCLUDED).length} module(s) excluded ` +
        `by design).`,
    ],
  };
}

if (import.meta.main) {
  const { failed, lines } = report(analyze());
  console.log(lines.join("\n"));
  process.exit(failed ? 1 : 0);
}
