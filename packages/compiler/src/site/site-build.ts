/**
 * Site-build — Multi-page build orchestrator
 *
 * Coordinates the full site build pipeline: 1. Load project.json 2. Discover pages/ routes 3.
 * Expand dynamic routes ($paths) 4. For each route: resolve layout, merge $head, inject context,
 * compile 5. Emit compiled files to dist/ 6. Generate redirects
 *
 * This is the Phase 1 implementation of site-architecture spec §12.
 */

import {
  writeFileSync,
  copyFileSync,
  mkdirSync,
  existsSync,
  rmSync,
  cpSync,
  readdirSync,
} from "node:fs";
import { resolve, dirname, join } from "node:path";
import { loadProjectConfig } from "./site-loader.ts";
import { discoverPages, expandDynamicRoutes, readPageDocument } from "./pages-discovery.ts";
import { buildProjectFormatRegistry } from "./format-host.ts";
import type { FormatRegistry } from "@jxsuite/schema/format-registry";
import { resolveLayout } from "./layout-resolver.ts";
import { mergeHead, renderHead } from "./head-merger.ts";
import { injectContext } from "./context-injection.ts";
import { compile, compileServer, compileSiteServer } from "../compiler.ts";
import { compileElement } from "../targets/compile-element.ts";
import {
  buildInitialScope,
  isTemplateString,
  evaluateStaticTemplate,
  preRenderComponentHtml,
  isComponentFullyStatic,
  buildComponentCSS,
  collectServerEntries,
  renderStaticNode,
  resolveStaticValue,
  resolveRefValue,
  DEFAULT_REACTIVITY_SRC,
  DEFAULT_LIT_HTML_SRC,
} from "../shared.ts";
import { loadContentTypes, loadContentConfig, resolveContentTypeRefs } from "./content-loader.ts";
import { resolvePrototypes } from "./prototype-resolver.ts";
import { transformImageNodes } from "./image-transform.ts";
import { loadCache, saveCache, getImageCacheDir } from "./image-cache.ts";
import type { ImageConfig } from "./image-optimizer.ts";
import type { ImageMetaCache } from "./image-transform.ts";
import type {
  JxElement,
  JxMutableNode,
  JxStyle,
  JxHeadEntry,
  JxStateDefinition,
  ProjectConfig,
} from "@jxsuite/schema/types";
import type { ContentLoaderEntry } from "@jxsuite/parser/types";
import type { SiteRoute } from "../types.ts";

/**
 * Build an entire Jx site from a project directory.
 *
 * @param {string} projectRoot - Absolute path to the project root (contains project.json)
 * @param {object} [options]
 * @param {boolean} [options.clean] - Remove outDir before building
 * @param {boolean} [options.verbose] - Log progress
 * @returns {Promise<{ routes: number; files: number; errors: string[] }>}
 */
