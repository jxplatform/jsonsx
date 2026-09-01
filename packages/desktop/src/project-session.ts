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
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { handleResolve, handleServerFunction } from "@jxsuite/server/resolve";
import {
  deleteDataRow,
  insertDataRow,
  listDataConnections,
  listSecretNames,
  pushDataSchema,
  queryDataRows,
  setProjectSecrets,
  testDataConnection,
  updateDataRow,
} from "@jxsuite/server/data";
import { applyRename, createFsWatcher, findReferences } from "@jxsuite/server/refactor";
import { startSitePreview } from "@jxsuite/server/site-preview";
import {
  clearLivePreviewOverlay,
  livePreviewOrigin,
  navigateLivePreview,
  notifyLivePreviewChange,
  setLivePreviewOverlay,
  startLivePreview,
} from "@jxsuite/server/live-preview";
import {
  buildExtensionsPayload,
  buildProjectExtensionRegistry,
} from "@jxsuite/compiler/format-host";
import { readBundledProjectSchemas } from "@jxsuite/compiler/schema-command";
import { componentMetaFrom } from "@jxsuite/schema/component-meta";
import type { ExtensionsPayloadEntry } from "@jxsuite/compiler/format-host";
import type {
  ExtensionCatalogEntry,
  DataPushRequest,
  DataRowDelete,
  DataRowInsert,
  DataRowsQuery,
  DataRowUpdate,
  SecretsSetRequest,
} from "@jxsuite/protocol";
import type { ExtensionRegistry } from "@jxsuite/schema/extension-registry";
import type {
  FsEventPayload,
  FsWatcherHandle,
  ReferencesResult,
  RenameReport,
} from "@jxsuite/server/refactor";
import { openExternal as handUrlToOs } from "./utils.ts";
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

