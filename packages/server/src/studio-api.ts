/**
 * Studio-api.js — Studio filesystem integration
 *
 * REST endpoints under /__studio/* that provide server-backed file operations so the studio can
 * work universally (not just Chrome with File System Access API).
 *
 * All paths are relative to the project root. Directory traversal above root is rejected.
 */

import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { componentMetaFrom } from "@jxsuite/schema/component-meta";
import { errorMessage } from "@jxsuite/schema/parse";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { LOCATION_ID_FILE } from "@jxsuite/protocol/routes";
import {
  buildExtensionsPayload,
  buildProjectExtensionRegistry,
} from "@jxsuite/compiler/format-host";
import { readBundledProjectSchemas } from "@jxsuite/compiler/schema-command";
import { handleDataApi } from "./data-api.ts";
import { containedPath } from "./net-guard.ts";
import { startSitePreview } from "./site-preview.ts";
import { navigateLivePreview, startLivePreview } from "./live-preview.ts";
import { applyRename } from "./refactor/apply.ts";
import { findReferences } from "./refactor/find-refs.ts";
import {
  bunExecutable,
  dependenciesNeedInstall,
  installDependencies,
  packageVersions,
  setPackageVersions,
} from "./packages.ts";
import type { ExtensionRegistry } from "@jxsuite/schema/extension-registry";
import type { FormatRegistry } from "@jxsuite/schema/format-registry";
import type { ClassJsonDef } from "./types.ts";
import type { DesignOptions } from "@jxsuite/create/generate";
import type { ProjectConfig } from "@jxsuite/schema/types";
import { problem } from "./problem.ts";

/** Normalise a path to forward slashes (Windows `path` module returns backslashes). */
const fwd = (p: string) => p.replaceAll("\\", "/");

/**
 * Expand a leading `~` to the user's home directory using path.join so separators are normalised (a
 * plain string replace left the input's forward slashes intact, yielding mixed separators on
 * Windows) and falling back to USERPROFILE where HOME is unset.
 */
const expandTilde = (p: string) =>
  p.startsWith("~") ? join(process.env.HOME || process.env.USERPROFILE || "", p.slice(1)) : p;

interface PackageJson {
  name?: string;
  workspaces?: unknown;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  customElements?: string;
  [key: string]: unknown;
}

/** A custom-element-manifest declaration (subset consumed here). */
interface CemDeclaration {
  customElement?: boolean;
  tagName?: string;
  description?: string;
  cssProperties?: unknown[];
  events?: unknown[];
  slots?: unknown[];
  members?: { kind?: string; privacy?: string; [key: string]: unknown }[];
  attributes?: {
    name?: string;
    default?: unknown;
    description?: string;
    type?: { text?: string };
  }[];
  [key: string]: unknown;
}

interface CemModule {
  path?: string;
  declarations?: CemDeclaration[];
}

interface Cem {
  modules?: CemModule[];
}

/** A parsed Jx component document (subset consumed by component discovery). */
interface ComponentDoc {
  $id?: string;
  tagName?: string;
  $elements?: unknown[];
  state?: Record<string, unknown>;
  [key: string]: unknown;
}

// ─── Extension registry (per project root, invalidated on project.json change) ──

const extensionRegistryCache = new Map<string, { mtime: number; registry: ExtensionRegistry }>();

/**
 * Build (or reuse) a project's extension registry (built from its project.json `extensions` array).
 * An empty registry is returned when there is no project.json — only .json files are handled then.
 *
 * @param {string} projectRoot
 * @returns {Promise<ExtensionRegistry>}
 */
async function getExtensionRegistry(projectRoot: string): Promise<ExtensionRegistry> {
  const projectJsonPath = resolve(projectRoot, "project.json");
  let mtime = 0;
  let projectConfig: ProjectConfig | undefined;
  try {
    mtime = statSync(projectJsonPath).mtimeMs;
    projectConfig = JSON.parse(readFileSync(projectJsonPath, "utf8")) as ProjectConfig;
  } catch {
    projectConfig = undefined;
  }
  const cached = extensionRegistryCache.get(projectRoot);
  if (cached && cached.mtime === mtime) {
    return cached.registry;
  }
  const registry = await buildProjectExtensionRegistry(projectRoot, projectConfig);
  extensionRegistryCache.set(projectRoot, { mtime, registry });
  return registry;
}

/** Format-dispatch view of {@link getExtensionRegistry} (parse/serialize/discover/load lookups). */
async function getFormatRegistry(projectRoot: string): Promise<FormatRegistry> {
  const registry = await getExtensionRegistry(projectRoot);
  return registry.formats;
}

/**
 * Check that a path is under either the server root OR the active project root. This allows file
 * operations on external projects that have been explicitly activated via /__studio/activate.
 *
 * @param {string} filePath
 * @param {string} root
 * @param {string | null} activeProjectRoot
 */
export function assertAccessible(filePath: string, root: string, activeProjectRoot: string | null) {
  // Realpath containment (symlink-safe) against the server root, or an explicitly-activated project.
  if (containedPath(filePath, root) !== null) {
    return;
  }
  if (activeProjectRoot && containedPath(filePath, activeProjectRoot) !== null) {
    return;
  }
  throw new Error("Path outside project root");
}

/**
 * Check that a NEW project may be scaffolded under `parent` (specs/server.md §4.2).
 *
 * Deliberately wider than {@link assertAccessible}: a new project is normally created _outside_ the
 * server root — the whole point of the modal's Location field — so root containment cannot apply.
 * What it still refuses is a destination the user did not name (relative paths) and anything
 * outside the places a person keeps projects: the server root, any configured `allowedRoots`, and
 * the account's home directory. That keeps a hostile page on the loopback origin from scaffolding
 * into system paths while leaving every realistic location reachable.
 *
 * @param {string} parent
 * @param {string} root
 * @param {string[]} allowedRoots
 */
export function assertCreatableParent(parent: string, root: string, allowedRoots: string[] = []) {
  if (!parent || !isAbsolute(parent)) {
    throw new Error("Destination folder must be an absolute path");
  }
  const bases = [root, ...allowedRoots, homedir()].filter(Boolean);
  if (bases.some((base) => containedPath(parent, resolve(base)) !== null)) {
    return;
  }
  throw new Error(
    "Destination folder is outside the permitted roots (the server root, an allowed root, or your home directory)",
  );
}

/**
 * True when `dir` is a Jx project this account already owns: an absolute directory holding a
 * `project.json`, somewhere under the user's home directory (specs/server.md §4.2).
 *
 * Existing projects live outside the server root as a matter of course — the dev server serving
 * this monorepo is not where anyone keeps their sites — so root containment alone would leave
 * `?project=/abs/path`, the Open Project picker, and the recent-projects list unable to activate
 * anything but a project inside the checkout. This admits those without opening the filesystem API
 * to arbitrary directories: a hostile page on the loopback origin still cannot bind the server to
 * `/etc` or another account's files, only to a project the account already has on disk.
 *
 * @param {string} dir
 */
export function isOwnedProjectDir(dir: string): boolean {
  const home = homedir();
  if (!home || !dir || !isAbsolute(dir)) {
    return false;
  }
  if (containedPath(dir, resolve(home)) === null) {
    return false;
  }
  return existsSync(resolve(dir, "project.json"));
}

const statusMap: Record<string, string> = {
  A: "A",
  C: "C",
  D: "D",
  M: "M",
  R: "R",
  T: "T",
  U: "U",
};

/**
 * Parse raw `git status --porcelain=v2 --branch` output into structured data.
 *
 * @param {string} out
 * @returns {{
 *   branch: string;
 *   ahead: number;
 *   behind: number;
 *   files: { path: string; status: string; staged: boolean }[];
 *   isRepo?: boolean;
 *   remotes?: string[];
 * }}
 */
