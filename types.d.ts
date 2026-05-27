declare module "three";
declare module "@webref/elements";
declare module "@webref/css";
declare module "@webref/idl";

// ─── Git & Platform Types ───────────────────────────────────────────────────

interface GitFileStatus {
  status: string;
  path: string;
  staged?: boolean;
}

interface GitStatusResult {
  branch: string;
  files: GitFileStatus[];
  ahead: number;
  behind: number;
}

interface GitBranchesResult {
  current: string;
  branches: string[];
}

interface GitLogEntry {
  hash: string;
  message: string;
  author: string;
  date: string;
}

interface ComponentMeta {
  tagName: string;
  $id?: string | null;
  path: string;
  props?: { name: string; type?: string; default?: unknown }[];
  hasElements?: boolean;
}

interface PackageInfo {
  name: string;
  version: string;
}

interface CodeServiceResult {
  code?: string;
  diagnostics?: unknown[];
  [key: string]: unknown;
}

// ─── Studio Platform ────────────────────────────────────────────────────────

interface StudioPlatform {
  id: string;
  projectRoot: string;
  activate(root?: string): Promise<void>;
  openProject(): Promise<{
    config: ProjectConfig;
    handle: { root: string; name: string; projectConfig: ProjectConfig };
  } | null>;
  probeRootProject(): Promise<{
    meta: { root: string; name: string };
    info: { isSiteProject: boolean; projectConfig?: ProjectConfig | null; directories?: string[] };
  } | null>;
  listDirectory(dir: string): Promise<DirEntry[]>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  uploadFile(path: string, data: string | File | Blob | ArrayBuffer): Promise<unknown>;
  deleteFile(path: string): Promise<void>;
  renameFile(from: string, to: string): Promise<void>;
  createDirectory(path: string): Promise<void>;
  discoverComponents(dir?: string): Promise<ComponentMeta[]>;
  addPackage(name: string): Promise<unknown>;
  removePackage(name: string): Promise<unknown>;
  listPackages(): Promise<PackageInfo[]>;
  codeService(action: string, payload: unknown): Promise<CodeServiceResult | null>;
  resolveSiteContext(
    filePath: string,
  ): Promise<{ sitePath: string | null; projectConfig?: ProjectConfig; fileRelPath?: string }>;
  locateFile(name: string): Promise<string | null>;
  searchFiles(query: string): Promise<DirEntry[]>;
  fetchPluginSchema(src: string, prototype?: string, base?: string): Promise<unknown>;
  gitStatus(): Promise<GitStatusResult>;
  gitBranches(): Promise<GitBranchesResult>;
  gitLog(limit?: number): Promise<GitLogEntry[]>;
  gitStage(files: string[]): Promise<void>;
  gitUnstage(files: string[]): Promise<void>;
  gitCommit(message: string): Promise<void>;
  gitPush(): Promise<void>;
  gitPull(): Promise<void>;
  gitFetch(): Promise<void>;
  gitCheckout(branch: string): Promise<void>;
  gitCreateBranch(name: string): Promise<void>;
  gitDiff(path?: string): Promise<string>;
  gitShow(opts: { path: string; ref?: string }): Promise<string>;
  gitDiscard(files: string[]): Promise<void>;
  createProject(opts: {
    name: string;
    description?: string;
    url?: string;
    adapter?: string;
    directory: string;
  }): Promise<{ root: string; config: ProjectConfig }>;
}

// ─── Studio UI Types ────────────────────────────────────────────────────────

interface InlineEditDef {
  path: JxPath;
  mediaName?: string;
}

interface FunctionEditDef {
  type: string;
  defName?: string;
  path?: JxPath;
  eventKey?: string;
  key?: string;
  body?: string;
  parameters?: string[];
}

interface DocumentStackEntry {
  document: JxMutableNode;
  documentPath: string | null;
  selection: JxPath | null;
  dirty?: boolean;
  mode?: string;
  sourceFormat?: string | null;
}

interface GitDiffState {
  filePath: string;
  originalContent: string;
  currentContent: string;
  isMarkdown: boolean;
  fileStatus: string;
}

// ─── Canvas Panel ───────────────────────────────────────────────────────────

interface CanvasPanel {
  mediaName: string;
  element: HTMLElement | null;
  canvas: HTMLElement | null;
  overlay: HTMLElement | null;
  overlayClk: HTMLElement | null;
  viewport: HTMLElement | null;
  scrollContainer: HTMLElement | null;
  dropLine: HTMLElement | null;
  _width: number | null;
}

// ─── Render Options ─────────────────────────────────────────────────────────

interface JxRenderOptions {
  _path?: JxPath;
  onNodeCreated?: (el: HTMLElement | Text, path: JxPath, def: Record<string, unknown>) => void;
}

// ─── Jx Domain Types ────────────────────────────────────────────────────────

