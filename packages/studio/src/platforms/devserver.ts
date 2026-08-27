/**
 * Devserver.js — Dev Server Platform Adapter
 *
 * Implements the StudioPlatform interface for the @jxsuite/server development workflow. All file
 * I/O goes through /__studio/* REST endpoints. Project opening uses the Chrome File System Access
 * API (showDirectoryPicker).
 *
 * See spec/desktop.md §8 for the full specification.
 */

import { streamImport } from "../services/import-client";
import { canPickDirectory, pickDirectoryPath } from "../services/directory-picker";
import { negotiateCollab } from "@jxsuite/collab/negotiate";
import type { CollabNegotiation } from "@jxsuite/collab/negotiate";
import type { WsCollabConnection } from "@jxsuite/collab/client";
import type { ProjectConfig } from "@jxsuite/schema/types";
import type {
  CreateProjectDestination,
  DataConnectionsResponse,
  DataConnectionTestResult,
  DataPushResult,
  DataRowDelete,
  DataRowInsert,
  DataRowsQuery,
  DataRowsResult,
  DataRowUpdate,
  DirEntry,
  ExtensionsInfo,
  FsEvent,
  ImportProgressEvent,
  ImportSiteOptions,
  ProjectSchemasResponse,
  ReferencesResult,
  RenameResult,
  SecretsSetRequest,
  SecretsSetResponse,
  SiteBuildResult,
  SitePreviewResult,
  StarterInfo,
} from "../types";
import { problemDetail, problemMessage } from "@jxsuite/protocol";
import type { UploadResult } from "@jxsuite/protocol";

/** A directory entry from the server, tolerating extra wire fields. */
type WireDirEntry = DirEntry & Record<string, unknown>;

/** Parse a fetch Response body as JSON, asserting the expected shape at the boundary. */
async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

interface ErrorBody {
  error?: string;
}

interface SiteEntry {
  config: unknown;
  path: string;
}

/**
 * Create a DevServerPlatform instance.
 *
 * The adapter is stateless apart from `_projectRoot`, which tracks the server-relative project
 * directory (e.g. "examples/site-demo"). All paths passed INTO PAL methods are project-relative;
 * the adapter prefixes them with `_projectRoot` before hitting the server, and strips the prefix
 * from responses.
 */
