/**
 * Ai-project-tools.ts — project-level tools for the AI assistant.
 *
 * Two tiers registered here (document tools live in ai-tools.ts):
 *
 * - Bootstrap (no project open): `create_project` scaffolds through the platform's shared
 *   `createProject` pipeline (`@jxsuite/create` server-side) and adopts the result into this
 *   window; `list_starters` enumerates starter templates.
 * - Cross-file (project open): `list_files` / `read_file` / `write_file` / `search_files` operate
 *   through the platform adapter without touching the tab strip, so the agent can develop across
 *   many files. `write_file` pre-validates Jx documents (no undo exists for disk writes, so
 *   validation blocks instead of optimistically applying) and reconciles with open tabs.
 *
 * @license MIT
 */

import { createToolDefinition } from "@jxsuite/ai/tools";
import type { CreateProjectDestination } from "../types";
import type { ToolRegistry, ToolResult } from "@jxsuite/ai/tools";
import type { JxMutableNode, ProjectConfig } from "@jxsuite/schema/types";
import { getPlatform } from "../platform";
import { workspace } from "../workspace/workspace";
import type { Tab } from "../tabs/tab";
import { adoptCreatedProject } from "./project-adoption";
import { translateValidationError } from "./ai-tools";
import { validateDoc, validateProjectConfig } from "./jx-validate";
import { recordWrite } from "./ai-writes";
import { flagHardcodedTokens, formatTokenHints } from "./token-lint";

/** Directories the file tools never descend into or report. */
const EXCLUDED_DIRS = new Set(["node_modules", "dist", ".git", ".jx-cache"]);

/** Caps keeping tool results inside chat-context and localStorage budgets. */
const LIST_CAP = 200;
const SEARCH_CAP = 100;
const READ_CAP_BYTES = 48 * 1024;
const WRITE_CAP_BYTES = 256 * 1024;

const NOT_UNDOABLE = "(saved to disk; not undoable with Cmd+Z)";

/**
 * Normalize a project-relative path, or return null when it escapes the project (absolute paths,
 * `..` segments, drive letters). The server re-checks; this keeps the error actionable.
 */
export function normalizeRelPath(path: unknown): string | null {
  if (typeof path !== "string" || !path.trim()) {
    return null;
  }
  let p = path.trim().replaceAll("\\", "/");
  while (p.startsWith("./")) {
    p = p.slice(2);
  }
  if (p.startsWith("/") || p.startsWith("~") || /^[A-Za-z]:/.test(p)) {
    return null;
  }
  if (p.split("/").includes("..")) {
    return null;
  }
  return p;
}

function pathError(path: unknown): ToolResult {
  return {
    success: false,
    error: `Invalid path ${JSON.stringify(path)} — use a path relative to the project root (no leading "/", no "..").`,
  };
}

/**
 * Whether a project-relative path conventionally holds a Jx document. Kept in step with
 * monaco-setup.ts's DOCUMENT_FILE_MATCH so the assistant's gate and the editor's diagnostics cover
 * the same files — `elements/` used to be missing here and validated only by the
 * {@link looksLikeJxDoc} sniff.
 */
function isJxDocPath(path: string): boolean {
  return /^(pages|layouts|components|elements)\//.test(path) && path.endsWith(".json");
}

/** Structural sniff for Jx-document-shaped JSON values. */
function looksLikeJxDoc(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    ("tagName" in value || "$id" in value || "$elements" in value)
  );
}