/**
 * Recursive style definition. Flat keys are CSS properties; nested keys are pseudo-classes
 * (`:hover`), child selectors (`.class`, `&`, `[attr]`), or media queries (`@media`).
 */
interface JxStyle {
  [property: string]: string | number | JxStyle | undefined;
}

/**
 * A Jx element node — the fundamental building block of a document tree. Beyond the known keys,
 * arbitrary properties pass through to the DOM or become scope bindings (if prefixed with `$`) or
 * event handlers (if prefixed with `on`).
 */
interface JxElement {
  tagName?: string;
  textContent?: string | null;
  innerHTML?: string;
  children?: (JxElement | string)[] | JxMappedArray;
  style?: JxStyle;
  attributes?: Record<string, unknown>;
  className?: string;
  id?: string;
  hidden?: boolean;
  tabIndex?: number;
  title?: string;
  lang?: string;
  dir?: string;

  // Reactivity
  $ref?: string;
  $props?: Record<string, unknown>;
  $switch?: { $ref: string };
  cases?: Record<string, JxElement>;

  // Metadata
  $prototype?: string;
  $static?: boolean;
  $prerendered?: boolean;
  $title?: string;
  $id?: string;
  $src?: string;

  // Custom element support
  observedAttributes?: string[];
  state?: Record<string, JxStateDefinition>;

  [key: string]: unknown;
}

/** A mapped-array children definition */
interface JxMappedArray {
  $prototype: "Array";
  items: { $ref: string } | unknown;
  map?: JxElement;
  filter?: { $ref: string } | unknown;
  sort?: { $ref: string } | unknown;
}

/** A full Jx document (top-level structure) */
interface JxDocument extends JxElement {
  state?: Record<string, JxStateDefinition>;
  $elements?: (JxElement | string)[];
  $head?: JxHeadEntry[];
  $media?: Record<string, string>;
  $defs?: Record<string, unknown>;
  imports?: Record<string, string>;
}

/**
 * Type for dynamically-constructed classes (classFromSchema). Allows arbitrary static and prototype
 * property assignment.
 */
interface DynamicClass {
  new (config?: Record<string, unknown>): Record<string, unknown>;
  [key: string]: unknown;
  prototype: Record<string, unknown>;
}

/**
 * Mutable node type for the studio editor — same shape as JxElement but allows property writes
 * without casting. Used by transact.js and all mutation paths.
 */
interface JxMutableNode {
  tagName?: string;
  textContent?: string | null;
  innerHTML?: string;
  children?: (JxMutableNode | string)[];
  style?: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  attributes?: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  className?: string;
  id?: string;
  $ref?: string;
  $props?: Record<string, unknown>;
  $switch?: string | { $ref: string };
  cases?: Record<string, JxMutableNode>;
  $prototype?: string;
  $title?: string;
  $id?: string;
  $src?: string;
  state?: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  $elements?: (JxMutableNode | string | { $ref: string })[];
  $head?: JxHeadEntry[];
  $media?: Record<string, string>;
  $defs?: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  [key: string]: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

// ─── State Shapes ────────────────────────────────────────────────────────────

type JxStateDefinition = string | number | boolean | null | JxStateObject | JxPrototypeDef;

interface JxStateObject {
  type?: string;
  default?: unknown;
  properties?: Record<string, unknown>;
  items?: unknown;
  enum?: unknown[];
  [key: string]: unknown;
}

interface JxPrototypeDef {
  $prototype: string;
  $src?: string;
  $export?: string;
  body?: string;
  parameters?: string[];
  arguments?: string[];
  timing?: "compiler" | "server" | "client";
  default?: unknown;
  debounce?: number;
  contentType?: string;
  filter?: Record<string, unknown>;
  sort?: { field: string; order?: string };
  limit?: number;
  id?: string | { $ref: string };
  [key: string]: unknown;
}

// ─── Head Entries ────────────────────────────────────────────────────────────

interface JxHeadEntry {
  tagName: string;
  attributes?: Record<string, string | boolean>;
  textContent?: string;
  children?: (JxHeadEntry | string)[];
  [key: string]: unknown;
}

// ─── Paths ───────────────────────────────────────────────────────────────────

type JxPath = (string | number)[];

// ─── Utility Types ──────────────────────────────────────────────────────────

type JsonValue = string | number | boolean | object | null | undefined;

// ─── Parser Output ───────────────────────────────────────────────────────────

interface MarkdownFileResult {
  slug: string;
  path: string;
  frontmatter: Record<string, unknown>;
  $children: (JxElement | string)[];
  $excerpt?: string;
  $toc?: TocEntry[];
  $readingTime?: number;
  $wordCount?: number;
  [key: string]: unknown;
}

interface TocEntry {
  depth: number;
  text: string;
  id: string;
}

// ─── Content Types ───────────────────────────────────────────────────────────

interface ContentEntry extends MarkdownFileResult {
  [key: string]: unknown;
}

interface ContentLoaderEntry {
  id: string;
  data: Record<string, unknown>;
  body: string | null;
  $children?: (JxElement | string)[];
  _meta?: {
    excerpt?: string;
    toc?: TocEntry[];
    readingTime?: number;
    wordCount?: number;
  };
}

interface ContentTypeDef {
  source: string;
  schema?: ContentTypeSchema;
  $elements?: (string | { $ref: string })[];
  [key: string]: unknown;
}

interface ContentTypeSchema {
  properties?: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  required?: string[];
  [key: string]: unknown;
}

interface SiteRoute {
  urlPattern: string;
  sourcePath?: string;
  _pathParams?: Record<string, string>;
  [key: string]: unknown;
}

/** Studio project state (file tree, git, etc.) */
interface ProjectState {
  root?: string;
  name: string;
  projectRoot: string;
  isSiteProject: boolean;
  projectConfig: ProjectConfig | null;
  dirs: Map<string, DirEntry[]>;
  expanded: Set<string>;
  selectedPath: string | null;
  searchQuery: string;
  projectDirs?: string[];
  [key: string]: unknown;
}

interface DirEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
  modified?: string;
}

