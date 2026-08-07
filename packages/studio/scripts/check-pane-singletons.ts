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
 * FILES.** See {@link analyzeFocusScope}: a function that has been handed a pane may not consult
 * the focus in its body — nor reach it through a zero-argument helper — wherever in `src/` it
 * lives. Rule 3 named one module; the pane context bar was in another, and wrote nine controls
 * through `activeTab.value` for a pane it was not drawing.
 *
 * It is the only rule here that parses rather than matches, and it had to become one: a regex over
 * function headers is blind to an arrow with a template-literal body, to a return type containing a
 * brace, and — structurally — to a focus read that is one call away. The table in that docstring
 * lists all eight shapes it used to walk past.
 *
 * Run: bun scripts/check-pane-singletons.ts
 */

import { Glob } from "bun";
import { dirname, join, relative } from "node:path";
import { API } from "typescript/unstable/async";
import { SyntaxKind } from "typescript/unstable/ast";

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
 *
 * **It is an AST check now, and it had to become one.** The first version was a regex over function
 * HEADERS — `\(params\)\s*(:type)?\s*(=>)?\s*\{` — and measured against thirteen hand-written
 * sources it caught four shapes and walked past eight:
 *
 * | missed shape                                               | why the regex could not see it                                   |
 * | ---------------------------------------------------------- | ---------------------------------------------------------------- |
 * | an arrow whose body is a template literal                  | there is no `{`, so no header matched                            |
 * | ``(paneId) => html`…` ``                                   | same, and it is how half this package renders                    |
 * | a return type containing a brace (`): { a: number } {`)    | the `{` of the TYPE closed the header                            |
 * | a return type that is a function type (`): (x) => void {`) | the `=>` did                                                     |
 * | `Promise<{ … }>`                                           | the brace again, one generic deeper                              |
 * | a parameter named `pane`                                   | the name list held `paneId` only                                 |
 * | a parameter named `container`                              | `paneOfContainer(container)` is the derived route — same promise |
 * | a focus read reached through a HELPER                      | a body-text scan cannot follow a call                            |
 *
 * The last one is the one that mattered: `documentHeaderTemplate(tab, paneId)` called
 * `isPageDocument()`, a zero-argument function whose body read `activeTab.value.documentPath`, and
 * so the Layout picker appeared and vanished in the pane being edited according to the document in
 * the OTHER one. A rule that only reads the body it is standing in cannot say that, however good
 * its regex is, which is why {@link analyzeFocusScope} walks ONE hop of the call graph: a call to a
 * zero-parameter local function that reads the focus is a focus read at the call site.
 *
 * One hop rather than a transitive closure, deliberately. Two hops reaches `render()`, and from
 * `render()` everything is reachable from everything — the rule would stop naming a defect and
 * start naming the module graph. Zero-parameter is the second brake: a helper that takes a tab has
 * already been told what it is about, so the caller passing one is the fix rather than the bug.
 */
const FOCUS_NAMES: ReadonlySet<string> = new Set([
  "activeTab",
  "activePaneId",
  "activePane",
  "activeCanvasSurface",
  "getCanvasMode",
]);

/**
 * A parameter name that says "the caller has already decided which pane this is about".
 *
 * `tab` is deliberately NOT here: plenty of functions take a tab AND legitimately ask whether it is
 * the focused one ({@link isTabActive}'s callers). `container` IS here, and it is the subtle one —
 * `canvas-surface.ts`'s `paneOfContainer(container)` exists precisely so stage content that is
 * handed an element and nothing else can still name its pane, so a function taking a container has
 * the same answer available and the same obligation to use it.
 */
export const PANE_PARAM_NAMES: ReadonlySet<string> = new Set([
  "paneId",
  "pane",
  "surface",
  "container",
]);

