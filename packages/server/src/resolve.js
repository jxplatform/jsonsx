/** Resolve.js — Generic $src module proxy + timing: "server" function proxy */

import { resolve, relative, dirname } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { loadContentTypes } from "@jxsuite/compiler/content-loader";

/**
 * Lazy-load project context (project.json + content types) for class instantiation.
 *
 * @param {string} projectRoot
 * @returns {Promise<{
 *   config: Record<string, unknown>;
 *   contentTypes: Map<string, unknown[]>;
 *   root: string;
 * } | null>}
 */
async function loadProjectContext(projectRoot) {
  const projectJsonPath = resolve(projectRoot, "project.json");
  if (!existsSync(projectJsonPath)) return null;
  try {
    const config = JSON.parse(readFileSync(projectJsonPath, "utf8"));
    const contentTypes = config.contentTypes
      ? await loadContentTypes(projectRoot, config)
      : new Map();
    return { config, contentTypes, root: projectRoot };
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
export async function handleResolve(req, root, activeProjectRoot = null) {
  let body;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  const { $src, $prototype, $export: xport, $base, ...config } = body;
  if (!$src) return new Response("Missing $src", { status: 400 });

  let moduleAbsPath;
  try {
    if ($src.startsWith("./") || $src.startsWith("../")) {
      // Relative path
      if ($base) {
        const docUrlPath = new URL($base).pathname;
        const docDir = docUrlPath.slice(0, docUrlPath.lastIndexOf("/") + 1);
        moduleAbsPath = resolve(resolve(root, "." + docDir), $src);
      } else {
        moduleAbsPath = resolve(activeProjectRoot || root, $src);
      }
    } else {
      // npm/bare specifier — use createRequire from project root, fall back to server package
      const projectRoot = activeProjectRoot || root;
      const projRequire = createRequire(resolve(projectRoot, "package.json"));
      try {
        moduleAbsPath = projRequire.resolve($src);
      } catch {
        const serverRequire = createRequire(import.meta.url);
        moduleAbsPath = serverRequire.resolve($src);
      }
    }
  } catch (/** @type {unknown} */ e) {
    return new Response(
      `Cannot resolve $src "${$src}": ${/** @type {{ message?: string }} */ (e).message}`,
      { status: 400 },
    );
  }

  // Rebase relative config paths from doc-relative to CWD-relative
  if ($base) {
    const docUrlPath = new URL($base).pathname;
    const docDir = docUrlPath.slice(0, docUrlPath.lastIndexOf("/") + 1);
    const docAbsDir = resolve(root, "." + docDir);
    for (const [k, v] of Object.entries(config)) {
      if (typeof v === "string" && (v.startsWith("./") || v.startsWith("../"))) {
        config[k] = "./" + relative(process.cwd(), resolve(docAbsDir, v)).split("\\").join("/");
      }
    }
  }

  // .class.json: read schema, follow $implementation to the real JS module
  if (moduleAbsPath.endsWith(".class.json")) {
    try {
      const content = readFileSync(moduleAbsPath, "utf8");
      const classDef = JSON.parse(content);

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
        const exportName = xport ?? classDef.title ?? $prototype;
        const mod = await import(implPath);
        const ExportedClass = mod[exportName] ?? mod.default?.[exportName];
        if (typeof ExportedClass !== "function") {
          return new Response(`Export "${exportName}" not found in "${classDef.$implementation}"`, {
            status: 500,
          });
        }
        const instance = new ExportedClass(config);
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
      const instance = /** @type {{ resolve?: () => unknown; value?: unknown }} */ (
        new DynClass(config)
      );
      const value =
        typeof instance.resolve === "function"
          ? await instance.resolve()
          : "value" in instance
            ? instance.value
            : instance;
      return Response.json(value);
    } catch (/** @type {unknown} */ e) {
      return Response.json(
        { error: /** @type {{ message?: string }} */ (e).message },
        { status: 500 },
      );
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
export async function handleServerFunction(req, root) {
  let body;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  const { $src, $export: xport, $base, arguments: args = {} } = body;
  if (!$src || !xport) return new Response("Missing $src or $export", { status: 400 });

  let moduleAbsPath;
  try {
    if ($base) {
      const docUrlPath = new URL($base).pathname;
      const docDir = docUrlPath.slice(0, docUrlPath.lastIndexOf("/") + 1);
      moduleAbsPath = resolve(resolve(root, "." + docDir), $src);
    } else {
      moduleAbsPath = resolve(root, $src);
    }
  } catch (/** @type {unknown} */ e) {
    return new Response(`Cannot resolve $src: ${/** @type {{ message?: string }} */ (e).message}`, {
      status: 400,
    });
  }

  let mod;
  try {
    mod = await import(moduleAbsPath);
  } catch (/** @type {unknown} */ e) {
    return new Response(
      `Failed to import "${$src}": ${/** @type {{ message?: string }} */ (e).message}`,
      { status: 500 },
    );
  }

  const fn = mod[xport] ?? mod.default?.[xport];
  if (typeof fn !== "function") {
    return new Response(`Export "${xport}" not found in "${$src}"`, { status: 500 });
  }

  try {
    const result = await fn(args);
    return Response.json(result ?? null);
  } catch (/** @type {unknown} */ e) {
    return Response.json(
      { error: /** @type {{ message?: string }} */ (e).message },
      { status: 500 },
    );
  }
}

/**
 * Dynamically construct a class from a .class.json schema definition. Server-side variant — no
 * private field limitations.
 *
 * @param {ClassJsonDef} classDef
 */
function classFromSchema(classDef) {
  const fields = classDef.$defs?.fields ?? {};
  const ctor = classDef.$defs?.constructor;
  const methods = classDef.$defs?.methods ?? {};

  class DynClass {
    constructor(config = {}) {
      const self = /** @type {Record<string, unknown>} */ (this);
      const cfg = /** @type {Record<string, unknown>} */ (config);
      for (const [key, field] of Object.entries(fields)) {
        const id = field.identifier ?? key;
        if (cfg[id] !== undefined) self[id] = cfg[id];
        else if (field.initializer !== undefined) self[id] = field.initializer;
        else if (field.default !== undefined) self[id] = structuredClone(field.default);
        else self[id] = null;
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
      if (p.$ref) return p.$ref.split("/").pop() ?? "arg";
      return p.identifier ?? p.name ?? "arg";
    });
    const bodyStr = Array.isArray(method.body) ? method.body.join("\n") : (method.body ?? "");

    if (method.role === "accessor") {
      /** @type {PropertyDescriptor} */
      const descriptor = {};
      if (method.getter)
        descriptor.get = /** @type {() => unknown} */ (new Function(method.getter.body));
      if (method.setter) {
        const sp = (method.setter.parameters ?? []).map((p) => p.$ref?.split("/").pop() ?? "v");
        descriptor.set = /** @type {(v: unknown) => void} */ (
          new Function(...sp, method.setter.body)
        );
      }
      Object.defineProperty(DynClass.prototype, name, { ...descriptor, configurable: true });
    } else if (method.scope === "static") {
      /** @type {DynamicClass} */ (DynClass)[name] = new Function(...params, bodyStr);
    } else {
      /** @type {DynamicClass} */ (DynClass).prototype[name] = new Function(...params, bodyStr);
    }
  }

  Object.defineProperty(DynClass, "name", { value: classDef.title, configurable: true });
  return DynClass;
}
