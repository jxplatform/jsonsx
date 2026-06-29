/**
 * Per-window project session. Each Jx Studio window owns one ProjectSession, which holds that
 * window's project root and its format-registry cache, and exposes all the file/format/resolve
 * handlers bound to that root. This is what makes multiple windows track independent projects: the
 * module-level singletons that used to live in handlers.ts are now per-session closures.
 *
 * Handlers.ts keeps a single process-global default session and re-exports the legacy free
 * functions (used by the chromium/ dev launcher and the test suite) by delegating to it.
 */

import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { handleResolve, handleServerFunction } from "@jxsuite/server/resolve";
import { applyRename, createFsWatcher } from "@jxsuite/server/refactor";
import { buildProjectFormatRegistry } from "@jxsuite/compiler/format-host";
import type { FsEventPayload, FsWatcherHandle, RenameReport } from "@jxsuite/server/refactor";
import type { FormatCapability, FormatRegistry } from "@jxsuite/schema/format-registry";
import type { ProjectConfig } from "@jxsuite/schema/types";
import type {
  CodeServiceResult,
  ComponentMeta,
  DirEntry,
  OpenProjectResult,
  SiteConfig,
} from "./rpc-schema";

// ─── Internal schema types for class.json parsing ─────────────────────────────

interface ClassFieldDef {
  identifier?: string;
  name?: string;
  type?: Record<string, unknown>;
  description?: string;
  examples?: unknown[];
  format?: string;
  default?: unknown;
  initializer?: unknown;
  role?: string;
  access?: string;
}

interface CtorParam {
  $ref?: string;
  identifier?: string;
  name?: string;
}

interface ComponentJsonDef {
  tagName?: string;
  $id?: string;
  $elements?: unknown[];
  state?: Record<string, unknown>;
}

interface SlotDef {
  name: string;
  fallback?: unknown[];
}

/**
 * Collect slot definitions (name + fallback children) from a parsed component tree. Whitespace-only
 * names count as unnamed (""). Only static children arrays are walked.
 */
function collectSlotDefs(node: unknown, out: SlotDef[] = []): SlotDef[] {
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    return out;
  }
  const el = node as Record<string, unknown>;
  if (el.tagName === "slot") {
    const attrs = el.attributes as Record<string, unknown> | undefined;
    const rawName = attrs?.name;
    const name = typeof rawName === "string" ? rawName.trim() : "";
    const { children } = el;
    out.push({
      name,
      ...(Array.isArray(children) && children.length > 0 ? { fallback: children } : {}),
    });
  }
  if (Array.isArray(el.children)) {
    for (const c of el.children) {
      collectSlotDefs(c, out);
    }
  }
  return out;
}

interface ClassJsonDef {
  title?: string;
  description?: string;
  extends?: { $ref?: string };
  $defs?: {
    parameters?: Record<string, ClassFieldDef>;
    fields?: Record<string, ClassFieldDef>;
    constructor?: { parameters?: CtorParam[] };
  };
}

export interface StudioSchema {
  type?: string;
  description?: string;
  properties: Record<string, Record<string, unknown>>;
  required: string[];
  format?: Record<string, unknown>;
  $studio?: Record<string, unknown>;
  capabilities?: Record<string, { identifier: string; timing: string[] }>;
}

export interface ProxyResult {
  status: number;
  body: string;
}

// ─── Shared file-dialog capability ────────────────────────────────────────────
// There is only ever one native file dialog, so the picker fn is process-global and shared by
// Every session (set once at startup).

let fileDialogFn: (() => Promise<string | null>) | null = null;

export function setFileDialog(fn: () => Promise<string | null>) {
  fileDialogFn = fn;
}

// ─── Pure helpers (no session state) ──────────────────────────────────────────

// Path convention: every path returned to the studio MUST be forward-slash and project-relative.
// Node's relative() and Bun.Glob.scan() emit OS-native backslashes on Windows.
// Those break the studio's forward-slash assumptions (e.g. findContentTypeSchema's prefix match).
// Route ALL studio-facing paths through toPosix()/relPosix(); a guard test enforces this.

/** Normalize an OS-native path to the studio's forward-slash convention. */
function toPosix(p: string): string {
  return p.replaceAll("\\", "/");
}

