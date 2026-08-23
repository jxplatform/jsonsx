/**
 * Function-level reachability for `packages/studio/src`, measured from the app's real entry points.
 *
 * P7 shipped eleven features that were built, unit-tested, and reachable from nothing:
 * `sourceControlCommands`, `publishCommands`, `gridViewCommands` and `redirectsCommands` were never
 * composed or registered; `aboutCommands` and `collabCommands` were composed but never registered;
 * `applyDraftFilter`, `loadMediaUsages`, `peekMediaUsages` and `mediaUsageHeadline` had no caller
 * at all. Every gate was green, because a unit test imports the module under test directly and
 * therefore cannot tell whether anything else does.
 *
 * The naive guard — "exported, mentioned by tests, no cross-module caller" — flags 406 symbols
 * here, because exporting a helper so a test can reach it is the house style and is legitimate. The
 * discriminator is not "who imports it" but "does the running app ever get there":
 * `bottomDockTemplate` is called inside its own module, on a path the shell reaches;
 * `applyDraftFilter` was called by nothing, anywhere.
 *
 * So this walks a CALL GRAPH, not an import graph, and asks reachability from roots:
 *
 * - The two bundle entrypoints (`scripts/build-config.ts`'s `STUDIO_ENTRYPOINTS`),
 * - The exports the package publishes (`package.json` `exports`), whose consumers — the desktop app
 *   and the cloud platform — are outside the type-check program,
 * - Anything a non-test file elsewhere in the repo reaches into: the sibling packages, and the repo's
 *   own `scripts/` (`check-command-levels.ts` imports `checkPlacements`, `docs/generators` imports
 *   `commandsMarkdown`; those are entry points too).
 *
 * Tests are deliberately NOT roots — that is the entire point.
 *
 * Module granularity would not do: `registerRedirectsCommands` called `redirectsCommands()`, so a
 * "has a caller" check saw the factory as live while nothing called the register. Each top-level
 * declaration is its own node, and identifiers are attributed to the innermost top-level
 * declaration that owns them — a function body only runs when the function is called, whereas a
 * top-level `const x = f()` runs at import and so belongs to the module's init node.
 *
 * Resolution is the TypeScript checker's, never a regex. `typescript@7`'s API hands back
 * compiler-resolved symbols, which is what makes all four of these resolve to the declaration they
 * actually name:
 *
 * - `rightPanelMod.mount()` — a namespace import, and the panel registry's whole idiom;
 * - `deps = { renderGitPanel }` — a shorthand property, whose identifier resolves to the PROPERTY;
 * - `import { redo as tabRedo }` — a renamed import;
 * - `import("./x").then(({ y }) => y())` — a destructured dynamic import.
 *
 * Each was a false "dead" before it was handled, and a false "dead" is what gets a check deleted.
 *
 * Blind spots, stated plainly: dispatch through a string (`commandRegistry.run("foo.bar")`) is
 * invisible, but commands are registered by reference so the registration is the edge; a function
 * stored in a plain object literal at module top level is attributed to the module init, so it is
 * counted live even if the object is not; and reachability is not liveness — a function the app can
 * reach only from a branch that never runs is still "live" here.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { API } from "typescript/unstable/async";
import type { Project, Symbol as TsSymbol, Type } from "typescript/unstable/async";
import { SyntaxKind } from "typescript/unstable/ast";

/** A node in the AST as the compiler API hands it back; shapes vary by kind, so this stays loose. */
type AnyNode = any;

/** A studio function the app cannot reach. */
export interface DeadFunction {
  /** The declared name. */
  name: string;
  /** Path relative to `packages/studio/src`. */
  file: string;
  /** 1-based line of the declaration. */
  line: number;
  /** `file:name`, the stable key an allowlist entry uses. */
  key: string;
}

/** What one analysis run found. */
export interface ReachabilityReport {
  /** Unreachable functions, in source order per file. */
  dead: DeadFunction[];
  /** Modules under `src/` that no root imports, relative to `src/`. */
  deadModules: string[];
  /** Every function the run considered, by `file:name` — the staleness check reads this. */
  allFunctions: Set<string>;
  /** How many top-level functions were analysed. */
  functionCount: number;
  /** How many modules under `src/` were analysed. */
  moduleCount: number;
}

