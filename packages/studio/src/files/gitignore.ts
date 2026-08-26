/**
 * Gitignore matching for the Files sidebar.
 *
 * A project root is a working directory, and a working directory holds two populations: the files
 * the author writes, and the files a tool wrote for them — `node_modules`, `dist`, `coverage`,
 * `.next`. The sidebar listed both, so a project of forty documents opened as a tree of forty
 * thousand rows. The author already told us which is which, in the one file every project of this
 * shape carries: `.gitignore`.
 *
 * **This lives in Studio, not behind the PAL, on purpose.** `listDirectory` has three
 * implementations — the dev server's route, the desktop session's `readdir`, and the cloud backend,
 * which is not in this repository at all. Filtering there is the same rule written three times, and
 * a rule written three times is a rule that disagrees with itself; the cloud copy could not even be
 * changed in the same pull request. Filtering here is written once and is true on every host the
 * moment it ships. It costs one `readFile` per directory (cached, negatives included), which is the
 * same round trip the listing itself already makes.
 *
 * **The tree cache stays faithful.** {@link isIgnoredEntry} is consulted where rows are BUILT, not
 * where entries are stored, so `projectState.dirs` keeps mirroring the filesystem and the show/hide
 * toggle is a repaint rather than a refetch. It also means `applyFsEvents` needs to know nothing
 * about any of this: a file arriving into an ignored directory lands in the cache and is simply not
 * drawn.
 *
 * The matcher implements `gitignore(5)` — comments, negation, trailing-space and `#`/`!` escapes,
 * directory-only patterns, anchoring, `**`, character classes, and last-match-wins across layers
 * ordered shallow-to-deep. What it deliberately does NOT read is `.git/info/exclude` or
 * `core.excludesFile`: both live outside the project, neither is reachable through the PAL's
 * project-rooted `readFile`, and a rule the author cannot see in their own repository is a poor
 * explanation for a missing row.
 *
 * @docs studio/interface
 */

import { getPlatform } from "../platform";

// ─── The rule ─────────────────────────────────────────────────────────────────

/** One `.gitignore` line, compiled. */
export interface IgnoreRule {
  /** The line as written. Kept so a hidden row can be explained by the rule that hid it. */
  source: string;
  /** `!pattern` — re-includes what an earlier rule excluded. */
  negated: boolean;
  /** `pattern/` — matches a directory and never a file. */
  dirOnly: boolean;
  /** Matches a path relative to the directory the rule's own `.gitignore` sits in. */
  re: RegExp;
}

/** The rules of one `.gitignore`, with the directory they are relative to. */
export interface IgnoreLayer {
  /** Project-relative, forward-slashed, no trailing slash; `""` is the project root. */
  base: string;
  rules: IgnoreRule[];
}

// ─── Parsing ──────────────────────────────────────────────────────────────────

/** Characters that mean something to a RegExp and nothing to a glob. */
const RE_SPECIAL = /[.*+?^${}()|[\]\\]/;

/** One glob character as a RegExp literal. */
function literal(ch: string): string {
  return RE_SPECIAL.test(ch) ? `\\${ch}` : ch;
}

/**
 * Drop trailing spaces, keeping any the author escaped.
 *
 * A space survives when the run of backslashes immediately before it is odd — the same rule that
 * decides whether the backslash escaped the space or another backslash.
 */
function stripTrailingSpaces(line: string): string {
  let end = line.length;
  while (end > 0 && line[end - 1] === " ") {
    let backslashes = 0;
    let i = end - 2;
    while (i >= 0 && line[i] === "\\") {
      backslashes += 1;
      i -= 1;
    }
    if (backslashes % 2 === 1) {
      break;
    }
    end -= 1;
  }
  return line.slice(0, end);
}

/**
 * The index of the `]` closing the class opened at `start`, or -1 when the line has none.
 *
 * A `]` in the first position (after an optional `!`) is a literal member rather than the close,
 * which is POSIX's rule and git's.
 */
function charClassEnd(pattern: string, start: number): number {
  let i = start + 1;
  if (pattern[i] === "!") {
    i += 1;
  }
  if (pattern[i] === "]") {
    i += 1;
  }
  while (i < pattern.length) {
    if (pattern[i] === "\\") {
      i += 2;
      continue;
    }
    if (pattern[i] === "]") {
      return i;
    }
    i += 1;
  }
  return -1;
}

/**
 * Compile a gitignore glob body to a RegExp source.
 *
 * `*` and `?` stop at a separator; `**` crosses them, but only where git says it does — as a whole
 * path segment. `a**b` is git's "two stars that are not a segment", and it behaves as one star.
 */
