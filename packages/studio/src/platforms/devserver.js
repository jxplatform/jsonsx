/**
 * Devserver.js — Dev Server Platform Adapter
 *
 * Implements the StudioPlatform interface for the @jxsuite/server development workflow. All file
 * I/O goes through /__studio/* REST endpoints. Project opening uses the Chrome File System Access
 * API (showDirectoryPicker).
 *
 * See spec/desktop.md §8 for the full specification.
 */

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
  function serverPath(rel) {
    const r = rel.replaceAll("\\", "/");
    if (!_projectRoot) return r;
    if (r === ".") return _projectRoot;
    return `${_projectRoot}/${r}`;
  }

  /**
   * Strip the project root prefix from a server-root-relative path.
   *
   * @param {string} path
   */
  function stripRoot(path) {
    const p = path.replaceAll("\\", "/");
    if (!_projectRoot) return p;
    return p.startsWith(_projectRoot + "/") ? p.slice(_projectRoot.length + 1) : p;
  }

  return {
    id: "devserver",

    /** Get or set the current project root (absolute path). */
    get projectRoot() {
      return _projectRoot;
    },
    set projectRoot(v) {
      _projectRoot = v || "";
      if (_projectRoot) this.activate(_projectRoot);
    },

    /**
     * Notify the server which project root to use for resolving static file paths. Returns a
     * promise so callers can await activation before loading assets.
     *
     * @param {string} [root]
     */
    async activate(root) {
      const r = root ?? _projectRoot;
      await fetch("/__studio/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root: r }),
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
        dirHandle =
          await /** @type {{ showDirectoryPicker(opts: { mode: string }): Promise<FileSystemDirectoryHandle> }} */ (
            window
          ).showDirectoryPicker({ mode: "readwrite" });
      } catch (/** @type {unknown} */ e) {
        // User cancelled the picker
        if (/** @type {Error} */ (e).name === "AbortError") return null;
        throw e;
      }

      // Read project.json from the chosen directory
      let siteHandle;
      try {
        siteHandle = await dirHandle.getFileHandle("project.json");
      } catch {
        throw new Error("No project.json found in selected folder");
      }

      const file = await siteHandle.getFile();
      const config = JSON.parse(await file.text());

      // Resolve server-relative path by matching against known sites
      const sitesRes = await fetch("/__studio/sites");
      if (!sitesRes.ok) throw new Error("Failed to fetch site list from server");
      const sites = await sitesRes.json();
      const match = sites.find(
        /** @param {{ config: unknown; path: string }} s */ (s) =>
          JSON.stringify(s.config) === JSON.stringify(config),
      );

      if (!match) {
        // Project is outside dev server root — ask the server to find it by directory name
        const findRes = await fetch(
          `/__studio/find-project?name=${encodeURIComponent(dirHandle.name)}`,
        );
        if (!findRes.ok) throw new Error("Could not locate project on disk");
        const found = await findRes.json();
        if (!found.path) throw new Error(`Could not find project directory "${dirHandle.name}"`);
        _projectRoot = found.path;
      } else {
        _projectRoot = match.path;
      }

      // Notify server of active project for static file resolution
      await this.activate();

      return {
        config,
        handle: {
          root: _projectRoot,
          name: config.name || _projectRoot.split("/").pop(),
          projectConfig: config,
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
        const meta = projectRes.ok ? await projectRes.json() : { root: ".", name: "project" };
        const info = infoRes.ok ? await infoRes.json() : { isSiteProject: false };
        return { meta, info };
      } catch {
        return null;
      }
    },

    // ─── File operations ──────────────────────────────────────────────────

    /** @param {string} dir */
    async listDirectory(dir) {
      const res = await fetch(`/__studio/files?dir=${encodeURIComponent(serverPath(dir))}`);
      if (!res.ok) throw new Error(`Failed to list directory: ${dir}`);
      const entries = await res.json();
      for (const e of entries) e.path = stripRoot(e.path);
      return entries;
    },

    /** @param {string} path */
    async readFile(path) {
      const res = await fetch(`/__studio/file?path=${encodeURIComponent(serverPath(path))}`);
      if (!res.ok) throw new Error(`Failed to read file: ${path}`);
      const data = await res.json();
      return data.content;
    },

    /**
     * @param {string} path
     * @param {string} content
     */
    async writeFile(path, content) {
      const res = await fetch(`/__studio/file?path=${encodeURIComponent(serverPath(path))}`, {
        method: "PUT",
        body: content,
      });
      if (!res.ok) throw new Error(`Failed to write file: ${path}`);
    },

    /**
     * Upload a binary file (image, video, font, etc.).
     *
     * @param {string} path — project-relative destination path
     * @param {File | Blob | ArrayBuffer} data — file content
     */
    async uploadFile(path, data) {
      const res = await fetch(
        `/__studio/file/upload?path=${encodeURIComponent(serverPath(path))}`,
        { method: "POST", body: data },
      );
      if (!res.ok) throw new Error(`Upload failed: ${path}`);
      return await res.json();
    },

    /** @param {string} path */
    async deleteFile(path) {
      const res = await fetch(`/__studio/file?path=${encodeURIComponent(serverPath(path))}`, {
        method: "DELETE",
      });
      if (!res.ok && res.status !== 404) throw new Error(`Failed to delete file: ${path}`);
    },

    /**
     * @param {string} from
     * @param {string} to
     */
    async renameFile(from, to) {
      const res = await fetch("/__studio/file/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: serverPath(from), to: serverPath(to) }),
      });
      if (!res.ok) throw new Error(`Failed to rename: ${from} → ${to}`);
    },

    /** @param {string} _path */
    async createDirectory(_path) {
      // The server creates directories implicitly when writing files.
      // Write a placeholder and delete it, or rely on mkdir behavior.
      // For now, use the writeFile + delete approach if directory creation
      // is explicitly needed. The server's writeFile already calls mkdir().
    },

    // ─── Component discovery ──────────────────────────────────────────────

    /** @param {string} dir */
    async discoverComponents(dir) {
      const scanDir = dir || _projectRoot;
      if (!scanDir) return [];
      const url = `/__studio/components?dir=${encodeURIComponent(scanDir)}`;
      const res = await fetch(url);
      if (!res.ok) return [];
      return await res.json();
    },

    // ─── Package management ──────────────────────────────────────────────

    /** @param {string} name */
    async addPackage(name) {
      const res = await fetch("/__studio/packages/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error(await res.text());
      return await res.json();
    },

    /** @param {string} name */
    async removePackage(name) {
      const res = await fetch("/__studio/packages/remove", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error(await res.text());
      return await res.json();
    },

    async listPackages() {
      const res = await fetch("/__studio/packages");
      if (!res.ok) return [];
      return await res.json();
    },

    // ─── Code services (optional) ─────────────────────────────────────────

    /**
     * @param {string} action
     * @param {unknown} payload
     */
    async codeService(action, payload) {
      try {
        const res = await fetch(`/__studio/code/${action}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) return null;
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
    async resolveSiteContext(filePath) {
      const res = await fetch(`/__studio/resolve-site?path=${encodeURIComponent(filePath)}`);
      if (!res.ok) return { sitePath: null };
      return await res.json();
    },

    // ─── File location ────────────────────────────────────────────────────

    /** @param {string} name */
    async locateFile(name) {
      try {
        const res = await fetch("/__studio/locate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        });
        if (res.ok) return (await res.json()).path || null;
      } catch {}
      return null;
    },

    /** @param {string} query */
    async searchFiles(query) {
      const glob = `**/*${query}*.{json,md}`;
      const res = await fetch(
        `/__studio/files?dir=${encodeURIComponent(serverPath("."))}&glob=${encodeURIComponent(glob)}`,
      );
      if (!res.ok) return [];
      const entries = await res.json();
      for (const e of entries) e.path = stripRoot(e.path);
      return entries;
    },

    // ─── Plugin schema ────────────────────────────────────────────────────

    /**
     * @param {string} src
     * @param {string} prototype
     * @param {string} base
     */
    async fetchPluginSchema(src, prototype, base) {
      const params = new URLSearchParams({ src });
      if (prototype) params.set("prototype", prototype);
      if (base) params.set("base", base);
      const res = await fetch(`/__studio/plugin-schema?${params}`);
      if (!res.ok) return null;
      const { schema } = await res.json();
      return schema;
    },

    // ─── Git operations ──────────────────────────────────────────────────

    async gitStatus() {
      const res = await fetch("/__studio/git/status");
      if (!res.ok) throw new Error(await res.text());
      return await res.json();
    },

    async gitBranches() {
      const res = await fetch("/__studio/git/branches");
      if (!res.ok) throw new Error(await res.text());
      return await res.json();
    },

    /** @param {number} [limit] */
    async gitLog(limit) {
      const q = limit ? `?limit=${limit}` : "";
      const res = await fetch(`/__studio/git/log${q}`);
      if (!res.ok) throw new Error(await res.text());
      return await res.json();
    },

    /** @param {string[]} files */
    async gitStage(files) {
      const res = await fetch("/__studio/git/stage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      return await res.json();
    },

    /** @param {string[]} files */
    async gitUnstage(files) {
      const res = await fetch("/__studio/git/unstage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      return await res.json();
    },

    /** @param {string} message */
    async gitCommit(message) {
      const res = await fetch("/__studio/git/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      return await res.json();
    },

    async gitPush() {
      const res = await fetch("/__studio/git/push", { method: "POST" });
      if (!res.ok) throw new Error((await res.json()).error);
      return await res.json();
    },

    async gitPull() {
      const res = await fetch("/__studio/git/pull", { method: "POST" });
      if (!res.ok) throw new Error((await res.json()).error);
      return await res.json();
    },

    async gitFetch() {
      const res = await fetch("/__studio/git/fetch", { method: "POST" });
      if (!res.ok) throw new Error((await res.json()).error);
      return await res.json();
    },

    /** @param {string} branch */
    async gitCheckout(branch) {
      const res = await fetch("/__studio/git/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branch }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      return await res.json();
    },

    /** @param {string} name */
    async gitCreateBranch(name) {
      const res = await fetch("/__studio/git/create-branch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      return await res.json();
    },

    /** @param {string} path */
    async gitDiff(path) {
      const res = await fetch(`/__studio/git/diff?path=${encodeURIComponent(path)}`);
      if (!res.ok) throw new Error(await res.text());
      return await res.json();
    },

    /** @param {{ path: string; ref?: string }} opts */
    async gitShow(opts) {
      const params = new URLSearchParams({ path: opts.path });
      if (opts.ref) params.set("ref", opts.ref);
      const res = await fetch(`/__studio/git/show?${params}`);
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      return data.content;
    },

    /** @param {string[]} files */
    async gitDiscard(files) {
      const res = await fetch("/__studio/git/discard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      return await res.json();
    },
  };
}