export interface ProjectToolsCtx {
  getTab: () => Tab | null;
  validate?: (doc: unknown) => Promise<string[]>;
  /** Gate for `project.json` writes — the per-project entry document, not the document schema. */
  validateProject?: (config: unknown) => Promise<string[]>;
  renderCheck?: (doc: unknown) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** Live getter — the project style appears only after a project is open/bootstrapped. */
  getProjectStyle?: () => Record<string, string> | undefined;
  /** The open tab whose `documentPath` equals the given project-relative path, if any. */
  findOpenTab: (path: string) => Tab | null;
  /** Reload an open tab's document from disk (files.ts `reloadFileInTab`). */
  reloadTab: (path: string) => Promise<void>;
  /** Open the project at an absolute root in this window (project-adoption.ts). */
  adoptProject: (root: string) => Promise<void>;
  /** Fired after adoption is verified — the session store re-keys the live chat here. */
  onProjectAdopted?: (root: string) => void;
  /**
   * Fired after a successful `project.json` write so the configuration DOCUMENT holds what was
   * written. The config has passed the project-schema gate by then, which is what makes the type
   * honest.
   *
   * AWAITED, and the only thing that reconciles this write with the rest of the app:
   * `tabs/project-config.ts` owns `project.json`, and a write that does not reach its document
   * leaves that document holding the PREVIOUS configuration for the next settings edit to persist
   * back over this one. It used to be fire-and-forget, and the write survived only because an open
   * tab happened to be re-read from disk afterwards ({@link ProjectToolsCtx.reloadTab}); that
   * re-read is gone, because a second parse of `project.json` is the very rival object the
   * configuration document exists to prevent.
   */
  onProjectConfigWritten?: (config: ProjectConfig) => void | Promise<void>;
}

/**
 * Register the project-level tools into a tool registry.
 *
 * @param {Pick<ToolRegistry, "register">} registry
 * @param {ProjectToolsCtx} ctx
 */