interface ClassJsonDef {
  title?: string;
  description?: string;
  extends?: { $ref?: string };
  $defs?: {
    parameters?: Record<string, ClassFieldDef>;
    fields?: Record<string, ClassFieldDef>;
    constructor?: { parameters?: CtorParam[] };
    /* Read below for the format-capability summary. Declared here because it IS read — the omission
       was silent while this package went untypechecked, and only the `as` cast on the read kept it
       from being a hard error. */
    methods?: Record<string, { role?: string; identifier?: string; timing?: string[] }>;
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

// Directory picker used by New Project to choose the parent folder for the scaffolded project.
let directoryDialogFn: (() => Promise<string | null>) | null = null;

export function setDirectoryDialog(fn: () => Promise<string | null>) {
  directoryDialogFn = fn;
}

/**
 * Ask the user for a project.json and answer with the project it names — WITHOUT binding any
 * session to it.
 *
 * Session-free on purpose, and that is the whole point of it existing beside `openProject()`.
 * Picking and binding were one operation, so "open this in a NEW window" had no way to ask the
 * question: the only picker Studio could reach re-rooted the asking window as a side effect of
 * being asked, which is exactly what opening a project elsewhere must not do. `openProject()` is
 * this function plus the binding, so both paths validate identically.
 */
export async function pickProjectFile(): Promise<{
  root: string;
  name: string;
  config: SiteConfig;
} | null> {
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
  const root = dirname(filePath);
  return { config, name: config.name || basename(root), root };
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
  const methods = classDef.$defs?.methods ?? {};
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

/**
 * Order a directory listing so two identical requests answer identically.
 *
 * `readdir` and `Bun.Glob.scan` both answer in FILESYSTEM order, which varies with the directory's
 * internal layout and so with the history of writes to it. Studio's collection grid inserts rows in
 * listing order on purpose (so that a concurrent read cannot decide it), which turns an unsorted
 * listing into a table that reshuffles itself between opens.
 *
 * This is the desktop twin of `byPathOrder` in `@jxsuite/server`'s `studio-api.ts`, and it has to
 * exist in both: the two are separate implementations of the same protocol route, and the desktop
 * app is the end-user path to Studio, so a guarantee only the dev server honours is not a
 * guarantee.
 *
 * Codepoint order, not `localeCompare`, so the answer does not depend on the machine's locale.
 */
function byPathOrder<T extends { path: string }>(entries: T[]): T[] {
  return entries.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function createProjectSession(initialRoot: string | null) {
  let projectRoot: string | null = initialRoot;
  let extensionRegistry: { root: string; registry: ExtensionRegistry } | null = null;

  function requireRoot(): string {
    if (!projectRoot) {
      throw new Error("No project open");
    }
    return projectRoot;
  }

  /**
   * Build the site to its output directory.
   *
   * `View: Open in Browser` runs this before it opens anything, so what the reader sees is what the
   * author is looking at. The compiler is imported dynamically for the same reason the dev server
   * does it: this is the one call that needs the build pipeline, and the desktop process should not
   * carry it for every window that never previews.
   *
   * Errors are RETURNED. A partial build still wrote pages, and refusing to open the one the author
   * asked for would trade a readable page plus a sentence for a sentence.
   *
   * The reply names the ORIGIN the result is browsable at. The built site is served on its own port
   * rather than on this window's project server, because that server's paths mean the project's
   * SOURCES and a built page means its output by the very same paths (`@jxsuite/server`'s
   * `site-preview.ts` has the whole argument).
   */
  async function buildSite(): Promise<{
    routes: number;
    files: number;
    errors: string[];
    url?: string;
  }> {
    const root = requireRoot();
    const { buildSite: build } = await import("@jxsuite/compiler/site");
    // `clean: false` — the reader is on their way to a page, and wiping the output first would
    // Mean every asset 404s for as long as the build takes.
    const result = await build(root, { clean: false, verbose: false });
    const preview = startSitePreview(root);
    return {
      errors: result.errors,
      files: result.files,
      routes: result.routes,
      ...(preview ? { url: preview.origin } : {}),
    };
  }

  /**
   * Preview the site LIVE, and point the project's open tab at a route.
   *
   * The sibling of {@link buildSite} and the one `View: Open in Browser` reaches first. Nothing is
   * compiled: `@jxsuite/site` composes each page from the working tree on demand and
   * `@jxsuite/runtime` assembles it in the reader's browser, so what opens is the tree as it
   * stands, unsaved edits included, because {@link setPreviewOverlay} has already published them.
   *
   * `reused` is the answer the caller must honour. A tab already holding this project's reload
   * stream is retargeted in place; opening another would give the author two tabs on one project,
   * which is the thing the retarget exists to prevent.
   */
  async function previewSite(params: { route: string }): Promise<{
    routes: number;
    files: number;
    errors: string[];
    mode: "live";
    url: string;
    reused: boolean;
  }> {
    const root = requireRoot();
    const preview = await startLivePreview(root);
    /* An origin now exists, and it wants filesystem events whether or not a shell subscribed for
       the sidebar. Re-arming is idempotent — `startWatching` stops the old watcher first. */
    startWatching();
    const reused = params.route ? await navigateLivePreview(root, params.route) : false;
    return {
      errors: preview.errors,
      /* A live preview writes nothing, so there are no files to count. Zero is the honest answer
         for a field the shared shape requires rather than an omission. */
      files: 0,
      mode: "live",
      reused,
      routes: preview.routes,
      url: preview.origin,
    };
  }

  /**
   * Publish the bytes a save WOULD write for one document.
   *
   * Byte-identical to a save by construction: Studio serializes through the same function
   * `writeFile` uses, so what a reader sees and what saving would produce cannot drift. Held in
   * memory and written nowhere, so a crash leaves the preview showing the saved state.
   */
  function setPreviewOverlay(params: { path: string; contents: string }): void {
    setLivePreviewOverlay(requireRoot(), params.path, params.contents);
  }

  /** Drop one document's unsaved bytes, or every one of this project's. */
  function clearPreviewOverlay(params: { path?: string }): void {
    clearLivePreviewOverlay(requireRoot(), params.path);
  }

  /**
   * Point this session at a project, and let go of the last one's unsaved state.
   *
   * The overlay is keyed by project root and lives for the process, so a session that re-roots
   * without clearing would leave one project's unsaved bytes for a later preview of it to read as
   * current. Clearing here is a net under Studio's own lifecycle rather than a replacement for it.
   *
   * Two windows on one project share the overlay, so a re-root by one drops the other's unsaved
   * bytes until its next keystroke republishes them. That is self-healing and bounded, which is why
   * it is preferred to leaving every root a session ever held populated forever.
   */
  function reroot(next: string | null): void {
    if (projectRoot && projectRoot !== next) {
      clearLivePreviewOverlay(projectRoot);
    }
    projectRoot = next;
    extensionRegistry = null;
    startWatching();
  }

  async function getExtensionRegistry(): Promise<ExtensionRegistry> {
    const root = requireRoot();
    if (extensionRegistry?.root === root) {
      return extensionRegistry.registry;
    }
    let projectConfig: ProjectConfig | undefined;
    try {
      projectConfig = JSON.parse(
        readFileSync(resolve(root, "project.json"), "utf8"),
      ) as ProjectConfig;
    } catch {
      projectConfig = undefined;
    }
    const registry = await buildProjectExtensionRegistry(root, projectConfig);
    extensionRegistry = { registry, root };
    return registry;
  }

  async function getFormatRegistry(): Promise<FormatRegistry> {
    const registry = await getExtensionRegistry();
    return registry.formats;
  }

  // ─── Filesystem watching (pushes change events to the webview over RPC) ───────

  let fileEventSink: ((events: FsEventPayload[]) => void) | null = null;
  let watcherHandle: FsWatcherHandle | null = null;

  /**
   * Stop watching, and RESOLVE when the watcher has actually let go.
   *
   * The close is awaited rather than fired and forgotten. chokidar's close is asynchronous, and on
   * Windows the directory keeps an open handle until it finishes — so a caller that tore a session
   * down and immediately deleted the project tree got EBUSY, which is what the data-session suite
   * did on every Windows run. POSIX releases eagerly enough that nothing noticed.
   */
  async function stopWatching(): Promise<void> {
    const handle = watcherHandle;
    watcherHandle = null;
    await handle?.close();
  }

  /** The last root refused below — so the refusal is logged once, not once per re-arm. */
  let unwatchableRoot: string | null = null;

  /**
   * Start watching the active project, or refuse and say so once.
   *
   * This asks exactly what the shell asks: `probeRootProject` reads `project.json` and, without
   * one, reports "no project" and the window shows the welcome screen. A recursive watch of that
   * root is then a scan of someone's directory tree on behalf of a project that is not open — and a
   * root is not always small. `jx-studio ~` is the case that matters: the launcher no longer ADOPTS
   * a non-project working directory, but a root named on the command line is still taken at its
   * word, and this is where taking it at its word stops being expensive.
   *
   * Nothing is lost by waiting. Every way a project can arrive — `openProject`, `createProject`,
   * `setWindowProject` — re-roots the session and calls back here, and by then the `project.json`
   * exists. A directory that becomes a project some other way is not watched until the window is
   * pointed at it, which is also when the sidebar would first have anything to show.
   */
  function startWatching(): void {
    void stopWatching();
    /* Two consumers now, and either is reason enough. The sidebar's sink was the original one; a
       live preview origin is the second, and it wants to know about a git checkout or an external
       editor whether or not a shell happens to be subscribed. */
    if (!projectRoot || (!fileEventSink && !livePreviewOrigin(projectRoot))) {
      return;
    }
    if (!existsSync(resolve(projectRoot, "project.json"))) {
      // Once per root: startWatching runs again on every re-root and every sink registration.
      if (unwatchableRoot !== projectRoot) {
        unwatchableRoot = projectRoot;
        console.log(`[desktop] not watching ${projectRoot} — no project.json, so no project here`);
      }
      return;
    }
    unwatchableRoot = null;
    const sink = fileEventSink;
    const root = projectRoot;
    watcherHandle = createFsWatcher(root, (events) => {
      /* The preview first, so a reload is scheduled from the same event the sidebar redraws on.
         One watcher, two consumers: a second chokidar on the same tree would double the inotify
         watch count and could disagree with this one about what `watch-policy.ts` ignores. */
      notifyLivePreviewChange(root);
      sink?.(events);
    });
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

  /**
   * List the project's enabled extensions with their project-section contributions — the desktop
   * twin of the dev server's formats-route `extensions` payload (entry schemas resolved from each
   * extension's shipped project fragment).
   */
  async function listExtensions(): Promise<ExtensionsPayloadEntry[]> {
    // Welcome windows have no project (and therefore no extensions) — mirror listFormats.
    if (!projectRoot) {
      return [];
    }
    try {
      const registry = await getExtensionRegistry();
      return buildExtensionsPayload(registry);
    } catch (error) {
      console.error("[desktop] listExtensions failed:", error);
      return [];
    }
  }

  /**
   * What this backend can OFFER, enabled or not — the desktop twin of GET
   * /__studio/extension-catalog.
   *
   * Same builder as the dev server, deliberately: what differs between the two hosts is what the
   * resolution PROBE answers, not the code. A desktop build stages what it stages, and hardcoding a
   * bundled list here would tell a reader "just enable it" for a package whose next build throws.
   *
   * A welcome window has no project to probe against, and the shipped half of the catalogue is
   * still true — but `installed`/`bundled` would be answered against nothing, so it returns the
   * empty list and the section falls back to a typed package name, exactly as listExtensions does.
   */
  async function listExtensionCatalog(): Promise<ExtensionCatalogEntry[]> {
    if (!projectRoot) {
      return [];
    }
    try {
      const { buildExtensionCatalog } = await import("@jxsuite/server/extension-catalog");
      return await buildExtensionCatalog(projectRoot);
    } catch (error) {
      console.error("[desktop] listExtensionCatalog failed:", error);
      return [];
    }
  }

  /**
   * The project's generated entry schemas, PRE-BUNDLED for Monaco registration — the desktop twin
   * of GET /__studio/project-schemas (regenerates missing/stale entry documents on demand).
   */
  async function fetchProjectSchemas(): Promise<{
    project?: Record<string, unknown>;
    document?: Record<string, unknown>;
  }> {
    if (!projectRoot) {
      return {};
    }
    try {
      return await readBundledProjectSchemas(projectRoot);
    } catch (error) {
      /*
       * Editor degradation, and it is worth saying WHICH: Studio keeps its bundled core schemas,
       * so `project.json` and documents still validate against the core — what is lost is the
       * per-project extras each enabled extension contributes.
       *
       * One line, not a stack. The failure that actually reaches users here is a host missing an
       * extension package, and its two-deep `cause` chain printed a screenful that named the
       * consequence nowhere. The stack stays available behind the cause.
       */
      const detail = error instanceof Error ? error.message : String(error);
      console.error(
        `[desktop] per-project schemas unavailable — Studio falls back to the bundled core ` +
          `schemas, so extension-contributed fields will not autocomplete or validate. ${detail}`,
      );
      return {};
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
    const picked = await pickProjectFile();
    if (!picked) {
      return null;
    }

    // Binding is the part `pickProjectFile` deliberately leaves out — see its docstring.
    reroot(picked.root);

    return {
      config: picked.config,
      handle: {
        name: picked.name,
        projectConfig: picked.config,
        // Absolute project path: the canonical, re-openable identity used for the recent-projects
        // List and multi-window dedup. File I/O is unaffected (handlers resolve relative paths
        // Against this session's root regardless of the studio-side value).
        root: picked.root,
      },
    };
  }

  /**
   * Scaffold a new project. Unlike the dev server (which resolves the directory against a fixed
   * server root), the desktop app has no single root, so it prompts for a parent folder with the
   * native directory picker and creates `<parent>/<directory>`. The freshly-scaffolded project
   * becomes this window's active project.
   *
   * @param {{
   *   name: string;
   *   description?: string;
   *   url?: string;
   *   adapter?: string;
   *   directory: string;
   *   starter?: string;
   * }} opts
   * @returns {Promise<{ root: string; config: SiteConfig }>}
   */
  /** Open the native directory picker (used by the New Project modal's Import tab). */
  async function pickDirectory(): Promise<{ path: string | null }> {
    if (!directoryDialogFn) {
      throw new Error("No directory dialog configured");
    }
    return { path: await directoryDialogFn() };
  }

  async function createProject(opts: {
    name: string;
    description?: string;
    url?: string;
    adapter?: string;
    directory: string;
    destination: { kind: "path"; parent: string };
    starter?: string;
    template?: string;
    design?: {
      accent?: string;
      background?: string;
      text?: string;
      bodyFont?: string;
      headingFont?: string;
      media?: Record<string, string>;
      logo?: { name: string; base64: string };
    };
  }): Promise<{ root: string; config: SiteConfig }> {
    if (!opts.name || !opts.directory) {
      throw new Error("name and directory are required");
    }
    // `directory` names the project FOLDER, not a path: a separator or dot-segment would walk out
    // Of the parent the user chose below.
    if (/[/\\]/.test(opts.directory) || opts.directory === "." || opts.directory === "..") {
      throw new Error("Directory must be a folder name, not a path");
    }
    // The destination is the caller's to choose (specs/desktop.md §4.5) — the backend never opens
    // A dialog of its own, so a scripted or AI-driven create is never ambushed by one.
    const parent = opts.destination?.parent;
    if (opts.destination?.kind !== "path" || !parent) {
      throw new Error("A destination folder is required.");
    }
    if (!isAbsolute(parent)) {
      throw new Error(`Destination folder must be an absolute path: ${parent}`);
    }
    const destPath = resolve(parent, opts.directory);

    const { generateProject } = await import("@jxsuite/create/generate");
    await generateProject(destPath, {
      name: opts.name,
      ...(opts.adapter === undefined
        ? {}
        : { adapter: opts.adapter as Parameters<typeof generateProject>[1]["adapter"] }),
      ...(opts.description === undefined ? {} : { description: opts.description }),
      ...(opts.url === undefined ? {} : { url: opts.url }),
      ...(opts.starter === undefined ? {} : { starter: opts.starter }),
      ...(opts.template === undefined
        ? {}
        : { template: opts.template as Parameters<typeof generateProject>[1]["template"] }),
      ...(opts.design === undefined ? {} : { design: opts.design }),
    });

    const config = JSON.parse(
      await readFile(resolve(destPath, "project.json"), "utf8"),
    ) as SiteConfig;
    reroot(destPath);

    return { config, root: destPath };
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

    return byPathOrder(result);
  }

  async function readFileHandler(params: { path: string }): Promise<string> {
    const root = requireRoot();
    const abs = resolve(root, params.path);
    assertUnderRoot(abs, root);
    return readFile(abs, "utf8");
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

  /**
   * Where a file or a component tag is used, over the same walker `renameFile` writes through. The
   * engine caches the sweep and drops it from this session's own fs watcher, so the inspector's
   * count, Find Usages and a delete confirmation all read one answer about one moment on disk.
   */
  async function referencesTo(params: {
    path?: string;
    tagName?: string;
  }): Promise<ReferencesResult> {
    const root = requireRoot();
    if (params.path) {
      assertUnderRoot(resolve(root, params.path), root);
    }
    const registry = await getFormatRegistry();
    return findReferences({
      path: params.path ?? null,
      registry,
      root,
      tagName: params.tagName ?? null,
    });
  }

  async function createDirectory(params: { path: string }): Promise<void> {
    const root = requireRoot();
    const abs = resolve(root, params.path);
    assertUnderRoot(abs, root);
    await mkdir(abs, { recursive: true });
  }

  async function uploadFile(params: {
    path: string;
    data: string;
  }): Promise<{ path: string; size: number }> {
    const root = requireRoot();
    const abs = resolve(root, params.path);
    assertUnderRoot(abs, root);
    await mkdir(dirname(abs), { recursive: true });
    const buffer = Buffer.from(params.data, "base64");
    await Bun.write(abs, buffer);
    /* The path this backend wrote is the one it was asked for — it is a filesystem, not a
       content-addressed store — but it REPORTS it, because the caller must not have to know
       which kind of backend it is talking to. */
    return { path: params.path, size: buffer.byteLength };
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
        /* The rules for "is this a component, and which of its `state` entries are props" live in
           @jxsuite/schema/component-meta, shared with the dev server and the cloud adapter. This
           session had its own copy and the two had already drifted — it set `type`/`format` only
           when non-null, which JSON hides — so the answer is one function rather than three.

           The cast is the same one the cloud adapter makes, for the same reason: @jxsuite/schema
           sits UNDER @jxsuite/protocol in the dependency graph, so it reports a `state` entry's
           `type` and `format` as it finds them (`unknown`) while the wire type narrows `type` to
           `string`. Narrowing here would be the extractor lying about a document it just read. */
        const meta = componentMetaFrom(JSON.parse(await readFile(fp, "utf8")), match);
        if (meta) {
          components.push(meta as ComponentMeta);
        }
      } catch {}
    }

    return components;
  }

  async function codeService(_params: unknown): Promise<CodeServiceResult | null> {
    return null;
  }

  /**
   * Hand a URL to the OS (Studio's Preview link clicks). Wrapped in the RPC's params/response shape
   * rather than re-exporting utils' bare `(url) => boolean`, so both launchers can register it
   * straight into their handler map.
   */
  async function openExternal(params: { url: string }): Promise<{ ok: boolean }> {
    return { ok: handUrlToOs(params.url) };
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

  /**
   * Fuzzy filename search behind Studio's Quick Access (⌘P) — the desktop twin of the dev server's
   * GET /__studio/files?glob=… . `extensions` carries the format registry's document extensions on
   * top of the always-searched .json; a leading dot is tolerated on each. Directories never match
   * (the glob ends in an extension), and paths come back project-relative like everywhere else.
   */
  async function searchFiles(params: {
    query: string;
    extensions?: string[];
  }): Promise<DirEntry[]> {
    const root = requireRoot();
    const exts = ["json", ...(params.extensions ?? []).map((e) => e.replace(/^\./, ""))];
    const glob = new Bun.Glob(`**/*${params.query}*.{${exts.join(",")}}`);
    const results: DirEntry[] = [];

    for await (const rawMatch of glob.scan({ cwd: root, dot: false })) {
      const match = toPosix(rawMatch);
      if (match.includes("node_modules") || match.includes("dist/")) {
        continue;
      }
      const absPath = resolve(root, match);
      try {
        const s = await stat(absPath);
        results.push({
          modified: s.mtime.toISOString(),
          name: basename(match),
          path: match,
          size: s.size,
          type: "file",
        });
      } catch {}
    }

    return byPathOrder(results);
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

  // ─── Data surface + secrets (desktop twins of /__studio/data/* + /__studio/secrets) ──────────
  // Delegates verbatim to @jxsuite/server/data: the same owner-console semantics apply — admin row
  // CRUD intentionally bypasses table permissions, with the desktop process boundary as the gate,
  // And secrets flow through .dev.vars with names-only reads (specs/extensions.md §13).

  function dataConnections() {
    return listDataConnections(requireRoot());
  }

  function dataConnectionTest(params: { connection: string }) {
    return testDataConnection(requireRoot(), params.connection);
  }

  function dataPush(params: DataPushRequest) {
    return pushDataSchema(requireRoot(), params);
  }

  function dataRows(params: DataRowsQuery) {
    return queryDataRows(requireRoot(), params);
  }

  function dataInsertRow(params: DataRowInsert) {
    return insertDataRow(requireRoot(), params);
  }

  function dataUpdateRow(params: DataRowUpdate) {
    return updateDataRow(requireRoot(), params);
  }

  function dataDeleteRow(params: DataRowDelete) {
    return deleteDataRow(requireRoot(), params);
  }

  function listSecrets() {
    return listSecretNames(requireRoot());
  }

  function setSecrets(params: SecretsSetRequest) {
    return setProjectSecrets(requireRoot(), params);
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
    setProjectRoot: reroot,
    setFileEventSink,
    dispose: stopWatching,
    listFormats,
    listExtensionCatalog,
    listExtensions,
    fetchProjectSchemas,
    formatAction,
    openProject,
    openExternal,
    buildSite,
    previewSite,
    setPreviewOverlay,
    clearPreviewOverlay,
    createProject,
    pickDirectory,
    listDirectory,
    handleReadFile: readFileHandler,
    handleWriteFile: writeFileHandler,
    handleDeleteFile: deleteFile,
    handleRenameFile: renameFile,
    findReferences: referencesTo,
    handleCreateDirectory: createDirectory,
    handleUploadFile: uploadFile,
    handleResolveSiteContext: resolveSiteContext,
    discoverComponents,
    codeService,
    locateFile,
    searchFiles,
    fetchPluginSchema,
    jxResolve,
    jxServerFunction,
    dataConnections,
    dataConnectionTest,
    dataPush,
    dataRows,
    dataInsertRow,
    dataUpdateRow,
    dataDeleteRow,
    listSecrets,
    setSecrets,
  };
}