/** A parameter TYPE that says it, whatever the parameter is called. */
const PANE_PARAM_TYPE_RE = /\bCanvasSurface\b/;

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
 * Functions still allowed to consult the focus while holding a pane.
 *
 * Keyed by file, counted like every other list here, and failing both ways. It was empty under the
 * regex and has two entries under the AST rule, which is the rule working: both are shapes a body
 * scan could not see, and each is written down rather than silently tolerated.
 *
 * - **`src/panels/editors.ts`** — `functionMountWanted(container, tab, editing)` asks
 *   `activeTab.value === tab` on the far side of Monaco's 12.6 MB dynamic import, and it is right
 *   to. Its `container` is the BOTTOM DOCK's, not a pane's stage: the function editor is one
 *   app-level surface that shows the focused document's target by design, so "is this still the tab
 *   the dock is showing" is the whole question. The rule cannot tell a dock container from a stage
 *   container by its name, and widening the name list was worth this one entry — `container` is how
 *   `canvas-surface.ts`'s `paneOfContainer` route is spelled everywhere else.
 * - **`src/settings/css-vars-editor.ts`** — `renderCssVarsEditor(container)` IS drawn in a pane's
 *   stage, and it calls `pushProjectStylesToCanvas()`, which is a zero-argument focus reader. This
 *   is the one-hop rule earning its keep: the SITE half of that push goes to every live host and is
 *   correct, while the STYLEBOOK half composes `activeTab.value?.doc.document?.style` and posts one
 *   result to all specimen canvases — so two panes each showing a stylebook get the focused
 *   document's effective style. Real debt, in `src/style/live-preview.ts` rather than here; the fix
 *   is a per-host post and it is a workstream of its own.
 */
export const ALLOWED_FOCUS_IN_PANE_SCOPE: Readonly<Record<string, number>> = {
  "src/panels/editors.ts": 1,
  "src/settings/css-vars-editor.ts": 1,
};

/** A node as the compiler API hands it back; shapes vary by kind, so this stays loose. */
type AnyNode = any;

/** Type-only syntax, from `CallSignature` to `ImportType`; an identifier inside one is not a read. */
const FIRST_TYPE_KIND = SyntaxKind.CallSignature;
const LAST_TYPE_KIND = SyntaxKind.ImportType;

/** The four ways this package spells a function. */
const FUNCTION_KINDS = new Set<SyntaxKind>([
  SyntaxKind.ArrowFunction,
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.FunctionExpression,
  SyntaxKind.MethodDeclaration,
]);

/** Declarations that are erased before anything runs, or that are not calls. */
const SKIP_KINDS = new Set<SyntaxKind>([
  SyntaxKind.ExportDeclaration,
  SyntaxKind.ImportDeclaration,
  SyntaxKind.ImportEqualsDeclaration,
  SyntaxKind.InterfaceDeclaration,
  SyntaxKind.ModuleDeclaration,
  SyntaxKind.TypeAliasDeclaration,
]);

/** Every name a parameter binds — an identifier, or the leaves of a destructuring pattern. */
function boundNames(name: AnyNode, out: string[] = []): string[] {
  if (!name) {
    return out;
  }
  if (name.kind === SyntaxKind.Identifier) {
    out.push(name.text as string);
    return out;
  }
  for (const element of (name.elements as AnyNode[] | undefined) ?? []) {
    boundNames(element.name, out);
  }
  return out;
}

/** True when this function's signature says which pane it is about. */
function isPaneScoped(fn: AnyNode, sf: AnyNode): boolean {
  for (const param of (fn.parameters as AnyNode[] | undefined) ?? []) {
    if (boundNames(param.name).some((name) => PANE_PARAM_NAMES.has(name))) {
      return true;
    }
    const type = param.type as AnyNode | undefined;
    if (type && PANE_PARAM_TYPE_RE.test((sf.text as string).slice(type.pos, type.end))) {
      return true;
    }
  }
  return false;
}

/** Does this subtree name the focus directly? Used to classify a candidate helper. */
function readsFocusDirectly(node: AnyNode): boolean {
  const kind: SyntaxKind = node.kind;
  if ((kind >= FIRST_TYPE_KIND && kind <= LAST_TYPE_KIND) || SKIP_KINDS.has(kind)) {
    return false;
  }
  if (kind === SyntaxKind.Identifier) {
    return FOCUS_NAMES.has(node.text as string);
  }
  let found = false;
  node.forEachChild((child: AnyNode) => {
    found ||= readsFocusDirectly(child);
  });
  return found;
}

/** One module's parsed facts. */
interface ModuleFacts {
  sf: AnyNode;
  /** Local binding name → the `src/` module it was imported from, for relative imports only. */
  importedFrom: Map<string, string>;
  /** Names of top-level ZERO-parameter functions in this module whose body reads the focus. */
  readers: Set<string>;
}

