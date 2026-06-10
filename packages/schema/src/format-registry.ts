/**
 * Format registry — auto-discovery of format-extension classes from a project imports map.
 *
 * A class participates in format dispatch iff its .class.json carries a top-level `format` block.
 * Hosts (compiler, server, studio) build a registry from the project-level imports map and dispatch
 * file-extension work (parse, serialize, discover, load) through it. `.json` is the single native
 * built-in and never appears in a registry.
 *
 * All I/O is injected via FormatHostIO so the same module serves node (fs + import) and browser
 * (fetch + dynamic import) hosts.
 */

export type FormatCapability = "parse" | "serialize" | "discover" | "load";

export const FORMAT_CAPABILITIES: readonly FormatCapability[] = [
  "parse",
  "serialize",
  "discover",
  "load",
];

export type FormatTiming = "compiler" | "server" | "client";

export type FormatDocumentKind = "page" | "component" | "content";

export interface FormatBlock {
  extensions: string[];
  mediaType?: string;
  documentKinds?: FormatDocumentKind[];
  exportTarget?: boolean;
  remote?: boolean;
}

export interface StudioHints {
  icon?: string;
  modes?: string[];
  documentMode?: {
    default?: "content" | "component";
    componentWhen?: { frontmatterKey?: string; matches?: string };
  };
  newFileTemplate?: string;
  elements?: {
    block?: string[];
    inline?: string[];
    void?: string[];
    textOnly?: string[];
    nesting?: Record<
      string,
      {
        block?: boolean;
        inline?: boolean;
        directive?: boolean;
        only?: string[];
      }
    >;
  };
  [key: string]: unknown;
}

export interface CapabilityInfo {
  /** Static method name on the implementation class. */
  identifier: string;
  /** Environments allowed to call directly; others round-trip via the dev server. */
  timing: FormatTiming[];
}

export interface FormatHostIO {
  /** Read and parse a JSON file or URL. */
  loadJson(pathOrUrl: string): Promise<Record<string, unknown>>;
  /** Import a JS module by path or URL. */
  importModule(pathOrUrl: string): Promise<Record<string, unknown>>;
  /** Resolve a relative reference against a base (node: path.resolve; browser: new URL). */
  resolvePath(base: string, ref: string): string;
}

interface ClassMethodLike {
  role?: string;
  identifier?: string;
  scope?: string;
  timing?: string[];
}

interface ClassDefLike {
  title?: string;
  $implementation?: string;
  format?: FormatBlock;
  $studio?: StudioHints;
  $defs?: { methods?: Record<string, ClassMethodLike> };
  [key: string]: unknown;
}

const DEFAULT_TIMING: FormatTiming[] = ["compiler", "server"];

export class FormatEntry {
  readonly name: string;
  readonly classPath: string;
  readonly classDef: ClassDefLike;
  readonly extensions: string[];
  readonly mediaType: string | null;
  readonly documentKinds: FormatDocumentKind[];
  readonly exportTarget: boolean;
  readonly remote: boolean;
  readonly studio: StudioHints | null;
  readonly capabilities: Partial<Record<FormatCapability, CapabilityInfo>>;

  #io: FormatHostIO;
  #implementation: Promise<Record<string, unknown>> | null = null;

  constructor(name: string, classPath: string, classDef: ClassDefLike, io: FormatHostIO) {
    this.name = name;
    this.classPath = classPath;
    this.classDef = classDef;
    this.#io = io;

    const format = classDef.format as FormatBlock;
    this.extensions = (format.extensions ?? []).map((e) => e.toLowerCase());
    this.mediaType = format.mediaType ?? null;
    this.documentKinds = format.documentKinds ?? [];
    this.exportTarget = format.exportTarget === true;
    this.remote = format.remote === true;
    this.studio = classDef.$studio ?? null;
    this.capabilities = extractCapabilities(classDef);
  }

  /** Import (and cache) the class's $implementation module. */
  implementation(): Promise<Record<string, unknown>> {
    if (!this.#implementation) {
      const impl = this.classDef.$implementation;
      if (!impl) {
        return Promise.reject(
          new Error(`Format class "${this.name}" has no $implementation to import`),
        );
      }
      this.#implementation = this.#io.importModule(this.#io.resolvePath(this.classPath, impl));
    }
    return this.#implementation;
  }

