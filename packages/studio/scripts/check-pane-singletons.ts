/**
 * Guard the pane grid against the singletons it exists to remove.
 *
 * A pane is the unit of split, focus, zoom and RENDER (§4.1), so everything a stage owns — its
 * pan/zoom wrap, its centering observer, its pan offsets, its source-view Monaco, its render
 * generation — is a field of one pane's `CanvasSurface`, and everything drawn INTO a stage — the
 * grid engine, the Library, the entry form, the Project Settings editor, the Document Header card —
 * is one instance per pane. Both were app-level singletons, and both are the same defect: a fact
 * about one pane stored where only one pane can have it.
 *
 * **Neither can be caught by the type system, which is the whole reason this file exists.**
 * `ViewState` carries `[key: string]: unknown`, so `view.panX` is not an error — it is a silently
 * `unknown` read that `as number` makes compile. And a module-level `let active` is perfectly
 * well-typed; it is only wrong because there are two stages.
 *
 * Four rules, all in this package's own idiom (`scripts/check-styles.ts`'s `ALLOWED_ORPHANS`), and
 * all failing BOTH ways: a new occurrence fails, and a stale allow-list entry fails too, so the
 * lists can only ratchet down.
 *
 * **The third rule is the general form of the first, and it exists because the first was a list of
 * NAMES.** `BANNED_VIEW_FIELDS` catches per-stage state that used to live on `view`; the pan/zoom
 * SCALE never did. It was injected into `canvas/canvas-utils.ts` through `initCanvasUtils`, spelled
 * `activeTab.value?.session.ui.zoom` in the bootstrap — so a module whose every geometry function
 * took an explicit `CanvasSurface` still read and wrote ONE pane's zoom, and this checker was
 * silent about it through the whole of P8. Four visible failures came out of that silence: the
 * unfocused pane drew at the focused tab's scale, the side pane's `+` zoomed the primary's
 * document, the unfocused zoom pod reported the focused pane's fit, and a pane entering Design
 * re-fitted the other one.
 *
 * So the rule that is checked is the one that was meant all along — **per-stage state is reached
 * through a surface** — and its mechanical form is: in the modules that compute stage geometry, the
 * FOCUSED tab is not an input. `activeTab` there means "whatever pane the keyboard is in", which is
 * never what a transform, a fit or a content zoom is about. The residue in the allow-list is the
 * command verbs, where "the active pane" is the whole meaning of the request.
 *
 * **The FOURTH rule is the general form of the third, and it exists because the third was a list of
 * FILES.** See {@link focusReadsInPaneScope}: a function that has been handed a `paneId` or a
 * `CanvasSurface` may not consult the focus in its body, wherever in `src/` it lives. Rule 3 named
 * one module; the pane context bar was in another, and wrote nine controls through
 * `activeTab.value` for a pane it was not drawing.
 *
 * Run: bun scripts/check-pane-singletons.ts
 */

import { Glob } from "bun";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");

/**
 * The `view` fields that moved onto `CanvasSurface`. Reading one back is the regression.
 *
 * They are listed by NAME rather than by absence from `view.ts`, because the index signature means
 * re-adding one would type-check everywhere and the guard has to be able to say what went wrong.
 */
export const BANNED_VIEW_FIELDS = [
  "panzoomWrap",
  "centerObserver",
  "needsCenter",
  "panX",
  "panY",
  "monacoEditor",
  "renderGeneration",
] as const;

/**
 * How many banned reads each file is still allowed. Empty: the inventory is cleared.
 *
 * Kept as a table rather than deleted so a re-introduction lands as a diff to THIS file, where the
 * reviewer is looking at a list of things that must not come back.
 */
export const ALLOWED_VIEW_READS: Readonly<Record<string, number>> = {};

/** Where a per-stage field would be read from. */
const VIEW_SCAN = [
  "src/canvas/**/*.ts",
  "src/editor/shortcuts.ts",
  "src/panels/stylebook-panel.ts",
  "src/panels/block-action-bar.ts",
  "src/studio.ts",
];