export function parseGitStatus(out: string) {
  let branch = "";
  let ahead = 0;
  let behind = 0;
  /** @type {{ path: string; status: string; staged: boolean }[]} */
  const files = [];

  for (const line of out.split("\n")) {
    if (!line) {
      continue;
    }

    if (line.startsWith("# branch.head ")) {
      branch = line.slice("# branch.head ".length);
    } else if (line.startsWith("# branch.ab ")) {
      const m = line.match(/\+(\d+) -(\d+)/);
      if (m) {
        ahead = Math.trunc(Number(m[1]!));
        behind = Math.trunc(Number(m[2]!));
      }
    } else if (line.startsWith("1 ") || line.startsWith("2 ")) {
      const parts = line.split(" ");
      const xy = parts[1]!;
      const stagedCode = xy[0]!;
      const unstagedCode = xy[1]!;
      let filePath;
      if (line.startsWith("2 ")) {
        const tabIdx = line.indexOf("\t");
        const pathPart = line.slice(tabIdx + 1);
        filePath = pathPart.split("\t").pop() || "";
      } else {
        filePath = parts.slice(8).join(" ");
      }
      if (stagedCode !== ".") {
        files.push({
          path: filePath,
          staged: true,
          status: statusMap[stagedCode] || stagedCode,
        });
      }
      if (unstagedCode !== ".") {
        files.push({
          path: filePath,
          staged: false,
          status: statusMap[unstagedCode] || unstagedCode,
        });
      }
    } else if (line.startsWith("? ")) {
      files.push({ path: line.slice(2), staged: false, status: "U" });
    }
  }

  return { ahead, behind, branch, files };
}

/** Host hooks for the routes that reach outside the server root (project creation). */
export interface StudioApiOptions {
  /** Extra roots a new project may be created under, mirroring `createDevServer.allowedRoots`. */
  allowedRoots?: string[];
  /**
   * Called with the absolute root of a project this API just created, so the host can permit a
   * subsequent `/__studio/activate` on it — a project created outside the server root is otherwise
   * unreachable by the very request that made it.
   */
  onProjectCreated?: (projectRoot: string) => void;
}

/**
 * Handle /__studio/* requests.
 *
 * @param {Request} req
 * @param {URL} url
 * @param {string} root
 * @param {string | null} [activeProjectRoot]
 * @param {StudioApiOptions} [opts]
 * @returns {Promise<Response | null>}
 */
/**
 * The paths git reported as conflicting, from a failed merge or pull's output.
 *
 * Parsed from the porcelain text because there is no machine-readable form of it: `git pull` writes
 * `CONFLICT (content): Merge conflict in <path>` to stdout and exits non-zero, and the alternative
 * — a second `git diff --name-only --diff-filter=U` — would be a separate command whose answer
 * could already have changed. An empty result means the failure was not a conflict, and the caller
 * rethrows rather than mislabelling it.
 *
 * @param {string} output - Combined git output from the failed command
 * @returns {string[]} Conflicting paths, deduplicated, in the order git reported them
 */
function conflictingPaths(output: string): string[] {
  const paths = new Set<string>();
  for (const line of output.split("\n")) {
    const match = /^CONFLICT \([^)]*\): Merge conflict in (.+)$/.exec(line.trim());
    if (match?.[1]) {
      paths.add(match[1].trim());
    }
  }
  return [...paths];
}

