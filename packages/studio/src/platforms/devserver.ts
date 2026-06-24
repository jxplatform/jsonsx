/**
 * Devserver.js — Dev Server Platform Adapter
 *
 * Implements the StudioPlatform interface for the @jxsuite/server development workflow. All file
 * I/O goes through /__studio/* REST endpoints. Project opening uses the Chrome File System Access
 * API (showDirectoryPicker).
 *
 * See spec/desktop.md §8 for the full specification.
 */

import type { ProjectConfig } from "@jxsuite/schema/types";
import type { DirEntry, FsEvent, RenameResult } from "../types";

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

    /** Get or set the current project root (absolute path). */
    get projectRoot() {
      return _projectRoot;
    },
    set projectRoot(v) {
      _projectRoot = v || "";
      if (_projectRoot) {
        void this.activate(_projectRoot);
      }
    },

    /**
     * Notify the server which project root to use for resolving static file paths. Returns a
     * promise so callers can await activation before loading assets.
     *
     * @param {string} [root]
     */
    async activate(root?: string) {
      const r = root ?? _projectRoot;
      await fetch("/__studio/activate", {
        body: JSON.stringify({ root: r }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
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
     * @param {{
     *   name: string;
     *   description?: string;
     *   url?: string;
     *   adapter?: string;
     *   directory: string;
     * }} opts
     */
    async createProject(opts: {
      name: string;
      description?: string;
      url?: string;
      adapter?: string;
      directory: string;
    }) {
      const res = await fetch("/__studio/create-project", {
        body: JSON.stringify(opts),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!res.ok) {
        const data = await readJson<ErrorBody>(res);
        throw new Error(data.error || "Failed to create project");
      }
      return await res.json();
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
      return await res.json();
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

    async outdatedPackages() {
      const res = await fetch("/__studio/packages/outdated");
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
        throw new Error(data.error || "Format action failed");
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
        throw new Error(body.error);
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
        throw new Error(body.error);
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
        throw new Error(body.error);
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
        throw new Error(body.error);
      }
      return await res.json();
    },

    async gitPull() {
      const res = await fetch("/__studio/git/pull", { method: "POST" });
      if (!res.ok) {
        const body = await readJson<ErrorBody>(res);
        throw new Error(body.error);
      }
      return await res.json();
    },

    async gitFetch() {
      const res = await fetch("/__studio/git/fetch", { method: "POST" });
      if (!res.ok) {
        const body = await readJson<ErrorBody>(res);
        throw new Error(body.error);
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
        throw new Error(body.error);
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
        throw new Error(body.error);
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
        throw new Error(body.error);
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
        throw new Error(body.error);
      }
      return await res.json();
    },

    async gitInit() {
      const res = await fetch("/__studio/git/init", { method: "POST" });
      if (!res.ok) {
        const body = await readJson<ErrorBody>(res);
        throw new Error(body.error);
      }
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
        throw new Error(body.error);
      }
    },

    // ─── AI Assistant ───────────────────────────────────

    async aiAuthStatus() {
      const res = await fetch("/__studio/ai/auth-status");
      return await res.json();
    },

    /** @param {{ message: string; systemPrompt?: string }} opts */
    async aiCreateSession(opts: { message: string; systemPrompt?: string }) {
      const res = await fetch("/__studio/ai/session", {
        body: JSON.stringify(opts),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!res.ok) {
        const body = await readJson<ErrorBody>(res);
        throw new Error(body.error);
      }
      return await res.json();
    },

    /** @param {string} id @param {string} message */
    async aiSendMessage(id: string, message: string) {
      const res = await fetch(`/__studio/ai/session/${id}/message`, {
        body: JSON.stringify({ message }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!res.ok) {
        const body = await readJson<ErrorBody>(res);
        throw new Error(body.error);
      }
      return await res.json();
    },

    /** @param {string} id */
    aiStreamUrl(id: string) {
      return `/__studio/ai/session/${id}/stream`;
    },

    /** @param {string} id */
    async aiStopSession(id: string) {
      await fetch(`/__studio/ai/session/${id}/stop`, { method: "POST" });
    },

    /** @param {string} id */
    async aiDeleteSession(id: string) {
      await fetch(`/__studio/ai/session/${id}`, { method: "DELETE" });
    },
  };
}