  /** Invoke a capability's static method on the implementation class. */
  async call(capability: FormatCapability, ...args: unknown[]): Promise<unknown> {
    const cap = this.capabilities[capability];
    if (!cap) {
      throw new Error(`Format class "${this.name}" does not declare a "${capability}" capability`);
    }
    const mod = await this.implementation();
    const title = this.classDef.title ?? this.name;
    const Cls = (mod[title] ?? (mod.default as Record<string, unknown>)?.[title] ?? mod.default) as
      | Record<string, unknown>
      | undefined;
    const fn = Cls?.[cap.identifier];
    if (typeof fn !== "function") {
      throw new Error(
        `Format class "${this.name}": implementation export "${title}" has no static "${cap.identifier}" method`,
      );
    }
    return await fn.call(Cls, ...args);
  }
}

export class FormatRegistry {
  #entries: FormatEntry[];

  constructor(entries: FormatEntry[]) {
    this.#entries = entries;

    // Ambiguous (extension, capability) claims are a configuration error.
    for (const cap of FORMAT_CAPABILITIES) {
      const seen = new Map<string, FormatEntry>();
      for (const entry of entries) {
        if (!entry.capabilities[cap]) continue;
        for (const ext of entry.extensions) {
          const prior = seen.get(ext);
          if (prior) {
            throw new Error(
              `Format conflict: "${prior.name}" and "${entry.name}" both claim "${ext}" with the "${cap}" capability`,
            );
          }
          seen.set(ext, entry);
        }
      }
    }
  }

  get entries(): readonly FormatEntry[] {
    return this.#entries;
  }

  /** Look up the format claiming an extension, optionally requiring a capability. */
  byExtension(ext: string, capability?: FormatCapability): FormatEntry | undefined {
    const norm = normalizeExt(ext);
    return this.#entries.find(
      (e) => e.extensions.includes(norm) && (!capability || e.capabilities[capability]),
    );
  }

  byName(name: string): FormatEntry | undefined {
    return this.#entries.find((e) => e.name === name);
  }

  withCapability(capability: FormatCapability): FormatEntry[] {
    return this.#entries.filter((e) => e.capabilities[capability]);
  }

  /**
   * All registered extensions, optionally filtered by document kind. Never includes ".json" — JSON
   * is the native built-in, handled inline by hosts.
   */
  documentExtensions(kind?: FormatDocumentKind): string[] {
    const exts = new Set<string>();
    for (const entry of this.#entries) {
      if (kind && !entry.documentKinds.includes(kind)) continue;
      for (const ext of entry.extensions) exts.add(ext);
    }
    exts.delete(".json");
    return [...exts];
  }

  has(ext: string): boolean {
    const norm = normalizeExt(ext);
    return this.#entries.some((e) => e.extensions.includes(norm));
  }
}

/**
 * Build a registry by scanning an imports map ({name: path}) for format classes.
 *
 * Only values ending in ".class.json" are inspected; other imports (layouts, components) are
 * skipped, as are class files that fail to load or carry no `format` block.
 */
export async function buildFormatRegistry(
  imports: Record<string, string> | undefined,
  io: FormatHostIO,
  base?: string,
): Promise<FormatRegistry> {
  const entries: FormatEntry[] = [];
  for (const [name, ref] of Object.entries(imports ?? {})) {
    if (typeof ref !== "string" || !ref.endsWith(".class.json")) continue;
    const classPath = base ? io.resolvePath(base, ref) : ref;
    let classDef: ClassDefLike;
    try {
      classDef = (await io.loadJson(classPath)) as ClassDefLike;
    } catch {
      continue; // unreadable imports are not format classes
    }
    if (!classDef || typeof classDef !== "object") continue;
    if (!classDef.format || !Array.isArray(classDef.format.extensions)) continue;
    entries.push(new FormatEntry(name, classPath, classDef, io));
  }
  return new FormatRegistry(entries);
}

function extractCapabilities(
  classDef: ClassDefLike,
): Partial<Record<FormatCapability, CapabilityInfo>> {
  const out: Partial<Record<FormatCapability, CapabilityInfo>> = {};
  const methods = classDef.$defs?.methods ?? {};
  for (const [key, method] of Object.entries(methods)) {
    const role = method.role as FormatCapability | undefined;
    if (!role || !FORMAT_CAPABILITIES.includes(role)) continue;
    out[role] = {
      identifier: method.identifier ?? key,
      timing: (method.timing as FormatTiming[] | undefined) ?? DEFAULT_TIMING,
    };
  }
  return out;
}

function normalizeExt(ext: string): string {
  const lower = ext.toLowerCase();
  return lower.startsWith(".") ? lower : `.${lower}`;
}