export function createDevServerPlatform() {
  let _projectRoot = "";
  /**
   * Lazy /__studio/collab capability probe (null = not asked yet). Its result is the subprotocol
   * negotiation, not a boolean: the probe is the only place the client can learn what envelope the
   * server speaks without risking the handshake (see `@jxsuite/collab/negotiate`).
   */
  let _collabProbe: Promise<CollabNegotiation | null> | null = null;
  /**
   * One multiplexed collab socket per page; per-doc handles come from openDoc. Memoized as a
   * promise so concurrent first opens share the connection instead of racing two sockets.
   */
  let _collabConnection: Promise<WsCollabConnection> | null = null;

  /**
   * Prefix a project-relative path with the active project root for server API calls.
   *
   * @param {string} rel
   */
  function serverPath(rel: string) {
    const r = rel.replaceAll("\\", "/");
    if (!_projectRoot) {
      return r;
    }
    if (r === ".") {
      return _projectRoot;
    }
    return `${_projectRoot}/${r}`;
  }

  /**
   * Strip the project root prefix from a server-root-relative path.
   *
   * @param {string} path
   */
  function stripRoot(path: string) {
    const p = path.replaceAll("\\", "/");
    if (!_projectRoot) {
      return p;
    }
    return p.startsWith(`${_projectRoot}/`) ? p.slice(_projectRoot.length + 1) : p;
  }

  return {
    id: "devserver",

    /* New projects go where the user says — the server refuses a create without a destination
       rather than defaulting to its own root, which is the jx checkout when serving this
       monorepo. */
    createDestination: "path" as const,

    /** Get or set the current project root (absolute path). */
    get projectRoot() {
      return _projectRoot;
    },
    set projectRoot(v) {
      _projectRoot = v || "";
      if (_projectRoot) {
        // Fire-and-forget: callers that need the binding in place before reading await activate()
        // Themselves. The rejection is reported rather than dropped — an unactivated root leaves
        // Every rootless endpoint (git especially) operating on the server's OWN root.
        void this.activate(_projectRoot).catch((error: unknown) => {
          console.error("Project activation failed:", error);
        });
      }
    },

    /**
     * Notify the server which project root to use for resolving static file paths. Returns a
     * promise so callers can await activation before loading assets.
     *
     * Throws when the server refuses the root. Silence here is worse than an error: the endpoints
     * that take no `dir` fall back to the server's own root, so a swallowed refusal turns "sync
     * this project" into git commands against whatever tree the dev server is serving.
     *
     * @param {string} [root]
     */
    async activate(root?: string) {
      const r = root ?? _projectRoot;
      const res = await fetch("/__studio/activate", {
        body: JSON.stringify({ root: r }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!res.ok) {
        const body = (await readJson<ErrorBody>(res).catch(() => ({}))) as ErrorBody;
        throw new Error(
          `Could not open ${r}: ${problemDetail(body) ?? `activation failed (${res.status})`}`,
        );
      }
    },

    // ─── Project opening ──────────────────────────────────────────────────

    async openProject() {
      // Use Chrome's showDirectoryPicker API
      if (!("showDirectoryPicker" in window)) {
        throw new Error("showDirectoryPicker not available — use a Chromium-based browser");
      }

      let dirHandle;
      try {
        dirHandle = await (
          window as unknown as {
            showDirectoryPicker: (opts: { mode: string }) => Promise<FileSystemDirectoryHandle>;
          }
        ).showDirectoryPicker({ mode: "readwrite" });
      } catch (error) {
        // User cancelled the picker
        if (error instanceof Error && error.name === "AbortError") {
          return null;
        }
        throw error;
      }

      // Read project.json from the chosen directory
      let siteHandle;
      try {
        siteHandle = await dirHandle.getFileHandle("project.json");
      } catch {
        throw new Error("No project.json found in selected folder");
      }

      const file = await siteHandle.getFile();
      const config = JSON.parse(await file.text()) as ProjectConfig;

      // Resolve server-relative path by matching against known sites
      const sitesRes = await fetch("/__studio/sites");
      if (!sitesRes.ok) {
        throw new Error("Failed to fetch site list from server");
      }
      const sites = await readJson<SiteEntry[]>(sitesRes);
      const match = sites.find(
        (s: SiteEntry) => JSON.stringify(s.config) === JSON.stringify(config),
      );

      if (!match) {
        // Project is outside dev server root — ask the server to find it by directory name
        const findRes = await fetch(
          `/__studio/find-project?name=${encodeURIComponent(dirHandle.name)}`,
        );
        if (!findRes.ok) {
          throw new Error("Could not locate project on disk");
        }
        const found = await readJson<{ path?: string }>(findRes);
        if (!found.path) {
          throw new Error(`Could not find project directory "${dirHandle.name}"`);
        }
        _projectRoot = found.path;
      } else {
        _projectRoot = match.path;
      }

      // Notify server of active project for static file resolution
      await this.activate();

      return {
        config,
        handle: {
          name: config.name || _projectRoot.split("/").pop()!,
          projectConfig: config,
          root: _projectRoot,
        },
      };
    },

    /**
     * Probe the server root to see if it is itself a site project. Used at startup to auto-detect
     * projects.
     */
    async probeRootProject() {
      try {
        const [projectRes, infoRes] = await Promise.all([
          fetch("/__studio/project"),
          fetch("/__studio/project-info?dir=."),
        ]);
        const meta = projectRes.ok
          ? await readJson<{ name: string; root: string }>(projectRes)
          : { name: "project", root: "." };
        const info = infoRes.ok
          ? await readJson<{
              isSiteProject: boolean;
              projectConfig?: ProjectConfig | null;
              directories?: string[];
              [key: string]: unknown;
            }>(infoRes)
          : { isSiteProject: false };
        return { info, meta };
      } catch {
        return null;
      }
    },

    // ─── Project creation ─────────────────────────────────────────────────

    /**
     * Scaffold a project at `destination.parent/directory`. The dev server refuses the request
     * outright when no destination is supplied — it will not fall back to its own root.
     *
     * @param {{
     *   name: string;
     *   description?: string;
     *   url?: string;
     *   adapter?: string;
     *   directory: string;
     *   destination: CreateProjectDestination;
     * }} opts
     */
    async createProject(opts: {
      name: string;
      description?: string;
      url?: string;
      adapter?: string;
      directory: string;
      destination: CreateProjectDestination;
      starter?: string;
      template?: string;
      design?: Record<string, unknown>;
    }) {
      const res = await fetch("/__studio/create-project", {
        body: JSON.stringify(opts),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!res.ok) {
        const data = await readJson<ErrorBody>(res);
        throw new Error(problemDetail(data) ?? "Failed to create project");
      }
      return await res.json();
    },

    /**
     * Native folder chooser for the New Project modal's Browse… button. Present only when the
     * browser implements `showDirectoryPicker` (Chromium-based); elsewhere the member stays
     * undefined and the modal falls back to a typed Location field.
     *
     * The picked handle carries no filesystem path, so it is resolved by the id the picker tags the
     * folder with (see `@jxsuite/studio/directory-picker`).
     */
    ...(canPickDirectory()
      ? {
          async pickDirectory(): Promise<string | null> {
            return pickDirectoryPath(async ({ id, name }) => {
              const res = await fetch(
                `/__studio/locate-directory?name=${encodeURIComponent(name)}&id=${encodeURIComponent(id)}`,
              );
              if (!res.ok) {
                return null;
              }
              const found = await readJson<{ path?: string }>(res);
              return found.path ?? null;
            });
          },
        }
      : {}),

    /** List starter templates from the dev server. */
    async listStarters(): Promise<StarterInfo[]> {
      const res = await fetch("/__studio/starters");
      if (!res.ok) {
        throw new Error("Failed to load starters");
      }
      return await readJson<StarterInfo[]>(res);
    },

    /** AI-guided site import: NDJSON progress stream from the dev server's import endpoint. */
    async importSite(
      opts: ImportSiteOptions,
      onProgress: (evt: ImportProgressEvent) => void,
      signal?: AbortSignal,
    ) {
      return await streamImport("/__studio/import-site", opts, onProgress, signal);
    },

    // ─── File operations ──────────────────────────────────────────────────

    /** @param {string} dir */
    async listDirectory(dir: string) {
      const res = await fetch(`/__studio/files?dir=${encodeURIComponent(serverPath(dir))}`);
      if (!res.ok) {
        throw new Error(`Failed to list directory: ${dir}`);
      }
      const entries = await readJson<WireDirEntry[]>(res);
      for (const e of entries) {
        e.path = stripRoot(e.path);
      }
      return entries;
    },

    /** @param {string} path */
    async readFile(path: string) {
      const res = await fetch(`/__studio/file?path=${encodeURIComponent(serverPath(path))}`);
      if (!res.ok) {
        throw new Error(`Failed to read file: ${path}`);
      }
      const data = await readJson<{ content: string }>(res);
      return data.content;
    },

    /**
     * @param {string} path
     * @param {string} content
     */
    async writeFile(path: string, content: string) {
      const res = await fetch(`/__studio/file?path=${encodeURIComponent(serverPath(path))}`, {
        body: content,
        method: "PUT",
      });
      if (!res.ok) {
        throw new Error(`Failed to write file: ${path}`);
      }
    },

    /**
     * Upload a binary file (image, video, font, etc.).
     *
     * @param {string} path — project-relative destination path
     * @param {File | Blob | ArrayBuffer} data — file content
     */
    async uploadFile(path: string, data: string | File | Blob | ArrayBuffer) {
      const res = await fetch(
        `/__studio/file/upload?path=${encodeURIComponent(serverPath(path))}`,
        { body: data, method: "POST" },
      );
      if (!res.ok) {
        throw new Error(`Upload failed: ${path}`);
      }
      const body = (await res.json()) as Partial<UploadResult>;
      // The dev server echoes the path today; falling back to the request keeps a backend that says
      // Nothing working rather than writing `undefined` into a document.
      return { path: body.path ?? path, ...(body.size === undefined ? {} : { size: body.size }) };
    },

    /** @param {string} path */
    async deleteFile(path: string) {
      const res = await fetch(`/__studio/file?path=${encodeURIComponent(serverPath(path))}`, {
        method: "DELETE",
      });
      if (!res.ok && res.status !== 404) {
        throw new Error(`Failed to delete file: ${path}`);
      }
    },

    /**
     * @param {string} from
     * @param {string} to
     */
    async renameFile(from: string, to: string): Promise<RenameResult> {
      const res = await fetch("/__studio/file/rename", {
        body: JSON.stringify({ from: serverPath(from), to: serverPath(to) }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!res.ok) {
        throw new Error(`Failed to rename: ${from} → ${to}`);
      }
      const report = await readJson<RenameResult>(res);
      // Map server-root-relative report paths back to project-relative for the studio.
      if (typeof report.from === "string") {
        report.from = stripRoot(report.from);
      }
      if (typeof report.to === "string") {
        report.to = stripRoot(report.to);
      }
      for (const f of report.references?.files ?? []) {
        f.path = stripRoot(f.path);
      }
      for (const e of report.errors ?? []) {
        e.path = stripRoot(e.path);
      }
      return report;
    },

    /**
     * Where a file / component tag is used, over the same walker the rename above writes through.
     * The engine caches the sweep server-side and drops it from the dev server's own file watcher,
     * so the three renderings never disagree and never re-scan the project per keystroke.
     *
     * @param {{ path?: string; tagName?: string }} target
     */
    async findReferences(target: { path?: string; tagName?: string }): Promise<ReferencesResult> {
      const params = new URLSearchParams();
      if (target.path) {
        params.set("path", serverPath(target.path));
      }
      if (target.tagName) {
        params.set("tag", target.tagName);
      }
      const res = await fetch(`/__studio/references?${params.toString()}`);
      if (!res.ok) {
        throw new Error(`Failed to find references: ${target.path ?? target.tagName ?? ""}`);
      }
      const result = await readJson<ReferencesResult>(res);
      // Server-root-relative report paths → project-relative, as renameFile already does.
      if (typeof result.path === "string") {
        result.path = stripRoot(result.path);
      }
      for (const f of result.files ?? []) {
        f.path = stripRoot(f.path);
      }
      for (const e of result.errors ?? []) {
        e.path = stripRoot(e.path);
      }
      return result;
    },

    /**
     * Subscribe to filesystem change events over the dev server's SSE stream. Listens for the named
     * "fs" event (the preview iframe's default `onmessage` ignores it), strips paths to
     * project-relative, and drops events for sibling projects outside the active root.
     */
    subscribeFileEvents(handler: (events: FsEvent[]) => void) {
      if (typeof EventSource === "undefined") {
        return () => {};
      }
      const es = new EventSource("/__reload");
      es.addEventListener("fs", (ev: MessageEvent) => {
        let payload: { events?: FsEvent[] };
        try {
          payload = JSON.parse(ev.data as string) as { events?: FsEvent[] };
        } catch {
          return;
        }
        const events: FsEvent[] = [];
        for (const e of payload.events ?? []) {
          const raw = e.path.replaceAll("\\", "/");
          if (_projectRoot && raw !== _projectRoot && !raw.startsWith(`${_projectRoot}/`)) {
            continue;
          }
          const path = stripRoot(raw);
          if (path && !path.startsWith("..")) {
            events.push({ isDir: e.isDir, path, type: e.type });
          }
        }
        if (events.length > 0) {
          handler(events);
        }
      });
      return () => {
        es.close();
      };
    },

    /**
     * Realtime co-editing over the dev server's /__studio/collab endpoint (rooms keyed by
     * server-root-relative path). Probes capability once — older servers without the endpoint
     * degrade to solo editing; the wire client's evaluation defers behind the dynamic import until
     * a doc opens.
     *
     * The same probe carries the subprotocol negotiation. A server that advertises no `protocols`
     * predates it and gets no offer, because an offer it cannot echo would fail the handshake
     * outright (RFC 6455 §4.1); a server that advertises an envelope this build does not speak is
     * refused here, where the reason can be said, rather than in a room where the two would merge
     * divergent histories.
     */
    async collab(docPath: string) {
      if (typeof WebSocket === "undefined" || typeof location === "undefined") {
        return null;
      }
      if (_collabProbe === null) {
        _collabProbe = fetch("/__studio/collab")
          .then(async (res) => (res.ok ? negotiateCollab(await res.json()) : null))
          .catch(() => null);
      }
      const negotiation = await _collabProbe;
      if (negotiation === null) {
        return null;
      }
      if (negotiation.refused !== null) {
        console.warn(`Collaboration unavailable: ${negotiation.refused}`);
        return null;
      }
      const { offer } = negotiation;
      _collabConnection ??= (async () => {
        const { createWsCollabConnection } = await import("@jxsuite/collab/client");
        const scheme = location.protocol === "https:" ? "wss" : "ws";
        return createWsCollabConnection({
          protocols: offer,
          url: `${scheme}://${location.host}/__studio/collab`,
        });
      })();
      const connection = await _collabConnection;
      return connection.openDoc(serverPath(docPath));
    },

    /** @param {string} _path */
    async createDirectory(_path: string) {
      // The server creates directories implicitly when writing files.
      // Write a placeholder and delete it, or rely on mkdir behavior.
      // For now, use the writeFile + delete approach if directory creation
      // Is explicitly needed. The server's writeFile already calls mkdir().
    },

    // ─── Component discovery ──────────────────────────────────────────────

    /** @param {string} dir */
    async discoverComponents(dir?: string) {
      const scanDir = dir || _projectRoot;
      if (!scanDir) {
        return [];
      }
      const url = `/__studio/components?dir=${encodeURIComponent(scanDir)}`;
      const res = await fetch(url);
      if (!res.ok) {
        return [];
      }
      return await res.json();
    },

    // ─── Package management ──────────────────────────────────────────────

    /** @param {string} name */
    async addPackage(name: string) {
      const res = await fetch("/__studio/packages/add", {
        body: JSON.stringify({ name }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!res.ok) {
        throw new Error(await res.text());
      }
      return await res.json();
    },

    /** @param {string} name */
    async removePackage(name: string) {
      const res = await fetch("/__studio/packages/remove", {
        body: JSON.stringify({ name }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!res.ok) {
        throw new Error(await res.text());
      }
      return await res.json();
    },

    async listPackages() {
      const res = await fetch("/__studio/packages");
      if (!res.ok) {
        return [];
      }
      return await res.json();
    },

    async installDependencies() {
      const res = await fetch("/__studio/packages/install", { method: "POST" });
      if (!res.ok) {
        return { log: await res.text(), ok: false };
      }
      return await res.json();
    },

    async dependenciesNeedInstall() {
      const res = await fetch("/__studio/packages/needs-install");
      if (!res.ok) {
        return false;
      }
      const data = (await res.json()) as { needsInstall?: boolean };
      return Boolean(data.needsInstall);
    },

    async packageVersions() {
      const res = await fetch("/__studio/packages/versions");
      if (!res.ok) {
        return [];
      }
      return await res.json();
    },

    /** @param {{ name: string; version: string; dev?: boolean }[]} updates */
    async setPackageVersions(updates: { name: string; version: string; dev?: boolean }[]) {
      const res = await fetch("/__studio/packages/set-versions", {
        body: JSON.stringify({ updates }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!res.ok) {
        return { log: await res.text(), ok: false };
      }
      return await res.json();
    },

    // ─── Code services (optional) ─────────────────────────────────────────

    /**
     * @param {string} action
     * @param {unknown} payload
     */
    async codeService(action: string, payload: unknown) {
      try {
        const res = await fetch(`/__studio/code/${action}`, {
          body: JSON.stringify(payload),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        if (!res.ok) {
          return null;
        }
        return await res.json();
      } catch {
        return null;
      }
    },

    // ─── Site context resolution ──────────────────────────────────────

    /**
     * Given an absolute file path, walk up to find the nearest project.json ancestor. Returns {
     * sitePath, projectConfig } or { sitePath: null }.
     *
     * @param {string} filePath — absolute system path
     */
    async resolveSiteContext(filePath: string) {
      const res = await fetch(`/__studio/resolve-site?path=${encodeURIComponent(filePath)}`);
      if (!res.ok) {
        return { sitePath: null };
      }
      return await res.json();
    },

    // ─── File location ────────────────────────────────────────────────────

    /** @param {string} name */
    async locateFile(name: string) {
      try {
        const res = await fetch("/__studio/locate", {
          body: JSON.stringify({ name }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        if (res.ok) {
          const body = await readJson<{ path?: string }>(res);
          return body.path || null;
        }
      } catch {}
      return null;
    },

    /**
     * @param {string} query
     * @param {string[]} [extensions] — extra extensions beyond .json (from the format registry)
     */
    async searchFiles(query: string, extensions: string[] = []) {
      const exts = ["json", ...extensions.map((e: string) => e.replace(/^\./, ""))];
      const glob = `**/*${query}*.{${exts.join(",")}}`;
      const res = await fetch(
        `/__studio/files?dir=${encodeURIComponent(serverPath("."))}&glob=${encodeURIComponent(glob)}`,
      );
      if (!res.ok) {
        return [];
      }
      const entries = await readJson<WireDirEntry[]>(res);
      for (const e of entries) {
        e.path = stripRoot(e.path);
      }
      return entries;
    },

    // ─── Format registry ──────────────────────────────────────────────────

    /** List the project's registered format classes (auto-discovered from imports). */
    async listFormats() {
      const res = await fetch(`/__studio/formats?dir=${encodeURIComponent(serverPath("."))}`);
      if (!res.ok) {
        return [];
      }
      const body = await readJson<{ formats?: unknown[] }>(res);
      return body.formats ?? [];
    },

    /** The extensions payload riding beside `formats` on the same route. */
    async listExtensions(): Promise<ExtensionsInfo[]> {
      const res = await fetch(`/__studio/formats?dir=${encodeURIComponent(serverPath("."))}`);
      if (!res.ok) {
        return [];
      }
      const body = await readJson<{ extensions?: ExtensionsInfo[] }>(res);
      return body.extensions ?? [];
    },

    /** Pre-bundled per-project entry schemas for Monaco registration (empty when unavailable). */
    async fetchProjectSchemas(): Promise<ProjectSchemasResponse> {
      const res = await fetch(
        `/__studio/project-schemas?dir=${encodeURIComponent(serverPath("."))}`,
      );
      if (!res.ok) {
        return {};
      }
      return await readJson<ProjectSchemasResponse>(res);
    },

    // ─── Data surface + secrets (owner console over /__studio/data/* + /__studio/secrets) ──

    /** Connector connections with configured state, table names, and provider metadata. */
    async dataConnections(): Promise<DataConnectionsResponse> {
      const res = await fetch(
        `/__studio/data/connections?dir=${encodeURIComponent(serverPath("."))}`,
      );
      if (!res.ok) {
        const data = await readJson<ErrorBody>(res);
        throw new Error(problemDetail(data) ?? "Failed to list connections");
      }
      return await readJson<DataConnectionsResponse>(res);
    },

    /** Probe one connection through the backend's connector registry. */
    async dataConnectionTest(connection: string): Promise<DataConnectionTestResult> {
      const res = await fetch(
        `/__studio/data/connections/test?dir=${encodeURIComponent(serverPath("."))}`,
        {
          body: JSON.stringify({ connection }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        },
      );
      const data = await readJson<DataConnectionTestResult & ErrorBody>(res);
      if (!res.ok) {
        throw new Error(problemDetail(data) ?? "Connection test failed");
      }
      return data;
    },

    /** Additive schema push; `dryRun` compiles the plan without applying it. */
    async dataPush(opts?: { connection?: string; dryRun?: boolean }): Promise<DataPushResult> {
      const res = await fetch(`/__studio/data/push?dir=${encodeURIComponent(serverPath("."))}`, {
        body: JSON.stringify(opts ?? {}),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const data = await readJson<DataPushResult & ErrorBody>(res);
      if (!res.ok) {
        throw new Error(problemDetail(data) ?? "Schema push failed");
      }
      return data;
    },

    /** Page a table's rows with introspected column metadata. */
    async dataRows(query: DataRowsQuery): Promise<DataRowsResult> {
      const params = new URLSearchParams({ dir: serverPath("."), table: query.table });
      if (query.connection) {
        params.set("connection", query.connection);
      }
      if (query.limit !== undefined) {
        params.set("limit", String(query.limit));
      }
      if (query.offset !== undefined) {
        params.set("offset", String(query.offset));
      }
      if (query.orderBy !== undefined) {
        params.set("orderBy", query.orderBy);
      }
      if (query.dir !== undefined) {
        params.set("dir", query.dir);
      }
      const res = await fetch(`/__studio/data/rows?${params}`);
      const data = await readJson<DataRowsResult & ErrorBody>(res);
      if (!res.ok) {
        throw new Error(problemDetail(data) ?? "Failed to load rows");
      }
      return data;
    },

    async dataInsertRow(req: DataRowInsert): Promise<{ row: Record<string, unknown> }> {
      const res = await fetch(`/__studio/data/rows?dir=${encodeURIComponent(serverPath("."))}`, {
        body: JSON.stringify(req),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const data = await readJson<{ row: Record<string, unknown> } & ErrorBody>(res);
      if (!res.ok) {
        throw new Error(problemDetail(data) ?? "Insert failed");
      }
      return data;
    },

    async dataUpdateRow(req: DataRowUpdate): Promise<{ row: Record<string, unknown> }> {
      const res = await fetch(`/__studio/data/rows?dir=${encodeURIComponent(serverPath("."))}`, {
        body: JSON.stringify(req),
        headers: { "Content-Type": "application/json" },
        method: "PUT",
      });
      const data = await readJson<{ row: Record<string, unknown> } & ErrorBody>(res);
      if (!res.ok) {
        throw new Error(problemDetail(data) ?? "Update failed");
      }
      return data;
    },

    async dataDeleteRow(req: DataRowDelete): Promise<{ ok: boolean }> {
      const params = new URLSearchParams({
        dir: serverPath("."),
        pk: String(req.pk),
        table: req.table,
      });
      if (req.connection) {
        params.set("connection", req.connection);
      }
      const res = await fetch(`/__studio/data/rows?${params}`, { method: "DELETE" });
      const data = await readJson<{ ok: boolean } & ErrorBody>(res);
      if (!res.ok) {
        throw new Error(problemDetail(data) ?? "Delete failed");
      }
      return data;
    },

    /** Configured secret env-var NAMES — never values. */
    async listSecrets(): Promise<string[]> {
      const res = await fetch(`/__studio/secrets?dir=${encodeURIComponent(serverPath("."))}`);
      if (!res.ok) {
        const data = await readJson<ErrorBody>(res);
        throw new Error(problemDetail(data) ?? "Failed to list secrets");
      }
      const data = await readJson<{ names: string[] }>(res);
      return data.names;
    },

    /** Write/remove secrets in the dev server's .dev.vars; names-only response. */
    async setSecrets(req: SecretsSetRequest): Promise<SecretsSetResponse> {
      const res = await fetch(`/__studio/secrets?dir=${encodeURIComponent(serverPath("."))}`, {
        body: JSON.stringify(req),
        headers: { "Content-Type": "application/json" },
        method: "PUT",
      });
      const data = await readJson<SecretsSetResponse & ErrorBody>(res);
      if (!res.ok) {
        throw new Error(problemDetail(data) ?? "Failed to write secrets");
      }
      return data;
    },

    /**
     * Invoke a format capability (parse/serialize) server-side.
     *
     * @param {Record<string, unknown>} payload — { format, action, source?, doc?, options? }
     */
    async formatAction(payload: Record<string, unknown>) {
      const res = await fetch("/__studio/format", {
        body: JSON.stringify({ ...payload, dir: serverPath(".") }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const data = await readJson<{ error?: string; result?: unknown }>(res);
      if (!res.ok) {
        throw new Error(problemDetail(data) ?? "Format action failed");
      }
      return data.result;
    },

    // ─── Plugin schema ────────────────────────────────────────────────────

    /**
     * @param {string} src
     * @param {string} prototype
     * @param {string} base
     */
    async fetchPluginSchema(src: string, prototype?: string, base?: string) {
      const params = new URLSearchParams({ src });
      if (prototype) {
        params.set("prototype", prototype);
      }
      if (base) {
        params.set("base", base);
      }
      const res = await fetch(`/__studio/plugin-schema?${params}`);
      if (!res.ok) {
        return null;
      }
      const { schema } = await readJson<{ schema: unknown }>(res);
      return schema;
    },

    // ─── Class resolution (dev-proxy) ─────────────────────────────────────

    /** @param {Record<string, unknown>} body */
    async resolveClass(body: Record<string, unknown>) {
      const res = await fetch("/__jx_resolve__", {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      if (!res.ok) {
        throw new Error(`Class resolution failed: ${res.status}`);
      }
      return await readJson<unknown>(res);
    },

    // ─── Git operations ──────────────────────────────────────────────────

    async gitStatus() {
      const res = await fetch("/__studio/git/status");
      if (!res.ok) {
        throw new Error(await res.text());
      }
      return await res.json();
    },

    async gitBranches() {
      const res = await fetch("/__studio/git/branches");
      if (!res.ok) {
        throw new Error(await res.text());
      }
      return await res.json();
    },

    /** @param {number} [limit] */
    async gitLog(limit?: number) {
      const q = limit ? `?limit=${limit}` : "";
      const res = await fetch(`/__studio/git/log${q}`);
      if (!res.ok) {
        throw new Error(await res.text());
      }
      return await res.json();
    },

    /** @param {string[]} files */
    async gitStage(files: string[]) {
      const res = await fetch("/__studio/git/stage", {
        body: JSON.stringify({ files }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!res.ok) {
        const body = await readJson<ErrorBody>(res);
        throw new Error(problemMessage(body));
      }
      return await res.json();
    },

    /** @param {string[]} files */
    async gitUnstage(files: string[]) {
      const res = await fetch("/__studio/git/unstage", {
        body: JSON.stringify({ files }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!res.ok) {
        const body = await readJson<ErrorBody>(res);
        throw new Error(problemMessage(body));
      }
      return await res.json();
    },

    /** @param {string} message */
    async gitCommit(message: string) {
      const res = await fetch("/__studio/git/commit", {
        body: JSON.stringify({ message }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!res.ok) {
        const body = await readJson<ErrorBody>(res);
        throw new Error(problemMessage(body));
      }
      return await res.json();
    },

    /** @param {{ setUpstream?: boolean }} [opts] */
    async gitPush(opts?: { setUpstream?: boolean }) {
      const res = await fetch("/__studio/git/push", {
        body: JSON.stringify(opts || {}),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!res.ok) {
        const body = await readJson<ErrorBody>(res);
        throw new Error(problemMessage(body));
      }
      return await res.json();
    },

    async gitPull() {
      const res = await fetch("/__studio/git/pull", { method: "POST" });
      if (!res.ok) {
        const body = await readJson<ErrorBody>(res);
        throw new Error(problemMessage(body));
      }
      return await res.json();
    },

    async gitFetch() {
      const res = await fetch("/__studio/git/fetch", { method: "POST" });
      if (!res.ok) {
        const body = await readJson<ErrorBody>(res);
        throw new Error(problemMessage(body));
      }
      return await res.json();
    },

    /** @param {string} branch */
    async gitCheckout(branch: string) {
      const res = await fetch("/__studio/git/checkout", {
        body: JSON.stringify({ branch }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!res.ok) {
        const body = await readJson<ErrorBody>(res);
        throw new Error(problemMessage(body));
      }
      return await res.json();
    },

    /** @param {string} name */
    async gitCreateBranch(name: string) {
      const res = await fetch("/__studio/git/create-branch", {
        body: JSON.stringify({ name }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!res.ok) {
        const body = await readJson<ErrorBody>(res);
        throw new Error(problemMessage(body));
      }
      return await res.json();
    },

    /** @param {string} [path] */
    async gitDiff(path?: string) {
      const res = await fetch(`/__studio/git/diff?path=${encodeURIComponent(path ?? "")}`);
      if (!res.ok) {
        throw new Error(await res.text());
      }
      return await res.json();
    },

    /** @param {{ path: string; ref?: string }} opts */
    async gitShow(opts: { path: string; ref?: string }) {
      const params = new URLSearchParams({ path: opts.path });
      if (opts.ref) {
        params.set("ref", opts.ref);
      }
      const res = await fetch(`/__studio/git/show?${params}`);
      if (!res.ok) {
        throw new Error(await res.text());
      }
      const data = await readJson<{ content: string }>(res);
      return data.content;
    },

    /** @param {string[]} files */
    async gitDiscard(files: string[]) {
      const res = await fetch("/__studio/git/discard", {
        body: JSON.stringify({ files }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!res.ok) {
        const body = await readJson<ErrorBody>(res);
        throw new Error(problemMessage(body));
      }
      return await res.json();
    },

    /** @param {string} url */
    async gitClone(url: string) {
      const res = await fetch("/__studio/git/clone", {
        body: JSON.stringify({ url }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!res.ok) {
        const body = await readJson<ErrorBody>(res);
        throw new Error(problemMessage(body));
      }
      return await res.json();
    },

    async gitInit() {
      const res = await fetch("/__studio/git/init", { method: "POST" });
      if (!res.ok) {
        const body = await readJson<ErrorBody>(res);
        throw new Error(problemMessage(body));
      }
    },
    async buildSite() {
      const res = await fetch("/__studio/build", { method: "POST" });
      if (!res.ok) {
        const body = await readJson<ErrorBody>(res);
        throw new Error(problemDetail(body) ?? "The site could not be built.");
      }
      return (await res.json()) as SiteBuildResult;
    },

    /**
     * Preview the working tree live, and point this project's open tab at a route.
     *
     * The dev server holds the same live origin the desktop launchers do, so the browser Studio
     * gets the same preview: composed on demand, unsaved edits included.
     */
    async previewSite(opts: { route: string }) {
      const res = await fetch("/__studio/preview", {
        body: JSON.stringify(opts),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!res.ok) {
        const body = await readJson<ErrorBody>(res);
        throw new Error(problemDetail(body) ?? "The site could not be previewed.");
      }
      return (await res.json()) as SitePreviewResult;
    },

    async setPreviewOverlay(path: string, contents: string) {
      await fetch("/__studio/preview/overlay", {
        body: JSON.stringify({ contents, path }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
    },

    async clearPreviewOverlay(path?: string) {
      await fetch("/__studio/preview/overlay", {
        body: JSON.stringify(path === undefined ? {} : { path }),
        headers: { "Content-Type": "application/json" },
        method: "DELETE",
      });
    },

    /**
     * @param {string} name
     * @param {string} url
     */
    async gitAddRemote(name: string, url: string) {
      const res = await fetch("/__studio/git/add-remote", {
        body: JSON.stringify({ name, url }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!res.ok) {
        const body = await readJson<ErrorBody>(res);
        throw new Error(problemMessage(body));
      }
    },

    // ─── Cloudflare publish surface (token-backed; see services/cf-settings) ─

    /**
     * Allowlisted Cloudflare API passthrough. The token comes from the client's cf-settings store
     * and rides in a header to the same-origin proxy (api.cloudflare.com is not CORS-enabled).
     */
    async cfApi(apiPath: string, init?: { method?: string; body?: unknown }) {
      const { getCfToken } = await import("../services/cf-settings");
      const token = getCfToken();
      if (!token) {
        throw new Error("No Cloudflare API token configured");
      }
      const res = await fetch("/__studio/cf/proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CF-Token": token },
        body: JSON.stringify({ path: apiPath, method: init?.method ?? "GET", body: init?.body }),
      });
      const envelope = (await res.json()) as {
        success?: boolean;
        result?: unknown;
        errors?: { message: string }[];
        error?: string;
      };
      if (!res.ok || envelope.success === false) {
        const message =
          envelope.errors?.map((e) => e.message).join("; ") ?? envelope.error ?? res.statusText;
        throw new Error(`Cloudflare API: ${message}`);
      }
      return envelope.result ?? envelope;
    },

    /** Verify the stored token by listing accounts; null when none/invalid. */
    async cfConnection() {
      const { getCfAccountId, getCfToken, setCfAccountId } =
        await import("../services/cf-settings");
      if (!getCfToken()) {
        return null;
      }
      try {
        const accounts = (await this.cfApi?.("/accounts")) as { id: string; name: string }[];
        if (!accounts?.length) {
          return { connected: false };
        }
        const chosen = accounts.find((a) => a.id === getCfAccountId()) ?? accounts[0]!;
        setCfAccountId(chosen.id);
        return { connected: true, accountId: chosen.id, accountName: chosen.name };
      } catch {
        return { connected: false };
      }
    },

    // ─── Project catalogue ──────────────────────────────────────────────────

    /** Every site under the server root, from the /__studio/sites glob. */
    async listProjects() {
      const res = await fetch("/__studio/sites");
      if (!res.ok) {
        return [];
      }
      const sites = await readJson<SiteEntry[]>(res);
      return sites.map((site) => {
        const config = site.config as { name?: string } | null;
        return {
          name: config?.name || site.path.split("/").at(-1) || site.path,
          root: site.path,
          description: site.path,
        };
      });
    },

    // ─── AI Assistant (Stack B: OpenAI-compatible SSE proxy) ───────────────────

    aiChatUrl() {
      return "/__studio/ai/chat";
    },
  };
}