const STUDIO_DIR = resolve(import.meta.dir, "..");
const REPO = resolve(STUDIO_DIR, "..", "..");
const SRC = join(STUDIO_DIR, "src");
const TSCONFIG = join(REPO, "tsconfig.json");

/**
 * Directories that never hold a caller: build output, dependencies, and the tests themselves.
 *
 * Dot-directories are skipped wholesale by the walk.
 */
const SKIP_DIRS = new Set(["coverage", "dist", "node_modules", "result", "tests"]);

/** Type-only syntax, from `CallSignature` to `ImportType`; an identifier inside one is not a call. */
const FIRST_TYPE_KIND = SyntaxKind.CallSignature;
const LAST_TYPE_KIND = SyntaxKind.ImportType;

/** Declaration kinds that make a symbol an alias for something declared elsewhere. */
const ALIAS_KINDS = new Set<SyntaxKind>([
  SyntaxKind.ExportSpecifier,
  SyntaxKind.ImportClause,
  SyntaxKind.ImportEqualsDeclaration,
  SyntaxKind.ImportSpecifier,
  SyntaxKind.NamespaceExport,
  SyntaxKind.NamespaceImport,
]);

/** Owner id for a module's top-level code — the statements that run on import. */
const moduleOwner = (path: string) => `module:${path}`;

/** Owner id for every reference made from outside `packages/studio/src`. */
const OUTSIDE = "outside";

/** A top-level declaration in `src/`, keyed by the compiler's own (file, node index) pair. */
interface Decl {
  id: string;
  name: string;
  file: string;
  line: number;
  isFunction: boolean;
  isExported: boolean;
}

/** One identifier to resolve, and the declaration whose body it sits in. */
interface Ref {
  positions: number[];
  owners: string[];
}

/** Every `.ts` file under `dir` that could contain a caller. */
function callerFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) {
      continue;
    }
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (!SKIP_DIRS.has(name)) {
        out.push(...callerFiles(path));
      }
    } else if (name.endsWith(".ts") && !name.endsWith(".d.ts") && !name.includes(".test.")) {
      out.push(path);
    }
  }
  return out;
}

/**
 * True when the file could possibly name a studio module.
 *
 * The only two ways to reach `packages/studio/src` are the package specifier `@jxsuite/studio…` and
 * a relative path through `packages/studio/src`, and both spell "studio". Skipping the rest takes
 * the whole-repo scan from ten seconds to three, and nothing sound is lost.
 */
function namesStudio(file: string): boolean {
  return readFileSync(file, "utf8").includes("studio");
}

/** True when a declaration carries the `export` modifier. */
function isExported(node: AnyNode): boolean {
  const modifiers: AnyNode[] = node.modifiers ?? [];
  return modifiers.some((m) => m.kind === SyntaxKind.ExportKeyword);
}

/** True when the symbol is an import/export alias and has to be followed to its target. */
function isAlias(symbol: TsSymbol): boolean {
  return symbol.declarations.some((d) => ALIAS_KINDS.has(d.kind));
}

/**
 * Resolve every alias in `symbols` to its target, in one pipelined batch.
 *
 * Returned in the same order, with non-aliases passed through untouched.
 */
async function followAliases(
  project: Project,
  symbols: readonly (TsSymbol | undefined)[],
): Promise<(TsSymbol | undefined)[]> {
  const pending = new Map<number, TsSymbol>();
  for (const s of symbols) {
    if (s && isAlias(s)) {
      pending.set(s.id, s);
    }
  }
  const ids = [...pending.keys()];
  const targets = await Promise.all(
    ids.map((id) => project.checker.getAliasedSymbol(pending.get(id)!)),
  );
  const resolved = new Map<number, TsSymbol>();
  for (const [i, id] of ids.entries()) {
    resolved.set(id, targets[i]!);
  }
  return symbols.map((s) => (s && isAlias(s) ? (resolved.get(s.id) ?? s) : s));
}

/** Walk the call graph of `packages/studio/src` and report the functions no entry point reaches. */
export async function analyzeReachability(): Promise<ReachabilityReport> {
  const api = new API({ cwd: REPO });
  try {
    return await run(api);
  } finally {
    await api.close();
  }
}

