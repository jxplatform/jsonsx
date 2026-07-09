/**
 * Format-host — the studio's view of the project's format registry.
 *
 * Format classes are auto-discovered server-side from the project imports map
 * (specs/extensions.md); the studio introspects them via the PAL (`listFormats`) and invokes
 * parse/serialize capabilities via `formatAction` (POST /__studio/format in the dev server, RPC on
 * desktop). The studio itself holds zero format knowledge — `.json` is the single native built-in.
 */

import { getPlatform } from "../platform";
import type { ExtensionsInfo } from "../types";
import type { JxMutableNode } from "@jxsuite/schema/types";

export interface StudioFormatHints {
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

export interface StudioFormat {
  name: string;
  extensions: string[];
  mediaType: string | null;
  documentKinds: string[];
  exportTarget: boolean;
  remote: boolean;
  studio: StudioFormatHints | null;
  capabilities: Record<string, { identifier: string; timing: string[] }>;
}

let _formats: StudioFormat[] = [];
let _loaded: Promise<StudioFormat[]> | null = null;

/** Load (and cache) the project's format registry from the platform. */
export function loadFormats(): Promise<StudioFormat[]> {
  if (!_loaded) {
    _loaded = (async () => {
      try {
        const platform = getPlatform() as {
          listFormats?: () => Promise<StudioFormat[]>;
        };
        _formats = (await platform.listFormats?.()) ?? [];
      } catch {
        _formats = [];
      }
      return _formats;
    })();
  }
  return _loaded;
}

/** Invalidate the cached registry and extensions payload (call on project switch). */
export function refreshFormats() {
  _loaded = null;
  _formats = [];
  _extensionsLoaded = null;
  _extensions = [];
}

/** Seed the registry directly (tests and hosts that preload format metadata). */
export function setFormats(formats: StudioFormat[]) {
  _formats = formats;
  _loaded = Promise.resolve(formats);
}

// ─── Extensions payload (specs/extensions.md §9/§9.1) ────────────────────────

let _extensions: ExtensionsInfo[] = [];
let _extensionsLoaded: Promise<ExtensionsInfo[]> | null = null;

/**
 * Load (and cache) the project's enabled extensions with their project-section contributions.
 * Backed by the platform's optional `listExtensions` member; platforms without it (or failures)
 * degrade to an empty list, hiding descriptor-contributed settings sections.
 */
export function loadExtensions(): Promise<ExtensionsInfo[]> {
  if (!_extensionsLoaded) {
    _extensionsLoaded = (async () => {
      try {
        const platform = getPlatform() as {
          listExtensions?: () => Promise<ExtensionsInfo[]>;
        };
        _extensions = (await platform.listExtensions?.()) ?? [];
      } catch {
        _extensions = [];
      }
      return _extensions;
    })();
  }
  return _extensionsLoaded;
}

/** The last-loaded extensions payload (synchronous access for render paths). */
export function getExtensions(): ExtensionsInfo[] {
  return _extensions;
}

/** Seed the extensions payload directly (tests and hosts that preload it). */
export function setExtensions(extensions: ExtensionsInfo[]) {
  _extensions = extensions;
  _extensionsLoaded = Promise.resolve(extensions);
}

/**
 * Fire-and-forget refresh of the extension-facing editor surface after project (re)activation or an
 * `extensions` change: Monaco's per-project schemas and the descriptor-contributed settings
 * sections. Both modules load lazily — monaco is heavy and the settings registry pulls DOM
 * templates — and both degrade silently (bundled core schemas, built-in sections only).
 *
 * @param {object} platform - The studio platform (only `fetchProjectSchemas` is consulted here)
 */
export function refreshExtensionUi(platform: {
  fetchProjectSchemas?: () => Promise<{ project?: unknown; document?: unknown }>;
}): void {
  void import("../services/monaco-setup")
    .then(({ refreshProjectSchemas }) => refreshProjectSchemas(platform))
    .catch(() => false);
  void import("../settings/extension-sections")
    .then(({ syncExtensionSettingsSections }) => syncExtensionSettingsSections())
    .catch(() => {
      // Contributed sections also refresh on the next settings-modal open.
    });
}

/** The last-loaded registry (synchronous access for render paths). */
export function getFormats(): StudioFormat[] {
  return _formats;
}

/** Look up the format claiming a file extension (".md" or "md"), optionally by capability. */
export function formatByExtension(ext: string, capability?: string): StudioFormat | undefined {
  const norm = ext.startsWith(".") ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
  return _formats.find(
    (f) => f.extensions.includes(norm) && (!capability || f.capabilities[capability]),
  );
}

/** Look up a format by its import name. */
export function formatByName(name: string | null | undefined): StudioFormat | undefined {
  if (!name) {
    return undefined;
  }
  return _formats.find((f) => f.name === name);
}

/** Error for opening a non-JSON file when no imported format class claims its extension. */
export function noFormatError(path: string): Error {
  return new Error(
    `No format class imported for "${path}" — add one to project.json imports ` +
      `(e.g. "Markdown": "@jxsuite/parser/Markdown.class.json") and make sure the ` +
      `project's dependencies are installed`,
  );
}

/** The format claiming a file path's extension, if any. */
export function formatForPath(path: string | null | undefined): StudioFormat | undefined {
  if (!path) {
    return undefined;
  }
  const dot = path.lastIndexOf(".");
  if (dot === -1) {
    return undefined;
  }
  return formatByExtension(path.slice(dot));
}

/** Registered extensions, optionally filtered by document kind. Never includes ".json". */
export function documentExtensions(kind?: string): string[] {
  const exts = new Set<string>();
  for (const f of _formats) {
    if (kind && !f.documentKinds.includes(kind)) {
      continue;
    }
    for (const e of f.extensions) {
      exts.add(e);
    }
  }
  exts.delete(".json");
  return [...exts];
}

/** The default format for new content documents (first content-kind serializer). */
export function defaultContentFormat(): StudioFormat | undefined {
  return _formats.find((f) => f.capabilities.serialize && f.documentKinds.includes("content"));
}

async function formatAction(payload: Record<string, unknown>): Promise<unknown> {
  const platform = getPlatform() as {
    formatAction?: (payload: Record<string, unknown>) => Promise<unknown>;
  };
  if (!platform.formatAction) {
    throw new Error("Platform does not support format actions");
  }
  return platform.formatAction(payload);
}

/** Parse source text into a Jx document via the named format's parse capability. */
export async function formatParse(
  name: string,
  source: string,
  options?: Record<string, unknown>,
): Promise<JxMutableNode> {
  return (await formatAction({
    action: "parse",
    format: name,
    options,
    source,
  })) as JxMutableNode;
}

/** Serialize a Jx document to source text via the named format's serialize capability. */
export async function formatSerialize(
  name: string,
  doc: Record<string, unknown>,
  options?: Record<string, unknown>,
): Promise<string> {
  return (await formatAction({
    action: "serialize",
    doc,
    format: name,
    options,
  })) as string;
}

/**
 * Split a parsed format document into { document, frontmatter, mode } per the format's
 * `$studio.documentMode` hints. Component documents (e.g. a frontmatter `tagName` with a hyphen)
 * keep their full shape; content documents separate frontmatter metadata from the body children.
 */
export function splitFormatDocument(format: StudioFormat | undefined, doc: JxMutableNode) {
  const hints = format?.studio?.documentMode;
  const componentWhen = hints?.componentWhen;
  if (componentWhen?.frontmatterKey) {
    const value = doc[componentWhen.frontmatterKey];
    const pattern = componentWhen.matches ? new RegExp(componentWhen.matches) : /./;
    if (typeof value === "string" && pattern.test(value)) {
      return {
        document: doc,
        frontmatter: {} as Record<string, unknown>,
        mode: "component",
      };
    }
  }
  if (hints?.default === "component") {
    return {
      document: doc,
      frontmatter: {} as Record<string, unknown>,
      mode: "component",
    };
  }

  // Content document — children form the root-level body; other keys are frontmatter
  const children = (doc.children as unknown[]) ?? [];
  if (children.length === 0) {
    children.push({ children: [], tagName: "p" });
  }

  const documentKeys = new Set(["state", "imports"]);
  const contentDoc: Record<string, unknown> = { children };
  const frontmatter: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(doc)) {
    if (key === "children") {
      continue;
    }
    if (documentKeys.has(key)) {
      contentDoc[key] = value;
    } else {
      frontmatter[key] = value;
    }
  }

  return {
    document: contentDoc as JxMutableNode,
    frontmatter,
    mode: "content",
  };
}