function globToRegExpSource(pattern: string): string {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === "\\") {
      const next = pattern[i + 1];
      if (next === undefined) {
        // A trailing backslash escapes nothing; match it literally.
        out += String.raw`\\`;
        i += 1;
      } else {
        out += literal(next);
        i += 2;
      }
      continue;
    }
    if (ch === "*") {
      let stars = 0;
      while (pattern[i] === "*") {
        stars += 1;
        i += 1;
      }
      /* `out` ends in `/` only where a separator was just emitted — every compiled form above ends
         in `*`, `)` or an escaped literal — so this is exactly "at the start of a segment". */
      const atSegmentStart = out === "" || out.endsWith("/");
      if (stars >= 2 && atSegmentStart && pattern[i] === "/") {
        // `**/` — zero or more whole directories.
        out += "(?:[^/]+/)*";
        i += 1;
      } else if (stars >= 2 && atSegmentStart && i >= pattern.length) {
        // A trailing `/**` — everything inside, at any depth.
        out += ".*";
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      i += 1;
      continue;
    }
    if (ch === "[") {
      const end = charClassEnd(pattern, i);
      if (end === -1) {
        out += String.raw`\[`;
        i += 1;
        continue;
      }
      const raw = pattern.slice(i + 1, end);
      const negatedClass = raw.startsWith("!");
      const members = negatedClass ? raw.slice(1) : raw;
      /* A `]` in the first position is a MEMBER to git and POSIX, and {@link charClassEnd} finds
         the real close accordingly — but JavaScript reads `[]` as an empty class that matches
         nothing, and `[^]` as "any character". Emitting the member verbatim therefore inverts the
         rule instead of translating it, so the leading `]` is escaped on the way out. */
      out += `[${negatedClass ? "^" : ""}${members.startsWith("]") ? String.raw`\]${members.slice(1)}` : members}]`;
      i = end + 1;
      continue;
    }
    out += literal(ch);
    i += 1;
  }
  return out;
}

/** Compile one line, or `null` when it is blank, a comment, or names nothing. */
function parseLine(raw: string): IgnoreRule | null {
  let line = stripTrailingSpaces(raw);
  if (line === "" || line.startsWith("#")) {
    return null;
  }
  let negated = false;
  if (line.startsWith("!")) {
    negated = true;
    line = line.slice(1);
  }
  /* `\#` and `\!` reach the compiler with their backslash intact and come out as literals, so the
     two checks above are the only place the unescaped forms are read. */
  let dirOnly = false;
  if (line.endsWith("/")) {
    dirOnly = true;
    line = line.slice(0, -1);
  }
  /* A slash anywhere but the end anchors the pattern to the `.gitignore`'s own directory; a
     slash-less pattern matches its name at any depth below it. */
  let anchored = line.includes("/");
  if (line.startsWith("/")) {
    line = line.slice(1);
    anchored = true;
  }
  if (line === "") {
    return null;
  }
  const body = globToRegExpSource(line);
  return {
    dirOnly,
    negated,
    re: new RegExp(`^${anchored ? "" : "(?:.*/)?"}${body}$`),
    source: raw,
  };
}

/** Compile a `.gitignore`'s text into rules, in file order. */
export function parseGitignore(text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const rule = parseLine(raw);
    if (rule) {
      rules.push(rule);
    }
  }
  return rules;
}

// ─── Paths ────────────────────────────────────────────────────────────────────

/** Project-relative, forward-slashed, and without the `.`/`./`/trailing-slash spellings of "here". */
export function normalizePath(path: string): string {
  const p = path
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
  return p === "." ? "" : p;
}

/** `path` relative to `base`, or `null` when it is not underneath it. */
function relativeTo(base: string, path: string): string | null {
  if (base === "") {
    return path;
  }
  return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : null;
}

/** The project root, then each directory down to `dir`, inclusive. */
export function ancestorDirs(dir: string): string[] {
  const base = normalizePath(dir);
  const chain = [""];
  if (base === "") {
    return chain;
  }
  let acc = "";
  for (const segment of base.split("/")) {
    acc = acc === "" ? segment : `${acc}/${segment}`;
    chain.push(acc);
  }
  return chain;
}

// ─── Matching ─────────────────────────────────────────────────────────────────

/**
 * The verdict on one path, judged on its own.
 *
 * Last match wins, and later layers are consulted after earlier ones — which is exactly git's two
 * precedence rules (a later line beats an earlier one; a deeper `.gitignore` beats a shallower one)
 * expressed as a single ordering.
 */
function verdictFor(layers: readonly IgnoreLayer[], path: string, isDir: boolean): boolean {
  let ignored = false;
  for (const layer of layers) {
    const rel = relativeTo(layer.base, path);
    if (rel === null || rel === "") {
      continue;
    }
    for (const rule of layer.rules) {
      if (rule.dirOnly && !isDir) {
        continue;
      }
      if (rule.re.test(rel)) {
        ignored = !rule.negated;
      }
    }
  }
  return ignored;
}