export async function buildSite(
  projectRoot: string,
  options: {
    clean?: boolean;
    verbose?: boolean;
  } = {},
) {
  const { clean = true, verbose = false } = options;
  const errors: string[] = [];
  const log = verbose ? console.log.bind(console) : () => {};

  // ── 1. Load project configuration ──────────────────────────────────────────
  log("Loading project.json...");
  const { config: projectConfig } = loadProjectConfig(projectRoot);

  const outDir = resolve(projectRoot, projectConfig.build.outDir);
  const pagesDir = resolve(projectRoot, "pages");
  const publicDir = resolve(projectRoot, "public");
  const trailingSlash = projectConfig.build.trailingSlash ?? "always";

  // ── 1b. Build the format registry from project imports ─────────────────
  const formatRegistry = await buildProjectFormatRegistry(projectRoot, projectConfig);
  if (formatRegistry.entries.length > 0) {
    log(
      `  Registered ${formatRegistry.entries.length} format(s): ${formatRegistry.entries
        .map((e) => e.name)
        .join(", ")}`,
    );
  }

  // ── 2. Clean output directory ───────────────────────────────────────────
  if (clean && existsSync(outDir)) {
    rmSync(outDir, { recursive: true, force: true });
  }
  mkdirSync(outDir, { recursive: true });

  // ── 3. Discover routes ──────────────────────────────────────────────────
  if (!existsSync(pagesDir)) {
    throw new Error(`pages/ directory not found in ${projectRoot}`);
  }

  log("Discovering pages...");
  const staticRoutes = await discoverPages(pagesDir, formatRegistry);
  log(`  Found ${staticRoutes.length} page(s)`);

  // ── 3b. Load content types ─────────────────────────────────────────────
  log("Loading content types...");
  const contentTypes = await loadContentTypes(projectRoot, projectConfig, formatRegistry);
  if (contentTypes.size > 0) {
    log(`  Loaded ${contentTypes.size} content type(s): ${[...contentTypes.keys()].join(", ")}`);
    // Resolve cross-content-type $ref references
    const contentConfig = loadContentConfig(projectRoot, projectConfig);
    if (contentConfig) {
      resolveContentTypeRefs(contentTypes, contentConfig.config);
    }
  }

  // ── 4. Expand dynamic routes ────────────────────────────────────────────
  const routes = await expandDynamicRoutes(staticRoutes, projectRoot, contentTypes, formatRegistry);
  log(`  ${routes.length} route(s) after expansion`);

  let fileCount = 0;

  // ── 5. Compile site components ──────────────────────────────────────────
  const componentsDir = resolve(projectRoot, "components");
  const compiledComponentTags: string[] = [];
  const componentCSS: Map<string, string> = new Map(); // tagName → CSS text
  const componentDefs: Map<string, JxElement> = new Map(); // tagName → parsed component definition
  if (existsSync(componentsDir)) {
    log("Compiling components...");
    const componentExtensions = [".json", ...formatRegistry.documentExtensions("component")];
    const componentFiles = readdirSync(componentsDir).filter((f: string) =>
      componentExtensions.some((ext) => f.endsWith(ext)),
    );
    const componentOutDir = resolve(outDir, "components");
    mkdirSync(componentOutDir, { recursive: true });

    for (const file of componentFiles) {
      try {
        const componentPath = resolve(componentsDir, file);
        const result = await compileElement(componentPath, {
          $media: projectConfig.$media,
          formats: formatRegistry,
        });
        for (const f of result.files) {
          const outName = f.path.includes("/") ? (f.path.split("/").pop() as string) : f.path;
          writeFileSync(resolve(componentOutDir, outName), f.content, "utf8");
          if (f.tagName) compiledComponentTags.push(f.tagName);
          fileCount++;
        }

        // Pre-render component HTML scaffold and CSS sidecar
        const doc = await readPageDocument(componentPath, formatRegistry);
        if (doc.tagName) {
          componentDefs.set(doc.tagName, doc);
          const css = buildComponentCSS(doc.tagName, doc.style, doc, projectConfig.$media ?? {});
          if (css) {
            componentCSS.set(doc.tagName, css);
            writeFileSync(resolve(componentOutDir, `${doc.tagName}.css`), css, "utf8");
            fileCount++;
          }
        }
      } catch (e) {
        const err = e as Error;
        errors.push(`Error compiling component ${file}: ${err.message}`);
        console.error(`Error compiling component ${file}: ${err.message}`);
      }
    }
    log(
      `  Compiled ${compiledComponentTags.length} component(s): ${compiledComponentTags.join(", ")}`,
    );
  }

  // ── 5b. Collect server entries from components (for site-wide bundling) ──
  /** @type {{ exportName: string; src: string }[]} */
  const siteServerEntries = [];
  if (projectConfig.build.adapter) {
    for (const [, doc] of componentDefs) {
      const entries = collectServerEntries(doc);
      for (const entry of entries) {
        const resolvedSrc = "./components/" + entry.src.replace(/^\.\//, "");
        siteServerEntries.push({
          exportName: entry.exportName,
          src: resolvedSrc,
        });
      }
    }
  }

  // ── 6. Compile each route ───────────────────────────────────────────────

  const cfImages = projectConfig.images.optimize && projectConfig.images.service === "cloudflare";
  const imageCache = projectConfig.images.optimize && !cfImages ? loadCache(projectRoot) : null;
  /** @type {import("./image-transform.ts").ImageMetaCache | null} */
  const imageMetaCache = cfImages ? new Map() : null;
  if (cfImages) {
    console.log(
      `images.service is "cloudflare" — srcsets use /cdn-cgi/image transform URLs. ` +
        `Ensure Image Transformations are enabled for your zone (Cloudflare dashboard → ` +
        `Images → Transformations); these URLs do not work on *.pages.dev / *.workers.dev previews.`,
    );
  }

  for (const route of routes) {
    try {
      log(`  Compiling ${route.urlPattern} ...`);
      const result = await compilePage(
        route as unknown as SiteRoute,
        projectConfig,
        projectRoot,
        contentTypes,
        imageCache,
        componentDefs,
        imageMetaCache,
        formatRegistry,
      );

      // Determine which component tags are fully static (for script omission)
      const staticTags: Set<string> = new Set();
      for (const [tag, def] of componentDefs) {
        if (isComponentFullyStatic(def)) staticTags.add(tag);
      }

      // Inject component CSS and JS scripts
      if (compiledComponentTags.length > 0) {
        result.html = injectComponentScripts(
          result.html,
          compiledComponentTags,
          componentCSS,
          staticTags,
        );
      }

      // Determine output path
      const outPath = routeToOutputPath(route.urlPattern, outDir, trailingSlash);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, result.html, "utf8");
      fileCount++;

      // Write serialized export sidecars alongside HTML (formats with exportTarget: true)
      for (const fmt of formatRegistry.withCapability("serialize")) {
        if (!fmt.exportTarget) continue;
        try {
          const content = (await fmt.call("serialize", result.doc, {
            mode: "export",
            componentDefs,
            evaluateTemplate: (value: string, scope: Record<string, unknown>) => {
              if (!isTemplateString(value)) return undefined;
              return evaluateStaticTemplate(value, scope) ?? value;
            },
            buildScope: (state: Record<string, JxStateDefinition>) =>
              buildInitialScope(state, null),
          })) as string;
          if (content) {
            const sidecarPath = outPath.replace(/\.html$/, fmt.extensions[0]);
            writeFileSync(sidecarPath, content, "utf8");
            fileCount++;
          }
        } catch (e) {
          const err = e as Error;
          errors.push(`Error exporting ${fmt.name} for ${route.urlPattern}: ${err.message}`);
        }
      }

      // Write any additional files (island modules, etc.)
      for (const file of result.files) {
        const filePath = resolve(dirname(outPath), file.path);
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, file.content, "utf8");
        fileCount++;
      }

      // Write server handler if present
      if (result.serverHandler) {
        const serverPath = resolve(dirname(outPath), "_server.js");
        writeFileSync(serverPath, result.serverHandler, "utf8");
        fileCount++;
      }
    } catch (e) {
      const err = e as Error;
      const msg = `Error compiling ${route.urlPattern}: ${err.message}`;
      errors.push(msg);
      console.error(msg);
    }
  }

  // ── 6b. Save image cache and copy variants to dist ──────────────────────
  if (imageCache && projectConfig.images.optimize) {
    saveCache(projectRoot, imageCache);
    const cacheOptimizedDir = resolve(getImageCacheDir(projectRoot), "_optimized");
    if (existsSync(cacheOptimizedDir)) {
      const distOptimizedDir = resolve(outDir, "images/_optimized");
      mkdirSync(distOptimizedDir, { recursive: true });
      cpSync(cacheOptimizedDir, distOptimizedDir, { recursive: true });
    }
    const totalImages = Object.keys(imageCache.entries).length;
    if (totalImages > 0) {
      log(`  Optimized ${totalImages} image(s)`);
    }
  }

  // ── 6c. Generate site-wide server worker ────────────────────────────────
  if (projectConfig.build.adapter) {
    const adapter = projectConfig.build.adapter;
    log("Generating site-wide server worker...");

    const deduped = new Map();
    for (const entry of siteServerEntries) {
      if (!deduped.has(entry.exportName)) deduped.set(entry.exportName, entry);
    }

    // Cloudflare Pages uses advanced mode (_worker.js inside the build output) — the
    // functions/ directory convention only works from the project root, not from dist/.
    // A static-only Pages site needs no worker at all.
    const skipWorker = adapter === "cloudflare-pages" && deduped.size === 0;
    const workerSource = skipWorker ? null : compileSiteServer([...deduped.values()], { adapter });

    if (workerSource) {
      const workerName = adapter === "cloudflare-pages" ? "_worker.js" : "worker.js";
      writeFileSync(resolve(outDir, workerName), workerSource, "utf8");
      fileCount++;
      log(`  Generated dist/${workerName} (${deduped.size} server function(s))`);

      if (adapter === "cloudflare-pages") {
        // Only invoke the worker for server routes; everything else stays static.
        writeFileSync(
          resolve(outDir, "_routes.json"),
          JSON.stringify({ version: 1, include: ["/_jx/*"], exclude: [] }, null, 2) + "\n",
          "utf8",
        );
        fileCount++;
      }

      // Copy server source files into dist/components/ so worker imports resolve
      const distComponentsDir = resolve(outDir, "components");
      mkdirSync(distComponentsDir, { recursive: true });
      for (const { src } of deduped.values()) {
        const srcFile = resolve(projectRoot, src.replace(/^\.\//, ""));
        const destFile = resolve(distComponentsDir, src.replace(/^\.\/components\//, ""));
        if (existsSync(srcFile)) {
          copyFileSync(srcFile, destFile);
        }
      }
    }
  }

  // ── 7. Generate redirects ───────────────────────────────────────────────
  if (projectConfig.redirects && Object.keys(projectConfig.redirects).length > 0) {
    log("Generating redirects...");
    const redirectFiles = generateRedirects(projectConfig.redirects, outDir);
    fileCount += redirectFiles;
  }

  // ── 7. Copy public/ assets ──────────────────────────────────────────────
  if (existsSync(publicDir)) {
    log("Copying public/ assets...");
    cpSync(publicDir, outDir, { recursive: true });
  }

  // ── 8. Copy declarative file mappings ──────────────────────────────────
  if (projectConfig.copy) {
    log("Copying mapped files...");
    for (const [src, dest] of Object.entries(projectConfig.copy)) {
      const srcPath = resolve(projectRoot, src as string);
      const destPath = resolve(outDir, dest as string);
      mkdirSync(dirname(destPath), { recursive: true });
      cpSync(srcPath, destPath);
    }
  }

  // ── 9. Summary ──────────────────────────────────────────────────────────
  log(`\nBuild complete: ${routes.length} routes, ${fileCount} files`);
  if (errors.length > 0) {
    log(`  ${errors.length} error(s)`);
  }

  return { routes: routes.length, files: fileCount, errors };
}

/**
 * Compile a single page within the site build context.
 *
 * Pipeline: load JSON → resolve layout → inject context → merge head → compile
 *
 * @param {SiteRoute} route
 * @param {ProjectConfig} projectConfig
 * @param {string} projectRoot
 * @param {Map<string, ContentLoaderEntry[]>} [contentTypes]
 * @param {import("./image-cache.js").CacheManifest | null} [imageCache]
 * @param {Map<string, JxElement>} [componentDefs]
 * @param {ImageMetaCache | null} [imageMetaCache] - Set when images.service is "cloudflare"
 * @returns {Promise<{
 *   html: string;
 *   files: { path: string; content: string; tagName?: string }[];
 *   serverHandler: string | null;
 *   doc: JxDocument;
 * }>}
 */
async function compilePage(
  route: SiteRoute,
  projectConfig: ProjectConfig,
  projectRoot: string,
  contentTypes: Map<string, ContentLoaderEntry[]> = new Map(),
  imageCache: import("./image-cache.js").CacheManifest | null = null,
  componentDefs: Map<string, JxElement> = new Map(),
  imageMetaCache: ImageMetaCache | null = null,
  formatRegistry?: FormatRegistry,
) {
  // Load the raw page document (.json natively, other formats via the registry)
  const pageDoc = await readPageDocument(route.sourcePath as string, formatRegistry);

  // Resolve layout (wraps page in layout with slot distribution)
  const layoutDoc = resolveLayout(pageDoc, projectConfig, projectRoot);

  // Extract head arrays before they get lost in the merge
  const pageHead = pageDoc.$head ?? layoutDoc._pageHead ?? ([] as JxHeadEntry[]);
  const layoutHead = layoutDoc.$head ?? [];
  const pageTitle = pageDoc.title ?? layoutDoc._pageTitle ?? (null as string | null);

  // Clean up internal properties
  delete layoutDoc._pageHead;
  delete layoutDoc._pageTitle;

  // Inject $site and $page context
  injectContext(layoutDoc, projectConfig, route, contentTypes, projectRoot);

  // Resolve generic $prototype entries via .class.json imports
  await resolvePrototypes(layoutDoc, route, projectRoot, {
    config: projectConfig,
    contentTypes,
  });

  // Build scope from resolved state so template strings in title/$head can be evaluated
  const scope = buildInitialScope(layoutDoc.state ?? {});

  // Determine the page title — resolve template strings against the scope
  let title = pageTitle ?? projectConfig.name ?? "Jx Site";
  if (typeof title === "string" && isTemplateString(title)) {
    title = evaluateStaticTemplate(title, scope) ?? (title as string);
  }

  // Resolve template strings in $head entries
  const resolvedPageHead = resolveHeadTemplates(pageHead, scope);
  const resolvedLayoutHead = resolveHeadTemplates(layoutHead, scope);

  // Resolve template strings in the document tree (innerHTML, textContent, style, attributes)
  // so that timing: "compiler" data is baked into the static HTML
  resolveDocTemplates(layoutDoc, scope);

  // Expand registered custom elements (apply $props, pre-render, mark static/prerendered)
  expandComponents(layoutDoc, componentDefs);

  // Strip resolved timing: "compiler" state entries — they're now baked into the tree
  // and keeping them would cause isDynamic() to misclassify the page as dynamic.
  // Also strip resolved content arrays (from ContentCollection) that have been
  // baked into unrolled map templates.
  if (layoutDoc.state) {
    for (const [key, def] of Object.entries(layoutDoc.state)) {
      if (key === "$site" || key === "$page") continue;
      if (
        def &&
        typeof def === "object" &&
        !Array.isArray(def) &&
        (def as JxMutableNode).timing === "compiler"
      ) {
        delete layoutDoc.state[key];
      } else if (Array.isArray(def)) {
        delete layoutDoc.state[key];
      }
    }
  }

  // Resolve bare npm specifiers in $head (e.g. "@pkg/name/file.css" → "/node_modules/@pkg/name/file.css")
  const resolvedSiteHead = resolveHeadBareSpecifiers(projectConfig.$head ?? []);

  // Merge $head from site + layout + page
  const mergedHead = mergeHead(resolvedSiteHead, resolvedLayoutHead, resolvedPageHead, {
    title,
    charset: projectConfig.defaults?.charset ?? "utf-8",
    ...(projectConfig.name != null && { siteName: projectConfig.name }),
    ...(projectConfig.url != null && { siteUrl: projectConfig.url }),
    pageUrl: route.urlPattern,
  });

  // Merge project-level $media into the layout document so responsive queries are available
  if (projectConfig.$media) {
    layoutDoc.$media = { ...projectConfig.$media, ...layoutDoc.$media };
  }

  // Transform <img> nodes for responsive image optimization
  if (projectConfig.images?.optimize && (imageCache || imageMetaCache)) {
    await transformImageNodes(
      layoutDoc,
      projectConfig.images as ImageConfig,
      projectRoot,
      imageCache,
      imageMetaCache ?? undefined,
    );
  }

  // Compile the document using the existing compiler
  const result = await compile(layoutDoc, {
    title,
    lang: projectConfig.defaults?.lang ?? "en",
    projectStyle: projectConfig.style ?? null,
  });

  // Post-process: inject merged <head> content into the compiled HTML
  result.html = injectHead(result.html, mergedHead, projectConfig.defaults?.lang ?? "en");

  // Inject <script type="module"> for npm $elements (cherry-picked component imports)
  const npmElements = (layoutDoc.$elements ?? []).filter(
    (e: JxElement | string) => typeof e === "string" && !e.startsWith("./") && !e.startsWith("../"),
  );
  if (npmElements.length > 0) {
    result.html = injectNpmElementScripts(result.html, /** @type {string[]} */ npmElements);
  }

  // Compile server handler if applicable (skip when provider bundles site-wide)
  let serverHandler: string | null = null;
  if (!projectConfig.build?.adapter) {
    try {
      const serverResult = await compileServer(route.sourcePath as string);
      if (serverResult) {
        serverHandler = serverResult;
      }
    } catch {
      // No server entries — that's fine
    }
  }

  return {
    html: result.html,
    files: result.files,
    serverHandler,
    doc: layoutDoc,
  };
}

/**
 * Resolve template strings in $head entries against the compiled scope.
 *
 * @param {JxHeadEntry[]} headEntries
 * @param {Record<string, unknown>} scope
 * @returns {JxHeadEntry[]}
 */
function resolveHeadTemplates(headEntries: JxHeadEntry[], scope: Record<string, unknown>) {
  return headEntries.map((entry: JxHeadEntry) => {
    if (!entry || typeof entry !== "object") return entry;
    const resolved = { ...entry };
    if (resolved.attributes) {
      resolved.attributes = { ...resolved.attributes };
      for (const [k, v] of Object.entries(resolved.attributes)) {
        if (typeof v === "string" && isTemplateString(v)) {
          resolved.attributes[k] = evaluateStaticTemplate(v, scope) ?? (v as string | boolean);
        }
      }
    }
    if (typeof resolved.textContent === "string" && isTemplateString(resolved.textContent)) {
      resolved.textContent =
        evaluateStaticTemplate(resolved.textContent, scope) ??
        (resolved.textContent as string | undefined);
    }
    return resolved;
  });
}

/**
 * Resolve bare npm specifiers in $head entry attributes (href, src). e.g.
 * "@shoelace-style/shoelace/dist/themes/light.css" →
 * "/node_modules/@shoelace-style/shoelace/dist/themes/light.css"
 *
 * @param {JxHeadEntry[]} headEntries
 * @returns {JxHeadEntry[]}
 */
function resolveHeadBareSpecifiers(headEntries: JxHeadEntry[]) {
  return headEntries.map((entry: JxHeadEntry) => {
    if (!entry || typeof entry !== "object" || !entry.attributes) return entry;
    const resolved = { ...entry, attributes: { ...entry.attributes } };
    for (const key of ["href", "src"]) {
      const val = resolved.attributes[key];
      if (typeof val === "string" && isBareSpecifier(val)) {
        resolved.attributes[key] = `/node_modules/${val}`;
      }
    }
    return resolved;
  });
}

/**
 * Check if a string is a bare npm specifier (not a relative/absolute path or URL).
 *
 * @param {string} s
 * @returns {boolean}
 */
function isBareSpecifier(s: string) {
  return (
    !s.startsWith("/") &&
    !s.startsWith("./") &&
    !s.startsWith("../") &&
    !s.startsWith("http") &&
    !s.startsWith("data:")
  );
}

/**
 * Deep-clone a map template, resolving template strings and $ref values against the given scope.
 *
 * @param {JxMutableNode} template
 * @param {Record<string, unknown>} scope
 * @returns {JxMutableNode}
 */
function expandMapTemplate(template: JxMutableNode, scope: Record<string, unknown>) {
  if (!template || typeof template !== "object") return template;
  const node = {} as JxMutableNode;
  for (const [k, v] of Object.entries(template)) {
    if (k === "children" && Array.isArray(v)) {
      node.children = v.map((child) => {
        if (typeof child === "string") return child;
        return expandMapTemplate(/** @type {JxMutableNode} */ child, scope);
      });
    } else if (k === "style" && v && typeof v === "object") {
      const style = { ...v } as Record<string, unknown>;
      for (const [sk, sv] of Object.entries(style)) {
        if (typeof sv === "string" && isTemplateString(sv)) {
          style[sk] = evaluateMapTemplate(sv, scope) ?? sv;
        }
      }
      node.style = style;
    } else if (k === "attributes" && v && typeof v === "object") {
      const attrs = { ...v } as Record<string, unknown>;
      for (const [ak, av] of Object.entries(attrs)) {
        if (typeof av === "string" && isTemplateString(av)) {
          attrs[ak] = evaluateMapTemplate(av, scope) ?? av;
        }
      }
      node.attributes = attrs;
    } else if (k === "$props" && v && typeof v === "object") {
      const props = { ...v } as Record<string, unknown>;
      for (const [pk, pv] of Object.entries(props)) {
        if (typeof pv === "string" && isTemplateString(pv)) {
          const resolved = evaluateMapTemplate(pv, scope);
          // null = evaluation error → keep template string; undefined = missing data → use null
          props[pk] = resolved !== null ? (resolved ?? null) : pv;
        }
      }
      node.$props = props;
    } else if (typeof v === "string" && isTemplateString(v)) {
      node[k] = evaluateMapTemplate(v, scope) ?? v;
    } else {
      node[k] = v;
    }
  }
  return node;
}

/**
 * Evaluate a template string in the context of a mapped array item. Exposes `item`, `index`,
 * `state`, and `$map` as local variables.
 *
 * @param {string} str
 * @param {Record<string, unknown>} scope
 * @returns {unknown}
 */
function evaluateMapTemplate(str: string, scope: Record<string, unknown>) {
  try {
    const item = (scope.$map as Record<string, unknown>)?.item;
    const index = (scope.$map as Record<string, unknown>)?.index;
    const singleExprMatch = str.match(/^\$\{(.+)\}$/s);
    if (singleExprMatch) {
      const fn = new Function("state", "$map", "item", "index", `return (${singleExprMatch[1]})`);
      return fn(scope, scope.$map, item, index);
    }
    const fn = new Function("state", "$map", "item", "index", `return \`${str}\``);
    return fn(scope, scope.$map, item, index);
  } catch {
    return null;
  }
}

/**
 * Recursively resolve template strings in a document tree against a scope. Mutates the document in
 * place — evaluates ${...} in innerHTML, textContent, style values, and attribute values.
 *
 * @param {JxElement | string} node
 * @param {Record<string, unknown>} scope
 */
function resolveDocTemplates(node: JxElement | string, scope: Record<string, unknown>) {
  if (!node || typeof node !== "object") return;

  if (typeof node.innerHTML === "string" && isTemplateString(node.innerHTML)) {
    const resolved = evaluateStaticTemplate(node.innerHTML, scope);
    if (resolved != null) {
      // Encode any remaining `${` as HTML entities so the compile phase won't
      // re-interpret them as template expressions. After resolution, any `${` in the
      // result is literal content (e.g., code examples), not an intentional template.
      node.innerHTML = String(resolved).replaceAll("${", "&#36;{");
    }
  }
  if (typeof node.textContent === "string" && isTemplateString(node.textContent)) {
    node.textContent =
      evaluateStaticTemplate(node.textContent, scope) ?? (node.textContent as string | null);
  }
  if (node.style && typeof node.style === "object") {
    for (const [k, v] of Object.entries(node.style)) {
      if (typeof v === "string" && isTemplateString(v)) {
        node.style[k] = evaluateStaticTemplate(v, scope) ?? (v as string | number | JxStyle);
      }
    }
  }
  if (node.attributes && typeof node.attributes === "object") {
    for (const [k, v] of Object.entries(node.attributes)) {
      if (typeof v === "string" && isTemplateString(v)) {
        node.attributes[k] = evaluateStaticTemplate(v, scope) ?? v;
      }
    }
  }
  if (node.$props && typeof node.$props === "object") {
    for (const [k, v] of Object.entries(node.$props)) {
      if (typeof v === "string" && isTemplateString(v)) {
        node.$props[k] = evaluateStaticTemplate(v, scope) ?? v;
      }
    }
  }
  const rawChildren = node.children as unknown;
  if (
    rawChildren &&
    typeof rawChildren === "object" &&
    !Array.isArray(rawChildren) &&
    (rawChildren as JxMutableNode).$prototype === "Array"
  ) {
    const arrayDef = rawChildren as JxMutableNode;
    const itemsSrc = arrayDef.items;
    let items = null;
    if (itemsSrc && typeof itemsSrc === "object" && (itemsSrc as JxMutableNode).$ref) {
      const ref = (itemsSrc as JxMutableNode).$ref as string;
      items = resolveRefValue(ref, scope);
    } else if (Array.isArray(itemsSrc)) {
      items = itemsSrc;
    }
    if (Array.isArray(items) && arrayDef.map) {
      node.children = items.map((item, index) => {
        const childScope = Object.create(scope);
        childScope.$map = { item, index };
        childScope["$map/item"] = item;
        childScope["$map/index"] = index;
        const expanded = expandMapTemplate(arrayDef.map, childScope);
        resolveDocTemplates(expanded as JxElement, childScope);
        return expanded;
      }) as (string | JxElement)[];
      return;
    }
  }
  if (typeof rawChildren === "string" && isTemplateString(rawChildren)) {
    const resolved = evaluateStaticTemplate(rawChildren, scope);
    if (Array.isArray(resolved)) {
      const resolvedNodes = resolved as (JxElement | string)[];
      node.children = resolvedNodes;
      for (const child of resolvedNodes) {
        resolveDocTemplates(child, scope);
      }
    }
  } else if (Array.isArray(node.children)) {
    let i = 0;
    while (i < node.children.length) {
      const child = node.children[i];
      if (typeof child === "string" && isTemplateString(child)) {
        const resolved = evaluateStaticTemplate(child, scope);
        if (Array.isArray(resolved)) {
          const resolvedNodes = resolved as (JxElement | string)[];
          node.children.splice(i, 1, ...resolvedNodes);
          for (const spliced of resolvedNodes) {
            resolveDocTemplates(spliced, scope);
          }
          i += resolvedNodes.length;
          continue;
        }
      }
      resolveDocTemplates(child, scope);
      i++;
    }
  }
}

/**
 * Walk the document tree and expand registered custom elements in-place. Applies $props via
 * preRenderComponentHtml, marks static/prerendered.
 *
 * @param {JxElement | string} node
 * @param {Map<string, JxElement>} componentDefs
 */
function expandComponents(node: JxElement | string, componentDefs: Map<string, JxElement>) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((n) => expandComponents(n, componentDefs));
    return;
  }

  // Recurse into children first (bottom-up expansion)
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      expandComponents(child, componentDefs);
    }
  }

  const def = componentDefs.get(node.tagName as string);
  if (def) {
    const slotContent =
      Array.isArray(node.children) && node.children.length > 0
        ? node.children.map((c: JxElement | string) => renderStaticNode(c, {}, null)).join("\n")
        : null;

    const innerHTML = preRenderComponentHtml(def, node.$props || null, slotContent);
    const isStatic = isComponentFullyStatic(def);

    node.innerHTML = innerHTML;
    delete node.children;

    // Resolve template-string host styles with props (per-instance values like background-image)
    if (def.style && node.$props) {
      let stateDefs: Record<string, JxStateDefinition> = { ...def.state };
      for (const [key, value] of Object.entries(node.$props)) {
        if (key in stateDefs) stateDefs[key] = value as JxStateDefinition;
        else stateDefs[key] = value as JxStateDefinition;
      }
      const scope = buildInitialScope(stateDefs, null);
      const resolvedStyle: Record<string, unknown> = {};
      for (const [prop, value] of Object.entries(def.style)) {
        if (typeof value === "string" && isTemplateString(value)) {
          const resolved = resolveStaticValue(value, scope);
          if (resolved != null) resolvedStyle[prop] = resolved;
        }
      }
      if (Object.keys(resolvedStyle).length > 0) {
        node.style = { ...node.style, ...resolvedStyle } as JxStyle;
      }
    }

    delete node.$props;

    if (isStatic) node.$static = true;
    else node.$prerendered = true;
  }
}

