/**
 * Prototype-resolver.js — Generic $prototype resolution at build time
 *
 * Mirrors the runtime's import-map → .class.json → $implementation → resolve() pipeline, but runs
 * at compile time using filesystem APIs.
 *
 * Any state entry with a $prototype that maps to a .class.json via doc.imports gets resolved: the
 * class is instantiated, .resolve() is called, and the state entry is replaced with the resolved
 * value.
 *
 * This is the extension point for content sources (Markdown, CSV, etc.) — each provides a
 * .class.json + JS implementation, and the compiler resolves them generically.
 *
 * @module prototype-resolver
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

/**
 * Prototype names handled elsewhere (builtins + legacy content system). These are skipped by the
 * generic resolver.
 */
const SKIP_PROTOTYPES = new Set(["Function", "LocalStorage", "SessionStorage", "Array"]);

/**
 * Keys reserved by the Jx prototype system — stripped before passing config to the external class
 * constructor. Mirrors runtime's EXTERNAL_RESERVED.
 */
const RESERVED_KEYS = new Set([
  "$prototype",
  "$src",
  "$export",
  "timing",
  "default",
  "description",
]);

/**
 * Resolve all generic $prototype entries in a document's state at build time.
 *
 * For each state entry with a $prototype that: 1. Is not a builtin (Function, Array, etc.) 2. Maps
 * to a .class.json path via doc.imports
 *
 * The resolver: - Reads the .class.json from disk - Follows $implementation to import the JS module
 * - Instantiates the class with the config - Calls .resolve() and replaces the state entry with the
 * result
 *
 * @param {JxMutableNode | JxDocument} doc - The page document (mutated in place)
 * @param {{ sourcePath?: string; _pathParams?: Record<string, string> }} route - Route info
 * @param {string} projectRoot - Absolute path to the project root
 * @param {{ config?: Record<string, unknown>; contentTypes?: Map<string, unknown[]> }} [projectContext] -
 *   Project-level context injected into all classes
 */
export async function resolvePrototypes(
  doc: JxMutableNode | JxDocument,
  route: { sourcePath?: string; _pathParams?: Record<string, string> },
  projectRoot: string,
  projectContext: { config?: Record<string, unknown>; contentTypes?: Map<string, unknown[]> } = {},
) {
  const imports = doc.imports ?? {};
  const state = doc.state;
  if (!state) return;

  for (const [key, def] of Object.entries(state)) {
    if (!def || typeof def !== "object" || !def.$prototype) continue;
    if (SKIP_PROTOTYPES.has(def.$prototype)) continue;
    // Only resolve timing: "compiler" (or unset timing with a .class.json mapping).
    // Leave timing: "server" and timing: "client" for their respective pipelines.
    if (def.timing && def.timing !== "compiler") continue;

    // Look up in imports if no $src already set
    if (!def.$src) {
      const mapped = imports[def.$prototype];
      if (!mapped) continue;
      def.$src = mapped;
    }

    try {
      const resolved = await resolveClassPrototype(def, route, projectRoot, state, projectContext);
      // Preserve timing metadata on the resolved value so compilePage() can strip it
      if (def.timing && resolved && typeof resolved === "object" && !Array.isArray(resolved)) {
        resolved.timing = def.timing;
      }
      state[key] = resolved;
    } catch (err) {
      console.warn(
        `prototype-resolver: failed to resolve "${key}" ($prototype: "${def.$prototype}"):`,
        (err as Error).message,
      );
    }
  }
}

/**
 * Resolve a single $prototype entry via its .class.json.
 *
 * @param {Record<string, any>} def - The state entry definition
 * @param {{ sourcePath?: string; _pathParams?: Record<string, string> }} route
 * @param {string} projectRoot
 * @param {Record<string, unknown>} state - The full page state object
 * @param {{ config?: Record<string, unknown>; contentTypes?: Map<string, unknown[]> }} projectContext
 * @returns {Promise<any>} The resolved value
 */
async function resolveClassPrototype(
  def: Record<string, any>,
  route: { sourcePath?: string; _pathParams?: Record<string, string> },
  projectRoot: string,
  state: Record<string, unknown>,
  projectContext: { config?: Record<string, unknown>; contentTypes?: Map<string, unknown[]> },
) {
  const src = def.$src;

  // 1. Resolve .class.json path — handles both npm specifiers and relative paths
  let classJsonPath;
  if (src.startsWith("./") || src.startsWith("../")) {
    // Relative path — resolve from page directory
    classJsonPath = route.sourcePath
      ? resolve(dirname(route.sourcePath), src)
      : resolve(projectRoot, src);
  } else {
    // npm/bare specifier — use createRequire from the project root to walk node_modules
    const require = createRequire(resolve(projectRoot, "package.json"));
    classJsonPath = require.resolve(src);
  }

  // 2. Read and parse .class.json
  const classJsonText = readFileSync(classJsonPath, "utf-8");
  const classDef = JSON.parse(classJsonText);

  if (!classDef.$implementation) {
    throw new Error(`${src} has no $implementation field`);
  }

  // 3. Resolve $implementation relative to .class.json location
  const classJsonURL = pathToFileURL(classJsonPath).href;
  const implURL = new URL(classDef.$implementation, classJsonURL).href;

  // 4. Import the module
  const mod = await import(implURL);

  // 5. Find the exported class
  const exportName = def.$export ?? classDef.title ?? def.$prototype;
  const ExportedClass = mod[exportName] ?? mod.default?.[exportName];
  if (!ExportedClass) {
    throw new Error(`Module ${classDef.$implementation} does not export "${exportName}"`);
  }

  // 6. Build config — filter out reserved keys
  const config: Record<string, any> = {};
  for (const [k, v] of Object.entries(def)) {
    if (!RESERVED_KEYS.has(k)) config[k] = v;
  }

  // Auto-set basePath from the page's directory if the config has `src` but no `basePath`
  if (config.src && !config.basePath && route.sourcePath) {
    config.basePath = dirname(route.sourcePath);
  }

  // Inject universal context — available to all classes
  config._project = {
    config: projectContext.config ?? null,
    contentTypes: projectContext.contentTypes ?? null,
    root: projectRoot,
  };
  config._document = { route, state };

  // 7. Instantiate and resolve
  const instance = new ExportedClass(config);
  if (typeof instance.resolve === "function") {
    return await instance.resolve();
  }
  return instance;
}