/**
 * Whether `path` is ignored by `layers`, which must be ordered shallow-to-deep.
 *
 * Every ancestor directory is judged before the path itself, and the first one that comes back
 * ignored ends it. That is `gitignore(5)`'s "it is not possible to re-include a file if a parent
 * directory of that file is excluded", and it is not decoration: `node_modules` and `dist/` are the
 * two patterns every project has, and judging `node_modules/pkg/index.js` on its own says NOT
 * ignored — the pattern names `node_modules`, and the path is not it. Checked against `git
 * check-ignore` over a matrix of thirty-five paths, this rule is the difference between agreeing
 * with git everywhere and disagreeing on the two cases that matter most.
 *
 * The sidebar happens not to depend on it — an ignored directory draws no row, so nothing ever asks
 * about its children — but a predicate that is only correct for the caller that exists today is a
 * trap for the next one.
 */
export function isIgnored(layers: readonly IgnoreLayer[], path: string, isDir: boolean): boolean {
  const target = normalizePath(path);
  if (target === "") {
    return false;
  }
  const segments = target.split("/");
  let prefix = "";
  for (const [index, segment] of segments.entries()) {
    prefix = prefix === "" ? segment : `${prefix}/${segment}`;
    const last = index === segments.length - 1;
    // Every ancestor is a directory; only the final segment is what the caller said it is.
    if (verdictFor(layers, prefix, last ? isDir : true)) {
      return true;
    }
  }
  return false;
}

// ─── The loaded layers ────────────────────────────────────────────────────────

/** Directory → its own `.gitignore` compiled, or `null` for "looked, there is none". */
const layerCache = new Map<string, IgnoreLayer | null>();
/** Reads in progress, so a burst of sibling listings makes one request per directory. */
const inFlight = new Map<string, Promise<IgnoreLayer | null>>();

/** Forget every layer. Called when the project changes and when a `.gitignore` does. */
export function resetIgnoreCache(): void {
  layerCache.clear();
  inFlight.clear();
}

/**
 * Read and compile one directory's `.gitignore`. Uncached, and never rejects.
 *
 * A directory without a `.gitignore` is the common case rather than an error, and a backend that
 * fails the read for some other reason gets the same answer — "no rules" shows the file, and
 * showing a file the author meant to hide is the only harmless way to be wrong here. The call is
 * wrapped rather than awaited directly because a platform adapter is free to throw synchronously.
 */
async function readGitignore(dir: string): Promise<IgnoreLayer | null> {
  try {
    const text = await getPlatform().readFile(dir === "" ? ".gitignore" : `${dir}/.gitignore`);
    return { base: dir, rules: parseGitignore(text) };
  } catch {
    return null;
  }
}

/** {@link readGitignore}, once per directory, with concurrent callers sharing the one read. */
function readLayer(dir: string): Promise<IgnoreLayer | null> {
  const cached = layerCache.get(dir);
  if (cached !== undefined) {
    return Promise.resolve(cached);
  }
  const pending = inFlight.get(dir);
  if (pending) {
    return pending;
  }
  const read = readGitignore(dir).then((layer) => {
    layerCache.set(dir, layer);
    inFlight.delete(dir);
    return layer;
  });
  inFlight.set(dir, read);
  return read;
}

/**
 * Re-read every `.gitignore` the tree has already consulted, and swap the results in together.
 *
 * Read-then-swap rather than clear-then-read, and that is the whole point of the function: an empty
 * cache means "nothing is ignored", so a repaint landing between the two would draw a
 * `node_modules` and then take it away again. Only directories already probed are re-read — the
 * ones nobody has listed will read their rules when someone does.
 */
export async function reloadIgnoreCache(): Promise<void> {
  const dirs = [...layerCache.keys()];
  inFlight.clear();
  const fresh = await Promise.all(dirs.map((dir) => readGitignore(dir)));
  layerCache.clear();
  for (const [index, dir] of dirs.entries()) {
    layerCache.set(dir, fresh[index] ?? null);
  }
}

/** Load every `.gitignore` governing `dir`, so {@link isIgnoredEntry} can answer synchronously. */
export async function ensureIgnoreLayers(dir: string): Promise<void> {
  await Promise.all(ancestorDirs(dir).map((ancestor) => readLayer(ancestor)));
}

/** The already-loaded layers governing `dir`, shallow-to-deep. */
export function loadedLayersFor(dir: string): IgnoreLayer[] {
  const layers: IgnoreLayer[] = [];
  for (const ancestor of ancestorDirs(dir)) {
    const layer = layerCache.get(ancestor);
    if (layer) {
      layers.push(layer);
    }
  }
  return layers;
}

/**
 * Whether the entry at `path`, listed under `dir`, is masked by `.gitignore`.
 *
 * Synchronous, and answers `false` for anything whose layers have not been read yet — a row that
 * appears and then disappears one frame later is a worse artefact than a row that stayed. The
 * listing path awaits {@link ensureIgnoreLayers}, so that frame does not normally exist.
 */
export function isIgnoredEntry(dir: string, path: string, isDir: boolean): boolean {
  return isIgnored(loadedLayersFor(dir), path, isDir);
}

/** Whether any of these paths is a `.gitignore`, i.e. whether the cache is now stale. */
export function touchesGitignore(paths: readonly string[]): boolean {
  return paths.some((path) => normalizePath(path).split("/").pop() === ".gitignore");
}