async function run(api: API): Promise<ReachabilityReport> {
  // The repo tsconfig covers `packages/*/src` and `extensions/*/src`; `scripts/`, `sites/` and
  // `packages/desktop` are outside it, and they hold real callers, so they are opened alongside.
  const first = await api.updateSnapshot({ openProjects: [TSCONFIG] });
  const main = first.getProjects()[0]!;
  const inProgram = new Set(await main.program.getSourceFileNames());
  const extra = callerFiles(REPO).filter((f) => !inProgram.has(f) && namesStudio(f));

  const snapshot = await api.updateSnapshot({ openProjects: [TSCONFIG], openFiles: extra });
  const configured = snapshot.getProjects().find((p) => p.configFileName === TSCONFIG)!;

  const studioFiles = [...inProgram].filter(
    (f) => f.startsWith(`${SRC}/`) && f.endsWith(".ts") && !f.endsWith(".d.ts"),
  );
  // Sibling packages' sources — a caller there keeps a studio symbol alive. Their own tests are in
  // `inProgram` too and are filtered out here: a test is never a root.
  const siblingFiles = [...inProgram].filter(
    (f) =>
      !f.startsWith(`${SRC}/`) &&
      f.endsWith(".ts") &&
      !f.endsWith(".d.ts") &&
      !f.includes("/node_modules/") &&
      !f.includes("/tests/") &&
      !f.includes(".test.") &&
      /\/(?:packages|extensions)\/[^/]+\/src\//.test(f) &&
      namesStudio(f),
  );

  const owner = new Map<string, Project>();
  for (const f of [...studioFiles, ...siblingFiles]) {
    owner.set(f, configured);
  }
  await Promise.all(
    extra.map(async (f) => {
      const p = await snapshot.getDefaultProjectForFile(f);
      if (p) {
        owner.set(f, p);
      }
    }),
  );

  const sources = new Map<string, AnyNode>();
  await Promise.all(
    [...owner].map(async ([f, p]) => {
      const sf = await p.program.getSourceFile(f);
      if (sf) {
        sources.set(f, sf);
      }
    }),
  );

  // ── Declarations ────────────────────────────────────────────────────────────────────────────
  const decls = new Map<string, Decl>();
  const addDecl = (sf: AnyNode, node: AnyNode, name: string, fn: boolean, exported: boolean) => {
    const id = `${sf.path}#${node.index}`;
    decls.set(id, {
      id,
      name,
      file: sf.fileName,
      line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
      isFunction: fn,
      isExported: exported,
    });
  };

  for (const f of studioFiles) {
    const sf = sources.get(f);
    if (!sf) {
      continue;
    }
    for (const st of sf.statements as AnyNode[]) {
      if (st.kind === SyntaxKind.FunctionDeclaration || st.kind === SyntaxKind.ClassDeclaration) {
        if (st.name?.text) {
          addDecl(sf, st, st.name.text, st.kind === SyntaxKind.FunctionDeclaration, isExported(st));
        }
      } else if (st.kind === SyntaxKind.VariableStatement) {
        for (const d of st.declarationList.declarations as AnyNode[]) {
          if (d.name?.kind !== SyntaxKind.Identifier) {
            continue;
          }
          const init = d.initializer?.kind;
          const fn = init === SyntaxKind.ArrowFunction || init === SyntaxKind.FunctionExpression;
          addDecl(sf, d, d.name.text, fn, isExported(st));
        }
      }
    }
  }

  // ── Attribute every identifier to the declaration whose body holds it ───────────────────────
  const refs = new Map<string, Ref>();
  const shorthands: { node: AnyNode; from: string }[] = [];
  const patterns: { node: AnyNode; from: string }[] = [];

  const collect = (sf: AnyNode, node: AnyNode, from: string, out: Ref) => {
    const kind: SyntaxKind = node.kind;
    if (kind >= FIRST_TYPE_KIND && kind <= LAST_TYPE_KIND) {
      return;
    }
    switch (kind) {
      case SyntaxKind.ExportDeclaration:
      case SyntaxKind.ImportDeclaration:
      case SyntaxKind.ImportEqualsDeclaration:
      case SyntaxKind.InterfaceDeclaration:
      case SyntaxKind.ModuleDeclaration:
      case SyntaxKind.TypeAliasDeclaration: {
        // An import is not a call, and a type reference is erased before anything runs.
        return;
      }
      case SyntaxKind.Identifier: {
        out.positions.push(node.getStart(sf));
        out.owners.push(from);
        return;
      }
      default: {
        if (kind === SyntaxKind.ShorthandPropertyAssignment) {
          // `{ renderGitPanel }` — the identifier resolves to the PROPERTY, so the value symbol
          // Has to be asked for separately or the reference is lost.
          shorthands.push({ node, from });
        } else if (kind === SyntaxKind.ObjectBindingPattern) {
          // `const { loadComponentRegistry } = await import(…)` — same story, via the type.
          patterns.push({ node, from });
        }
        node.forEachChild((child: AnyNode) => {
          collect(sf, child, from, out);
        });
      }
    }
  };

  for (const f of studioFiles) {
    const sf = sources.get(f);
    if (!sf) {
      continue;
    }
    const out: Ref = { positions: [], owners: [] };
    const init = moduleOwner(sf.path);
    for (const st of sf.statements as AnyNode[]) {
      if (st.kind === SyntaxKind.VariableStatement) {
        for (const d of st.declarationList.declarations as AnyNode[]) {
          // A `const f = () => …` body runs when f is called; a `const x = compute()` runs NOW,
          // So only the function form owns its subtree.
          const decl = decls.get(`${sf.path}#${d.index}`);
          collect(sf, d, decl?.isFunction === true ? decl.id : init, out);
        }
        continue;
      }
      const decl = decls.get(`${sf.path}#${st.index}`);
      collect(sf, st, decl ? decl.id : init, out);
    }
    refs.set(f, out);
  }

  for (const f of [...siblingFiles, ...extra]) {
    const sf = sources.get(f);
    if (!sf) {
      continue;
    }
    const out: Ref = { positions: [], owners: [] };
    for (const st of sf.statements as AnyNode[]) {
      collect(sf, st, OUTSIDE, out);
    }
    refs.set(f, out);
  }

  // ── Resolve, and turn resolved declarations into edges ──────────────────────────────────────
  const edges = new Map<string, Set<string>>();
  const addEdge = (from: string, to: string) => {
    let set = edges.get(from);
    if (!set) {
      set = new Set();
      edges.set(from, set);
    }
    set.add(to);
  };
  const link = (from: string, symbol: TsSymbol | undefined) => {
    for (const d of symbol?.declarations ?? []) {
      const id = `${d.path}#${d.index}`;
      if (decls.has(id)) {
        addEdge(from, id);
      }
    }
  };

  const files = [...refs].filter(([, r]) => r.positions.length > 0);
  const resolvedPerFile = await Promise.all(
    files.map(async ([f, r]) => {
      const project = owner.get(f)!;
      const found = await project.checker.getSymbolAtPosition(f, r.positions);
      return followAliases(project, found);
    }),
  );
  for (const [i, [, r]] of files.entries()) {
    const symbols = resolvedPerFile[i]!;
    for (const [j, symbol] of symbols.entries()) {
      link(r.owners[j]!, symbol);
    }
  }

  const shorthandValues = await Promise.all(
    shorthands.map((h) =>
      owner.get(h.node.getSourceFile().fileName)!.checker.getShorthandAssignmentValueSymbol(h.node),
    ),
  );
  const shorthandTargets = await followAliases(configured, shorthandValues);
  for (const [i, h] of shorthands.entries()) {
    link(h.from, shorthandTargets[i]);
  }

  const patternTypes = await Promise.all(
    patterns.map((p) =>
      owner.get(p.node.getSourceFile().fileName)!.checker.getTypeAtLocation(p.node),
    ),
  );
  const wanted: {
    from: string;
    project: Project;
    type: Type;
    name: string;
  }[] = [];
  for (const [i, p] of patterns.entries()) {
    const type = patternTypes[i];
    if (!type) {
      continue;
    }
    const project = owner.get(p.node.getSourceFile().fileName)!;
    for (const element of p.node.elements as AnyNode[]) {
      const name: string | undefined = element.propertyName?.text ?? element.name?.text;
      if (name !== undefined) {
        wanted.push({ from: p.from, project, type, name });
      }
    }
  }
  const properties = await Promise.all(
    wanted.map((w) => w.project.checker.getPropertyOfType(w.type, w.name)),
  );
  const propertyTargets = await followAliases(configured, properties);
  for (const [i, w] of wanted.entries()) {
    link(w.from, propertyTargets[i]);
  }

  // ── Which modules run at all ────────────────────────────────────────────────────────────────
  const resolveSpecifier = (from: string, spec: string): string | undefined => {
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
  };
  const importsOf = new Map<string, string[]>();
  for (const f of studioFiles) {
    const sf = sources.get(f);
    if (!sf) {
      continue;
    }
    const list: string[] = [];
    for (const specifier of sf.imports as AnyNode[]) {
      const target = resolveSpecifier(f, specifier.text);
      if (target !== undefined) {
        list.push(target);
      }
    }
    importsOf.set(f, list);
  }

  const manifest = JSON.parse(readFileSync(join(STUDIO_DIR, "package.json"), "utf8")) as {
    exports: Record<string, string>;
  };
  /* TypeScript exports only. The map may legitimately name non-source files — `./package.json` is
     the npm convention for letting a consumer resolve the package root — and those are not
     modules this analysis can walk. Filtered by extension rather than by name, so a future asset
     export does not have to be added here. */
  const published = Object.values(manifest.exports)
    .filter((p) => p.endsWith(".ts"))
    .map((p) => join(STUDIO_DIR, p));
  const bundleSource = readFileSync(join(STUDIO_DIR, "scripts", "build-config.ts"), "utf8");
  const bundled = [...bundleSource.matchAll(/"(\.\/src\/[\w./-]+\.ts)"/g)].map((m) =>
    join(STUDIO_DIR, m[1]!),
  );
  if (bundled.length === 0) {
    throw new Error("no STUDIO_ENTRYPOINTS found in scripts/build-config.ts — the roots moved");
  }
  for (const root of [...published, ...bundled]) {
    if (!sources.has(root)) {
      throw new Error(`declared entry point is not in the program: ${root}`);
    }
  }
  // A repo script that imports a studio symbol also runs that module's top-level code.
  const reachedFromOutside = [...(edges.get(OUTSIDE) ?? [])].map((id) => decls.get(id)!.file);

  const liveModules = new Set<string>();
  const moduleQueue = [...published, ...bundled, ...reachedFromOutside];
  while (moduleQueue.length > 0) {
    const f = moduleQueue.pop()!;
    if (liveModules.has(f)) {
      continue;
    }
    liveModules.add(f);
    moduleQueue.push(...(importsOf.get(f) ?? []));
  }

  // ── Reachability ────────────────────────────────────────────────────────────────────────────
  const live = new Set<string>();
  const queue: string[] = [];
  const seed = (id: string) => {
    if (!live.has(id)) {
      live.add(id);
      queue.push(id);
    }
  };
  for (const f of liveModules) {
    seed(moduleOwner(sources.get(f).path));
  }
  seed(OUTSIDE);
  // What the package publishes is an entry point: desktop and the cloud platform consume it, and
  // Neither is inside the type-check program.
  for (const decl of decls.values()) {
    if (decl.isExported && published.includes(decl.file)) {
      seed(decl.id);
    }
  }
  while (queue.length > 0) {
    for (const next of edges.get(queue.pop()!) ?? []) {
      seed(next);
    }
  }

  const functions = [...decls.values()].filter((d) => d.isFunction);
  const key = (d: Decl) => `${relative(SRC, d.file)}:${d.name}`;
  const dead = functions
    .filter((d) => !live.has(d.id))
    .map((d) => ({
      name: d.name,
      file: relative(SRC, d.file),
      line: d.line,
      key: key(d),
    }));

  return {
    dead,
    deadModules: studioFiles.filter((f) => !liveModules.has(f)).map((f) => relative(SRC, f)),
    allFunctions: new Set(functions.map((d) => key(d))),
    functionCount: functions.length,
    moduleCount: studioFiles.length,
  };
}