/**
 * Inject component script and CSS link tags into compiled HTML for any referenced custom elements.
 * Adds an import map and module scripts before </body>, and CSS links in <head>.
 *
 * @param {string} html
 * @param {string[]} allComponentTags - All compiled component tag names
 * @param {Map<string, string>} [cssMap] - TagName → CSS text (for link injection)
 * @param {Set<string>} [staticTags] - Tags where ALL instances are fully static (skip JS)
 * @returns {string}
 */
function injectComponentScripts(
  html: string,
  allComponentTags: string[],
  cssMap: Map<string, string> = new Map(),
  staticTags: Set<string> = new Set(),
) {
  // Find which components are actually referenced in this page
  const usedTags = allComponentTags.filter(
    (tag: string) => html.includes(`<${tag}`), // matches <tag> and <tag ...>
  );
  if (usedTags.length === 0) return html;

  // Inject CSS links in <head> for ALL components that have CSS sidecars
  const cssLinks = usedTags
    .filter((tag: string) => cssMap.has(tag))
    .map((tag: string) => `<link rel="stylesheet" href="/components/${tag}.css">`)
    .join("\n  ");
  if (cssLinks) {
    html = html.replace("</head>", `  ${cssLinks}\n</head>`);
  }

  // Only inject JS for components that have non-static instances
  const jsTags = usedTags.filter((tag: string) => !staticTags.has(tag));
  if (jsTags.length === 0) return html;

  // Build import map (needed for @vue/reactivity and lit-html)
  const importMap = `<script type="importmap">
  {
    "imports": {
      "@vue/reactivity": "${DEFAULT_REACTIVITY_SRC}",
      "lit-html": "${DEFAULT_LIT_HTML_SRC}"
    }
  }
  </script>`;

  const moduleScripts = jsTags
    .map((tag: string) => `<script type="module" src="/components/${tag}.js"></script>`)
    .join("\n  ");

  // Check if an import map already exists (from islands etc.)
  const hasImportMap = html.includes('<script type="importmap">');
  const injection = (hasImportMap ? "" : `${importMap}\n  `) + moduleScripts;

  return html.replace("</body>", `  ${injection}\n</body>`);
}

