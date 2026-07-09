/**
 * Studio Backend Protocol — wire types. Every shape a Studio backend serves
 * (or a `StudioPlatform` adapter consumes) lives here so client adapters and
 * server implementations (the dev server, the desktop RPC bridge, cloud
 * platforms) share one contract. Environment-agnostic: no DOM, no node —
 * importable in browsers, Bun, and Cloudflare Workers alike.
 *
 * @license MIT
 */

import type { JsonValue as SchemaJsonValue, JxMutableNode } from "@jxsuite/schema/types";

/**
 * A JSON document value, or `undefined` to signal property removal in the mutators. Re-uses the
 * schema's precise recursive JSON model.
 */
export type JsonValue = SchemaJsonValue | undefined;

// ─── Errors ──────────────────────────────────────────────────────────────────

/** Message-level failure body every protocol route may return. */
export interface ErrorBody {
  error: string;
  /** Machine-readable discriminator (e.g. "remote_moved", "cf_not_connected"). */
  code?: string;
  detail?: unknown;
}

// ─── Filesystem ──────────────────────────────────────────────────────────────

export interface DirEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
  modified?: string;
}

/** A filesystem change pushed from the backend (project-relative, forward-slashed path). */
export interface FsEvent {
  type: "add" | "change" | "unlink" | "addDir" | "unlinkDir";
  path: string;
  isDir: boolean;
}

/** Result of a rename, including the references rewritten across the project (refactor report). */
export interface RenameResult {
  ok: boolean;
  from: string;
  to: string;
  isDir?: boolean;
  references?: {
    filesChanged: number;
    refsUpdated: number;
    files: { path: string; count: number }[];
  };
  errors?: { path: string; error: string }[];
  tag?: { from: string; to: string; filesChanged: number; refsUpdated: number };
  tagSkipped?: string;
  error?: string;
}

// ─── Git ─────────────────────────────────────────────────────────────────────

export interface GitFileStatus {
  status: string;
  path: string;
  staged?: boolean;
}

export interface GitStatusResult {
  branch: string;
  files: GitFileStatus[];
  ahead: number;
  behind: number;
  isRepo: boolean;
  remotes: string[];
}

export interface GitBranchesResult {
  current: string;
  branches: string[];
}

export interface GitLogEntry {
  hash: string;
  message: string;
  author: string;
  date: string;
}

/** Response of the pull-request route (see StudioPlatform.createPullRequest). */
export interface PullRequestInfo {
  url: string;
  number: number;
}

// ─── Components ──────────────────────────────────────────────────────────────

export interface ComponentSlotMeta {
  name: string;
  description?: string;
  fallback?: (JxMutableNode | string)[];
}

export interface ComponentMeta {
  tagName: string;
  $id?: string | null;
  path: string;
  props?: { name: string; type?: string; default?: JsonValue; [k: string]: unknown }[];
  slots?: ComponentSlotMeta[];
  hasElements?: boolean;
}

// ─── Extensions (specs/extensions.md §9/§9.1) ────────────────────────────────

/** The `project` admission block of a section-owning extension class. */
export interface ExtensionProjectBlock {
  /** The project.json top-level property the class owns. */
  key: string;
  title?: string;
  description?: string;
  referenceable?: boolean;
}

/** One project-section contribution of an extension class, as served on the formats route. */
export interface ExtensionContributionInfo {
  /** The $prototype-visible class name declaring the `project` block. */
  className: string;
  project: ExtensionProjectBlock;
  /** The class descriptor's `$studio` block (settings-section vocabulary), when declared. */
  studio?: Record<string, unknown> | null;
  /**
   * The section's value schema — `properties[<key>]` of the extension's shipped project fragment —
   * resolved backend-side; null when the extension ships no fragment (or it lacks the key).
   */
  entrySchema?: Record<string, unknown> | null;
}

/**
 * One enabled extension package on the wire — the `extensions` sibling of the formats route's
 * `formats` array (additive; the `formats` shape is unchanged).
 */
export interface ExtensionsInfo {
  /** The project.json `extensions` entry that produced this extension. */
  specifier: string;
  /** The manifest's package name. */
  name: string;
  title?: string;
  description?: string;
  /** Project-section contributions, in class declaration order. */
  contributions: ExtensionContributionInfo[];
}

/**
 * Response of the project-schemas route: the project's generated entry documents
 * (project.schema.json / document.schema.json), PRE-BUNDLED into self-contained compound schemas so
 * editors can register them without resolving relative `$ref`s.
 */
