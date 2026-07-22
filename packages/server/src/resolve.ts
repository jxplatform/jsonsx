/** Resolve.js — Generic $src module proxy + timing: "server" function proxy */

import { dirname, relative, resolve } from "node:path";
import { errorMessage, parseClassDef } from "@jxsuite/schema/parse";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { containedPath } from "./net-guard.ts";
import { buildProjectExtensionRegistry } from "@jxsuite/compiler/format-host";
import { loadProjectSections } from "@jxsuite/compiler/project-sections";
import type { DynamicClass } from "@jxsuite/runtime/types";
import type { JxClassDef, ProjectConfig } from "@jxsuite/schema/types";

interface ModuleNamespace {
  default?: Record<string, unknown>;
  [key: string]: unknown;
}

interface ClassInstance {
  resolve?: () => unknown;
  value?: unknown;
  [key: string]: unknown;
}

interface ResolveBody {
  $src?: string;
  $prototype?: string;
  $export?: string;
  $base?: string;
  [key: string]: unknown;
}

interface ServerFunctionBody {
  $src?: string;
  $export?: string;
  $base?: string;
  arguments?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * True when `p` is contained within `root` or (when set) `activeProjectRoot`. Guards every
 * `import()`/read of a caller-supplied `$src`/`$base`/`$implementation` so a `../` or absolute path
 * cannot pull in arbitrary modules from the filesystem.
 */
function isImportable(p: string, root: string, activeProjectRoot: string | null): boolean {
  if (containedPath(p, root) !== null) {
    return true;
  }
  if (activeProjectRoot && containedPath(p, activeProjectRoot) !== null) {
    return true;
  }
  return false;
}

/** Per-project context cache, invalidated when project.json changes on disk. */
const projectContextCache = new Map<string, { mtime: number; context: Record<string, unknown> }>();

/**
 * Lazy-load project context (project.json + extension-loaded sections) for class instantiation.
 * Sections land under their section keys (e.g. `content` for the parser), matching the compiler's
 * `_project` shape.
 *
 * @param {string} projectRoot
 * @returns {Promise<Record<string, unknown> | null>} `{ config, root, ...sections }` or null
 */
async function loadProjectContext(projectRoot: string) {
  const projectJsonPath = resolve(projectRoot, "project.json");
  if (!existsSync(projectJsonPath)) {
    return null;
  }
  try {
    const { mtimeMs } = statSync(projectJsonPath);
    const cached = projectContextCache.get(projectRoot);
    if (cached && cached.mtime === mtimeMs) {
      return cached.context;
    }
    const config = JSON.parse(readFileSync(projectJsonPath, "utf8")) as ProjectConfig;
    const registry = await buildProjectExtensionRegistry(projectRoot, config);
    const sections = await loadProjectSections(projectRoot, config, registry);
    const context = { config, root: projectRoot, ...sections };
    projectContextCache.set(projectRoot, { context, mtime: mtimeMs });
    return context;
  } catch {
    return null;
  }
}

/**
 * Handle POST /**jx_resolve** — proxy $prototype + $src entries.
 *
 * @param {Request} req
 * @param {string} root
 * @param {string | null} [activeProjectRoot]
 */
export async function handleResolve(
  req: Request,
  root: string,
  activeProjectRoot: string | null = null,
) {
  let body: ResolveBody;
  try {
    body = (await req.json()) as ResolveBody;
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  const { $src, $prototype, $export: xport, $base, ...config } = body;
  if (!$src) {
    return new Response("Missing $src", { status: 400 });
  }

  let moduleAbsPath;
  try {
    if ($src.startsWith("./") || $src.startsWith("../")) {
      // Relative path
      if ($base) {
        const docUrlPath = new URL($base).pathname;
        const docDir = docUrlPath.slice(0, docUrlPath.lastIndexOf("/") + 1);
        moduleAbsPath = resolve(resolve(root, `.${docDir}`), $src);
      } else {
        moduleAbsPath = resolve(activeProjectRoot || root, $src);
      }
      if (!isImportable(moduleAbsPath, root, activeProjectRoot)) {
        return new Response(`$src "${$src}" escapes the project root`, { status: 403 });
      }
    } else {
      // Npm/bare specifier — use createRequire from project root, fall back to server package
      const projectRoot = activeProjectRoot || root;
      const projRequire = createRequire(resolve(projectRoot, "package.json"));
      try {
        moduleAbsPath = projRequire.resolve($src);
      } catch {
        const serverRequire = createRequire(import.meta.url);
        moduleAbsPath = serverRequire.resolve($src);
      }
    }
  } catch (error) {
    return new Response(`Cannot resolve $src "${$src}": ${errorMessage(error)}`, { status: 400 });
  }

  // Rebase relative config paths from doc-relative to CWD-relative
  if ($base) {
    const docUrlPath = new URL($base).pathname;
    const docDir = docUrlPath.slice(0, docUrlPath.lastIndexOf("/") + 1);
    const docAbsDir = resolve(root, `.${docDir}`);
    for (const [k, v] of Object.entries(config)) {
      if (typeof v === "string" && (v.startsWith("./") || v.startsWith("../"))) {
        config[k] = `./${relative(process.cwd(), resolve(docAbsDir, v)).split("\\").join("/")}`;
      }
    }
  }

  // .class.json: read schema, follow $implementation to the real JS module
  if (moduleAbsPath.endsWith(".class.json")) {
    try {
      const content = readFileSync(moduleAbsPath, "utf8");
      const classDef = parseClassDef(content, moduleAbsPath);

      // Inject project context for classes that need it
      const projectRoot = activeProjectRoot || root;
      const projectCtx = await loadProjectContext(projectRoot);
      if (projectCtx) {
        config._project = projectCtx;
      }
      config._document = { route: { _pathParams: {} }, state: {} };

      if (classDef.$implementation) {
        // Hybrid mode: redirect to the JS implementation
        const implPath = resolve(dirname(moduleAbsPath), classDef.$implementation);
        if (!isImportable(implPath, root, activeProjectRoot)) {
          return new Response(`$implementation escapes the project root`, { status: 403 });
        }
        const exportName = xport ?? classDef.title ?? $prototype;
        const mod = (await import(implPath)) as ModuleNamespace;
        const ExportedClass =
          exportName === undefined ? undefined : (mod[exportName] ?? mod.default?.[exportName]);
        if (typeof ExportedClass !== "function") {
          return new Response(`Export "${exportName}" not found in "${classDef.$implementation}"`, {
            status: 500,
          });
        }
        const ClassCtor = ExportedClass as new (config: unknown) => ClassInstance;
        const instance = new ClassCtor(config);
        const value =
          typeof instance.resolve === "function"
            ? await instance.resolve()
            : "value" in instance
              ? instance.value
              : instance;
        return Response.json(value);
      }

      // Self-contained: construct class from schema
      const DynClass = classFromSchema(classDef);
      const instance = new DynClass(config) as {
        resolve?: () => unknown;
        value?: unknown;
      };
      const value =
        typeof instance.resolve === "function"
          ? await instance.resolve()
          : "value" in instance
            ? instance.value
            : instance;
      return Response.json(value);
    } catch (error) {
      return Response.json({ error: errorMessage(error) }, { status: 500 });
    }
  }

  // Non-Function $prototype must use .class.json as entrypoint
  return new Response(
    `Non-Function $prototype "${$prototype}" requires a .class.json $src, got "${$src}". ` +
      `Wrap the class in a .class.json schema with $implementation.`,
    { status: 400 },
  );
}

/**
 * Handle POST /**jx_server** — proxy timing: "server" function calls. In dev mode, the runtime
 * sends these instead of hitting the production Hono handler.
 *
 * @param {Request} req
 * @param {string} root
 */
export async function handleServerFunction(req: Request, root: string) {
  let body: ServerFunctionBody;
  try {
    body = (await req.json()) as ServerFunctionBody;
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  const { $src, $export: xport, $base, arguments: args = {} } = body;
  if (!$src || !xport) {
    return new Response("Missing $src or $export", { status: 400 });
  }

  let moduleAbsPath;
  try {
    if ($base) {
      const docUrlPath = new URL($base).pathname;
      const docDir = docUrlPath.slice(0, docUrlPath.lastIndexOf("/") + 1);
      moduleAbsPath = resolve(resolve(root, `.${docDir}`), $src);
    } else {
      moduleAbsPath = resolve(root, $src);
    }
  } catch (error) {
    return new Response(`Cannot resolve $src: ${errorMessage(error)}`, {
      status: 400,
    });
  }

  if (!isImportable(moduleAbsPath, root, null)) {
    return new Response(`$src "${$src}" escapes the project root`, { status: 403 });
  }

  let mod: ModuleNamespace;
  try {
    mod = (await import(moduleAbsPath)) as ModuleNamespace;
  } catch (error) {
    return new Response(`Failed to import "${$src}": ${errorMessage(error)}`, {
      status: 500,
    });
  }

  const fn = mod[xport] ?? mod.default?.[xport];
  if (typeof fn !== "function") {
    return new Response(`Export "${xport}" not found in "${$src}"`, {
      status: 500,
    });
  }

  try {
    // Match the production contract `fn(args, env)` (compiler emits `fn(args, c.env)`): the dev
    // Proxy runs server-side, so `process.env` is the analogous environment binding.
    const result = await (fn as (args: Record<string, unknown>, env: unknown) => unknown)(
      args,
      process.env,
    );
    return Response.json(result ?? null);
  } catch (error) {
    return Response.json({ error: errorMessage(error) }, { status: 500 });
  }
}

/**
 * Dynamically construct a class from a .class.json schema definition. Server-side variant — no
 * private field limitations.
 *
 * @param {JxClassDef} classDef
 */
function classFromSchema(classDef: JxClassDef) {
  const fields = classDef.$defs?.fields ?? {};
  // JSON objects inherit Object.prototype.constructor — only an own object value counts.
  const rawCtor = classDef.$defs?.constructor;
  const ctor = typeof rawCtor === "object" ? rawCtor : undefined;
  const methods = classDef.$defs?.methods ?? {};

  // oxlint-disable-next-line typescript/no-extraneous-class -- methods are attached to the prototype dynamically below
  class DynClass {
    constructor(config = {}) {
      const self = this as Record<string, unknown>;
      const cfg = config as Record<string, unknown>;
      for (const [key, field] of Object.entries(fields)) {
        const id = field.identifier ?? key;
        if (cfg[id] !== undefined) {
          self[id] = cfg[id];
        } else if (field.initializer !== undefined) {
          self[id] = field.initializer;
        } else if (field.default !== undefined) {
          self[id] = structuredClone(field.default);
        } else {
          self[id] = null;
        }
      }
      if (ctor?.body) {
        const bodyStr = Array.isArray(ctor.body) ? ctor.body.join("\n") : ctor.body;
        new Function("config", bodyStr).call(this, config);
      }
    }
  }

  for (const [key, method] of Object.entries(methods)) {
    const name = method.identifier ?? key;
    const params = (method.parameters ?? []).map((p) => {
      if (p.$ref) {
        return p.$ref.split("/").pop() ?? "arg";
      }
      const n = p.identifier ?? p.name;
      return typeof n === "string" ? n : "arg";
    });
    const bodyStr = Array.isArray(method.body) ? method.body.join("\n") : (method.body ?? "");

    if (method.role === "accessor") {
      const descriptor: PropertyDescriptor = {};
      if (method.getter) {
        descriptor.get = new Function(method.getter.body ?? "") as () => unknown;
      }
      if (method.setter) {
        const sp = (method.setter.parameters ?? []).map((p) => p.$ref?.split("/").pop() ?? "v");
        descriptor.set = new Function(...sp, method.setter.body ?? "") as (v: unknown) => void;
      }
      Object.defineProperty(DynClass.prototype, name, {
        ...descriptor,
        configurable: true,
      });
    } else if (method.scope === "static") {
      (DynClass as DynamicClass)[name] = new Function(...params, bodyStr);
    } else {
      (DynClass as DynamicClass).prototype[name] = new Function(...params, bodyStr);
    }
  }

  Object.defineProperty(DynClass, "name", {
    configurable: true,
    value: classDef.title,
  });
  return DynClass;
}