/**
 * Inject <script type="module"> tags for npm package $elements (cherry-picked component imports).
 * Bare specifiers are resolved to /node_modules/ paths.
 *
 * @param {string} html
 * @param {string[]} npmElements - Bare specifier strings, e.g.
 *   "@shoelace-style/shoelace/components/button/button.js"
 * @returns {string}
 */
function injectNpmElementScripts(html: string, npmElements: string[]) {
  const scripts = npmElements
    .map((spec: string) => `<script type="module" src="/node_modules/${spec}"></script>`)
    .join("\n  ");

  return html.replace("</body>", `  ${scripts}\n</body>`);
}

/**
 * Replaces the compiler's default <head> section with our merged version.
 *
 * @param {string} html
 * @param {JxHeadEntry[]} headEntries
 * @param {string} lang
 * @returns {string}
 */
function injectHead(html: string, headEntries: JxHeadEntry[], lang: string) {
  const headHtml = renderHead(headEntries);

  // Replace the existing <head>...</head> block, preserving compiler-generated <style> and <script> blocks
  const headPattern = /<head>([\s\S]*?)<\/head>/i;
  const existingMatch = html.match(headPattern);
  let preservedBlocks = "";
  if (existingMatch) {
    const styles = existingMatch[1].match(/<style>[\s\S]*?<\/style>/gi);
    if (styles) preservedBlocks += "\n  " + styles.join("\n  ");
    const scripts = existingMatch[1].match(/<script[\s\S]*?<\/script>/gi);
    if (scripts) preservedBlocks += "\n  " + scripts.join("\n  ");
  }
  if (headPattern.test(html)) {
    html = html.replace(headPattern, `<head>\n  ${headHtml}${preservedBlocks}\n</head>`);
  }

  // Set the lang attribute on <html>
  html = html.replace(/<html\s[^>]*>/i, (match: string) => {
    if (/lang=/.test(match)) {
      return match.replace(/lang="[^"]*"/, `lang="${lang}"`);
    }
    return match.replace("<html", `<html lang="${lang}"`);
  });

  return html;
}

