/// <reference lib="dom" />
/**
 * Cloud platform adapter (PAL) — implements StudioPlatform against a cloud backend speaking the
 * Studio Backend Protocol behind a session gateway: file/git operations go to
 * `/api/v1/p/:owner/:repo/:branch/studio/*` (cookie auth), AI to the backend's proxy at
 * `/api/v1/ai/chat`. The session is pre-bound to one (repo, branch) — the shell picks the project
 * before Studio boots — while project-less mode (null) powers the /studio welcome screen.
 *
 * Cloud omissions (Studio degrades per @jxsuite/protocol's route table): pickDirectory/importSite,
 * package install/outdated/set-versions (package ops are manifest-only edits), multi-window,
 * gitClone, resolveClass, component discovery, code services.
 */

/* Import the browser-safe primitives directly (NOT the Markdown class —
   its node-only discover/load chain drags glob/node:fs into the bundle). */
import { transpileJxMarkdown } from "@jxsuite/parser/transpile";
import { serializeJxMarkdown } from "@jxsuite/parser/serialize";
import markdownClassDef from "@jxsuite/parser/Markdown.class.json";
import type { WsCollabConnection } from "@jxsuite/collab/client";
import type { JxDocument, ProjectConfig } from "@jxsuite/schema/types";
import type {
  DirEntry,
  FsEvent,
  GitBranchesResult,
  GitLogEntry,
  GitStatusResult,
  PackageInfo,
  ProjectListEntry,
  RenameResult,
  StarterInfo,
  StudioPlatform,
} from "../types";

export interface CloudProject {
  owner: string;
  repo: string;
  branch: string;
}

interface ProjectInfoWire {
  root: string;
  name: string;
  defaultBranch: string;
  permission: "admin" | "write" | "read" | "none";
  projectConfig: Record<string, unknown> | null;
}

interface SessionEventWire {
  kind: "fs" | "git";
  events?: FsEvent[];
  event?: string;
  sha?: string;
}

/** Message-level failure body every platform route uses. */
interface ErrorBody {
  error?: string;
  code?: string;
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as ErrorBody;
    return body.error ?? fallback;
  } catch {
    return fallback;
  }
}

async function okJson<T>(res: Response, fallback: string): Promise<T> {
  if (!res.ok) {
    throw new Error(await errorMessage(res, fallback));
  }
  return (await res.json()) as T;
}

/**
 * Formats the cloud can execute: browser-safe built-ins only (parse/serialize run IN the editor
 * page via @jxsuite/parser — the platform never executes project JS). The registry entry mirrors
 * the devserver's `GET /__studio/formats` shape, sourced from the canonical class descriptor.
 * Unlike the devserver we register Markdown regardless of project.json imports — the compiler still
 * requires the import for `jx build`, but the editor should never strand a .md file unopenable.
 */
interface MarkdownClassDef {
  format: {
    extensions: string[];
    mediaType: string;
    documentKinds: string[];
    exportTarget: boolean;
    remote: boolean;
  };
  $studio: Record<string, unknown>;
}

function builtinFormats(config: ProjectConfig | null): Record<string, unknown>[] {
  const def = markdownClassDef as unknown as MarkdownClassDef;
  const imports = (config?.imports ?? {}) as Record<string, string>;
  const importedName = Object.keys(imports).find((name) =>
    imports[name]?.includes("Markdown.class.json"),
  );
  return [
    {
      name: importedName ?? "Markdown",
      extensions: def.format.extensions,
      mediaType: def.format.mediaType,
      documentKinds: def.format.documentKinds,
      exportTarget: def.format.exportTarget,
      remote: def.format.remote,
      studio: def.$studio,
      capabilities: {
        parse: { identifier: "parse", timing: ["compiler", "server", "client"] },
        serialize: { identifier: "serialize", timing: ["compiler", "server", "client"] },
      },
    },
  ];
}

