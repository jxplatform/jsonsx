/// <reference lib="dom" />
/**
 * Cloud platform adapter (PAL) — implements StudioPlatform against a cloud backend speaking the
 * Studio Backend Protocol behind a session gateway: file/git operations go to
 * `/api/v1/p/:owner/:repo/:branch/studio/*` (cookie auth), AI to the backend's proxy at
 * `/api/v1/ai/chat`. The session is pre-bound to one (repo, branch) — the shell picks the project
 * before Studio boots — while project-less mode (null) powers the /studio welcome screen.
 *
 * Cloud omissions (Studio degrades per @jxsuite/protocol's route table): pickDirectory, package
 * install/outdated/set-versions (package ops are manifest-only edits), multi-window, gitClone,
 * resolveClass, component discovery, code services.
 */

import { negotiateCollab } from "@jxsuite/collab/negotiate";
import type { CollabNegotiation } from "@jxsuite/collab/negotiate";
import type { WsCollabConnection } from "@jxsuite/collab/client";
import type { ProjectConfig } from "@jxsuite/schema/types";
import { componentMetaFrom } from "@jxsuite/schema/component-meta";
import { streamImport } from "../services/import-client";
import type {
  AccountStatus,
  CfAccountSummary,
  CfConnection,
  CfConnectOutcome,
  ComponentMeta,
  CreateProjectDestination,
  DirEntry,
  ExtensionCatalogEntry,
  ExtensionsInfo,
  FsEvent,
  GitBranchesResult,
  GitLogEntry,
  GitStatusResult,
  ImportProgressEvent,
  ImportReadyEvent,
  ImportSiteOptions,
  PackageInfo,
  ProjectListEntry,
  SiteBuildResult,
  ProjectSchemasResponse,
  ReferencesResult,
  RenameResult,
  RepoInfo,
  StarterInfo,
  StudioPlatform,
} from "../types";
import { problemDetail, problemSlug } from "@jxsuite/protocol";
import type { UploadResult } from "@jxsuite/protocol";

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

/** One row of the platform's project catalogue (`GET /api/v1/projects`). */
interface ProjectListWire {
  fullName: string;
  owner: string;
  name: string;
  defaultBranch: string;
  permission: string;
}

interface SessionEventWire {
  kind: "fs" | "git";
  events?: FsEvent[];
  event?: string;
  sha?: string;
}

/**
 * Message-level failure body every platform route uses.
 *
 * `error` is the pre-RFC-9457 name and is read through `problemDetail`, which also reads a problem
 * document's `detail` — so this one reader covers a backend that has migrated and one that has
 * not.
 */