/** Project-relative, forward-slash path — the canonical form for every studio-facing path. */
function relPosix(root: string, absPath: string): string {
  return toPosix(relative(root, absPath));
}

/** Normalize a path for cross-platform containment comparison (separators + case on Windows). */
function normalizeForCompare(p: string): string {
  const slashed = toPosix(p);
  return process.platform === "win32" ? slashed.toLowerCase() : slashed;
}

/**
 * The deepest ancestor of `absPath` (inclusive) that exists on disk. Used so the realpath symlink
 * check below applies even when the leaf does not exist yet (a brand-new file/dir being written).
 */
function deepestExisting(absPath: string): string {
  let p = absPath;
  while (!existsSync(p)) {
    const parent = dirname(p);
    if (parent === p) {
      return p;
    }
    p = parent;
  }
  return p;
}

function assertUnderRoot(absPath: string, root: string) {
  // (1) Lexical guard — the raw separator is irrelevant to the "../" and "/" escape checks.
  const rel = relative(root, absPath);
  if (rel.startsWith("..") || rel.startsWith("/")) {
    throw new Error("Path outside project root");
  }
  // (2) Symlink containment (mirrors the project server's containedFile read-path hardening):
  // Realpath the project root and the deepest existing ancestor of the target, then re-check the
  // Resolved target is still under the resolved root. A symlink INSIDE the project that points
  // Outside would otherwise let the file mutators escape root.
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    // Root itself is unresolvable — the lexical guard already passed; do not block.
    return;
  }
  let realTarget: string;
  try {
    realTarget = realpathSync(deepestExisting(absPath));
  } catch {
    return;
  }
  const nRoot = normalizeForCompare(realRoot);
  const nTarget = normalizeForCompare(realTarget);
  const contained =
    nTarget === nRoot || nTarget.startsWith(nRoot.endsWith("/") ? nRoot : `${nRoot}/`);
  if (!contained) {
    throw new Error("Path outside project root");
  }
}

function extractStudioSchema(classDef: ClassJsonDef, classJsonPath: string): StudioSchema {
  let parentSchema: StudioSchema | null = null;
  if (classDef.extends?.["$ref"]) {
    try {
      const parentPath = resolve(dirname(classJsonPath), classDef.extends["$ref"]);
      const parentContent = readFileSync(parentPath, "utf8");
      const parentDef = JSON.parse(parentContent) as ClassJsonDef;
      parentSchema = extractStudioSchema(parentDef, parentPath);
    } catch {}
  }

  const params = classDef.$defs?.parameters ?? {};
  const fields = classDef.$defs?.fields ?? {};
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];

  if (parentSchema?.properties) {
    Object.assign(properties, parentSchema.properties);
  }
  if (parentSchema?.required) {
    required.push(...parentSchema.required);
  }

  for (const [key, param] of Object.entries(params)) {
    const id = param.identifier ?? key;
    const prop: Record<string, unknown> = {};
    if (param.type && typeof param.type === "object") {
      Object.assign(prop, param.type);
    }
    if (param.description) {
      prop.description = param.description;
    }
    if (param.examples) {
      prop.examples = param.examples;
    }
    if (param.format) {
      prop.format = param.format;
    }
    properties[id] = prop;
  }

  for (const [key, field] of Object.entries(fields)) {
    if (field.role !== "field") {
      continue;
    }
    if (field.access === "private") {
      continue;
    }
    const id = field.identifier ?? key;
    const prop: Record<string, unknown> = {};
    if (field.type && typeof field.type === "object") {
      Object.assign(prop, field.type);
    }
    if (field.description) {
      prop.description = field.description;
    }
    if (field.default !== undefined) {
      prop.default = field.default;
    }
    if (field.initializer !== undefined && prop.default === undefined) {
      prop.default = field.initializer;
    }
    if (field.examples) {
      prop.examples = field.examples;
    }
    properties[id] = prop;
  }

  const ctorParams: CtorParam[] = classDef.$defs?.constructor?.parameters ?? [];
  const requiredSet = new Set(required);
  for (const p of ctorParams) {
    const name = p.$ref ? p.$ref.split("/").pop() : (p.identifier ?? p.name);
    if (name && properties[name] && properties[name].default === undefined) {
      requiredSet.add(name);
    }
  }

  const result: StudioSchema = {
    properties,
    required: [...requiredSet],
  };
  const desc = classDef.description ?? classDef.title;
  if (desc != null) {
    result.description = desc;
  }

  // Surface format-extension metadata (format block, studio hints, capability summary)
  const def = classDef as Record<string, unknown>;
  if (def.format) {
    result.format = def.format as Record<string, unknown>;
  }
  if (def.$studio) {
    result.$studio = def.$studio as Record<string, unknown>;
  }
  const capabilityRoles = new Set(["parse", "serialize", "discover", "load"]);
  const methods = (classDef.$defs?.methods ?? {}) as Record<
    string,
    { role?: string; identifier?: string; timing?: string[] }
  >;
  const capabilities: Record<string, { identifier: string; timing: string[] }> = {};
  for (const [key, method] of Object.entries(methods)) {
    if (method.role && capabilityRoles.has(method.role)) {
      capabilities[method.role] = {
        identifier: method.identifier ?? key,
        timing: method.timing ?? ["compiler", "server"],
      };
    }
  }
  if (Object.keys(capabilities).length > 0) {
    result.capabilities = capabilities;
  }
  return result;
}