/** Editor URL for a project session (mirrors the shell's route). */
export function editUrl(project: CloudProject): string {
  return `/edit/${project.owner}/${project.repo}@${encodeURIComponent(project.branch)}`;
}

/** Parse an /edit/:owner/:repo@:branch path (editUrl's inverse); null when it is not one. */
export function parseEditPath(pathname: string): CloudProject | null {
  /* Asset routers may normalize "@" to "%40", so decode the whole path first
     (branch slashes survive: `.+` spans them). */
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const match = /^\/edit\/([^/]+)\/([^/@]+)@(.+)$/.exec(decoded);
  if (!match) {
    return null;
  }
  const [, owner, repo, branch] = match;
  if (!owner || !repo || !branch) {
    return null;
  }
  return { owner, repo, branch };
}

/** Gateway base path for a project session. */
export function sessionBase(project: CloudProject): string {
  const { owner, repo, branch } = project;
  return `/api/v1/p/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(branch)}/studio`;
}

/** Catalogue/recents root key for a project: "owner/repo@branch". */
export function projectRootKey(project: CloudProject): string {
  return `${project.owner}/${project.repo}@${project.branch}`;
}

/** Current hosted Cloudflare connection; null when none is brokered yet. */
async function fetchCfConnection(): Promise<{
  connected: boolean;
  accountId?: string | undefined;
  accountName?: string | undefined;
} | null> {
  const res = await fetch("/api/v1/cf/connection", { credentials: "include" });
  if (!res.ok) {
    return null;
  }
  const body = (await res.json()) as {
    connected: boolean;
    accountId?: string | null;
    accountName?: string | null;
  };
  if (!body.connected) {
    return null;
  }
  return {
    connected: true,
    ...(body.accountId ? { accountId: body.accountId } : {}),
    ...(body.accountName ? { accountName: body.accountName } : {}),
  };
}

/** Parse an "owner/repo@branch" root key; null when malformed. */
export function parseRootKey(root: string): CloudProject | null {
  const match = /^([^/@]+)\/([^/@]+)@(.+)$/.exec(root);
  if (!match) {
    return null;
  }
  const [, owner, repo, branch] = match;
  if (!owner || !repo || !branch) {
    return null;
  }
  return { owner, repo, branch };
}

/**
 * Bound mode (project non-null) drives one repo+branch session; project-less mode (null, the
 * /studio route) exposes only the catalogue surface — listProjects/listStarters/createProject and
 * the navigation members — so Studio's own welcome screen and New Project modal do the rest.
 */