/**
 * The modules that draw INTO a stage, and how many module-level instances each may still hold.
 *
 * Every one of them was a `let active` / `let _host`: pane B mounting its content ran the module's
 * unconditional `detach*()` and destroyed pane A's — and `canvas-render.ts`'s `resetCanvasView`
 * calls those detaches on every pane that empties, so it never took a second instance of the same
 * editor to do it. Two Code panes were the worst of them: `disposeSourceEditor` committed a buffer
 * parsed against a model belonging to a different document.
 *
 * Empty: all six are keyed by pane id.
 */
export const ALLOWED_SINGLE_INSTANCE: Readonly<Record<string, number>> = {};

/**
 * How many `activeTab` reads each geometry module may still make. One: `requireTab`, in the canvas
 * view COMMANDS, whose subject is the focused pane by definition.
 *
 * The import statement counts too — it is how the name gets into the file — so the single allowed
 * occurrence in `canvas-utils.ts` is the import, and the one call site is `requireTab`'s. Both are
 * counted because the rule is "this module does not consult the focus", and a file that imports the
 * binding is a file that can.
 */
export const ALLOWED_ACTIVE_TAB_READS: Readonly<Record<string, number>> = {
  "src/canvas/canvas-utils.ts": 2,
};

/**
 * The modules that compute what a STAGE looks like: its transform, its fit, its content zoom, its
 * artboard headers. Every function in them already takes a `CanvasSurface`.
 */
const GEOMETRY_SCAN = ["src/canvas/canvas-utils.ts"];

/** A read of the focused tab, as it appears in code rather than in prose. */
const ACTIVE_TAB_RE = /\bactiveTab\b/g;

/** The modules the second rule polices. */
const INSTANCE_SCAN = [
  "src/grid/grid-panel.ts",
  "src/content/entry-editor.ts",
  "src/browse/library-pane.ts",
  "src/panels/frontmatter-panel.ts",
  "src/panels/settings-pane.ts",
  "src/canvas/canvas-render.ts",
];

/**
 * A module-scope mutable holding ONE of something a stage owns.
 *
 * Deliberately shallow: it matches the names these six modules actually used, at column zero, which
 * is what a re-introduction would look like. A guard that tried to understand the code would be a
 * type checker, and the point of this file is that the type checker cannot see the problem.
 */
const INSTANCE_RE = /^let (active|_active|_host|_scheduler|sourceCollabCleanup)\b/gm;

// ─── Rule 4 · a function given a pane does not consult the focus ──────────────

/**
 * **The general form of rule 3, and the reason rule 3 kept missing things.**
 *
 * Rules 1 and 2 are lists of NAMES; rule 3 is a list of FILES. Each was written after a failure and
 * each was silent about the next one, because per-stage state does not announce itself by name and
 * the modules that hold it are not a fixed set. Four instances landed in one session, all the same
 * shape and none of them catchable:
 *
 * - The Document Header card, drawn for `tab`, mutating `activeTab.value`;
 * - The zoom axis, handed a surface, writing `activeTab.value.session.ui.zoom`;
 * - The debounced Monaco commit, reading one tab's buffer and writing `activeTab.value`;
 * - The whole pane context bar — drawn per pane, from `tabOfPane(paneId)` — writing every one of its
 *   seven axes, its editor picker and its view control through the FOCUSED pane.
 *
 * The rule they all break is one sentence: **a function that has been told which pane it is about
 * does not get to ask which pane has focus.** That is what is checked, and it is checked per
 * FUNCTION rather than per file, because "this module is pane-scoped" is not true of any real
 * module — `panels/stylebook-panel.ts` has one function that takes a surface and another whose
 * subject genuinely is the focused pane, and a file-level rule can only be wrong about one of
 * them.
 *
 * The pane context bar would not have been caught by this on the day it landed, and that is the
 * other half of the fix: every one of those writes went through `store.ts`'s `updateUi(field,
 * value)`, which resolved `activeTab.value` on the caller's behalf. So `store.ts`'s session
 * dispatchers take their target now — there is no `activeTab` in that file — and a pane-scoped
 * caller that wants the focused tab has to spell it, where this rule can see it.
 */