interface ErrorBody {
  error?: string;
  code?: string;
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    return problemDetail(await res.json()) ?? fallback;
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

/**
 * Current hosted Cloudflare connection; null when none is brokered yet.
 *
 * A LAPSED row is not a healthy one. This reader used to answer `{connected: true}` for any body
 * whose `connected` flag was set and drop `needsReconnect` on the floor, so a row whose grant had
 * expired came back indistinguishable from one that works — which is how `cfConnect`'s poll came to
 * close the popup the moment it opened, over a row from a previous session, while the user was
 * still on Cloudflare's login page. Every diagnostic the broker sends now passes straight through.
 */
async function fetchCfConnection(): Promise<CfConnection | null> {
  const res = await fetch("/api/v1/cf/connection", { credentials: "include" });
  if (!res.ok) {
    return null;
  }
  const body = (await res.json()) as {
    connected: boolean;
    accountId?: string | null;
    accountName?: string | null;
    needsReconnect?: boolean;
    needsAccount?: boolean;
    code?: CfConnection["code"];
    reason?: string;
    hasRefreshToken?: boolean;
    expiresAt?: number;
  };
  /* Cloud never emits {connected: false} to the PAL — no brokered row at all is `null`, and a row
     that cannot be used arrives as connected + needsReconnect. See CfConnection. */
  if (!body.connected) {
    return null;
  }
  return {
    connected: true,
    ...(body.accountId ? { accountId: body.accountId } : {}),
    ...(body.accountName ? { accountName: body.accountName } : {}),
    ...(body.needsReconnect ? { needsReconnect: true } : {}),
    ...(body.needsAccount ? { needsAccount: true } : {}),
    ...(body.code ? { code: body.code } : {}),
    ...(body.reason ? { reason: body.reason } : {}),
    ...(body.hasRefreshToken === undefined ? {} : { hasRefreshToken: body.hasRefreshToken }),
    ...(body.expiresAt === undefined ? {} : { expiresAt: body.expiresAt }),
  };
}

interface CfConnectFlow {
  popup: Window | null;
  promise: Promise<CfConnectOutcome | null>;
}

/**
 * The connect flow currently running, or null.
 *
 * Module-level rather than per-platform because the popup's TARGET NAME ("cf-connect") is global to
 * the browsing context: a second `window.open` on that name re-uses the first flow's popup, and the
 * first flow's cleanup then closes it out from under the second — the user watches their half-typed
 * Cloudflare login vanish. Joining the in-flight promise is the only answer that leaves both
 * callers correct.
 */
let cfConnectFlow: CfConnectFlow | null = null;

/**
 * Drive one hosted OAuth connect to a {@link CfConnectOutcome}. See `cfConnect` for the semantics;
 * this lives at module scope so the single-flight handle can too.
 */
async function runCfConnect(handle: CfConnectFlow): Promise<CfConnectOutcome | null> {
  /* The baseline is read BEFORE the popup opens, and it is what keeps the poll honest: a row that
     was already healthy proves nothing about THIS flow, so the poll must not settle on one. Reading
     it after the popup opened would race the callback and could capture the new row as "old". */
  const baseline = await fetchCfConnection().catch(() => null);
  const healthyBaseline = Boolean(baseline?.connected && !baseline.needsReconnect);
  const popup = window.open("/api/v1/cf/connect", "cf-connect", "width=980,height=780");
  if (!popup) {
    /* Popup blocked: the whole page is now navigating to the broker. Not a failure — the caller
       must render nothing at all rather than an error it will never get to show. */
    location.assign("/api/v1/cf/connect");
    return { status: "redirect" };
  }
  handle.popup = popup;
  const deadline = Date.now() + 180_000;
  return new Promise<CfConnectOutcome>((resolve, reject) => {
    let timer = 0;
    const cleanup = () => {
      window.removeEventListener("message", onMessage);
      window.clearTimeout(timer);
      if (!popup.closed) {
        popup.close();
      }
    };
    const settle = (outcome: CfConnectOutcome) => {
      cleanup();
      resolve(outcome);
    };
    const fail = (reason: string) => {
      cleanup();
      reject(new Error(reason));
    };
    /** A usable row: brokered, and its grant has not lapsed. */
    const usable = (connection: CfConnection | null): connection is CfConnection =>
      Boolean(connection?.connected && !connection.needsReconnect);
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== location.origin) {
        return;
      }
      const data = event.data as { source?: string; status?: string; reason?: string | null };
      if (!data || data.source !== "jx-cf") {
        return;
      }
      if (data.status === "error") {
        fail(data.reason ?? "Cloudflare authorization failed");
        return;
      }
      /* Any other status — "connected", "pick-account", or one a shell of another vintage sends —
         is a CLAIM that the callback ran, and the broker row is what adjudicates it. */
      void fetchCfConnection().then(
        (connection) => {
          settle(usable(connection) ? { connection, status: "connected" } : { status: "timeout" });
        },
        /* This promise had no rejection handler, so one network blip left the listener installed,
           the timer armed and the popup open forever. */
        () => {
          fail("Cloudflare connected, but the connection could not be confirmed");
        },
      );
    };
    window.addEventListener("message", onMessage);
    const poll = async () => {
      if (Date.now() > deadline) {
        settle({ status: "timeout" });
        return;
      }
      let connection: CfConnection | null = null;
      let answered = true;
      try {
        connection = await fetchCfConnection();
      } catch {
        answered = false; // A blip is not an answer: re-arm and ask again.
      }
      /* The poll is a FALLBACK for shells whose postMessage never arrives, so it may only settle on
         proof that THIS flow stored a fresh token: a usable row that was NOT already usable at the
         baseline. For a reconnect, `needsReconnect` flipping false is that proof; for a connection
         that was healthy all along nothing the poll can see is, so it must never settle — the relay
         or the popup-closed path answers that case instead. */
      if (answered && usable(connection) && !healthyBaseline) {
        settle({ connection, status: "connected" });
        return;
      }
      if (popup.closed) {
        const final = await fetchCfConnection().catch(() => null);
        settle(usable(final) ? { connection: final, status: "connected" } : { status: "canceled" });
        return;
      }
      timer = window.setTimeout(() => {
        void poll();
      }, 1500);
    };
    timer = window.setTimeout(() => {
      void poll();
    }, 1500);
  });
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