export function createCloudPlatform(project: CloudProject | null): StudioPlatform {
  const base = project ? sessionBase(project) : "";
  const root = project ? `${project.owner}/${project.repo}` : "";
  /**
   * One multiplexed collab socket per session; per-doc handles come from openDoc. Memoized as a
   * promise so concurrent first opens share the connection instead of racing two sockets.
   */
  let collabConnection: Promise<WsCollabConnection> | null = null;

  function api(path: string, init?: RequestInit): Promise<Response> {
    if (!project) {
      return Promise.reject(new Error("No project is open in this session"));
    }
    return fetch(`${base}${path}`, { credentials: "include", ...init });
  }

  function postJson(path: string, body: unknown): Promise<Response> {
    return api(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function projectInfo(): Promise<ProjectInfoWire> {
    return okJson<ProjectInfoWire>(await api("/project-info"), "Failed to load project");
  }

  async function readPackageJson(): Promise<Record<string, unknown>> {
    const res = await api(`/file?path=${encodeURIComponent("package.json")}`);
    if (!res.ok) {
      return {};
    }
    const data = (await res.json()) as { content: string };
    try {
      return JSON.parse(data.content) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  async function writePackageJson(pkg: Record<string, unknown>): Promise<void> {
    const res = await api("/file", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "package.json", content: `${JSON.stringify(pkg, null, 2)}\n` }),
    });
    if (!res.ok) {
      throw new Error(await errorMessage(res, "Failed to update package.json"));
    }
  }

  let cachedConfig: ProjectConfig | null = null;

  const platform: StudioPlatform = {
    id: "cloud",
    projectRoot: root,
    canvasUrl: "/canvas.html",

    async activate() {
      if (!project) {
        return;
      }
      await postJson("/activate", {});
    },

    /* The shell binds the session to one repo+branch before Studio boots, so
       "opening" a project just returns the bound one. */
    async openProject() {
      if (!project) {
        return null;
      }
      const info = await projectInfo();
      const config = (info.projectConfig ?? {}) as ProjectConfig;
      return {
        config,
        handle: { root, name: config.name || info.name, projectConfig: config },
      };
    },

    async probeRootProject() {
      if (!project) {
        return null;
      }
      try {
        const info = await projectInfo();
        return {
          meta: { root, name: info.name },
          info: {
            isSiteProject: info.projectConfig !== null,
            projectConfig: (info.projectConfig as ProjectConfig | null) ?? null,
          },
        };
      } catch {
        return null;
      }
    },

    // ─── Files ────────────────────────────────────────────────────────────

    async listDirectory(dir: string) {
      return okJson<DirEntry[]>(
        await api(`/files?dir=${encodeURIComponent(dir)}`),
        `Failed to list directory: ${dir}`,
      );
    },

    async readFile(path: string) {
      const data = await okJson<{ content: string }>(
        await api(`/file?path=${encodeURIComponent(path)}`),
        `Failed to read file: ${path}`,
      );
      return data.content;
    },

    async writeFile(path: string, content: string) {
      const res = await api("/file", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, content }),
      });
      if (!res.ok) {
        throw new Error(await errorMessage(res, `Failed to write file: ${path}`));
      }
    },

    async uploadFile(path: string, data: string | File | Blob | ArrayBuffer) {
      const res = await api(`/file/upload?path=${encodeURIComponent(path)}`, {
        method: "POST",
        body: data,
      });
      return okJson<unknown>(res, `Upload failed: ${path}`);
    },

    async deleteFile(path: string) {
      const res = await api(`/file?path=${encodeURIComponent(path)}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) {
        throw new Error(await errorMessage(res, `Failed to delete file: ${path}`));
      }
    },

    async renameFile(from: string, to: string): Promise<RenameResult> {
      return okJson<RenameResult>(
        await postJson("/file/rename", { from, to }),
        `Failed to rename: ${from} → ${to}`,
      );
    },

    async createDirectory(_path: string) {
      // Directories exist implicitly in the virtual tree (created on write).
    },

    /**
     * Live session events over the gateway WebSocket. Reconnects with a small backoff; the DO
     * pushes {kind:"fs"} batches for file mutations (including those from other tabs) and
     * {kind:"git"} notices this handler ignores.
     */
    /**
     * Realtime co-editing over the gateway's /collab WebSocket (rooms keyed by project-relative
     * path, per the shared ProjectSession working tree). Backends without the endpoint (or with the
     * flag off) refuse the upgrade and Studio degrades to solo editing. The wire client loads on
     * demand so yjs stays out of the base bundle.
     */
    async collab(docPath: string) {
      if (!project || typeof WebSocket === "undefined" || typeof location === "undefined") {
        return null;
      }
      collabConnection ??= (async () => {
        const { createWsCollabConnection } = await import("@jxsuite/collab/client");
        const scheme = location.protocol === "https:" ? "wss" : "ws";
        return createWsCollabConnection({
          hydratePath: async (path) => {
            // The DO has no GitHub token on a WS message; a plain read hydrates + caches the row.
            await api(`/file?path=${encodeURIComponent(path)}`);
          },
          url: `${scheme}://${location.host}${base}/collab`,
        });
      })();
      const connection = await collabConnection;
      return connection.openDoc(docPath);
    },

    subscribeFileEvents(handler: (events: FsEvent[]) => void) {
      if (typeof WebSocket === "undefined" || typeof location === "undefined") {
        return () => {};
      }
      let socket: WebSocket | null = null;
      let closed = false;
      let retryMs = 1000;
      const connect = () => {
        const scheme = location.protocol === "https:" ? "wss" : "ws";
        socket = new WebSocket(`${scheme}://${location.host}${base}/events`);
        socket.addEventListener("message", (ev: MessageEvent) => {
          let payload: SessionEventWire;
          try {
            payload = JSON.parse(ev.data as string) as SessionEventWire;
          } catch {
            return;
          }
          if (payload.kind === "fs" && payload.events?.length) {
            handler(payload.events);
          }
        });
        socket.addEventListener("open", () => {
          retryMs = 1000;
        });
        socket.addEventListener("close", () => {
          if (!closed) {
            setTimeout(connect, retryMs);
            retryMs = Math.min(retryMs * 2, 30_000);
          }
        });
      };
      connect();
      return () => {
        closed = true;
        socket?.close();
      };
    },

    // ─── Formats (browser-safe built-ins, executed in-page) ───────────────

    async listFormats() {
      if (cachedConfig === null) {
        try {
          const info = await projectInfo();
          cachedConfig = (info.projectConfig as ProjectConfig | null) ?? null;
        } catch {
          cachedConfig = null;
        }
      }
      return builtinFormats(cachedConfig);
    },

    async formatAction(payload: Record<string, unknown>) {
      const { action, source, doc, options } = payload as {
        action: string;
        source?: string;
        doc?: Record<string, unknown>;
        options?: Record<string, unknown>;
      };
      if (action === "parse") {
        return transpileJxMarkdown(source ?? "");
      }
      if (action === "serialize") {
        return serializeJxMarkdown((doc ?? {}) as JxDocument, options);
      }
      throw new Error(`Unsupported format action: ${action}`);
    },

    // ─── Components / code services (cloud: static-only posture) ──────────

    async discoverComponents() {
      // No execution of project JS in the cloud (MVP security posture).
      return [];
    },

    async codeService() {
      return null;
    },

    async fetchPluginSchema() {
      return null;
    },

    // ─── Packages (manifest-only edits; resolution happens in Pages CI) ───

    async addPackage(name: string) {
      const pkg = await readPackageJson();
      const deps = (pkg["dependencies"] ?? {}) as Record<string, string>;
      const at = name.lastIndexOf("@");
      const [pkgName, version] =
        at > 0 ? [name.slice(0, at), name.slice(at + 1)] : [name, "latest"];
      deps[pkgName] = version;
      pkg["dependencies"] = deps;
      await writePackageJson(pkg);
      return { ok: true, name: pkgName, version };
    },

    async removePackage(name: string) {
      const pkg = await readPackageJson();
      for (const key of ["dependencies", "devDependencies"]) {
        const deps = pkg[key] as Record<string, string> | undefined;
        if (deps && name in deps) {
          pkg[key] = Object.fromEntries(Object.entries(deps).filter(([dep]) => dep !== name));
        }
      }
      await writePackageJson(pkg);
      return { ok: true, name };
    },

    async listPackages(): Promise<PackageInfo[]> {
      const pkg = await readPackageJson();
      const out: PackageInfo[] = [];
      const deps = (pkg["dependencies"] ?? {}) as Record<string, string>;
      for (const [name, version] of Object.entries(deps)) {
        out.push({ name, version });
      }
      const devDeps = (pkg["devDependencies"] ?? {}) as Record<string, string>;
      for (const [name, version] of Object.entries(devDeps)) {
        out.push({ name, version, dev: true });
      }
      return out;
    },

    // ─── Site context & lookup ─────────────────────────────────────────────

    async resolveSiteContext(filePath: string) {
      try {
        const info = await projectInfo();
        const config = (info.projectConfig as ProjectConfig | null) ?? undefined;
        return {
          sitePath: root,
          ...(config === undefined ? {} : { projectConfig: config }),
          ...(filePath === root ? {} : { fileRelPath: filePath }),
        };
      } catch {
        return { sitePath: null };
      }
    },

    async locateFile(name: string) {
      try {
        const res = await api(`/locate?name=${encodeURIComponent(name)}`);
        if (res.ok) {
          const body = (await res.json()) as { path?: string | null };
          return body.path ?? null;
        }
      } catch {
        // Fall through to null; the caller treats it as "not found".
      }
      return null;
    },

    async searchFiles(query: string, extensions: string[] = []) {
      const exts = ["json", ...extensions.map((e) => e.replace(/^\./, ""))];
      const res = await api(
        `/search?query=${encodeURIComponent(query)}&extensions=${encodeURIComponent(exts.join(","))}`,
      );
      if (!res.ok) {
        return [];
      }
      return (await res.json()) as DirEntry[];
    },

    // ─── Git (virtual engine in the ProjectSession DO) ─────────────────────

    async gitStatus() {
      return okJson<GitStatusResult>(await api("/git/status"), "Failed to read git status");
    },

    async gitBranches() {
      return okJson<GitBranchesResult>(await api("/git/branches"), "Failed to list branches");
    },

    async gitLog(limit?: number) {
      const q = limit ? `?limit=${limit}` : "";
      return okJson<GitLogEntry[]>(await api(`/git/log${q}`), "Failed to read git log");
    },

    async gitStage(files: string[]) {
      await okJson(await postJson("/git/stage", { files }), "Failed to stage files");
    },

    async gitUnstage(files: string[]) {
      await okJson(await postJson("/git/unstage", { files }), "Failed to unstage files");
    },

    /** Commits land on GitHub immediately (blobs → tree → commit → ref CAS). */
    async gitCommit(message: string) {
      await okJson(await postJson("/git/commit", { message }), "Commit failed");
    },

    /** Every commit is already on GitHub; push is a sync check. */
    async gitPush() {
      await okJson(await postJson("/git/push", {}), "Push failed");
    },

    async gitPull() {
      await okJson(await postJson("/git/pull", {}), "Pull failed");
    },

    async gitFetch() {
      await okJson(await postJson("/git/fetch", {}), "Fetch failed");
    },

    /** Branches are separate cloud sessions; re-point the page at the sibling. */
    async gitCheckout(branch: string) {
      if (project && typeof location !== "undefined") {
        location.assign(editUrl({ ...project, branch }));
      }
    },

    async gitCreateBranch(name: string) {
      await okJson(await postJson("/git/create-branch", { name }), "Failed to create branch");
    },

    async gitDiff(path?: string) {
      const data = await okJson<{ diff: string }>(
        await api(`/git/diff?path=${encodeURIComponent(path ?? "")}`),
        "Failed to compute diff",
      );
      return data.diff;
    },

    async gitShow(opts: { path: string; ref?: string }) {
      const params = new URLSearchParams({ path: opts.path });
      if (opts.ref) {
        params.set("ref", opts.ref);
      }
      const data = await okJson<{ content: string }>(
        await api(`/git/show?${params}`),
        `Failed to read ${opts.path} at ref`,
      );
      return data.content;
    },

    async gitDiscard(files: string[]) {
      await okJson(await postJson("/git/discard", { files }), "Failed to discard changes");
    },

    async gitInit() {
      // Cloud projects are always GitHub repositories already.
    },

    async gitAddRemote() {
      // The GitHub repo IS the remote; nothing to add.
    },

    // ─── Project catalogue & navigation (Studio welcome / New Project UI) ──

    async listProjects(): Promise<ProjectListEntry[]> {
      const res = await fetch("/api/v1/projects", { credentials: "include" });
      if (!res.ok) {
        return [];
      }
      const entries = (await res.json()) as {
        fullName: string;
        owner: string;
        name: string;
        defaultBranch: string;
        permission: string;
      }[];
      return entries.map((p) => ({
        name: p.fullName,
        root: projectRootKey({ owner: p.owner, repo: p.name, branch: p.defaultBranch }),
        description: `${p.defaultBranch} · ${p.permission}`,
      }));
    },

    async listStarters(): Promise<StarterInfo[]> {
      const res = await fetch("/api/v1/starters", { credentials: "include" });
      if (!res.ok) {
        return [];
      }
      return (await res.json()) as StarterInfo[];
    },

    /** Welcome/recents open path: navigate this tab into the project's editor. */
    async setWindowProject(rootKey: string) {
      const target = parseRootKey(rootKey);
      if (target && typeof location !== "undefined") {
        location.assign(editUrl(target));
      }
      // Navigation unloads the page; deduped stops the caller's follow-up work.
      return { deduped: true, config: null };
    },

    async openProjectInNewWindow(rootKey: string) {
      const target = parseRootKey(rootKey);
      if (target && typeof window !== "undefined") {
        window.open(editUrl(target), "_blank", "noopener");
      }
    },

    /**
     * Create the GitHub repo (seeded from a starter) via the platform API and return its catalogue
     * root key — Studio's modal flow then opens it via setWindowProject. Server errors (e.g.
     * needs_installation_access) surface as the thrown message inside the modal.
     */
    async createProject(opts: {
      name: string;
      description?: string | undefined;
      directory: string;
      starter?: string | undefined;
      template?: string | undefined;
    }) {
      const res = await fetch("/api/v1/projects", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: opts.name,
          description: opts.description,
          starter: opts.starter,
        }),
      });
      const created = await okJson<{ owner: string; name: string; defaultBranch: string }>(
        res,
        "Failed to create project",
      );
      return {
        root: projectRootKey({
          owner: created.owner,
          repo: created.name,
          branch: created.defaultBranch,
        }),
        config: { name: opts.name } as ProjectConfig,
      };
    },

    // ─── Identity & Cloudflare publish surface ──────────────────────────────

    async getUser() {
      const res = await fetch("/api/v1/me", { credentials: "include" });
      if (!res.ok) {
        return null;
      }
      const me = (await res.json()) as {
        user: { login: string; name: string | null; avatar_url: string | null } | null;
      };
      if (!me.user) {
        return null;
      }
      return {
        login: me.user.login,
        ...(me.user.name ? { name: me.user.name } : {}),
        ...(me.user.avatar_url ? { avatarUrl: me.user.avatar_url } : {}),
      };
    },

    /** Open a PR from this session's branch (ProjectSession /git/pr). */
    async createPullRequest(opts: { title: string; body?: string; head?: string; base?: string }) {
      return okJson<{ url: string; number: number }>(
        await postJson("/git/pr", opts),
        "Failed to open pull request",
      );
    },

    async cfConnection() {
      return fetchCfConnection();
    },

    /**
     * Hosted OAuth connect: open the broker flow in a popup and poll until the connection lands (or
     * the popup closes / times out). Popup-blocked browsers fall back to a full-page redirect.
     */
    async cfConnect() {
      if (typeof window === "undefined" || typeof location === "undefined") {
        return null;
      }
      const popup = window.open("/api/v1/cf/connect", "cf-connect", "width=980,height=780");
      if (!popup) {
        location.assign("/api/v1/cf/connect");
        return null;
      }
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => {
          setTimeout(resolve, 1500);
        });
        const connection = await fetchCfConnection();
        if (connection) {
          popup.close();
          return connection;
        }
        if (popup.closed) {
          return fetchCfConnection();
        }
      }
      return null;
    },

    /** Allowlisted Cloudflare API passthrough (platform injects the OAuth token). */
    async cfApi(apiPath: string, init?: { method?: string; body?: unknown }) {
      const res = await fetch(`/api/v1/cf/proxy${apiPath}`, {
        method: init?.method ?? "GET",
        credentials: "include",
        ...(init?.body === undefined
          ? {}
          : {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(init.body),
            }),
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

    // ─── AI (platform Workers AI proxy, StreamEvent SSE) ───────────────────

    aiChatUrl() {
      return "/api/v1/ai/chat";
    },
  };

  return platform;
}