interface ImageConfig {
  optimize: boolean;
  widths: number[];
  formats: string[];
  quality: { webp?: number; avif?: number; jpeg?: number; png?: number };
  sizes: string;
  lazyLoad: boolean;
}

interface ProjectConfig {
  name?: string;
  url?: string;
  state?: Record<string, unknown>;
  $media?: Record<string, string>;
  $elements?: (string | JxElement)[];
  $head?: JxHeadEntry[];
  $defs?: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  build?: { adapter?: string; [key: string]: unknown };
  images?: ImageConfig;
  imports?: Record<string, string>;
  contentTypes?: Record<string, ContentTypeDef>;
  defaults?: { layout?: string; lang?: string; charset?: string; [key: string]: unknown };
  style?: JxStyle;
  [key: string]: unknown;
}

// ─── Head Merge Context ──────────────────────────────────────────────────────

interface HeadMergeContext {
  title?: string;
  siteName?: string;
  lang?: string;
  charset?: string;
  url?: string;
  siteUrl?: string;
  pageUrl?: string;
}

// ─── Mdast/Hast Node Types (unified ecosystem) ──────────────────────────────
// Minimal structural types compatible with the real @types/mdast definitions.
// Used in JSDoc annotations where the full mdast types aren't importable.

interface MdastNode {
  type: string;
  children?: MdastNode[];
  value?: string;
  data?: unknown;
  position?: unknown;
  // Common properties across node types
  depth?: number;
  ordered?: boolean | null;
  start?: number | null;
  spread?: boolean;
  isHeader?: boolean;
  name?: string;
  attributes?: Record<string, string>;
  url?: string;
  alt?: string;
  title?: string | null;
  lang?: string | null;
  meta?: string | null;
  align?: (string | null)[] | null;
}

interface HastNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  value?: string;
}

// ─── Diagnostics ─────────────────────────────────────────────────────────────

interface JxDiagnostic {
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  range?: { start: { line: number; character: number }; end: { line: number; character: number } };
  source?: string;
}

// ─── Build Entries (server) ──────────────────────────────────────────────────

interface BuildEntry {
  entrypoints: string[];
  outdir: string;
  match?: Function | RegExp;
  label?: string;
}

// ─── Class JSON schema types (resolve.js / studio-api.js) ────────────────────

interface ClassJsonParam {
  $ref?: string;
  identifier?: string;
  name?: string;
}

interface ClassJsonField {
  role?: string;
  access?: string;
  scope?: string;
  identifier?: string;
  initializer?: unknown;
  default?: unknown;
  type?: Record<string, unknown>;
  description?: string;
  examples?: unknown[];
}

interface ClassJsonMethod {
  identifier?: string;
  role?: string;
  scope?: string;
  body?: string | string[];
  getter?: { body: string };
  setter?: { parameters?: ClassJsonParam[]; body: string };
  parameters?: ClassJsonParam[];
}

interface ClassJsonParameterDef {
  identifier?: string;
  type?: Record<string, unknown>;
  format?: string;
  description?: string;
  examples?: unknown[];
}

interface ClassJsonDef {
  title?: string;
  description?: string;
  $implementation?: string;
  extends?: { $ref?: string };
  $defs?: {
    fields?: Record<string, ClassJsonField>;
    constructor?: {
      role?: string;
      $prototype?: string;
      body?: string | string[];
      parameters?: ClassJsonParam[];
    };
    methods?: Record<string, ClassJsonMethod>;
    parameters?: Record<string, ClassJsonParameterDef>;
  };
}