// ─── Session factory ──────────────────────────────────────────────────────────

export type ProjectSession = ReturnType<typeof createProjectSession>;

export function createProjectSession(initialRoot: string | null) {
  let projectRoot: string | null = initialRoot;
  let formatRegistry: { root: string; registry: FormatRegistry } | null = null;

  function requireRoot(): string {
    if (!projectRoot) {
      throw new Error("No project open");
    }
    return projectRoot;
  }

  async function getFormatRegistry(): Promise<FormatRegistry> {
    const root = requireRoot();
    if (formatRegistry?.root === root) {
      return formatRegistry.registry;
    }
    let projectConfig: ProjectConfig | undefined;
    try {
      projectConfig = JSON.parse(
        readFileSync(resolve(root, "project.json"), "utf8"),
      ) as ProjectConfig;
    } catch {
      projectConfig = undefined;
    }
    const registry = await buildProjectFormatRegistry(root, projectConfig);
    formatRegistry = { registry, root };
    return registry;
  }

  // ─── Filesystem watching (pushes change events to the webview over RPC) ───────

  let fileEventSink: ((events: FsEventPayload[]) => void) | null = null;
  let watcherHandle: FsWatcherHandle | null = null;

  function stopWatching(): void {
    if (watcherHandle) {
      void watcherHandle.close();
      watcherHandle = null;
    }
  }

  function startWatching(): void {
    stopWatching();
    if (projectRoot && fileEventSink) {
      const sink = fileEventSink;
      watcherHandle = createFsWatcher(projectRoot, (events) => sink(events));
    }
  }

  /** Register (or clear) the sink that receives batched filesystem events for the active project. */
  function setFileEventSink(sink: ((events: FsEventPayload[]) => void) | null): void {
    fileEventSink = sink;
    startWatching();
  }

  /** List the project's registered format classes (auto-discovered from imports). */
  async function listFormats() {
    // No project open yet (e.g. a fresh welcome window): there are no imported formats to list, and
    // Building a registry would throw "No project open". Return empty quietly instead of logging a
    // Spurious error — the studio's welcome screen calls this before any project is loaded.
    if (!projectRoot) {
      return [];
    }
    try {
      const registry = await getFormatRegistry();
      return registry.entries.map((e) => ({
        capabilities: e.capabilities,
        documentKinds: e.documentKinds,
        exportTarget: e.exportTarget,
        extensions: e.extensions,
        mediaType: e.mediaType,
        name: e.name,
        remote: e.remote,
        studio: e.studio,
      }));
    } catch (error) {
      console.error("[desktop] listFormats failed:", error);
      return [];
    }
  }

  /** Invoke a format capability (parse/serialize) through the registry. */
  async function formatAction(params: {
    format: string;
    action: string;
    source?: string;
    doc?: Record<string, unknown>;
    options?: Record<string, unknown>;
  }) {
    try {
      const registry = await getFormatRegistry();
      const entry = registry.byName(params.format);
      if (!entry) {
        throw new Error(`Format "${params.format}" is not an imported format class`);
      }
      if (params.action !== "parse" && params.action !== "serialize") {
        throw new Error(`Unsupported action "${params.action}"`);
      }
      return params.action === "parse"
        ? await entry.call("parse" as FormatCapability, params.source ?? "", params.options)
        : await entry.call("serialize" as FormatCapability, params.doc ?? {}, params.options);
    } catch (error) {
      // Re-throw as a plain Error: non-Error rejection values (e.g. Bun's ResolveMessage) do not
      // Survive the electrobun RPC bridge and crash the bun process as an unhandled rejection.
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  async function openProject(): Promise<OpenProjectResult | null> {
    if (!fileDialogFn) {
      throw new Error("No file dialog configured");
    }
    const selectedPath = await fileDialogFn();
    if (!selectedPath) {
      return null;
    }

    const filePath = resolve(selectedPath);
    if (!existsSync(filePath) || basename(filePath) !== "project.json") {
      throw new Error("Selected file is not a project.json");
    }

    const raw = await readFile(filePath, "utf8");
    const config = JSON.parse(raw) as SiteConfig;
    projectRoot = dirname(filePath);
    formatRegistry = null;
    startWatching();

    return {
      config,
      handle: {
        name: config.name || basename(projectRoot),
        projectConfig: config,
        // Absolute project path: the canonical, re-openable identity used for the recent-projects
        // List and multi-window dedup. File I/O is unaffected (handlers resolve relative paths
        // Against this session's root regardless of the studio-side value).
        root: projectRoot,
      },
    };
  }

  async function listDirectory(params: { dir: string }): Promise<DirEntry[]> {
    const root = requireRoot();
    const absDir = resolve(root, params.dir);
    assertUnderRoot(absDir, root);

    const entries = await readdir(absDir, { withFileTypes: true });
    const result: DirEntry[] = [];

    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const absPath = join(absDir, entry.name);
      try {
        const s = await stat(absPath);
        result.push({
          modified: s.mtime.toISOString(),
          name: entry.name,
          path: relPosix(root, absPath),
          size: s.size,
          type: entry.isDirectory() ? "directory" : "file",
        });
      } catch {}
    }

    return result;
  }

  async function readFileHandler(params: { path: string }): Promise<string> {
    const root = requireRoot();
    const abs = resolve(root, params.path);
    assertUnderRoot(abs, root);
    return readFile(abs, "utf8");
  }

  async function readFileAsDataUrl(params: { path: string }): Promise<string> {
    const root = requireRoot();
    let abs = resolve(root, params.path);
    assertUnderRoot(abs, root);

    if (!existsSync(abs)) {
      const publicAbs = resolve(root, "public", params.path);
      assertUnderRoot(publicAbs, root);
      if (!existsSync(publicAbs)) {
        throw new Error(`File not found: ${params.path}`);
      }
      abs = publicAbs;
    }

    const buffer = await readFile(abs);
    const base64 = Buffer.from(buffer).toString("base64");
    const ext = params.path.split(".").pop()?.toLowerCase() || "";
    const mimeMap: Record<string, string> = {
      avif: "image/avif",
      gif: "image/gif",
      ico: "image/x-icon",
      jpeg: "image/jpeg",
      jpg: "image/jpeg",
      png: "image/png",
      svg: "image/svg+xml",
      webp: "image/webp",
    };
    const mime = mimeMap[ext] || "application/octet-stream";
    return `data:${mime};base64,${base64}`;
  }

  async function writeFileHandler(params: { path: string; content: string }): Promise<void> {
    const root = requireRoot();
    const abs = resolve(root, params.path);
    assertUnderRoot(abs, root);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, params.content, "utf8");
  }

  async function deleteFile(params: { path: string }): Promise<void> {
    const root = requireRoot();
    const abs = resolve(root, params.path);
    assertUnderRoot(abs, root);
    await rm(abs, { force: true, maxRetries: 3, retryDelay: 100 });
  }

  async function renameFile(params: { from: string; to: string }): Promise<RenameReport> {
    const root = requireRoot();
    const absFrom = resolve(root, params.from);
    const absTo = resolve(root, params.to);
    assertUnderRoot(absFrom, root);
    assertUnderRoot(absTo, root);
    await mkdir(dirname(absTo), { recursive: true });
    await rename(absFrom, absTo);
    // Refactor pass: rewrite references project-wide and auto-rename a component's tag (Pillar B/C).
    // The move already succeeded, so a refactor failure degrades to a bare report instead of erroring.
    try {
      const registry = await getFormatRegistry();
      return await applyRename({ absFrom, absTo, registry, root });
    } catch {
      const rel = (p: string) => relPosix(root, p);
      return {
        errors: [],
        from: rel(absFrom),
        isDir: false,
        ok: true,
        references: { files: [], filesChanged: 0, refsUpdated: 0 },
        to: rel(absTo),
      };
    }
  }

  async function createDirectory(params: { path: string }): Promise<void> {
    const root = requireRoot();
    const abs = resolve(root, params.path);
    assertUnderRoot(abs, root);
    await mkdir(abs, { recursive: true });
  }

  async function uploadFile(params: { path: string; data: string }): Promise<void> {
    const root = requireRoot();
    const abs = resolve(root, params.path);
    assertUnderRoot(abs, root);
    await mkdir(dirname(abs), { recursive: true });
    const buffer = Buffer.from(params.data, "base64");
    await Bun.write(abs, buffer);
  }

  async function resolveSiteContext(params: {
    filePath: string;
  }): Promise<{ sitePath: string | null }> {
    const root = requireRoot();
    let dir = resolve(root, dirname(params.filePath));

    while (true) {
      const rel = relative(root, dir);
      if (rel.startsWith("..") || rel.startsWith("/")) {
        break;
      }

      const candidate = join(dir, "project.json");
      if (existsSync(candidate)) {
        return { sitePath: relPosix(root, dir) || "." };
      }

      const parent = dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }

    return { sitePath: null };
  }

  async function discoverComponents(params: { dir?: string }): Promise<ComponentMeta[]> {
    const root = requireRoot();
    const scanRoot = params.dir ? resolve(root, params.dir) : root;
    if (params.dir) {
      assertUnderRoot(scanRoot, root);
    }

    const glob = new Bun.Glob("**/*.json");
    const components: ComponentMeta[] = [];

    for await (const rawMatch of glob.scan({ cwd: scanRoot, dot: false })) {
      // Normalize first: Bun.Glob emits backslashes on Windows, which would both leak to the studio
      // And defeat the forward-slash "dist/" / ".claude/" exclusion checks below.
      const match = toPosix(rawMatch);
      if (match.includes("node_modules") || match.includes("dist/") || match.includes(".claude/")) {
        continue;
      }
      const fp = resolve(scanRoot, match);
      try {
        const content = JSON.parse(await readFile(fp, "utf8")) as ComponentJsonDef;
        if (content.tagName && content.tagName.includes("-")) {
          const slotDefs = collectSlotDefs(content);
          components.push({
            $id: content.$id || null,
            hasElements: Array.isArray(content.$elements) && content.$elements.length > 0,
            path: match,
            props: Object.entries(content.state || {})
              .filter(([, d]) => {
                if (d == null) {
                  return false;
                }
                if (typeof d !== "object") {
                  return true;
                }
                const entry = d as Record<string, unknown>;
                return !entry.$prototype && !entry.$handler && !entry.$compute;
              })
              .map(([name, d]) => {
                if (typeof d !== "object") {
                  return { default: d, name, type: typeof d };
                }
                const entry = d as Record<string, unknown>;
                const propResult: {
                  name: string;
                  type?: string;
                  default?: unknown;
                  format?: string;
                } = {
                  default: entry.default,
                  name,
                };
                if (entry.type != null) {
                  propResult.type = entry.type as string;
                }
                if (entry.format != null) {
                  propResult.format = entry.format as string;
                }
                return propResult;
              }),
            ...(slotDefs.length > 0 ? { slots: slotDefs } : {}),
            tagName: content.tagName,
          });
        }
      } catch {}
    }

    return components;
  }

  async function codeService(_params: unknown): Promise<CodeServiceResult | null> {
    return null;
  }

  async function locateFile(params: { name: string }): Promise<string | null> {
    const root = requireRoot();
    const glob = new Bun.Glob(`**/${params.name}`);
    const matches: string[] = [];

    for await (const rawMatch of glob.scan({ cwd: root, dot: false })) {
      const match = toPosix(rawMatch);
      if (match.includes("node_modules") || match.includes("dist/")) {
        continue;
      }
      matches.push(match);
    }

    return matches.length > 0 ? matches[0] : null;
  }

  async function fetchPluginSchema(params: {
    src: string;
    prototype?: string;
    base?: string;
  }): Promise<unknown> {
    const root = requireRoot();

    let moduleAbsPath: string;
    try {
      if (params.src.startsWith("./") || params.src.startsWith("../")) {
        // Relative path — resolve against the document's directory when a base is provided
        if (params.base) {
          const docUrlPath = new URL(params.base).pathname;
          const docDir = docUrlPath.slice(0, docUrlPath.lastIndexOf("/") + 1);
          moduleAbsPath = resolve(resolve(root, `.${docDir}`), params.src);
        } else {
          moduleAbsPath = resolve(root, params.src);
        }
      } else {
        // Npm/bare specifier (e.g. "@jxsuite/parser/ContentCollection.class.json") — resolve
        // Through the project's node_modules, falling back to the desktop package's own require.
        const { createRequire } = await import("node:module");
        const projRequire = createRequire(resolve(root, "package.json"));
        try {
          moduleAbsPath = projRequire.resolve(params.src);
        } catch {
          const selfRequire = createRequire(import.meta.url);
          moduleAbsPath = selfRequire.resolve(params.src);
        }
      }
    } catch {
      return null;
    }

    if (moduleAbsPath.endsWith(".class.json")) {
      try {
        const content = readFileSync(moduleAbsPath, "utf8");
        const classDef = JSON.parse(content) as ClassJsonDef;
        return extractStudioSchema(classDef, moduleAbsPath);
      } catch {
        return null;
      }
    }

    const exportName = params.prototype || params.src;
    const classJsonPath = resolve(dirname(moduleAbsPath), `${exportName}.class.json`);
    if (existsSync(classJsonPath)) {
      try {
        const content = readFileSync(classJsonPath, "utf8");
        const classDef = JSON.parse(content) as ClassJsonDef;
        return extractStudioSchema(classDef, classJsonPath);
      } catch {}
    }

    try {
      const mod = (await import(moduleAbsPath)) as Record<string, unknown> & {
        default?: Record<string, unknown>;
      };
      const ExportedClass = mod[exportName] ?? mod.default?.[exportName];
      if (typeof ExportedClass !== "function") {
        return null;
      }
      return (ExportedClass as { schema?: unknown }).schema ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Proxy a $prototype + $src class resolution. Mirrors the dev server's POST /**jx_resolve**:
   * loads project context (content types) and runs the class's resolve() server-side. This is what
   * makes ContentCollection / MarkdownCollection and friends return live data in the studio.
   */
  async function jxResolve(params: { body: string }): Promise<ProxyResult> {
    const root = requireRoot();
    const req = new Request("http://localhost/__jx_resolve__", {
      body: params.body,
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    // ActiveProjectRoot defaults to the project root (parity with project-server.ts:311).
    // Resolve.ts falls back null||root, so this is low-risk and correct for a nested-site $base.
    const res = await handleResolve(req, root, root);
    return { body: await res.text(), status: res.status };
  }

  /** Proxy a timing: "server" function call. Mirrors the dev server's POST /**jx_server**. */
  async function jxServerFunction(params: { body: string }): Promise<ProxyResult> {
    const root = requireRoot();
    const req = new Request("http://localhost/__jx_server__", {
      body: params.body,
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const res = await handleServerFunction(req, root);
    return { body: await res.text(), status: res.status };
  }

  return {
    get projectRoot(): string | null {
      return projectRoot;
    },
    setProjectRoot(root: string | null) {
      projectRoot = root;
      formatRegistry = null;
      startWatching();
    },
    setFileEventSink,
    dispose: stopWatching,
    listFormats,
    formatAction,
    openProject,
    listDirectory,
    handleReadFile: readFileHandler,
    handleReadFileAsDataUrl: readFileAsDataUrl,
    handleWriteFile: writeFileHandler,
    handleDeleteFile: deleteFile,
    handleRenameFile: renameFile,
    handleCreateDirectory: createDirectory,
    handleUploadFile: uploadFile,
    handleResolveSiteContext: resolveSiteContext,
    discoverComponents,
    codeService,
    locateFile,
    fetchPluginSchema,
    jxResolve,
    jxServerFunction,
  };
}