export function registerProjectTools(
  registry: Pick<ToolRegistry, "register">,
  {
    getTab,
    validate = validateDoc,
    validateProject = validateProjectConfig,
    renderCheck,
    getProjectStyle,
    findOpenTab,
    reloadTab,
    adoptProject,
    onProjectAdopted,
    onProjectConfigWritten,
  }: ProjectToolsCtx,
) {
  // ── list_files ─────────────────────────────────────────────────────────

  registry.register(
    createToolDefinition({
      name: "list_files",
      description:
        "List the project's files recursively (paths relative to the project root, with type and " +
        "size). Use this to discover pages, layouts, components, content, data, and styles before " +
        "reading or writing files. Build folders (node_modules, dist, .git) are excluded.",
      parameters: {
        type: "object",
        properties: {
          dir: {
            type: "string",
            description:
              'Directory to list, relative to the project root. Omit for the root (".").',
          },
        },
        required: [],
      },
      async execute(args) {
        const { dir } = args as { dir?: string };
        const start = dir === undefined || dir === "" ? "." : normalizeRelPath(dir);
        if (start === null) {
          return pathError(dir);
        }
        const platform = getPlatform();
        const entries: { path: string; type: string; size?: number }[] = [];
        const queue = [start];
        let truncated = false;
        while (queue.length > 0 && !truncated) {
          const current = queue.shift()!;
          let children;
          try {
            children = await platform.listDirectory(current);
          } catch {
            continue;
          }
          for (const e of children) {
            const name = e.name || e.path.split("/").pop() || "";
            if (EXCLUDED_DIRS.has(name) || name.startsWith(".")) {
              continue;
            }
            const path = e.path || (current === "." ? name : `${current}/${name}`);
            if (entries.length >= LIST_CAP) {
              truncated = true;
              break;
            }
            entries.push({
              path,
              type: e.type,
              ...(typeof e.size === "number" ? { size: e.size } : {}),
            });
            if (e.type === "directory") {
              queue.push(path);
            }
          }
        }
        return {
          success: true,
          data: { entries, truncated },
          summary: `Listed ${entries.length} entries under "${start}"${truncated ? ` (truncated at ${LIST_CAP})` : ""}.`,
        };
      },
    }),
  );

  // ── read_file ──────────────────────────────────────────────────────────

  registry.register(
    createToolDefinition({
      name: "read_file",
      description:
        "Read a project file's content by its project-relative path. Works for any text file " +
        "(Jx documents, markdown, CSS, data). Large files are truncated.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: 'Project-relative file path, e.g. "pages/about.json".',
          },
        },
        required: ["path"],
      },
      async execute(args) {
        const relPath = normalizeRelPath((args as { path: string }).path);
        if (relPath === null) {
          return pathError((args as { path: string }).path);
        }
        try {
          const content = await getPlatform().readFile(relPath);
          if (content.length > READ_CAP_BYTES) {
            return {
              success: true,
              data: {
                content: `${content.slice(0, READ_CAP_BYTES)}\n… [truncated: file is ${content.length} bytes, showing first ${READ_CAP_BYTES}]`,
                truncated: true,
              },
            };
          }
          return { success: true, data: { content, truncated: false } };
        } catch (error) {
          return {
            success: false,
            error: `Failed to read "${relPath}": ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      },
    }),
  );

  // ── write_file ─────────────────────────────────────────────────────────

  registry.register(
    createToolDefinition({
      name: "write_file",
      description:
        "Write a project file (create or overwrite) at a project-relative path. Jx documents " +
        "(.json under pages/, layouts/, components/) are schema-validated and render-checked " +
        "before writing — fix reported errors and retry. Refused while the target file is open " +
        "with unsaved changes. Disk writes are not undoable.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: 'Project-relative file path, e.g. "components/footer.json".',
          },
          content: {
            type: "string",
            description: "The complete new file content (full file, not a diff).",
          },
        },
        required: ["path", "content"],
      },
      async execute(args) {
        const { path, content } = args as { path: string; content: string };
        const relPath = normalizeRelPath(path);
        if (relPath === null) {
          return pathError(path);
        }
        if (content.length > WRITE_CAP_BYTES) {
          return {
            success: false,
            error: `Content is ${content.length} bytes — the write cap is ${WRITE_CAP_BYTES}. Split the content across smaller files.`,
          };
        }

        // Reconcile with an open tab BEFORE writing: a dirty tab would silently diverge from disk.
        const openTab = findOpenTab(relPath);
        if (openTab?.doc.dirty) {
          return {
            success: false,
            error:
              `"${relPath}" is open in the editor with unsaved changes. Use open_document plus the ` +
              `document tools to edit it, or ask the user to save or discard their changes first.`,
          };
        }

        // Pre-validate Jx documents — disk writes have no undo to lean on.
        let parsed: unknown;
        const isJson = relPath.endsWith(".json") && relPath !== "project.json";
        if (isJson) {
          try {
            parsed = JSON.parse(content);
          } catch (error) {
            return {
              success: false,
              error: `Content is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
            };
          }
        }
        let tokenHints = "";
        if (isJson && (isJxDocPath(relPath) || looksLikeJxDoc(parsed))) {
          const errors = await validate(parsed);
          if (errors.length > 0) {
            const formatted = errors.map((e) => `- ${translateValidationError(e)}`).join("\n");
            return {
              success: false,
              error: `Document has schema errors — nothing was written. Fix these and retry:\n${formatted}`,
            };
          }
          if (renderCheck) {
            const renderResult = await renderCheck(parsed);
            if (!renderResult.ok) {
              return {
                success: false,
                error: `Document is schema-valid but fails to render — nothing was written. Fix and retry:\n- ${renderResult.error}`,
              };
            }
          }
          const projectStyle = getProjectStyle?.();
          if (projectStyle) {
            tokenHints = formatTokenHints(
              flagHardcodedTokens(parsed as JxMutableNode, projectStyle),
            );
          }
        }

        /* Parsed as `unknown` because that is what it is until the schema says otherwise — this is
           model-authored text, and the gate below is the whole reason we do not trust its shape. */
        let projectConfig: ProjectConfig | undefined;
        if (relPath === "project.json") {
          let parsedConfig: unknown;
          try {
            parsedConfig = JSON.parse(content);
          } catch (error) {
            return {
              success: false,
              error: `project.json must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
            };
          }
          /* The per-project entry document closes the composition over every enabled extension
             (extensions.md §5.2), so this is what catches a typo'd section key or a misshapen
             extension section. Without it the model shipped config its own tool call called clean
             and Monaco flagged the moment a human opened the file. */
          const configErrors = await validateProject(parsedConfig);
          if (configErrors.length > 0) {
            const formatted = configErrors
              .map((e) => `- ${translateValidationError(e)}`)
              .join("\n");
            return {
              success: false,
              error: `project.json has schema errors — nothing was written. Fix these and retry:\n${formatted}`,
            };
          }
          // Narrowed only now: the assertion is earned by the schema gate, not by JSON.parse.
          projectConfig = parsedConfig as ProjectConfig;
        }

        try {
          await getPlatform().writeFile(relPath, content);
          /* Disk, not transaction: there is no undo behind this and there never was. Recorded as
             `disk: true` so the panel can say so to the person holding ⌘Z — the caveat used to be
             appended to the model-facing summary only (§7.4). */
          recordWrite({ disk: true, ok: true, path: relPath, tool: "write_file" });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          recordWrite({ disk: true, error: message, ok: false, path: relPath, tool: "write_file" });
          return {
            success: false,
            error: `Failed to write "${relPath}": ${message}`,
          };
        }

        /* `project.json`'s open tab IS the configuration document, so adopting the write refreshes
           it — re-reading the file here would parse a SECOND configuration object and hand it to
           that tab, which is the split the adoption just closed. Every other path is a plain file
           and its tab has to be told from disk. */
        if (projectConfig) {
          await onProjectConfigWritten?.(projectConfig);
        } else if (openTab) {
          await reloadTab(relPath);
        }

        const refreshed = openTab ? " and refreshed its open editor tab" : "";
        const summary = `Wrote "${relPath}"${refreshed} ${NOT_UNDOABLE}.`;
        return { success: true, summary: tokenHints ? `${summary}\n\n${tokenHints}` : summary };
      },
    }),
  );

  // ── search_files ───────────────────────────────────────────────────────

  registry.register(
    createToolDefinition({
      name: "search_files",
      description:
        "Search project files by file NAME (not content). Returns matching paths. Use list_files " +
        "for a directory overview and read_file to inspect contents.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: 'Substring of the file name, e.g. "hero".' },
          extensions: {
            type: "array",
            description: 'Optional extension filter, e.g. [".json", ".md"].',
            items: { type: "string" },
          },
        },
        required: ["query"],
      },
      async execute(args) {
        const { query, extensions } = args as { query: string; extensions?: string[] };
        try {
          const results = await getPlatform().searchFiles(query, extensions);
          const paths = results.map((r) => r.path).slice(0, SEARCH_CAP);
          return {
            success: true,
            data: { paths, truncated: results.length > SEARCH_CAP },
            summary: `Found ${paths.length} file(s) matching "${query}".`,
          };
        } catch (error) {
          return {
            success: false,
            error: `Search failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      },
    }),
  );

  // ── create_project ─────────────────────────────────────────────────────

  registry.register(
    createToolDefinition({
      name: "create_project",
      description:
        "Create a new Jx project (project.json, conventional directories, starter pages) and open " +
        "it in the studio. Only available while no project is open. After it succeeds, the file " +
        "and document tools become available for building out the project. If the directory " +
        "already exists, retry with a different directory slug. Requires an explicit destination: " +
        'on a filesystem platform pass "location" (an absolute parent folder); on the cloud pass ' +
        '"owner" (a GitHub account or organization). Ask the user where to put it rather than ' +
        "guessing — nothing is created without one.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: 'Human project name, e.g. "Acme Bakery".' },
          description: { type: "string", description: "Short project description." },
          template: {
            type: "string",
            description:
              'Scaffold variant: "blank" (default), "desktop-first", "mobile-first", or "mobile-app".',
            enum: ["blank", "desktop-first", "mobile-first", "mobile-app"],
          },
          directory: {
            type: "string",
            description:
              "Folder (or repository) name to create the project as. Defaults to a slug of the name.",
          },
          location: {
            type: "string",
            description:
              "Absolute path of the EXISTING parent folder to create the project folder inside, " +
              'e.g. "/home/you/Sites". Required on filesystem platforms (desktop, dev server).',
          },
          owner: {
            type: "string",
            description:
              "GitHub account or organization to create the repository under. Required on the " +
              "cloud platform.",
          },
          private: {
            type: "boolean",
            description: "Cloud only: repository visibility. Defaults to private.",
          },
          design: {
            type: "object",
            description:
              "Optional design quickstart: { accent, background, text, bodyFont, headingFont } — " +
              "CSS colors and font-family names applied to the scaffold's design tokens.",
          },
        },
        required: ["name"],
      },
      async execute(args) {
        const {
          name,
          description,
          template,
          directory,
          design,
          location,
          owner,
          private: isPrivate,
        } = args as {
          name: string;
          description?: string;
          template?: string;
          directory?: string;
          design?: Record<string, string>;
          location?: string;
          owner?: string;
          private?: boolean;
        };
        if (workspace.projectRoot) {
          return {
            success: false,
            error:
              "A project is already open in this window — create_project is only for bootstrapping.",
          };
        }
        const slug =
          directory?.trim() ||
          name
            .toLowerCase()
            .replaceAll(/[^a-z0-9]+/g, "-")
            .replaceAll(/^-|-$/g, "");
        if (!slug) {
          return { success: false, error: 'Could not derive a directory slug — pass "directory".' };
        }

        // No destination, no project. The backend refuses one anyway; failing here gives the model
        // A message it can act on instead of a wire error.
        const platform = getPlatform();
        let destination: CreateProjectDestination;
        if (platform.createDestination === "repo") {
          if (!owner?.trim()) {
            return {
              success: false,
              error:
                'Pass "owner" — the GitHub account or organization to create the repository under. ' +
                "Ask the user which one to use.",
            };
          }
          destination = {
            kind: "repo",
            owner: owner.trim(),
            private: isPrivate ?? true,
            repo: slug,
          };
        } else {
          if (!location?.trim()) {
            return {
              success: false,
              error:
                'Pass "location" — the absolute path of the folder to create the project inside. ' +
                "Ask the user where the project should live.",
            };
          }
          if (!/^(?:[a-zA-Z]:[/\\]|\/)/.test(location.trim())) {
            return { success: false, error: `"location" must be an absolute path: ${location}` };
          }
          destination = { kind: "path", parent: location.trim().replace(/[/\\]+$/, "") };
        }

        let result: { root: string; config: object };
        try {
          result = await platform.createProject({
            name,
            destination,
            directory: slug,
            ...(description ? { description } : {}),
            ...(template ? { template } : {}),
            ...(design ? { design } : {}),
          });
        } catch (error) {
          return {
            success: false,
            error: `Failed to create project: ${error instanceof Error ? error.message : String(error)}`,
          };
        }

        /*
         * Git init, then the full project-open flow, then a check that it landed — all three in
         * `services/project-adoption.ts`, because `import_site` is the same act with a different
         * backend. Git init in particular was missing here: `specs/desktop.md` §4.5 promises every
         * create path initialises a repository, and only the New Project modal was keeping it.
         */
        const { adopted, error: adoptionError } = await adoptCreatedProject(result.root, {
          adopt: adoptProject,
          getTab,
        });
        if (adopted) {
          onProjectAdopted?.(result.root);
          return {
            success: true,
            summary:
              `Created project "${name}" at ${result.root} and opened it. The file tools ` +
              `(list_files, read_file, write_file) and document tools are now available — start ` +
              `with list_files to see the scaffolded pages, layouts, and components.`,
          };
        }
        return {
          success: true,
          summary:
            `Created project "${name}" at ${result.root}, but it was not opened in this window` +
            `${adoptionError ? ` (${adoptionError})` : " (it may have opened in another window)"}. ` +
            `Ask the user to open it from the welcome screen or recent projects.`,
        };
      },
    }),
  );

  // ── list_starters ──────────────────────────────────────────────────────

  registry.register(
    createToolDefinition({
      name: "list_starters",
      description:
        "List the starter templates available for new projects (id, name, description). " +
        "Currently informational — create_project scaffolds from built-in template variants.",
      parameters: { type: "object", properties: {}, required: [] },
      async execute() {
        try {
          const starters = (await getPlatform().listStarters?.()) ?? [];
          return {
            success: true,
            data: { starters },
            summary: `${starters.length} starter(s) available.`,
          };
        } catch (error) {
          return {
            success: false,
            error: `Failed to list starters: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      },
    }),
  );
}