/** Every project this account can open, straight off the wire; [] when the catalogue is unreachable. */
async function fetchProjects(): Promise<ProjectListWire[]> {
  const res = await fetch("/api/v1/projects", { credentials: "include" });
  return res.ok ? ((await res.json()) as ProjectListWire[]) : [];
}

/**
 * The project a root key names, for the two members that navigate by one.
 *
 * Tolerates the branchless "owner/repo" keys older studios wrote into Recent: they cannot say which
 * branch they meant, so the catalogue's default branch answers for them — the same branch that
 * project's Projects row opens. Null when the key is neither form, or names nothing this account
 * can reach.
 */
export async function resolveRootKey(rootKey: string): Promise<CloudProject | null> {
  const parsed = parseRootKey(rootKey);
  if (parsed) {
    return parsed;
  }
  const legacy = /^([^/@]+)\/([^/@]+)$/.exec(rootKey);
  if (!legacy) {
    return null;
  }
  const [, owner, repo] = legacy;
  const catalogue = await fetchProjects().catch(() => []);
  const match = catalogue.find((p) => p.owner === owner && p.name === repo);
  return match ? { owner: match.owner, repo: match.name, branch: match.defaultBranch } : null;
}

/**
 * Bound mode (project non-null) drives one repo+branch session; project-less mode (null, the
 * /studio route) exposes only the catalogue surface — listProjects/listStarters/createProject and
 * the navigation members — so Studio's own welcome screen and New Project modal do the rest.
 */
