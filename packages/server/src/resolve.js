/** Resolve.js — Generic $src module proxy + timing: "server" function proxy */

import { resolve, relative, dirname } from "node:path";
import { readFileSync } from "node:fs";

/**
 * Handle POST /**jx_resolve** — proxy $prototype + $src entries.
 *
 * @param {Request} req
 * @param {string} root
 */
export async function handleResolve(req, root) {
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
    if ($base) {
      const docUrlPath = new URL($base).pathname;
      const docDir = docUrlPath.slice(0, docUrlPath.lastIndexOf("/") + 1);
      moduleAbsPath = resolve(resolve(root, "." + docDir), $src);
    } else {
      moduleAbsPath = resolve(root, $src);
    }
  } catch (/** @type {any} */ e) {
    return new Response(`Cannot resolve $src "${$src}": ${e.message}`, { status: 400 });
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
      const instance = /** @type {any} */ (new DynClass(config));
      const value =
        typeof instance.resolve === "function"
          ? await instance.resolve()
          : "value" in instance
            ? instance.value
            : instance;
      return Response.json(value);
    } catch (/** @type {any} */ e) {
      return Response.json({ error: e.message }, { status: 500 });
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
  } catch (/** @type {any} */ e) {
    return new Response(`Cannot resolve $src: ${e.message}`, { status: 400 });
  }

  let mod;
  try {
    mod = await import(moduleAbsPath);
  } catch (/** @type {any} */ e) {
    return new Response(`Failed to import "${$src}": ${e.message}`, { status: 500 });
  }

  const fn = mod[xport] ?? mod.default?.[xport];
  if (typeof fn !== "function") {
    return new Response(`Export "${xport}" not found in "${$src}"`, { status: 500 });
  }

  try {
    const result = await fn(args);
    return Response.json(result ?? null);
  } catch (/** @type {any} */ e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

/**
 * Dynamically construct a class from a .class.json schema definition. Server-side variant — no
 * private field limitations.
 *
 * @param {any} classDef
 */
function classFromSchema(classDef) {
  const fields = classDef.$defs?.fields ?? {};
  const ctor = classDef.$defs?.constructor;
  const methods = classDef.$defs?.methods ?? {};

  class DynClass {
    constructor(config = {}) {
      const self = /** @type {any} */ (this);
      const cfg = /** @type {Record<string, any>} */ (config);
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
    const params = (method.parameters ?? []).map((/** @type {any} */ p) => {
      if (p.$ref) return p.$ref.split("/").pop();
      return p.identifier ?? p.name ?? "arg";
    });
    const bodyStr = Array.isArray(method.body) ? method.body.join("\n") : (method.body ?? "");

    if (method.role === "accessor") {
      /** @type {any} */
      const descriptor = {};
      if (method.getter) descriptor.get = new Function(method.getter.body);
      if (method.setter) {
        const sp = (method.setter.parameters ?? []).map(
          (/** @type {any} */ p) => p.$ref?.split("/").pop() ?? "v",
        );
        descriptor.set = new Function(...sp, method.setter.body);
      }
      Object.defineProperty(DynClass.prototype, name, { ...descriptor, configurable: true });
    } else if (method.scope === "static") {
      /** @type {any} */ (DynClass)[name] = new Function(...params, bodyStr);
    } else {
      /** @type {any} */ (DynClass.prototype)[name] = new Function(...params, bodyStr);
    }
  }

  Object.defineProperty(DynClass, "name", { value: classDef.title, configurable: true });
  return DynClass;
}