/**
 * Convert a URL pattern to an output file path.
 *
 * "/" → dist/index.html "/about" → dist/about/index.html (with trailingSlash: "always")
 * "/blog/hello" → dist/blog/hello/index.html
 *
 * @param {string} urlPattern
 * @param {string} outDir
 * @param {string} trailingSlash
 * @returns {string}
 */
function routeToOutputPath(urlPattern: string, outDir: string, trailingSlash: string) {
  if (urlPattern === "/") {
    return join(outDir, "index.html");
  }

  // Remove leading slash
  const segments = urlPattern.replace(/^\//, "");

  if (trailingSlash === "always") {
    return join(outDir, segments, "index.html");
  }

  // trailingSlash: "never" or default
  return join(outDir, `${segments}.html`);
}

/**
 * Generate redirect files (HTML meta refresh and _redirects).
 *
 * @param {Record<string, string | { destination: string; status?: number }>} redirects
 * @param {string} outDir
 * @returns {number} Number of files written
 */
function generateRedirects(
  redirects: Record<string, string | { destination: string; status?: number }>,
  outDir: string,
) {
  let count = 0;
  const redirectLines: string[] = [];

  for (const [source, target] of Object.entries(redirects)) {
    const dest = typeof target === "object" ? target.destination : target;
    const status = typeof target === "object" ? (target.status ?? 301) : 301;

    // Skip patterns with :param or * — these need platform-specific handling
    if (source.includes(":") || source.includes("*")) {
      redirectLines.push(`${source} ${dest} ${status}`);
      continue;
    }

    // Static redirect — emit an HTML file with meta refresh
    const htmlPath = routeToOutputPath(source, outDir, "always");
    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="0;url=${escapeAttr(dest)}">
  <link rel="canonical" href="${escapeAttr(dest)}">
  <title>Redirecting...</title>
</head>
<body>
  <p>Redirecting to <a href="${escapeAttr(dest)}">${escapeHtml(dest)}</a>...</p>
</body>
</html>`;
    mkdirSync(dirname(htmlPath), { recursive: true });
    writeFileSync(htmlPath, html, "utf8");
    count++;
    redirectLines.push(`${source} ${dest} ${status}`);
  }

  // Write _redirects file (Netlify/Cloudflare format)
  if (redirectLines.length > 0) {
    writeFileSync(join(outDir, "_redirects"), redirectLines.join("\n") + "\n", "utf8");
    count++;
  }

  return count;
}

/**
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str: string) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * @param {string} str
 * @returns {string}
 */
function escapeAttr(str: string) {
  return String(str).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