const FOCUS_RE =
  /\bactiveTab\b|\bactivePaneId\b|\bactivePane\s*\(|\bactiveCanvasSurface\s*\(|\bgetCanvasMode\s*\(/g;

/**
 * A parameter list that names a pane or a stage. `Tab` is deliberately NOT here: plenty of
 * functions take a tab AND legitimately ask whether it is the focused one ({@link isTabActive}'s
 * callers). A `paneId` or a `CanvasSurface` is a different promise — it says the caller has already
 * decided which pane this is about.
 */
const PANE_PARAM_RE = /\bpaneId\b|\bsurface\b|\bCanvasSurface\b/;

/**
 * Function headers, as they appear in this package: `function name(params) {`, a method, or an
 * arrow with a block body. The regex tolerates one level of nested parens in the parameter list (a
 * callback type, a destructured default) which is as deep as anything here goes.
 */
const FUNCTION_HEADER_RE =
  /(?:function\s+(?<name>[A-Za-z_$][\w$]*)\s*)?\((?<params>[^()]*(?:\([^()]*\)[^()]*)*)\)\s*(?::[^{=;]*)?(?:=>\s*)?\{/g;

/**
 * The module that OWNS focus, excluded by name.
 *
 * `focusPane` and `closePane` both take a `paneId` and both write `workspace.activePaneId` — that
 * IS the definition of moving focus. A rule that fired on its own definition site would be one
 * nobody could satisfy, and silencing it with an allow-list entry would put the one legitimate
 * writer in a table of things that must not come back.
 */
const FOCUS_OWNER = "src/workspace/workspace.ts";

/** Everywhere the rule applies. */
const FOCUS_SCOPE_SCAN = ["src/**/*.ts"];

/**
 * Functions still allowed to consult the focus while holding a pane. Empty: none do.
 *
 * Keyed by file, counted like every other list here, and failing both ways.
 */
export const ALLOWED_FOCUS_IN_PANE_SCOPE: Readonly<Record<string, number>> = {};

/**
 * Count focus reads that appear in the BODY of a pane-scoped function, per file.
 *
 * The body only — a default such as `surface: CanvasSurface = activeCanvasSurface()` is the
 * opposite of the defect: it is a signature saying, in public, "the focused pane when you do not
 * say". Eleven of the geometry verbs are written that way on purpose.
 *
 * @param {string} source A module's text, comments already stripped.
 * @returns {number}
 */
export function focusReadsInPaneScope(source: string): number {
  let found = 0;
  const headers = new RegExp(FUNCTION_HEADER_RE.source, FUNCTION_HEADER_RE.flags);
  let header: RegExpExecArray | null;
  while ((header = headers.exec(source)) !== null) {
    if (!PANE_PARAM_RE.test(header.groups?.params ?? "")) {
      continue;
    }
    const open = header.index + header[0].length - 1;
    let depth = 0;
    let close = source.length;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === "{") {
        depth += 1;
      } else if (source[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    const body = source.slice(open + 1, close);
    found += body.match(new RegExp(FOCUS_RE.source, FOCUS_RE.flags))?.length ?? 0;
  }
  return found;
}

/** A `view.<banned>` read, as it appears in code rather than in prose. */
const viewReadRe = new RegExp(String.raw`\bview\.(${BANNED_VIEW_FIELDS.join("|")})\b`, "g");

/** Strip comments, so a docstring naming a deleted field is prose rather than a violation. */
function code(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/^[ \t]*\/\/.*$/gm, "");
}

async function filesFor(patterns: string[]): Promise<string[]> {
  const found = new Set<string>();
  for (const pattern of patterns) {
    if (pattern.includes("*")) {
      for await (const file of new Glob(pattern).scan({ absolute: true, cwd: ROOT })) {
        found.add(file);
      }
    } else {
      found.add(join(ROOT, pattern));
    }
  }
  return [...found].toSorted();
}

/**
 * Count matches of `re` in each file, keyed by repo-relative path. Zero counts are omitted.
 *
 * A file that cannot be read counts as zero rather than throwing. The lists below name paths, and a
 * path that has been deleted or renamed should make this guard say "the rule holds here" — a
 * checker that crashes on a stale entry is a checker nobody can run to find out.
 */
export async function countPerFile(patterns: string[], re: RegExp): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const file of await filesFor(patterns)) {
    const text = await Bun.file(file)
      .text()
      .catch(() => "");
    const found = code(text).match(new RegExp(re.source, re.flags))?.length ?? 0;
    if (found > 0) {
      counts.set(relative(ROOT, file), found);
    }
  }
  return counts;
}

/**
 * Compare counts against an allow-list, both directions.
 *
 * @returns The failure lines — empty when the rule holds.
 */
export function diffAgainstAllowed(
  counts: Map<string, number>,
  allowed: Readonly<Record<string, number>>,
  noun: string,
): string[] {
  const failures: string[] = [];
  for (const [file, found] of counts) {
    const budget = allowed[file] ?? 0;
    if (found > budget) {
      failures.push(`${file}: ${found} ${noun}, ${budget} allowed`);
    }
  }
  for (const [file, budget] of Object.entries(allowed)) {
    const found = counts.get(file) ?? 0;
    if (found < budget) {
      failures.push(
        `${file}: allow-list says ${budget} ${noun} but only ${found} remain — ratchet the ` +
          `entry down (or delete it) in scripts/check-pane-singletons.ts`,
      );
    }
  }
  return failures;
}

/**
 * Rule 4's counts, per file. Same shape as {@link countPerFile}, but the unit is a function body
 * rather than a match, so it cannot reuse it.
 */
export async function countFocusInPaneScope(patterns: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const file of await filesFor(patterns)) {
    const path = relative(ROOT, file);
    if (path === FOCUS_OWNER) {
      continue;
    }
    const text = await Bun.file(file)
      .text()
      .catch(() => "");
    const found = focusReadsInPaneScope(code(text));
    if (found > 0) {
      counts.set(path, found);
    }
  }
  return counts;
}

export async function checkPaneSingletons(): Promise<string[]> {
  const viewFailures = diffAgainstAllowed(
    await countPerFile(VIEW_SCAN, viewReadRe),
    ALLOWED_VIEW_READS,
    "per-stage `view.*` read(s)",
  );
  const instanceFailures = diffAgainstAllowed(
    await countPerFile(INSTANCE_SCAN, INSTANCE_RE),
    ALLOWED_SINGLE_INSTANCE,
    "module-level stage singleton(s)",
  );
  const focusFailures = diffAgainstAllowed(
    await countPerFile(GEOMETRY_SCAN, ACTIVE_TAB_RE),
    ALLOWED_ACTIVE_TAB_READS,
    "focused-tab read(s) in stage geometry",
  );
  const paneScopeFailures = diffAgainstAllowed(
    await countFocusInPaneScope(FOCUS_SCOPE_SCAN),
    ALLOWED_FOCUS_IN_PANE_SCOPE,
    "focus read(s) inside a function that was given a pane",
  );
  return [...viewFailures, ...instanceFailures, ...focusFailures, ...paneScopeFailures];
}

/**
 * Print the verdict and hand back an exit code. Same shape as `scripts/check-styles.ts`'s `report`,
 * and for the same reason: a function that RETURNS the code is one a test can run, where a
 * `process.exit` inside an `import.meta.main` block is one nothing can.
 *
 * @param {string[]} failures
 * @returns {number} 0 when the rules hold, 1 when they do not.
 */
export function report(failures: string[]): number {
  if (failures.length > 0) {
    console.error("❌ pane singletons:");
    for (const line of failures) {
      console.error(`   ${line}`);
    }
    console.error(
      "\n   Per-stage state belongs on `CanvasSurface` (src/canvas/surface-registry.ts);\n" +
        "   per-pane content belongs in a Map keyed by pane id; and stage geometry reaches\n" +
        "   both through the surface it was given — never through `activeTab`.\n" +
        "   A function handed a `paneId` or a `CanvasSurface` has already been told which pane\n" +
        "   it is about: ask `tabOfPane(paneId)` / `canvasModeOfTab(tab)`, and pass the tab on\n" +
        "   to `updateUi` / `setCanvasMode`, which take one.",
    );
    return 1;
  }
  console.log(
    "✓ check-pane-singletons: no per-stage state on `view`, no stage-content singletons, " +
      "stage geometry reaches per-pane state through a surface, and no function handed a " +
      "pane consults the focus",
  );
  return 0;
}

if (import.meta.main) {
  process.exit(report(await checkPaneSingletons()));
}