export async function handleStudioApi(
  req: Request,
  url: URL,
  root: string,
  activeProjectRoot: string | null = null,
  opts: StudioApiOptions = {},
) {
  const path = url.pathname;

  // Data-domain owner console + secrets (names only) — delegated to data-api.ts.
  const dataRes = await handleDataApi(req, url, root, activeProjectRoot);
  if (dataRes) {
    return dataRes;
  }

  // Project metadata
  if (path === "/__studio/project" && req.method === "GET") {
    try {
      const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8")) as PackageJson;
      return Response.json({
        name: pkg.name ?? basename(root),
        root,
        workspaces: pkg.workspaces ?? [],
      });
    } catch {
      return Response.json({ name: basename(root), root, workspaces: [] });
    }
  }

  // Project info — probe a directory for site-project characteristics
  if (path === "/__studio/project-info" && req.method === "GET") {
    const dir = url.searchParams.get("dir") || activeProjectRoot || root;
    const absDir = isAbsolute(dir) ? dir : resolve(root, dir);
    try {
      assertAccessible(absDir, root, activeProjectRoot);
    } catch (error) {
      return problem("invalidRequest", errorMessage(error));
    }
    try {
      const projectRoot = fwd(absDir);
      const conventionalDirs = [
        "pages",
        "layouts",
        "components",
        "content",
        "data",
        "public",
        "styles",
      ];
      const directories = [];
      for (const d of conventionalDirs) {
        try {
          const s = await stat(resolve(absDir, d));
          if (s.isDirectory()) {
            directories.push(d);
          }
        } catch {}
      }

      let isSiteProject = false;
      let projectConfig: ProjectConfig | null = null;
      try {
        const raw = JSON.parse(await readFile(resolve(absDir, "project.json"), "utf8")) as unknown;
        if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
          isSiteProject = true;
          projectConfig = raw as ProjectConfig;
        }
      } catch {}

      return Response.json({
        directories,
        isSiteProject,
        projectConfig,
        projectRoot,
      });
    } catch (error) {
      return problem("internalError", errorMessage(error));
    }
  }

  // Resolve nearest project.json ancestor for a given file path
  if (path === "/__studio/resolve-site" && req.method === "GET") {
    const filePath = url.searchParams.get("path");
    if (!filePath) {
      return problem("invalidRequest", "Missing path param");
    }
    try {
      // Walk up looking for project.json. Accept a directory (e.g. the project root itself, as
      // Deep links like ?project=/abs/my-site pass) by starting the walk AT the directory and
      // Treating its project.json as the target file, so callers land on the home page.
      let absFile = expandTilde(filePath);
      let dir: string;
      let isDir = false;
      try {
        isDir = statSync(absFile).isDirectory();
      } catch {}
      if (isDir) {
        dir = absFile;
        absFile = resolve(absFile, "project.json");
      } else {
        dir = dirname(absFile);
      }
      while (dir) {
        const candidate = resolve(dir, "project.json");
        if (existsSync(candidate)) {
          const config = JSON.parse(readFileSync(candidate, "utf8")) as ProjectConfig;
          const relPath = fwd(dir);
          const fileRelPath = fwd(relative(dir, absFile));
          return Response.json({
            fileRelPath,
            projectConfig: config,
            relPath,
            sitePath: dir,
          });
        }
        const parent = dirname(dir);
        if (parent === dir) {
          break;
        }
        dir = parent;
      }
      return Response.json({ sitePath: null });
    } catch (error) {
      return problem("internalError", errorMessage(error));
    }
  }

  // Find a project directory by name — searches $HOME for the first matching directory with a
  // Project.json. Dev-mode workaround for when showDirectoryPicker() can't provide absolute paths.
  if (path === "/__studio/find-project" && req.method === "GET") {
    const name = url.searchParams.get("name");
    if (!name) {
      return problem("invalidRequest", "Missing name");
    }
    try {
      const home = process.env.HOME || process.env.USERPROFILE || "";
      if (!home) {
        return Response.json({ path: null });
      }
      const glob = new Bun.Glob(`**/${name}/project.json`);
      try {
        for await (const match of glob.scan({ cwd: home, dot: false })) {
          if (match.includes("node_modules") || match.includes(".Trash")) {
            continue;
          }
          const abs = resolve(home, dirname(match));
          return Response.json({ path: abs });
        }
      } catch {}
      return Response.json({ path: null });
    } catch (error) {
      return problem("internalError", errorMessage(error));
    }
  }

  /*
   * Recover the absolute path of a directory the browser picked with `showDirectoryPicker()`.
   *
   * A `FileSystemDirectoryHandle` exposes only `.name`, never a filesystem path (§8.2), and unlike
   * /__studio/find-project there is no `project.json` to search for — the whole point is that the
   * folder is empty. So the client tags the folder with a hidden LOCATION_ID_FILE holding a random
   * id and asks us which directory carries that id.
   *
   * Identity lives in the file's CONTENTS, not its name: matching the id is exact where matching a
   * path shape is only probable — two folders can share a basename, and a file left behind by a
   * crashed session can still be on disk. A candidate whose contents do not equal `id` is skipped,
   * so a stale tag can never redirect a create. The winning file is deleted here, the moment it has
   * served its purpose, rather than being left for the client to tidy up.
   */
  if (path === "/__studio/locate-directory" && req.method === "GET") {
    const name = url.searchParams.get("name");
    const id = url.searchParams.get("id");
    // `name` is interpolated into a glob; the id is only ever compared, never used as a pattern.
    if (!name || !id || !/^[a-f0-9]{32}$/.test(id) || !/^[^/\\]+$/.test(name)) {
      return problem("invalidRequest", "Missing or invalid name/id");
    }
    try {
      const home = process.env.HOME || process.env.USERPROFILE || "";
      if (!home) {
        return Response.json({ path: null });
      }
      /** The tagged directory when this candidate holds our id, else null. */
      const claim = (dir: string): string | null => {
        const file = resolve(dir, LOCATION_ID_FILE);
        try {
          if (readFileSync(file, "utf8").trim() !== id) {
            return null;
          }
        } catch {
          return null;
        }
        try {
          unlinkSync(file);
        } catch {
          // Read-only or already gone; the client's own cleanup is the backstop.
        }
        return dir;
      };

      // The home directory itself is a legitimate pick, and no `**/<name>/` glob can match it.
      const atHome = claim(home);
      if (atHome) {
        return Response.json({ path: atHome });
      }
      // `dot: true` — the tag is a dotfile, so a dot-blind scan would never see it.
      const glob = new Bun.Glob(`**/${name}/${LOCATION_ID_FILE}`);
      try {
        for await (const match of glob.scan({ cwd: home, dot: true })) {
          if (match.includes("node_modules") || match.includes(".Trash")) {
            continue;
          }
          const claimed = claim(resolve(home, dirname(match)));
          if (claimed) {
            return Response.json({ path: claimed });
          }
        }
      } catch {}
      return Response.json({ path: null });
    } catch (error) {
      return problem("internalError", errorMessage(error));
    }
  }

  // Discover site projects — find all project.json files under root
  if (path === "/__studio/sites" && req.method === "GET") {
    try {
      const glob = new Bun.Glob("**/project.json");
      const sites = [];
      for await (const match of glob.scan({ cwd: root, dot: false })) {
        if (
          match.includes("node_modules") ||
          fwd(match).includes("dist/") ||
          fwd(match).includes(".claude/")
        ) {
          continue;
        }
        const fp = resolve(root, match);
        try {
          const raw = JSON.parse(await readFile(fp, "utf8")) as unknown;
          if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
            const projectDir = fwd(dirname(fp));
            sites.push({ config: raw as ProjectConfig, path: projectDir });
          }
        } catch {}
      }
      return Response.json(sites);
    } catch (error) {
      return problem("internalError", errorMessage(error));
    }
  }

  // Create a new project
  if (path === "/__studio/create-project" && req.method === "POST") {
    try {
      const body = (await req.json()) as {
        name?: string;
        description?: string;
        url?: string;
        adapter?: "static" | "cloudflare-pages" | "cloudflare-workers" | "node" | "bun";
        directory?: string;
        destination?: { kind?: string; parent?: string };
        starter?: string;
        template?: string;
        design?: DesignOptions;
      };
      const {
        name,
        description,
        url: siteUrl,
        adapter,
        directory,
        destination,
        starter,
        template,
        design,
      } = body;
      if (!name || !directory) {
        return problem("invalidRequest", "name and directory are required");
      }
      // The destination is the user's to choose (specs/server.md §4.2). Without one the project
      // Would silently land under the server root — which, when the dev server is the jx checkout,
      // Means scaffolding into the monorepo. Refuse instead of guessing.
      if (destination?.kind !== "path" || !destination.parent) {
        return problem("invalidRequest", "A destination folder is required.");
      }
      // `directory` names the project FOLDER, not a path: a separator or dot-segment would walk out
      // Of the parent that was just vetted below, which is exactly what the vetting is for.
      if (/[/\\]/.test(directory) || directory === "." || directory === "..") {
        return problem("invalidRequest", "Directory must be a folder name, not a path");
      }
      const { isTemplateId } = await import("@jxsuite/create/templates");
      if (template !== undefined && !isTemplateId(template)) {
        return problem("invalidRequest", `Unknown template: "${template}"`);
      }
      // A bad destination is client input, so answer 400 rather than letting the guard's throw fall
      // Through to the catch-all 500 below.
      try {
        assertCreatableParent(destination.parent, root, opts.allowedRoots);
      } catch (error) {
        return problem("invalidRequest", errorMessage(error));
      }
      const destPath = resolve(destination.parent, directory);

      const { generateProject } = await import("@jxsuite/create/generate");
      await generateProject(destPath, {
        name,
        ...(adapter !== undefined ? { adapter } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(siteUrl !== undefined ? { url: siteUrl } : {}),
        ...(starter !== undefined ? { starter } : {}),
        ...(template !== undefined && isTemplateId(template) ? { template } : {}),
        ...(design !== undefined ? { design } : {}),
      });

      const config = JSON.parse(
        await readFile(resolve(destPath, "project.json"), "utf8"),
      ) as ProjectConfig;
      // Root-relative while the project happens to sit under the server root (the historical
      // Shape every caller already handles); absolute otherwise, which is the same shape
      // /__studio/find-project returns for an external project.
      const inRoot = containedPath(destPath, root) !== null;
      opts.onProjectCreated?.(destPath);
      return Response.json({ config, root: inRoot ? fwd(relative(root, destPath)) : destPath });
    } catch (error) {
      return problem("internalError", errorMessage(error));
    }
  }

  // List available starter templates (for the New Project picker)
  if (path === "/__studio/starters" && req.method === "GET") {
    try {
      const { listStarters } = await import("@jxsuite/starters");
      return Response.json(listStarters());
    } catch (error) {
      return problem("internalError", errorMessage(error));
    }
  }

  // List files
  if (path === "/__studio/files" && req.method === "GET") {
    const dir = url.searchParams.get("dir") || activeProjectRoot || root;
    const pattern = url.searchParams.get("glob");
    const absDir = isAbsolute(dir) ? dir : resolve(root, dir);
    try {
      assertAccessible(absDir, root, activeProjectRoot);
    } catch (error) {
      return problem("invalidRequest", errorMessage(error));
    }

    /** Report a path relative to the active project root (or server root as fallback). */
    const reportRelative = (fp: string) => {
      if (activeProjectRoot) {
        const rel = relative(activeProjectRoot, fp);
        if (!rel.startsWith("..")) {
          return fwd(rel);
        }
      }
      return fwd(relative(root, fp));
    };

    try {
      if (pattern) {
        const glob = new Bun.Glob(pattern);
        const files = [];
        for await (const match of glob.scan({ cwd: absDir, dot: false })) {
          const fp = resolve(absDir, match);
          try {
            const s = await stat(fp);
            if (!s.isDirectory()) {
              files.push({
                modified: s.mtime.toISOString(),
                name: basename(match),
                path: reportRelative(fp),
                size: s.size,
              });
            }
          } catch {}
        }
        return Response.json(files);
      }

      const entries = await readdir(absDir, { withFileTypes: true });
      const files = [];
      for (const entry of entries) {
        if (entry.name.startsWith(".")) {
          continue;
        }
        const fp = resolve(absDir, entry.name);
        const s = await stat(fp);
        files.push({
          modified: s.mtime.toISOString(),
          name: entry.name,
          path: reportRelative(fp),
          size: s.size,
          type: entry.isDirectory() ? "directory" : "file",
        });
      }
      return Response.json(files);
    } catch (error) {
      return problem("internalError", errorMessage(error));
    }
  }

  // Component discovery — scan project for custom element definitions
  if (path === "/__studio/components" && req.method === "GET") {
    const dir = url.searchParams.get("dir") || activeProjectRoot || root;
    const scanRoot = isAbsolute(dir) ? dir : resolve(root, dir);
    try {
      assertAccessible(scanRoot, root, activeProjectRoot);
    } catch (error) {
      return problem("invalidRequest", errorMessage(error));
    }
    try {
      const registry = await getFormatRegistry(scanRoot);
      const componentExts = registry.documentExtensions("component").map((e: string) => e.slice(1));
      const glob = new Bun.Glob(`**/*.{${["json", ...componentExts].join(",")}}`);
      const components = [];
      for await (const match of glob.scan({ cwd: scanRoot, dot: false })) {
        if (
          match.includes("node_modules") ||
          fwd(match).includes("dist/") ||
          fwd(match).includes(".claude/")
        ) {
          continue;
        }
        const fp = resolve(scanRoot, match);
        try {
          let content: ComponentDoc;
          if (match.endsWith(".json")) {
            content = JSON.parse(await readFile(fp, "utf8")) as ComponentDoc;
          } else {
            const entry = registry.byExtension(extname(match), "parse");
            if (!entry) {
              continue;
            }
            const source = await readFile(fp, "utf8");
            content = (await entry.call("parse", source)) as ComponentDoc;
          }
          /* The metadata rules live in @jxsuite/schema/component-meta because THREE backends need
             the same answer — this one, the desktop session, and now the cloud adapter, which can
             discover JSON components precisely because deriving them executes nothing. Two copies
             had already drifted apart in wording; a third would have made "which state entries are
             props" a question with three answers. */
          const meta = componentMetaFrom(content, fwd(match));
          if (meta) {
            components.push({ ...meta, source: "jx" });
          }
        } catch {} // Skip non-JSON or parse errors
      }

      // Discover CEM-bearing npm packages
      try {
        const projectPkgPath = resolve(scanRoot, "package.json");
        if (existsSync(projectPkgPath)) {
          const pkg = JSON.parse(await readFile(projectPkgPath, "utf8")) as PackageJson;
          const deps = { ...pkg.dependencies, ...pkg.devDependencies };
          for (const name of Object.keys(deps)) {
            try {
              const depPkgPath = resolve(
                scanRoot,
                "node_modules",
                ...name.split("/"),
                "package.json",
              );
              // Fall back to root node_modules for hoisted packages
              const fallbackPath = resolve(
                root,
                "node_modules",
                ...name.split("/"),
                "package.json",
              );
              const actualPath = existsSync(depPkgPath)
                ? depPkgPath
                : existsSync(fallbackPath)
                  ? fallbackPath
                  : null;
              if (!actualPath) {
                continue;
              }
              const depPkg = JSON.parse(await readFile(actualPath, "utf8")) as PackageJson;
              if (!depPkg.customElements) {
                continue;
              }
              const cemPath = resolve(dirname(actualPath), depPkg.customElements);
              if (!existsSync(cemPath)) {
                continue;
              }
              const cem = JSON.parse(await readFile(cemPath, "utf8")) as Cem;
              for (const mod of cem.modules || []) {
                for (const decl of mod.declarations || []) {
                  if (decl.customElement && decl.tagName) {
                    components.push({
                      $id: null,
                      cssProperties: decl.cssProperties || [],
                      description: decl.description || null,
                      events: decl.events || [],
                      hasElements: false,
                      members: (decl.members || []).filter(
                        (m) => m.kind === "field" && m.privacy !== "private",
                      ),
                      modulePath: mod.path,
                      package: name,
                      path: null,
                      props: (decl.attributes || []).map((a) => ({
                        default: a.default,
                        description: a.description || null,
                        name: a.name,
                        type: a.type?.text,
                      })),
                      slots: decl.slots || [],
                      source: "npm",
                      tagName: decl.tagName,
                    });
                  }
                }
              }
            } catch {} // Skip packages without valid CEM
          }
        }
      } catch {} // Skip if no project package.json

      return Response.json(components);
    } catch (error) {
      return problem("internalError", errorMessage(error));
    }
  }

  // ─── Site build ──────────────────────────────────────────────────────────────

  /**
   * Build the site, so `View: Open in Browser` opens what the author is looking at.
   *
   * The compiler is imported dynamically for the same reason `dev.ts` does it: the server depends
   * on the compiler for this one call, and a static import would pull the whole build pipeline into
   * every server process that never builds anything.
   *
   * Build errors come back in the payload rather than as a 500. A partial build still produced
   * pages, and the author is better served by opening the page they asked for with the failures
   * named beside it than by a preview that refuses and says only "500".
   *
   * The reply carries the ORIGIN to open the result at, not just the counts, because the built site
   * is served on its own port ({@link file://./site-preview.ts}) rather than on this one — the
   * caller has no way to know that port and no business guessing it.
   */
  if (path === "/__studio/build" && req.method === "POST") {
    const dir = activeProjectRoot ?? root;
    if (!existsSync(resolve(dir, "project.json"))) {
      return problem("invalidRequest", "Not a site project");
    }
    try {
      const { buildSite } = await import("@jxsuite/compiler/site");
      // `clean: false` — this runs on the way to opening a page, and wiping the output directory
      // First would mean every asset 404s for as long as the build takes.
      const result = await buildSite(dir, { clean: false, verbose: false });
      const preview = startSitePreview(dir);
      return Response.json({
        errors: result.errors,
        files: result.files,
        routes: result.routes,
        ...(preview ? { url: preview.origin } : {}),
      });
    } catch (error) {
      return problem("internalError", errorMessage(error));
    }
  }

  /**
   * Preview the site LIVE — the working tree browsable at real routes, with no build on the path.
   *
   * The sibling of `/__studio/build` and the one Open in Browser reaches first. What it answers
   * with is not compiler output: `@jxsuite/site` composes each page on demand and
   * `@jxsuite/runtime` assembles it in the reader's browser, so what opens is the tree as it stands
   * — the author's unsaved edits included, because Studio publishes those as an overlay this origin
   * reads first.
   *
   * `reused` is the second answer and the caller must honour it. A tab already holding this
   * project's reload stream is retargeted in place, and opening another would give the author two
   * tabs on one project — which is the thing the retarget exists to prevent.
   */
  if (path === "/__studio/preview" && req.method === "POST") {
    const dir = activeProjectRoot ?? root;
    if (!existsSync(resolve(dir, "project.json"))) {
      return problem("invalidRequest", "Not a site project");
    }
    let body: { route?: string };
    try {
      body = (await req.json()) as { route?: string };
    } catch {
      return problem("invalidRequest", "Invalid JSON body");
    }
    try {
      const preview = await startLivePreview(dir);
      const reused = body.route ? await navigateLivePreview(dir, body.route) : false;
      return Response.json({
        errors: preview.errors,
        /* A live preview writes nothing, so there are no files to count. The field is part of the
           shared shape and saying zero is the honest answer rather than an omission. */
        files: 0,
        mode: "live",
        reused,
        routes: preview.routes,
        url: preview.origin,
      });
    } catch (error) {
      return problem("internalError", errorMessage(error));
    }
  }

  // ─── Package management ──────────────────────────────────────────────────────

  // List CEM-bearing npm packages
  if (path === "/__studio/packages" && req.method === "GET") {
    const dir = url.searchParams.get("dir") || activeProjectRoot || root;
    const scanRoot = isAbsolute(dir) ? dir : resolve(root, dir);
    try {
      const pkgPath = resolve(scanRoot, "package.json");
      if (!existsSync(pkgPath)) {
        return Response.json([]);
      }
      const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as PackageJson;
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      const packages: {
        name: string;
        version: string;
        dev: boolean;
        hasCem: boolean;
        customElementsPath: string | null;
      }[] = [];
      for (const [name, version] of Object.entries(deps)) {
        const depPkgPath = resolve(scanRoot, "node_modules", ...name.split("/"), "package.json");
        const fallbackPath = resolve(root, "node_modules", ...name.split("/"), "package.json");
        const actualPath = existsSync(depPkgPath)
          ? depPkgPath
          : existsSync(fallbackPath)
            ? fallbackPath
            : null;
        if (!actualPath) {
          continue;
        }
        try {
          const depPkg = JSON.parse(await readFile(actualPath, "utf8")) as PackageJson;
          packages.push({
            customElementsPath: depPkg.customElements || null,
            dev: pkg.dependencies?.[name] === undefined,
            hasCem: Boolean(depPkg.customElements),
            name,
            version,
          });
        } catch {}
      }
      return Response.json(packages);
    } catch (error) {
      return problem("internalError", errorMessage(error));
    }
  }

  // Read CEM from a specific package
  if (path === "/__studio/cem" && req.method === "GET") {
    const pkg = url.searchParams.get("pkg");
    if (!pkg) {
      return problem("invalidRequest", "Missing pkg");
    }
    const dir = url.searchParams.get("dir") || activeProjectRoot || root;
    const scanRoot = isAbsolute(dir) ? dir : resolve(root, dir);
    try {
      const depPkgPath = resolve(scanRoot, "node_modules", ...pkg.split("/"), "package.json");
      const fallbackPath = resolve(root, "node_modules", ...pkg.split("/"), "package.json");
      const actualPath = existsSync(depPkgPath)
        ? depPkgPath
        : existsSync(fallbackPath)
          ? fallbackPath
          : null;
      if (!actualPath) {
        return Response.json({ cem: null });
      }
      const depPkg = JSON.parse(await readFile(actualPath, "utf8")) as PackageJson;
      if (!depPkg.customElements) {
        return Response.json({ cem: null });
      }
      const cemPath = resolve(dirname(actualPath), depPkg.customElements);
      if (!existsSync(cemPath)) {
        return Response.json({ cem: null });
      }
      const cem = JSON.parse(await readFile(cemPath, "utf8")) as Cem;
      return Response.json({ cem });
    } catch (error) {
      return problem("internalError", errorMessage(error));
    }
  }

  // Add an npm package
  if (path === "/__studio/packages/add" && req.method === "POST") {
    try {
      const body = (await req.json()) as { name?: string; dir?: string; dev?: boolean };
      const { name } = body;
      if (!name || typeof name !== "string") {
        return problem("invalidRequest", "Missing name");
      }
      const dir = body.dir || activeProjectRoot;
      const cwd = dir ? (isAbsolute(dir) ? dir : resolve(root, dir)) : root;
      const args = ["add", name];
      if (body.dev) {
        args.splice(1, 0, "-d");
      }
      const proc = Bun.spawn([bunExecutable(), ...args], {
        cwd,
        stderr: "pipe",
        stdout: "pipe",
      });
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        return problem("internalError", stderr || `bun add exited with ${exitCode}`);
      }
      return Response.json({ ok: true });
    } catch (error) {
      return problem("internalError", errorMessage(error));
    }
  }

  // Remove an npm package
  if (path === "/__studio/packages/remove" && req.method === "POST") {
    try {
      const body = (await req.json()) as { name?: string; dir?: string };
      const { name } = body;
      if (!name || typeof name !== "string") {
        return problem("invalidRequest", "Missing name");
      }
      const dir = body.dir || activeProjectRoot;
      const cwd = dir ? (isAbsolute(dir) ? dir : resolve(root, dir)) : root;
      const proc = Bun.spawn([bunExecutable(), "remove", name], {
        cwd,
        stderr: "pipe",
        stdout: "pipe",
      });
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        return problem("internalError", stderr || `bun remove exited with ${exitCode}`);
      }
      return Response.json({ ok: true });
    } catch (error) {
      return problem("internalError", errorMessage(error));
    }
  }

  // Install all dependencies (bun install)
  if (path === "/__studio/packages/install" && req.method === "POST") {
    try {
      const body = (await req.json().catch(() => ({}))) as { dir?: string };
      const dir = body.dir || activeProjectRoot || root;
      const scanRoot = isAbsolute(dir) ? dir : resolve(root, dir);
      return Response.json(await installDependencies(scanRoot));
    } catch (error) {
      return problem("internalError", errorMessage(error));
    }
  }

  // Whether dependencies need installing (node_modules missing)
  if (path === "/__studio/packages/needs-install" && req.method === "GET") {
    const dir = url.searchParams.get("dir") || activeProjectRoot || root;
    const scanRoot = isAbsolute(dir) ? dir : resolve(root, dir);
    return Response.json({ needsInstall: dependenciesNeedInstall(scanRoot) });
  }

  // The newest published version of each dependency (whether or not it is behind)
  if (path === "/__studio/packages/versions" && req.method === "GET") {
    try {
      const dir = url.searchParams.get("dir") || activeProjectRoot || root;
      const scanRoot = isAbsolute(dir) ? dir : resolve(root, dir);
      return Response.json(await packageVersions(scanRoot));
    } catch (error) {
      return problem("internalError", errorMessage(error));
    }
  }

  // Set version ranges for one or more packages, then reinstall
  if (path === "/__studio/packages/set-versions" && req.method === "POST") {
    try {
      const body = (await req.json()) as {
        dir?: string;
        updates?: { name: string; version: string; dev?: boolean }[];
      };
      if (!Array.isArray(body.updates)) {
        return problem("invalidRequest", "Missing updates");
      }
      const dir = body.dir || activeProjectRoot || root;
      const scanRoot = isAbsolute(dir) ? dir : resolve(root, dir);
      return Response.json(await setPackageVersions(scanRoot, body.updates));
    } catch (error) {
      return problem("internalError", errorMessage(error));
    }
  }

  // Read file
  if (path === "/__studio/file" && req.method === "GET") {
    const fp = url.searchParams.get("path");
    if (!fp) {
      return problem("invalidRequest", "Missing path");
    }
    const abs = expandTilde(fp);
    try {
      assertAccessible(abs, root, activeProjectRoot);
    } catch (error) {
      return new Response(errorMessage(error), { status: 400 });
    }
    try {
      return Response.json(
        {
          content: await readFile(abs, "utf8"),
          path: fp,
        },
        { headers: { "Cache-Control": "public, max-age=5" } },
      );
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT"
        ? problem("notFound", "Not found")
        : problem("internalError", errorMessage(error));
    }
  }

  // Write file
  if (path === "/__studio/file" && req.method === "PUT") {
    const fp = url.searchParams.get("path");
    if (!fp) {
      return problem("invalidRequest", "Missing path");
    }
    const abs = resolve(root, fp);
    try {
      assertAccessible(abs, root, activeProjectRoot);
    } catch (error) {
      return new Response(errorMessage(error), { status: 400 });
    }
    try {
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, await req.text(), "utf8");
      return Response.json({ ok: true, path: fwd(relative(root, abs)) });
    } catch (error) {
      return problem("internalError", errorMessage(error));
    }
  }

  // Upload binary file
  if (path === "/__studio/file/upload" && req.method === "POST") {
    const fp = url.searchParams.get("path");
    if (!fp) {
      return problem("invalidRequest", "Missing path");
    }
    const abs = resolve(root, fp);
    try {
      assertAccessible(abs, root, activeProjectRoot);
    } catch (error) {
      return new Response(errorMessage(error), { status: 400 });
    }
    try {
      await mkdir(dirname(abs), { recursive: true });
      const buffer = await req.arrayBuffer();
      await Bun.write(abs, new Uint8Array(buffer));
      return Response.json({ ok: true, path: fwd(relative(root, abs)) });
    } catch (error) {
      return problem("internalError", errorMessage(error));
    }
  }

  // Delete file
  if (path === "/__studio/file" && req.method === "DELETE") {
    const fp = url.searchParams.get("path");
    if (!fp) {
      return problem("invalidRequest", "Missing path");
    }
    const abs = resolve(root, fp);
    try {
      assertAccessible(abs, root, activeProjectRoot);
    } catch (error) {
      return new Response(errorMessage(error), { status: 400 });
    }
    try {
      await unlink(abs);
      return Response.json({ ok: true, path: fwd(relative(root, abs)) });
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT"
        ? problem("notFound", "Not found")
        : problem("internalError", errorMessage(error));
    }
  }

  // Rename file
  if (path === "/__studio/file/rename" && req.method === "POST") {
    let body: { from?: string; to?: string };
    try {
      body = (await req.json()) as { from?: string; to?: string };
    } catch {
      return problem("invalidRequest", "Invalid JSON");
    }
    const { from, to } = body;
    if (!from || !to) {
      return problem("invalidRequest", "Missing from or to");
    }
    const absFrom = resolve(root, from);
    const absTo = resolve(root, to);
    try {
      assertAccessible(absFrom, root, activeProjectRoot);
      assertAccessible(absTo, root, activeProjectRoot);
    } catch (error) {
      return new Response(errorMessage(error), { status: 400 });
    }
    try {
      await mkdir(dirname(absTo), { recursive: true });
      await rename(absFrom, absTo);
    } catch (error) {
      return problem("internalError", errorMessage(error));
    }
    // Refactor pass: rewrite path references project-wide and, for a component, auto-rename its tag.
    // The move already succeeded, so a refactor failure is reported but never fails the rename.
    const scanRoot = activeProjectRoot ?? root;
    try {
      const registry = await getFormatRegistry(scanRoot);
      const report = await applyRename({ absFrom, absTo, registry, root: scanRoot });
      return Response.json(report);
    } catch (error) {
      return Response.json({
        error: errorMessage(error),
        from: fwd(relative(root, absFrom)),
        ok: true,
        to: fwd(relative(root, absTo)),
      });
    }
  }

  // Where a file / component tag is used (the read side of the rename refactor's walker)
  if (path === "/__studio/references" && req.method === "GET") {
    const target = url.searchParams.get("path");
    const tag = url.searchParams.get("tag");
    if (!target && !tag) {
      return problem("invalidRequest", "Missing path or tag");
    }
    const scanRoot = activeProjectRoot ?? root;
    if (target) {
      try {
        assertAccessible(resolve(scanRoot, target), root, activeProjectRoot);
      } catch (error) {
        return new Response(errorMessage(error), { status: 400 });
      }
    }
    try {
      const registry = await getFormatRegistry(scanRoot);
      return Response.json(
        await findReferences({ path: target, registry, root: scanRoot, tagName: tag }),
      );
    } catch (error) {
      return problem("internalError", errorMessage(error));
    }
  }

  // Locate a file by name within the project root
  if (path === "/__studio/locate" && req.method === "POST") {
    let body: { name?: string };
    try {
      body = (await req.json()) as { name?: string };
    } catch {
      return problem("invalidRequest", "Invalid JSON");
    }
    const { name } = body;
    if (!name) {
      return problem("invalidRequest", "Missing name");
    }

    try {
      const glob = new Bun.Glob(`**/${name}`);
      const matches = [];
      for await (const match of glob.scan({ cwd: root, dot: false })) {
        // Skip node_modules / dist / hidden dirs
        if (match.includes("node_modules") || fwd(match).includes("dist/")) {
          continue;
        }
        matches.push(fwd(match));
      }
      if (matches.length === 0) {
        return Response.json({ path: null });
      }
      return Response.json({
        path: matches[0],
        ...(matches.length > 1 ? { alternatives: matches } : {}),
      });
    } catch (error) {
      return problem("internalError", errorMessage(error));
    }
  }

  // Discover a plugin module's schema for studio form rendering
  /* Cloudflare API passthrough — the backend of the publish surface's `cfApi`.
     Stateless: the credential arrives per-request in X-CF-Token (the user's
     pasted API token, kept client-side) and is never stored. Only account
     listing and Pages project/deployment paths are reachable. */
  if (path === "/__studio/cf/proxy" && req.method === "POST") {
    const CF_PROXY_ALLOWLIST = [
      /^\/accounts$/,
      /^\/accounts\/[0-9a-f]{32}\/pages\/projects(?:\/[\w-]+)?$/,
      /^\/accounts\/[0-9a-f]{32}\/pages\/projects\/[\w-]+\/deployments(?:\/[\w-]+)?$/,
      /^\/accounts\/[0-9a-f]{32}\/pages\/projects\/[\w-]+\/deployments\/[\w-]+\/retry$/,
    ];
    const cfToken = req.headers.get("X-CF-Token");
    if (!cfToken) {
      return problem("unauthorized", "Missing X-CF-Token header");
    }
    let payload: { path?: string; method?: string; body?: unknown };
    try {
      payload = (await req.json()) as typeof payload;
    } catch {
      return problem("invalidRequest", "Invalid JSON body");
    }
    const apiPath = payload.path ?? "";
    if (!CF_PROXY_ALLOWLIST.some((re) => re.test(apiPath))) {
      return problem("forbidden", `Path not allowed: ${apiPath}`);
    }
    const method = payload.method ?? "GET";
    const upstream = await fetch(`https://api.cloudflare.com/client/v4${apiPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${cfToken}`,
        ...(payload.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(payload.body === undefined ? {} : { body: JSON.stringify(payload.body) }),
    });
    return new Response(upstream.body, {
      headers: { "Content-Type": upstream.headers.get("Content-Type") ?? "application/json" },
      status: upstream.status,
    });
  }

  // Format capability proxy — studio fallback for capabilities whose timing excludes "client".
  // Dispatches parse/serialize through the project's format registry by import name.
  if (path === "/__studio/format" && req.method === "POST") {
    try {
      const body = (await req.json()) as {
        format?: string;
        action?: string;
        source?: string;
        doc?: Record<string, unknown>;
        options?: Record<string, unknown>;
        dir?: string;
      };
      const { format, action, source, doc, options } = body;
      const dir = body.dir || activeProjectRoot || root;
      const projectRoot = isAbsolute(dir) ? dir : resolve(root, dir);
      assertAccessible(projectRoot, root, activeProjectRoot);

      if (!format || !action) {
        return problem("invalidRequest", "Missing format or action");
      }
      if (action !== "parse" && action !== "serialize") {
        return problem("invalidRequest", `Unsupported action "${action}"`);
      }
      const registry = await getFormatRegistry(projectRoot);
      const entry = registry.byName(format);
      if (!entry) {
        return problem("notFound", `Format "${format}" is not an imported format class`);
      }
      const result =
        action === "parse"
          ? await entry.call("parse", source ?? "", options)
          : await entry.call("serialize", doc ?? {}, options);
      return Response.json({ result });
    } catch (error) {
      return problem("internalError", errorMessage(error));
    }
  }

  // Format registry listing — lets the studio introspect available formats without
  // Fetching each .class.json itself. The sibling `extensions` array carries each enabled
  // Extension's manifest identity and project-section contributions (additive; the `formats`
  // Shape is unchanged for compat).
  if (path === "/__studio/formats" && req.method === "GET") {
    const dir = url.searchParams.get("dir") || activeProjectRoot || root;
    const projectRoot = isAbsolute(dir) ? dir : resolve(root, dir);
    try {
      assertAccessible(projectRoot, root, activeProjectRoot);
      const registry = await getExtensionRegistry(projectRoot);
      return Response.json({
        extensions: buildExtensionsPayload(registry),
        formats: registry.formats.entries.map((e) => ({
          capabilities: e.capabilities,
          documentKinds: e.documentKinds,
          exportTarget: e.exportTarget,
          extensions: e.extensions,
          mediaType: e.mediaType,
          name: e.name,
          remote: e.remote,
          studio: e.studio,
        })),
      });
    } catch (error) {
      return problem("invalidRequest", errorMessage(error));
    }
  }

  // Pre-bundled per-project entry schemas (project.schema.json / document.schema.json) for the
  // Studio's editor — regenerated on demand when missing or older than project.json, then bundled
  // Into self-contained compound documents so no relative $ref resolution is needed client-side.
  if (path === "/__studio/project-schemas" && req.method === "GET") {
    const dir = url.searchParams.get("dir") || activeProjectRoot || root;
    const projectRoot = isAbsolute(dir) ? dir : resolve(root, dir);
    try {
      assertAccessible(projectRoot, root, activeProjectRoot);
    } catch (error) {
      return problem("invalidRequest", errorMessage(error));
    }
    try {
      const { document, project } = await readBundledProjectSchemas(projectRoot);
      return Response.json({ document, project });
    } catch (error) {
      return problem("internalError", errorMessage(error));
    }
  }

  if (path === "/__studio/plugin-schema" && req.method === "GET") {
    const src = url.searchParams.get("src");
    const prototype = url.searchParams.get("prototype");
    const base = url.searchParams.get("base");
    if (!src) {
      return problem("invalidRequest", "Missing src param");
    }

    let moduleAbsPath;
    try {
      if (src.startsWith("./") || src.startsWith("../")) {
        // Relative path
        if (base) {
          const docUrlPath = new URL(base).pathname;
          const docDir = docUrlPath.slice(0, docUrlPath.lastIndexOf("/") + 1);
          moduleAbsPath = resolve(resolve(root, `.${docDir}`), src);
        } else {
          moduleAbsPath = resolve(activeProjectRoot || root, src);
          if (!existsSync(moduleAbsPath) && activeProjectRoot) {
            moduleAbsPath = resolve(root, src);
          }
        }
      } else {
        // Npm/bare specifier — use createRequire from project root, fall back to server package
        const projectRoot = activeProjectRoot || root;
        const { createRequire } = await import("node:module");
        const projRequire = createRequire(resolve(projectRoot, "package.json"));
        try {
          moduleAbsPath = projRequire.resolve(src);
        } catch {
          const serverRequire = createRequire(import.meta.url);
          moduleAbsPath = serverRequire.resolve(src);
        }
      }
    } catch (error) {
      return Response.json({
        error: errorMessage(error),
        schema: null,
      });
    }

    // .class.json: read and extract schema directly
    if (moduleAbsPath.endsWith(".class.json")) {
      try {
        const content = readFileSync(moduleAbsPath, "utf8");
        const classDef = JSON.parse(content) as ClassJsonDef;
        return Response.json({
          schema: extractStudioSchema(classDef, moduleAbsPath),
        });
      } catch (error) {
        return Response.json({
          error: errorMessage(error),
          schema: null,
        });
      }
    }

    // Sibling .class.json auto-discovery: check for <ClassName>.class.json next to the .js module
    const exportName = prototype || src;
    const classJsonPath = resolve(dirname(moduleAbsPath), `${exportName}.class.json`);
    if (existsSync(classJsonPath)) {
      try {
        const content = readFileSync(classJsonPath, "utf8");
        const classDef = JSON.parse(content) as ClassJsonDef;
        return Response.json({
          schema: extractStudioSchema(classDef, classJsonPath),
        });
      } catch {
        // Fall through to JS module import
      }
    }

    // Fallback: import JS module (backwards compat for classes without .class.json)
    try {
      const mod = (await import(moduleAbsPath)) as {
        default?: Record<string, unknown>;
        [key: string]: unknown;
      };
      const ExportedClass = mod[exportName] ?? mod.default?.[exportName];
      if (typeof ExportedClass !== "function") {
        return Response.json({
          error: `Export "${exportName}" not found`,
          schema: null,
        });
      }
      return Response.json({ schema: (ExportedClass as { schema?: unknown }).schema ?? null });
    } catch (error) {
      return Response.json({
        error: errorMessage(error),
        schema: null,
      });
    }
  }

  // ── Git endpoints ──────────────────────────────────────────────────────────

  if (path.startsWith("/__studio/git/")) {
    const cwd = activeProjectRoot || root;
    const gitCmd = path.slice("/__studio/git/".length);

    const runGit = async (args: string[]) => {
      const proc = Bun.spawn(["git", ...args], {
        cwd,
        stderr: "pipe",
        stdout: "pipe",
      });
      const exitCode = await proc.exited;
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      if (exitCode !== 0) {
        /*
         * Both streams, because git splits its failures across them and stderr alone loses the
         * ones that matter most. A conflicting `git pull` writes every `CONFLICT (…)` line to
         * STDOUT and leaves stderr empty — so the old `stderr || "git exited with 1"` turned the
         * one failure this API publishes a shape for into a contentless message, and the 409 the
         * route table promises could never be produced.
         */
        throw Object.assign(new Error(stderr || stdout || `git exited with ${exitCode}`), {
          stderr,
          stdout,
        });
      }
      return stdout;
    };

    try {
      if (gitCmd === "status" && req.method === "GET") {
        // Check if we're in a git repo first
        const checkProc = Bun.spawn(["git", "rev-parse", "--is-inside-work-tree"], {
          cwd,
          stderr: "pipe",
          stdout: "pipe",
        });
        const checkExit = await checkProc.exited;
        if (checkExit !== 0) {
          return Response.json({
            ahead: 0,
            behind: 0,
            branch: "",
            files: [],
            isRepo: false,
            remotes: [],
          });
        }

        const [out, remotesOut] = await Promise.all([
          runGit(["status", "--porcelain=v2", "--branch"]),
          runGit(["remote"]),
        ]);
        const status = parseGitStatus(out);
        const fullStatus = {
          ...status,
          isRepo: true,
          remotes: remotesOut.trim().split("\n").filter(Boolean),
        };
        return Response.json(fullStatus);
      }

      if (gitCmd === "init" && req.method === "POST") {
        await runGit(["init"]);
        return Response.json({ ok: true });
      }

      if (gitCmd === "add-remote" && req.method === "POST") {
        const { name, url: remoteUrl } = (await req.json()) as {
          name?: string;
          url?: string;
        };
        if (!name || !remoteUrl) {
          return problem("invalidRequest", "name and url required");
        }
        await runGit(["remote", "add", name, remoteUrl]);
        return Response.json({ ok: true });
      }

      if (gitCmd === "branches" && req.method === "GET") {
        const out = await runGit(["branch", "--format=%(refname:short)\t%(HEAD)"]);
        let current = "";
        const branches = [];
        for (const line of out.trim().split("\n")) {
          if (!line) {
            continue;
          }
          const [name, head] = line.split("\t");
          branches.push(name!);
          if (head === "*") {
            current = name!;
          }
        }
        return Response.json({ branches, current });
      }

      if (gitCmd === "log" && req.method === "GET") {
        const limit = url.searchParams.get("limit") || "20";
        const out = await runGit(["log", `--max-count=${limit}`, "--format=%H\t%s\t%an\t%aI"]);
        const entries = out
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const [hash, message, author, date] = line.split("\t");
            return { author, date, hash, message };
          });
        return Response.json(entries);
      }

      if (gitCmd === "stage" && req.method === "POST") {
        const { files } = (await req.json()) as { files?: string[] };
        if (!Array.isArray(files) || files.length === 0) {
          return problem("invalidRequest", "Missing files");
        }
        for (const f of files) {
          if (f.includes("..")) {
            return problem("invalidRequest", "Invalid path");
          }
        }
        await runGit(["add", "--", ...files]);
        return Response.json({ ok: true });
      }

      if (gitCmd === "unstage" && req.method === "POST") {
        const { files } = (await req.json()) as { files?: string[] };
        if (!Array.isArray(files) || files.length === 0) {
          return problem("invalidRequest", "Missing files");
        }
        await runGit(["restore", "--staged", "--", ...files]);
        return Response.json({ ok: true });
      }

      if (gitCmd === "commit" && req.method === "POST") {
        const { message } = (await req.json()) as { message?: string };
        if (!message || typeof message !== "string") {
          return problem("invalidRequest", "Missing message");
        }
        const statusOut = await runGit(["status", "--porcelain"]);
        const hasStaged = statusOut
          .split("\n")
          .some((l) => l.length > 0 && l[0] !== " " && l[0] !== "?");
        const args = hasStaged ? ["commit", "-m", message] : ["commit", "-a", "-m", message];
        const out = await runGit(args);
        const hashMatch = out.match(/\[[\w/]+ ([a-f0-9]+)\]/);
        return Response.json({ hash: hashMatch?.[1] || "", ok: true });
      }

      if (gitCmd === "push" && req.method === "POST") {
        let body: { setUpstream?: boolean } = {};
        try {
          body = (await req.json()) as { setUpstream?: boolean };
        } catch {}
        const { setUpstream } = body;
        if (setUpstream) {
          const branchRaw = await runGit(["rev-parse", "--abbrev-ref", "HEAD"]);
          const branch = branchRaw.trim();
          await runGit(["push", "-u", "origin", branch]);
        } else {
          await runGit(["push"]);
        }
        return Response.json({ ok: true });
      }

      if (gitCmd === "pull" && req.method === "POST") {
        /*
         * The one failure the route table has always published — `409 {conflicts}` — and never
         * produced: a conflicting pull threw like any other git failure and reached the catch-all
         * as a 500, so Studio told the user the backend broke rather than that their branch and
         * the remote both touched the same files. The conflicting paths are the only thing that
         * makes the message actionable, so they ride along as the extension member the type
         * documents.
         */
        try {
          await runGit(["pull"]);
        } catch (error) {
          const output = error as { stdout?: string; stderr?: string };
          const conflicts = conflictingPaths(`${output.stdout ?? ""}\n${output.stderr ?? ""}`);
          if (conflicts.length === 0) {
            throw error;
          }
          return problem(
            "conflict",
            `Pull stopped: ${conflicts.length} file(s) changed on both sides.`,
            { conflicts },
          );
        }
        return Response.json({ ok: true });
      }

      if (gitCmd === "fetch" && req.method === "POST") {
        await runGit(["fetch"]);
        return Response.json({ ok: true });
      }

      if (gitCmd === "checkout" && req.method === "POST") {
        const { branch } = (await req.json()) as { branch?: string };
        if (!branch || typeof branch !== "string") {
          return problem("invalidRequest", "Missing branch");
        }
        await runGit(["checkout", branch]);
        return Response.json({ ok: true });
      }

      if (gitCmd === "create-branch" && req.method === "POST") {
        const { name } = (await req.json()) as { name?: string };
        if (!name || typeof name !== "string") {
          return problem("invalidRequest", "Missing name");
        }
        await runGit(["checkout", "-b", name]);
        return Response.json({ ok: true });
      }

      if (gitCmd === "diff" && req.method === "GET") {
        const fp = url.searchParams.get("path");
        if (!fp) {
          return problem("invalidRequest", "Missing path");
        }
        if (fp.includes("..")) {
          return problem("invalidRequest", "Invalid path");
        }
        const diff = await runGit(["diff", "--", fp]);
        return Response.json({ diff });
      }

      if (gitCmd === "show" && req.method === "GET") {
        const fp = url.searchParams.get("path");
        const ref = url.searchParams.get("ref") || "HEAD";
        if (!fp) {
          return problem("invalidRequest", "Missing path");
        }
        if (fp.includes("..")) {
          return problem("invalidRequest", "Invalid path");
        }
        const content = await runGit(["show", `${ref}:${fp}`]);
        return Response.json({ content });
      }

      if (gitCmd === "discard" && req.method === "POST") {
        const { files } = (await req.json()) as { files?: string[] };
        if (!Array.isArray(files) || files.length === 0) {
          return problem("invalidRequest", "Missing files");
        }
        for (const f of files) {
          if (f.includes("..")) {
            return problem("invalidRequest", "Invalid path");
          }
        }
        await runGit(["checkout", "--", ...files]);
        return Response.json({ ok: true });
      }

      if (gitCmd === "clone" && req.method === "POST") {
        const { url: repoUrl } = (await req.json()) as { url?: string };
        if (!repoUrl || typeof repoUrl !== "string") {
          return problem("invalidRequest", "Missing url");
        }
        const repoName = basename(repoUrl.replace(/\.git$/, ""));
        const dest = resolve(cwd, repoName);
        const proc = Bun.spawn(["git", "clone", repoUrl, dest], {
          cwd,
          stderr: "pipe",
          stdout: "pipe",
        });
        const exitCode = await proc.exited;
        const stderr = await new Response(proc.stderr).text();
        if (exitCode !== 0) {
          throw new Error(stderr || `git clone exited with ${exitCode}`);
        }
        return Response.json({ ok: true, root: dest });
      }
    } catch (error) {
      return problem("internalError", errorMessage(error));
    }
  }

  return null;
}