export interface ProjectSchemasResponse {
  project?: Record<string, unknown> | null;
  document?: Record<string, unknown> | null;
}

// ─── Packages ────────────────────────────────────────────────────────────────

export interface PackageInfo {
  name: string;
  version: string;
  /** True when the dependency lives in `devDependencies` rather than `dependencies`. */
  dev?: boolean;
}

/** A dependency with a newer version available, as reported by `bun outdated` / the npm registry. */
export interface OutdatedInfo {
  name: string;
  /** The version range pinned in package.json (e.g. "^0.19.0"). */
  current: string;
  /** The newest published version. */
  latest: string;
  /** The newest version satisfying the current range, if known. */
  wanted?: string;
  dev?: boolean;
}

/** Result of a package mutation that runs `bun install` (install / set-versions). */
export interface PackageOpResult {
  ok: boolean;
  /** Combined stdout/stderr from the bun invocation, surfaced to the user on failure. */
  log?: string;
}

// ─── App / code services ─────────────────────────────────────────────────────

/** Desktop app/build info surfaced in the About screen. */
export interface AppInfo {
  version: string;
  channel: string;
  hash: string;
  /** Human-readable update status (e.g. "Up to date", "Update available"), if known. */
  updateStatus?: string;
}

export interface CodeServiceResult {
  code?: string;
  diagnostics?: unknown[];
  [key: string]: unknown;
}

// ─── Projects & starters ─────────────────────────────────────────────────────

/** A starter template surfaced in the New Project picker (mirrors @jxsuite/starters StarterMeta). */
export interface StarterInfo {
  id: string;
  name: string;
  industry: string;
  tagline: string;
  description: string;
  features: string[];
  accent: string;
  /** Preview image as a self-contained `data:` URI. */
  thumbnail: string;
}

/** A recently-opened project, keyed by its re-openable `root` (platform-specific). */
export interface RecentProjectEntry {
  name: string;
  root: string;
  timestamp: number;
}

/** One entry in the platform's project catalogue (see StudioPlatform.listProjects). */
export interface ProjectListEntry {
  /** Display name (project.json name, repository name, ...). */
  name: string;
  /** Re-openable root key (server-relative path, owner/repo, absolute path). */
  root: string;
  /** Optional one-line descriptor shown under the name (path, permission, ...). */
  description?: string | undefined;
}

// ─── Site import ─────────────────────────────────────────────────────────────

/** A progress line from the AI-guided site import (mirrors @jxsuite/import ImportProgressEvent). */
export interface ImportProgressEvent {
  phase: string;
  message: string;
  current?: number;
  total?: number;
}

/** Options for the import-site pipeline (StudioPlatform.importSite). */
export interface ImportSiteOptions {
  /** The live site to clone; must be http(s). */
  url: string;
  /** Display name for the new project. */
  name: string;
  /** Destination directory (platform-interpreted: project-relative on the dev server). */
  directory: string;
  /** Max crawl depth; 0 = single page. */
  depth: number;
  /** Max pages to capture. */
  maxPages: number;
  /** Refine component/prop names with the LLM (requires a key). */
  aiComponents: boolean;
  /** OpenAI-compatible credentials, from the user's AI settings. */
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

// ─── AI proxy ────────────────────────────────────────────────────────────────

/** One entry of the AI proxy's model catalogue. */
export interface AiModelInfo {
  id: string;
  name?: string;
  contextWindow?: number;
  /** Whether the model supports tool/function calling (agentic editing). */
  toolSupport?: boolean;
}

/** Response of the AI proxy's models route (the chat route's sibling). */
export interface AiModelsResponse {
  models: AiModelInfo[];
  /** True when the backend holds working credentials (env key, managed platform). */
  configured: boolean;
  /** True when the platform manages AI credentials itself (e.g. cloud Workers AI). */
  managed?: boolean;
  /** The backend's preferred model id, when it declares one. */
  defaultModel?: string;
  /** Set when the upstream provider was unreachable and defaults were returned. */
  upstreamError?: number | string;
}

// ─── Cloudflare publish surface ──────────────────────────────────────────────

/** Cloudflare connection state (see StudioPlatform.cfConnection). */
export interface CfConnection {
  connected: boolean;
  accountId?: string | undefined;
  accountName?: string | undefined;
}