export function createCloudPlatform(project: CloudProject | null): StudioPlatform {
  const base = project ? sessionBase(project) : "";
  /* The ROOT KEY, branch included — not a bare "owner/repo". This value is the project's identity
     everywhere the shell keeps one: `probeRootProject` hands it to the recent-projects list, and
     `setWindowProject` reopens a project by parsing it back with `parseRootKey`, which answers null
     for a branchless key. So every Recent row a bound session had written was a click that did
     nothing — no navigation, no error, and `deduped: true` telling the caller the open had been
     handled — while the SAME project opened fine from the Projects catalogue, whose entries carry
     the branch (`listProjects` below builds them with `projectRootKey`). Agreeing with the catalogue
     also restores the welcome screen's dedupe (it matches the two lists by root, so the project
     stopped appearing in both) and gives a branch its own Recent row, which is what a root key that
     names a branch is for. */
  const root = project ? projectRootKey(project) : "";
  /**
   * One multiplexed collab socket per session; per-doc handles come from openDoc. Memoized as a
   * promise so concurrent first opens share the connection instead of racing two sockets.
   */
  let collabConnection: Promise<WsCollabConnection> | null = null;
  /** Lazy subprotocol negotiation from the gateway's capability probe (null = not asked yet). */
  let collabNegotiation: Promise<CollabNegotiation> | null = null;

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

  const platform: StudioPlatform = {
    id: "cloud",
    projectRoot: root,
    canvasUrl: "/canvas.html",
    /* The projectRoot here is the IDENTIFIER "owner/repo@branch", not a served path, so the canvas's
       default base — <origin>/<projectRoot>/ — addressed nothing. Every component $ref fetch landed
       on the SPA fallback, which answers the marketing page at HTTP 200, so res.ok passed and the
       runtime's res.json() died on "Unexpected token '<'". Images failed the same way, silently.
       The session serves the project tree at /raw.

       Conditional because `base` is "" until a project is bound, and "/raw/" would be a confident
       wrong answer — worse than the default, which at least fails visibly.

       `assetSpace` rides in the SAME spread, and that is the whole of its correctness: studio.jx-
       suite.com is a multi-tenant SPA origin, so `/hero.jpg` misses Workers Static Assets and the
       single-page-app fallback answers index.html at HTTP 200 — the <img> gets HTML, renders
       broken, and logs nothing. Declaring "repo" tells Studio to resolve each reference to the
       project file it names and address it under /raw. Until a project is bound there is no /raw to
       address, so the project-less hub declares neither and stays exactly as it was. */
    ...(base ? { assetSpace: "repo" as const, documentBaseUrl: `${base}/raw/` } : {}),
    /* Open Project routes through Studio's repo picker (write-access repos via listRepos +
       importProject) — sessions are URL-bound, so openProject() below never opens a dialog. */
    openProjectPicker: "repo-list",

    /* A cloud project IS a GitHub repo, so the New Project modal collects the repository location
       (owner, name, visibility) rather than a folder. */
    createDestination: "repo",

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
      const body = await okJson<Partial<UploadResult>>(res, `Upload failed: ${path}`);
      // The session echoes the path today; falling back to the request keeps a backend that says
      // Nothing working rather than writing `undefined` into a document.
      return { path: body.path ?? path, ...(body.size === undefined ? {} : { size: body.size }) };
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

    /**
     * Usage counts, computed SERVER-SIDE. The walker lives in `@jxsuite/server`, which the cloud
     * target already runs against the ProjectSession's working tree, so cloud is not a host that
     * degrades to "unknown" — it answers the same query the desktop does, over the same engine.
     */
    async findReferences(target: { path?: string; tagName?: string }): Promise<ReferencesResult> {
      const params = new URLSearchParams();
      if (target.path) {
        params.set("path", target.path);
      }
      if (target.tagName) {
        params.set("tag", target.tagName);
      }
      return okJson<ReferencesResult>(
        await api(`/references?${params.toString()}`),
        `Failed to find references: ${target.path ?? target.tagName ?? ""}`,
      );
    },

    async createDirectory(_path: string) {
      // Directories exist implicitly in the virtual tree (created on write).
    },

    /**
     * Realtime co-editing over the gateway's /collab WebSocket (rooms keyed by project-relative
     * path, per the shared ProjectSession working tree). Backends without the endpoint (or with the
     * flag off) refuse the upgrade and Studio degrades to solo editing. The wire client's
     * evaluation defers behind the dynamic import until a doc opens.
     *
     * A plain GET on the same URL is the subprotocol negotiation, and this adapter did not make one
     * before. **A probe that does not answer is not a refusal here.** The gateway is deployed
     * separately from this bundle, so a 404 or a network error means "older gateway", and treating
     * that as no-collab would take working co-editing away from every session pointed at one. It
     * connects as it always has, offering nothing — which is also the only handshake-safe answer to
     * a server that would echo nothing (RFC 6455 §4.1).
     */
    async collab(docPath: string) {
      if (!project || typeof WebSocket === "undefined" || typeof location === "undefined") {
        return null;
      }
      collabNegotiation ??= api("/collab")
        .then(async (res) =>
          res.ok ? negotiateCollab(await res.json()) : { offer: [], refused: null },
        )
        .catch(() => ({ offer: [], refused: null }));
      const negotiated = await collabNegotiation;
      if (negotiated.refused !== null) {
        console.warn(`Collaboration unavailable: ${negotiated.refused}`);
        return null;
      }
      const { offer } = negotiated;
      collabConnection ??= (async () => {
        const { createWsCollabConnection } = await import("@jxsuite/collab/client");
        const scheme = location.protocol === "https:" ? "wss" : "ws";
        return createWsCollabConnection({
          hydratePath: async (path) => {
            // The DO has no GitHub token on a WS message; a plain read hydrates + caches the row.
            await api(`/file?path=${encodeURIComponent(path)}`);
          },
          protocols: offer,
          url: `${scheme}://${location.host}${base}/collab`,
        });
      })();
      const connection = await collabConnection;
      return connection.openDoc(docPath);
    },

    /**
     * Live session events over the gateway WebSocket. Reconnects with a small backoff; the DO
     * pushes {kind:"fs"} batches for file mutations (including those from other tabs) and
     * {kind:"git"} notices this handler ignores.
     */
    subscribeFileEvents(handler: (events: FsEvent[]) => void) {
      // No project means an empty base, so the bare `/events` URL hits no gateway route.
      // That fails in a reconnect loop; mirror `collab`'s guard and degrade to no-op on the hub.
      if (!project || typeof WebSocket === "undefined" || typeof location === "undefined") {
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

    // ─── Formats (session backend registry, mirroring the dev-server seam) ─

    /**
     * The project's format registry, served by the session gateway (the dev server's `GET
     * /__studio/formats` under this session's base path). Degrades to an empty registry (only .json
     * documents open) against backends that predate the route.
     */
    async listFormats() {
      try {
        const res = await api("/formats");
        if (!res.ok) {
          return [];
        }
        const body = (await res.json()) as { formats?: Record<string, unknown>[] };
        return body.formats ?? [];
      } catch {
        return [];
      }
    },

    /** The extensions payload riding beside `formats` on the same route. */
    async listExtensions(): Promise<ExtensionsInfo[]> {
      try {
        const res = await api("/formats");
        if (!res.ok) {
          return [];
        }
        const body = (await res.json()) as { extensions?: ExtensionsInfo[] };
        return body.extensions ?? [];
      } catch {
        return [];
      }
    },

    /**
     * The extensions THIS WORKER bundles — not the shipped first-party catalogue.
     *
     * A Worker ships a fixed set of extension packages (specs/extensions.md §5.5), decided by the
     * platform build rather than by this repository's `extensions/` tree, so the gateway is the
     * only thing that knows. Everything it returns is therefore `bundled: true`: enabling one is a
     * `project.json` write alone, and an extension the Worker does not bundle is dropped from the
     * registry before composition — advertising it would promise a toggle that silently does
     * nothing.
     *
     * `installed` here means DECLARED. Nothing resolves a module in a Worker: `addPackage` is a
     * manifest edit and resolution happens later in Pages CI, so the manifest is the only fact this
     * adapter has, and it is the one the reader is being asked about.
     *
     * Degrades to an EMPTY list, which is the whole contract: a session whose gateway predates this
     * route must offer nothing rather than five extensions three of which it cannot load.
     */
    async listExtensionCatalog(): Promise<ExtensionCatalogEntry[]> {
      try {
        const res = await api("/catalog");
        if (!res.ok) {
          return [];
        }
        const entries = (await res.json()) as ExtensionCatalogEntry[];
        const pkg = await readPackageJson();
        const declared = new Set([
          ...Object.keys((pkg["dependencies"] ?? {}) as Record<string, string>),
          ...Object.keys((pkg["devDependencies"] ?? {}) as Record<string, string>),
        ]);
        for (const entry of entries) {
          entry.bundled = true;
          entry.installed = declared.has(entry.name);
        }
        return entries;
      } catch {
        return [];
      }
    },

    /**
     * The session's generated entry documents, composed server-side from the core schemas and each
     * enabled extension's fragments (extensions.md §5.2) and returned PRE-BUNDLED — Monaco and the
     * AI assistant register them as inline objects and never fetch (studio.md §4.2.1).
     *
     * Degrades to `{}` rather than throwing: a backend too old to serve the route, or a project
     * whose extensions the session cannot compose, keeps the bundled core schemas. That fallback
     * under-suggests extension extras but never reports false errors (§5.3).
     */
    async fetchProjectSchemas(): Promise<ProjectSchemasResponse> {
      try {
        const res = await api("/project-schemas");
        if (!res.ok) {
          return {};
        }
        return (await res.json()) as ProjectSchemasResponse;
      } catch {
        return {};
      }
    },

    /**
     * Invoke a format capability (parse/serialize) on the session backend — the dev server's `POST
     * /__studio/format` seam. In-page execution left with the core → @jxsuite/parser dependency, so
     * backends without the route surface the error below instead of silently mangling format
     * documents.
     */
    async formatAction(payload: Record<string, unknown>) {
      const res = await postJson("/format", payload);
      if (!res.ok) {
        throw new Error(
          await errorMessage(
            res,
            "This cloud session cannot run format actions yet (the backend serves no format route)",
          ),
        );
      }
      const data = (await res.json()) as { result?: unknown };
      return data.result;
    },

    // ─── Components / code services (cloud: static-only posture) ──────────

    /**
     * Component discovery, by READING rather than executing.
     *
     * This returned `[]` under "no execution of project JS in the cloud", and the cost was not the
     * loss of discovery — it was the canvas. `canvas-live-render` injects the `$elements` a
     * document's tags need only when the registry is non-empty, so an empty registry meant nothing
     * was ever registered, no component was ever fetched, and every component instance rendered as
     * an unregistered custom element: an empty inline box. A page built from components came up as
     * blank space between the layout's chrome.
     *
     * Discovery does not need to execute anything. For a JSON component it is a file read and a
     * property lookup — `componentMetaFrom` is that function, shared with the two Bun backends so
     * "which `state` entries are props" has one answer. Non-JSON component formats DO need a
     * project-supplied parser, and those stay out: the posture is kept where it actually applies
     * rather than across the whole feature.
     *
     * Bounded rather than unbounded: the walk skips the directories a scan has no business in and
     * stops at a depth and a file count, because this runs against a remote session over HTTP and a
     * pathological tree must not turn opening a project into thousands of requests.
     */
    async discoverComponents() {
      const SKIP = new Set(["node_modules", "dist", ".git", ".claude", ".obsidian", "build"]);
      const MAX_FILES = 400;
      const MAX_DEPTH = 6;
      const jsonPaths: string[] = [];

      const walk = async (dir: string, depth: number): Promise<void> => {
        if (depth > MAX_DEPTH || jsonPaths.length >= MAX_FILES) {
          return;
        }
        let entries: DirEntry[];
        try {
          entries = await platform.listDirectory(dir);
        } catch {
          return; // A directory that vanished mid-walk is not a discovery failure.
        }
        const dirs: string[] = [];
        for (const entry of entries) {
          if (entry.type === "directory") {
            if (!SKIP.has(entry.name) && !entry.name.startsWith(".")) {
              dirs.push(entry.path);
            }
          } else if (entry.name.endsWith(".json") && jsonPaths.length < MAX_FILES) {
            jsonPaths.push(entry.path);
          }
        }
        await Promise.all(dirs.map(async (d) => walk(d, depth + 1)));
      };
      await walk("", 0);

      const metas = await Promise.all(
        jsonPaths.map(async (path) => {
          try {
            return componentMetaFrom(JSON.parse(await platform.readFile(path)), path);
          } catch {
            return null; // Not JSON, not readable, or not a component — all the same answer here.
          }
        }),
      );
      return metas.filter((m): m is NonNullable<typeof m> => m !== null) as ComponentMeta[];
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

    /**
     * Open in Browser, cloud edition — a LIVE preview rather than a build.
     *
     * The backend cannot run `jx build`: it never executes project JS, and the compiler needs
     * `sharp`, a bundler and a filesystem, none of which exist in a Worker. What it can do is serve
     * the working tree as a real site on an origin of its own, rendering each page with the same
     * runtime the canvas uses — so the reply names `mode: "live"` and Studio says so, instead of
     * letting a reader assume they are looking at build output.
     *
     * That it is not a build is also the best thing about it: the preview is the tree as it stands,
     * including edits nobody has saved and edits another collaborator is making right now.
     */
    async buildSite() {
      return okJson<SiteBuildResult>(
        await api("/build", { method: "POST" }),
        "The site could not be previewed.",
      );
    },

    // ─── Project catalogue & navigation (Studio welcome / New Project UI) ──

    async listProjects(): Promise<ProjectListEntry[]> {
      const entries = await fetchProjects();
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
      const target = await resolveRootKey(rootKey);
      /* Throw rather than fall through: `deduped` tells the caller the open was handled, so an
         unresolvable key answered "done" and left the user looking at the screen they clicked on.
         The throw reaches `openRecentProject`'s catch, which reports the failure and drops the
         entry — the right end for a row naming a project this account can no longer open. */
      if (!target) {
        throw new Error(`No project to open at ${rootKey}`);
      }
      if (typeof location !== "undefined") {
        location.assign(editUrl(target));
      }
      // Navigation unloads the page; deduped stops the caller's follow-up work.
      return { deduped: true, config: null };
    },

    async openProjectInNewWindow(rootKey: string) {
      const target = await resolveRootKey(rootKey);
      // Same contract as setWindowProject: the caller reports "Opened in another window" on any
      // Resolved call, so a key that opens nothing has to fail rather than answer.
      if (!target) {
        throw new Error(`No project to open at ${rootKey}`);
      }
      if (typeof window !== "undefined") {
        window.open(editUrl(target), "_blank", "noopener");
      }
      // `_blank` always makes a tab; a browser tab already showing this project is not something
      // The page can see, let alone raise.
      return { focused: false };
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
      destination: CreateProjectDestination;
      starter?: string | undefined;
      template?: string | undefined;
    }) {
      // The repository location comes from the modal's Owner / Repository / Visibility fields —
      // Never from a server-side default. The API resolves `owner` against the session login to
      // Decide between /user/repos and /orgs/<owner>/repos.
      const { destination } = opts;
      if (destination.kind !== "repo" || !destination.owner || !destination.repo) {
        throw new Error("A destination repository is required.");
      }
      const res = await fetch("/api/v1/projects", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: opts.name,
          description: opts.description,
          starter: opts.starter,
          owner: destination.owner,
          repo: destination.repo,
          private: destination.private,
        }),
      });
      if (!res.ok) {
        // Preserve the structured 403 (needs_installation_access + installUrl) so the New
        // Project modal can render an install link instead of flattened text.
        const body = (await res.json().catch(() => null)) as
          | (ErrorBody & { installUrl?: string; type?: string })
          | null;
        /*
         * `code` survives as the machine-readable discriminator the modal branches on, and a
         * problem document supplies it from its `type` — `problemSlug` derives the same string the
         * old `code` field carried, so the modal's branch is unchanged either way.
         */
        throw Object.assign(new Error(problemDetail(body) ?? "Failed to create project"), {
          ...((problemSlug(body?.type) ?? body?.code)
            ? { code: problemSlug(body?.type) ?? body?.code }
            : {}),
          ...(body?.installUrl ? { installUrl: body.installUrl } : {}),
        });
      }
      const created = (await res.json()) as { owner: string; name: string; defaultBranch: string };
      return {
        root: projectRootKey({
          owner: created.owner,
          repo: created.name,
          branch: created.defaultBranch,
        }),
        config: { name: opts.name } as ProjectConfig,
      };
    },

    /**
     * AI-guided site import, streamed from the PLATFORM's import route rather than a session one.
     *
     * Deliberately not routed through `api()`: importing is how a cloud project comes into
     * existence, so the one mode it has to work in is the project-less hub, where `api()` rejects
     * before a request is ever made and `base` is "".
     *
     * The path is same-origin and relative, so `streamImport`'s plain `fetch` carries the session
     * cookie under the default `same-origin` credentials mode — the same authority every
     * `/api/v1/*` call here sends `credentials: "include"` for, with no cloud-shaped option added
     * to the shared client. A bring-your-own-key run rides on the headers that client already sets,
     * so the backend sees `X-Api-Key` / `X-Api-Base-URL` exactly as the OSS server does.
     *
     * `onReady` is forwarded and this backend never calls it, which is a difference worth naming:
     * adopting the project mid-run would navigate this page to the editor and abort the request
     * still writing the import, so the stream carries no `ready` line and the caller adopts on
     * `done`. That is the same path a backend older than `ready` has always taken.
     */
    async importSite(
      opts: ImportSiteOptions,
      onProgress: (evt: ImportProgressEvent) => void,
      signal?: AbortSignal,
      onReady?: (evt: ImportReadyEvent) => void,
    ) {
      return await streamImport("/api/v1/import/site", opts, onProgress, signal, onReady);
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

    /** Repositories reachable through the user's Jx Suite App installations (user + org). */
    async listRepos(): Promise<RepoInfo[]> {
      const res = await fetch("/api/v1/repos", { credentials: "include" });
      if (!res.ok) {
        throw new Error(await errorMessage(res, "Failed to list repositories"));
      }
      const entries = (await res.json()) as (RepoInfo & { repoId: number })[];
      return entries.map((r) => ({
        owner: r.owner,
        name: r.name,
        fullName: r.fullName,
        private: r.private,
        defaultBranch: r.defaultBranch,
        permission: r.permission,
        isJxProject: r.isJxProject,
      }));
    },

    /** Adopt an existing repo as a Jx project; resolves to its catalogue root key. */
    async importProject(opts: { owner: string; name: string }) {
      const res = await fetch("/api/v1/projects/import", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(opts),
      });
      const imported = await okJson<{ owner: string; name: string; defaultBranch: string }>(
        res,
        "Failed to import repository",
      );
      return {
        root: projectRootKey({
          owner: imported.owner,
          repo: imported.name,
          branch: imported.defaultBranch,
        }),
      };
    },

    /**
     * GitHub-App installation coverage from /me — powers the welcome install prompt and the repo
     * picker's "grant access to more repositories" links (`manageUrl` per installation).
     */
    async getAccountStatus() {
      const res = await fetch("/api/v1/me", { credentials: "include" });
      if (!res.ok) {
        return null;
      }
      const me = (await res.json()) as {
        installations?: { id: number; account: string | null; manageUrl?: string }[];
        appInstallUrl?: string;
      };
      return {
        installations: (me.installations ?? []).map((entry) => {
          const installation: AccountStatus["installations"][number] = {
            id: entry.id,
            account: entry.account,
          };
          if (entry.manageUrl) {
            installation.manageUrl = entry.manageUrl;
          }
          return installation;
        }),
        ...(me.appInstallUrl ? { appInstallUrl: me.appInstallUrl } : {}),
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
     * Hosted OAuth connect: open the broker flow in a popup. The home shell relays the callback's
     * result back via postMessage {source: "jx-cf"} and closes the popup, so success resolves and
     * OAuth errors (denial, invalid_scope misregistration) REJECT with the real reason instead of
     * timing out. A 1.5s poll remains as fallback for older shells / blocked message delivery, and
     * popup-blocked browsers fall back to a full-page redirect.
     *
     * Promise semantics, which are narrower than they look:
     *
     * - **Resolves `null`** only under the SSR guard, where there is no window to open.
     * - **Resolves an outcome** for all four real endings — `connected`, `redirect` (popup blocked,
     *   page navigating away), `canceled` (popup closed with nothing stored), `timeout` (180s).
     * - **Rejects** only on a relayed OAuth error, or on a relayed success this platform could not
     *   confirm against the broker.
     *
     * Concurrent calls JOIN the flow already running rather than starting a second one: both would
     * open the same "cf-connect" target, and the first one's cleanup would then close the popup the
     * second is waiting on.
     */
    cfConnect() {
      if (typeof window === "undefined" || typeof location === "undefined") {
        return Promise.resolve(null);
      }
      const running = cfConnectFlow;
      if (running) {
        try {
          running.popup?.focus();
        } catch {
          // A cross-origin popup may refuse focus; joining the flow is what mattered.
        }
        return running.promise;
      }
      const handle: CfConnectFlow = { popup: null, promise: Promise.resolve(null) };
      cfConnectFlow = handle;
      handle.promise = runCfConnect(handle).finally(() => {
        if (cfConnectFlow === handle) {
          cfConnectFlow = null;
        }
      });
      return handle.promise;
    },

    /**
     * Every Cloudflare account this connection can reach (the account picker's rows).
     *
     * A non-OK body is the broker's own unusable-connection payload — `{error, code}` naming a
     * lapsed grant or a connection that never existed — so its sentence is the one worth showing.
     */
    async cfAccounts() {
      const res = await fetch("/api/v1/cf/accounts", { credentials: "include" });
      return okJson<CfAccountSummary[]>(res, "Failed to list Cloudflare accounts");
    },

    /** Store the chosen account on the brokered connection. */
    async cfSelectAccount(account: { id: string; name?: string }) {
      const res = await fetch("/api/v1/cf/select-account", {
        body: JSON.stringify({ accountId: account.id, accountName: account.name }),
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!res.ok) {
        throw new Error(await errorMessage(res, "Failed to select a Cloudflare account"));
      }
    },

    /** Forget the brokered connection (the broker revokes its tokens upstream). */
    async cfDisconnect() {
      const res = await fetch("/api/v1/cf/connection", {
        credentials: "include",
        method: "DELETE",
      });
      if (!res.ok) {
        throw new Error(await errorMessage(res, "Failed to disconnect Cloudflare"));
      }
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