/**
 * Extract a studio-friendly schema from a .class.json definition. Transforms $defs.parameters and
 * $defs.fields into the flat { description, properties, required } shape that renderSchemaFields()
 * in the studio already consumes.
 *
 * @param {ClassJsonDef} classDef
 * @param {string} classJsonPath
 * @returns {{
 *   description: string | undefined;
 *   properties: Record<string, Record<string, unknown>>;
 *   required: string[];
 * }}
 */
function extractStudioSchema(classDef: ClassJsonDef, classJsonPath: string) {
  // If extends.$ref points to a parent, recursively merge
  let parentSchema = null;
  if (classDef.extends && typeof classDef.extends === "object" && classDef.extends.$ref) {
    try {
      const parentPath = resolve(dirname(classJsonPath), classDef.extends.$ref);
      const parentContent = readFileSync(parentPath, "utf8");
      const parentDef = JSON.parse(parentContent) as ClassJsonDef;
      parentSchema = extractStudioSchema(parentDef, parentPath);
    } catch {
      // Parent not found — proceed without inheritance
    }
  }

  const params = classDef.$defs?.parameters ?? {};
  const fields = classDef.$defs?.fields ?? {};
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];

  // Start with parent properties (child overrides)
  if (parentSchema?.properties) {
    Object.assign(properties, parentSchema.properties);
  }
  if (parentSchema?.required) {
    required.push(...parentSchema.required);
  }

  // Build properties from parameters (constructor config surface)
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

  // Build properties from fields (config-visible ones only)
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

  // Determine required from constructor parameters that have no default
  const ctorParams = classDef.$defs?.constructor?.parameters ?? [];
  const requiredSet = new Set<string>(required);
  for (const p of ctorParams) {
    const name = p.$ref ? p.$ref.split("/").pop() : (p.identifier ?? p.name);
    if (name && properties[name] && properties[name].default === undefined) {
      requiredSet.add(name);
    }
  }

  const resolveMethod = classDef.$defs?.methods?.resolve;

  // Surface format-extension metadata: the format block, studio hints, and a
  // Capability summary ({ parse: { timing }, serialize: { timing }, ... }).
  const def = classDef as Record<string, unknown>;
  const capabilityRoles = new Set(["parse", "serialize", "discover", "load"]);
  const capabilities: Record<string, { identifier: string; timing: string[] }> = {};
  const methods = (classDef.$defs?.methods ?? {}) as Record<
    string,
    { role?: string; identifier?: string; timing?: string[] }
  >;
  for (const [key, method] of Object.entries(methods)) {
    if (method.role && capabilityRoles.has(method.role)) {
      capabilities[method.role] = {
        identifier: method.identifier ?? key,
        timing: method.timing ?? ["compiler", "server"],
      };
    }
  }

  return {
    description: classDef.description ?? classDef.title,
    properties,
    required: [...requiredSet],
    ...(resolveMethod?.returns ? { returns: resolveMethod.returns } : {}),
    ...(def.format ? { format: def.format } : {}),
    ...(def.$studio ? { $studio: def.$studio } : {}),
    ...(Object.keys(capabilities).length > 0 ? { capabilities } : {}),
  };
}