/** Resolve a relative import to a file in `sources`, the way the bundler will. */
function resolveSpecifier(from: string, spec: string, sources: Set<string>): string | undefined {
  if (!spec.startsWith(".")) {
    return undefined;
  }
  const base = join(dirname(from), spec.replace(/\.js$/, ""));
  for (const candidate of [base, `${base}.ts`, `${base}/index.ts`]) {
    if (sources.has(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/** A function-shaped top-level declaration: `function f()` or `const f = () => …`. */
function topLevelFunctions(sf: AnyNode): { name: string; fn: AnyNode }[] {
  const out: { name: string; fn: AnyNode }[] = [];
  for (const st of sf.statements as AnyNode[]) {
    if (st.kind === SyntaxKind.FunctionDeclaration && st.name?.text) {
      out.push({ fn: st, name: st.name.text as string });
    } else if (st.kind === SyntaxKind.VariableStatement) {
      for (const d of st.declarationList.declarations as AnyNode[]) {
        const init = d.initializer as AnyNode | undefined;
        if (
          d.name?.kind === SyntaxKind.Identifier &&
          init &&
          FUNCTION_KINDS.has(init.kind as SyntaxKind)
        ) {
          out.push({ fn: init, name: d.name.text as string });
        }
      }
    }
  }
  return out;
}

/** Every local binding a module's relative imports introduce, by local name. */
function importedBindings(sf: AnyNode, from: string, sources: Set<string>): Map<string, string> {
  const map = new Map<string, string>();
  for (const st of sf.statements as AnyNode[]) {
    if (st.kind !== SyntaxKind.ImportDeclaration || !st.importClause) {
      continue;
    }
    const target = resolveSpecifier(from, st.moduleSpecifier.text as string, sources);
    if (!target) {
      continue;
    }
    const clause = st.importClause as AnyNode;
    if (clause.name?.text) {
      map.set(clause.name.text as string, target);
    }
    for (const element of (clause.namedBindings?.elements as AnyNode[] | undefined) ?? []) {
      map.set(element.name.text as string, target);
    }
  }
  return map;
}

/** One focus read the rule objects to, located and explained. */
export interface FocusSite {
  /** 1-based line of the read. */
  line: number;
  /** The identifier read, or the helper called. */
  name: string;
  /** Set when the read is one hop away: the zero-argument reader this call reaches. */
  via: string | null;
}

/**
 * The focus reads inside pane-scoped functions, per absolute file path.
 *
 * A read is counted ONCE however many pane-scoped functions enclose it — nesting an arrow inside a
 * pane-scoped renderer is how every one of the context bar's controls was written, and counting the
 * same `activeTab` twice would make the numbers in the allow-list depend on how deeply the closure
 * happened to sit.
 *
 * Parameter subtrees are walked OUTSIDE the pane scope on purpose, so a default such as `surface:
 * CanvasSurface = activeCanvasSurface()` does not count. That signature is the opposite of the
 * defect: it says in public "the focused pane when you do not say", and eleven of the geometry
 * verbs are written that way.
 *
 * @param {string[]} files Absolute paths to analyse.
 * @returns {Promise<Map<string, FocusSite[]>>} Absolute path → sites. Empty entries are omitted.
 */
export async function analyzeFocusScope(files: string[]): Promise<Map<string, FocusSite[]>> {
  const api = new API({ cwd: ROOT });
  try {
    const snapshot = await api.updateSnapshot({ openFiles: files });
    const parsed = await Promise.all(
      files.map(async (file) => {
        const project = await snapshot.getDefaultProjectForFile(file);
        const sf = project ? await project.program.getSourceFile(file) : undefined;
        return [file, sf] as const;
      }),
    );
    const sources = new Set(parsed.filter(([, sf]) => sf).map(([file]) => file));
    const modules = new Map<string, ModuleFacts>();
    for (const [file, sf] of parsed) {
      if (!sf) {
        continue;
      }
      const readers = new Set<string>();
      for (const { name, fn } of topLevelFunctions(sf)) {
        const arity = ((fn.parameters as AnyNode[] | undefined) ?? []).length;
        if (arity === 0 && fn.body && readsFocusDirectly(fn.body)) {
          readers.add(name);
        }
      }
      modules.set(file, { importedFrom: importedBindings(sf, file, sources), readers, sf });
    }

    /**
     * Is a bare `name()` a call to a zero-argument focus reader — here, or in a module this one
     * imports it from? Cross-module is the case that matters: finding 3 was `frontmatter-panel.ts`
     * calling `head-panel.ts`'s `isPageDocument()`.
     */
    const isFocusReader = (facts: ModuleFacts, name: string): boolean =>
      facts.readers.has(name) ||
      (modules.get(facts.importedFrom.get(name) ?? "")?.readers.has(name) ?? false);

    const found = new Map<string, FocusSite[]>();
    for (const [file, facts] of modules) {
      const hits = new Map<number, FocusSite>();
      const at = (node: AnyNode, name: string, via: string | null): FocusSite => ({
        line: (facts.sf.getLineAndCharacterOfPosition(node.getStart(facts.sf)).line as number) + 1,
        name,
        via,
      });
      const walk = (node: AnyNode, inPane: boolean): void => {
        const kind: SyntaxKind = node.kind;
        if ((kind >= FIRST_TYPE_KIND && kind <= LAST_TYPE_KIND) || SKIP_KINDS.has(kind)) {
          return;
        }
        if (FUNCTION_KINDS.has(kind)) {
          const scoped = inPane || isPaneScoped(node, facts.sf);
          for (const param of (node.parameters as AnyNode[] | undefined) ?? []) {
            walk(param, inPane);
          }
          if (node.body) {
            walk(node.body, scoped);
          }
          return;
        }
        if (inPane) {
          if (kind === SyntaxKind.Identifier && FOCUS_NAMES.has(node.text as string)) {
            hits.set(node.getStart(facts.sf) as number, at(node, node.text as string, null));
          } else if (
            kind === SyntaxKind.CallExpression &&
            node.expression?.kind === SyntaxKind.Identifier &&
            isFocusReader(facts, node.expression.text as string)
          ) {
            const callee = node.expression.text as string;
            hits.set(node.getStart(facts.sf) as number, at(node, `${callee}()`, callee));
          }
        }
        node.forEachChild((child: AnyNode) => {
          walk(child, inPane);
        });
      };
      walk(facts.sf, false);
      if (hits.size > 0) {
        found.set(
          file,
          [...hits.values()].toSorted((a, b) => a.line - b.line),
        );
      }
    }
    return found;
  } finally {
    await api.close();
  }
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

/** Rule 4's sites, per repo-relative file. {@link FOCUS_OWNER} is dropped rather than allow-listed. */
export async function focusSitesInPaneScope(patterns: string[]): Promise<Map<string, FocusSite[]>> {
  const scanned = await filesFor(patterns);
  const files = scanned.filter((file) => relative(ROOT, file) !== FOCUS_OWNER);
  const sites = new Map<string, FocusSite[]>();
  if (files.length === 0) {
    return sites;
  }
  for (const [file, found] of await analyzeFocusScope(files)) {
    sites.set(relative(ROOT, file), found);
  }
  return sites;
}

/**
 * Rule 4's counts, per file. Same shape as {@link countPerFile}, but the unit is a function body
 * rather than a match, so it cannot reuse it.
 */
export async function countFocusInPaneScope(patterns: string[]): Promise<Map<string, number>> {
  const sites = await focusSitesInPaneScope(patterns);
  return new Map([...sites].map(([file, found]) => [file, found.length]));
}

/**
 * `file:line name` for every site the rule objects to — printed under a rule-4 failure.
 *
 * A count alone sends the reader back to the source to find out what it meant, and the one-hop
 * reads are the ones nobody would find: `pushProjectStylesToCanvas()` contains no focus name at all
 * at the call site.
 */
export function describeFocusSites(sites: Map<string, FocusSite[]>, file: string): string {
  const found = sites.get(file) ?? [];
  return found
    .map((site) => `${file}:${site.line} ${site.name}${site.via ? " (one hop)" : ""}`)
    .join(", ");
}

/**
 * Append `file:line name` detail to each rule-4 failure line, which opens with the file's path.
 *
 * Separate and pure so it is testable without a failing tree: a checker whose most informative
 * output only appears when the repo is broken is one nobody has read.
 */
export function withFocusDetail(failures: string[], sites: Map<string, FocusSite[]>): string[] {
  return failures.map((line) => {
    const detail = describeFocusSites(sites, line.slice(0, line.indexOf(":")));
    return detail ? `${line} — ${detail}` : line;
  });
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
  const sites = await focusSitesInPaneScope(FOCUS_SCOPE_SCAN);
  const siteCounts = new Map([...sites].map(([file, found]) => [file, found.length]));
  const paneScopeFailures = withFocusDetail(
    diffAgainstAllowed(
      siteCounts,
      ALLOWED_FOCUS_IN_PANE_SCOPE,
      "focus read(s) inside a function that was given a pane",
    ),
    sites,
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
        "   A function handed a `paneId`, a `pane`, a `surface` or a `container` has already been\n" +
        "   told which pane it is about: ask `tabOfPane(paneId)` / `paneOfContainer(container)` /\n" +
        "   `canvasModeOfTab(tab)`, and pass the tab on to `updateUi` / `setCanvasMode`, which\n" +
        "   take one. A read marked `(one hop)` is reached through a zero-argument helper — give\n" +
        "   that helper the tab too, at the call site where the pane is still known.",
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
