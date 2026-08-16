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
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { isMappedArray, isRef } from "@jxsuite/schema/guards";
import { isNpmSpecifier, npmAssetPath, sidecarAssetPath } from "@jxsuite/schema/asset-paths";
import {
  CLIENT_EXTERNALS,
  bundleEntry,
  bundleWorkerSource,
  isBundleableSrc,
  resolveSidecarEntry,
} from "./bundler.ts";
import { loadProjectConfig } from "./site-loader.ts";
import { discoverPages, expandDynamicRoutes, readPageDocument } from "./pages-discovery.ts";
import {
  buildHeaderRules,
  contentTypeRules,
  writeHeaders,
  writeNoJekyll,
} from "./headers-emitter.ts";
import { buildProjectExtensionRegistry } from "./format-host.ts";
import { loadProjectSections } from "./project-sections.ts";
import { collectAssetRefs, copyMountedAssets, loadAssetMounts } from "./asset-mounts.ts";
import type { AssetMount } from "@jxsuite/schema/asset-paths";
import type { FormatEntry, FormatRegistry } from "@jxsuite/schema/format-registry";
import type { ExtensionRegistry } from "@jxsuite/schema/extension-registry";
import { resolveLayout } from "./layout-resolver.ts";
import { mergeHead, renderHead } from "./head-merger.ts";
import { unregisteredHeadRelations } from "./link-relations.ts";
import { injectContext } from "./context-injection.ts";
import { compile, compileServer, compileSiteServer } from "../compiler.ts";
import { compileElement } from "../targets/compile-element.ts";
import type { SiteConnectorSpec, SiteMountSpec } from "../targets/compile-server.ts";
import {
  buildComponentCSS,
  buildInitialScope,
  collectServerEntries,
  collectStyles,
  colorSchemePrePaintScript,
  evaluateStaticTemplate,
  isComponentFullyStatic,
  isTemplateString,
  preRenderComponentHtml,
  pureSchemeOf,
  renderStaticNode,
  resolveRefValue,
  resolveStaticValue,
} from "../shared.ts";
import { resolvePrototypes } from "./prototype-resolver.ts";
import { transformImageNodes } from "./image-transform.ts";
import { collectCspSources, emptyCspSources } from "./csp.ts";
import { resolveShadowMode } from "../shadow.ts";
import {
  buildServiceWorker,
  normalizeServiceWorker,
  registrationScript,
  tombstoneServiceWorker,
} from "./service-worker.ts";
import {
  buildManifest,
  buildSecurityTxt,
  manifestHeadEntries,
  writeWellKnown,
} from "./well-known.ts";
import {
  localeAlternates,
  localeOfRoute,
  pageLanguage,
  resolveI18n,
  undeclaredLocalePrefix,
} from "./i18n.ts";
import type { LocaleAlternate, ResolvedI18n } from "./i18n.ts";
import { renderImportMap, resolveClientRuntime, writeClientRuntime } from "./client-runtime.ts";
import { getImageCacheDir, loadCache, saveCache } from "./image-cache.ts";
import type { ImageConfig } from "./image-optimizer.ts";
import type { ImageMetaCache } from "./image-transform.ts";
import type {
  JsonValue,
  JxAttributeValue,
  JxElement,
  JxHeadEntry,
  JxMappedArray,
  JxMutableNode,
  JxStateDefinition,
  JxStyle,
  ProjectConfig,
} from "@jxsuite/schema/types";
import type { SiteRoute } from "../types.ts";
import type { CacheManifest } from "./image-cache.js";

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

  // The legacy imports-based content model is gone (specs/extensions.md v2) — fail loudly with
  // The migration path instead of silently ignoring the section.
  if ("contentTypes" in projectConfig) {
    throw new Error(
      `project.json declares "contentTypes", which is no longer supported. ` +
        `Run \`bun scripts/migrate-project-extensions.ts <project>\` to migrate to ` +
        `"extensions" + "content", then \`jx schema\`.`,
    );
  }

  const outDir = resolve(projectRoot, projectConfig.build.outDir);
  const pagesDir = resolve(projectRoot, "pages");
  const publicDir = resolve(projectRoot, "public");
  const trailingSlash = projectConfig.build.trailingSlash ?? "always";

  // Client sidecar bundles: bundleable Function-def `$src` specifiers (and lowered-def `$bundle`
  // Hints) are rewritten to their /assets/ URL during compilation, registered here, and bundled
  // In step 6d (spec.md §12). Keyed by asset path so duplicate specifiers bundle once.
  const sidecarBundles = new Map<string, { entryPath: string; specifier: string }>();
  /*
   * Files a `$head` entry names by bare specifier — a package's stylesheet, most often. Copied
   * rather than bundled.
   *
   * These used to be rewritten to `/node_modules/<specifier>`, which resolves in dev, where the
   * server serves that path, and 404s in production, where nothing copies node_modules into dist.
   */
  const npmAssets = new Map<string, string>();
  /*
   * Bundles and copies land in one URL directory, so one map arbitrates it. Two different files
   * that slug to the same name is a build error, not a silent last-writer-wins overwrite.
   */
  /*
   * The two modules the import map names. Resolved up front so every page's map is identical, and
   * written at the end only if some page actually emitted one.
   */
  const clientRuntime = resolveClientRuntime();
  const runtimeImports = clientRuntime.imports;
  const runtimeAssetsUsed = new Set<string>();
  /*
   * Scanned from every finished page, so the hashes name the exact bytes shipped rather than what
   * some emission site believed it wrote.
   */
  const cspSources = emptyCspSources();

  /*
   * Locale routing (§13). Validated once: a malformed BCP 47 tag is a build error, because a
   * locale is a URL prefix, an `hreflang` value and an `<html lang>` at once — a typo does not
   * degrade, it produces a site claiming a language that does not exist.
   */
  const { errors: i18nErrors, i18n } = resolveI18n(projectConfig);
  for (const error of i18nErrors) {
    errors.push(error);
    console.error(error);
  }
  for (const warning of clientRuntime.warnings) {
    console.warn(warning);
  }

  const assetClaims = new Map<string, { entryPath: string; specifier: string }>();
  const claimAsset = (assetPath: string, entryPath: string, specifier: string) => {
    const existing = assetClaims.get(assetPath);
    if (existing !== undefined && existing.entryPath !== entryPath) {
      throw new Error(
        `"${specifier}" and "${existing.specifier}" both map to ${assetPath} — rename one`,
      );
    }
    assetClaims.set(assetPath, { entryPath, specifier });
  };
  const rewriteSidecarSrc = (specifier: string, docDir: string | null): string => {
    if (!isBundleableSrc(specifier)) {
      return specifier;
    }
    try {
      const entryPath = resolveSidecarEntry(specifier, docDir ?? projectRoot, projectRoot);
      // A declared-but-absent relative sidecar keeps its verbatim import (the historical
      // Behavior) with a warning — the doc may only ever run interpreted. Unresolvable npm
      // Specifiers stay hard errors: a missing dependency should fail the build.
      if (!isNpmSpecifier(specifier) && !existsSync(entryPath)) {
        console.warn(`Sidecar "${specifier}" not found at ${entryPath} — emitting unbundled`);
        return specifier;
      }
      // Relative specifiers key on their project-relative resolved path so `./x.js` declared in
      // Two directories cannot collide on one slug; npm specifiers are location-independent.
      const assetKey = isNpmSpecifier(specifier)
        ? specifier
        : `./${relative(projectRoot, entryPath)}`;
      const assetPath = sidecarAssetPath(assetKey);
      claimAsset(assetPath, entryPath, specifier);
      sidecarBundles.set(assetPath, { entryPath, specifier });
      return assetPath;
    } catch (error) {
      errors.push(`Sidecar "${specifier}": ${(error as Error).message}`);
      return specifier;
    }
  };

  const rewriteNpmAsset = (specifier: string): string => {
    const assetPath = npmAssetPath(specifier);
    try {
      const entryPath = resolveSidecarEntry(`npm:${specifier}`, projectRoot, projectRoot);
      claimAsset(assetPath, entryPath, specifier);
      npmAssets.set(assetPath, entryPath);
      return assetPath;
    } catch (error) {
      // A missing dependency is a hard error, like an unresolvable sidecar: the alternative is a
      // Page that looks fine in dev and loses its stylesheet on deploy.
      errors.push(`$head specifier "${specifier}": ${(error as Error).message}`);
      return specifier;
    }
  };

  // ── 1b. Build the extension registry from project.json#/extensions ─────
  const registry = await buildProjectExtensionRegistry(projectRoot, projectConfig);
  const formatRegistry = registry.formats;
  if (formatRegistry.entries.length > 0) {
    log(
      `  Registered ${formatRegistry.entries.length} format(s): ${formatRegistry.entries
        .map((e) => e.name)
        .join(", ")}`,
    );
  }

  // ── 1c. Active extension server mounts (specs/extensions.md §11) ────────
  // A mount is active when its class owns no project section, or the project declares a
  // Non-empty value for its section key. Sites with active mounts always get a worker; a
  // Static site cannot serve dynamic sections, so that combination is a build error.
  const activeMounts = registry.serverMounts().filter((entry) => {
    if (!entry.project) {
      return true;
    }
    const value = projectConfig[entry.project.key] as Record<string, unknown> | undefined;
    return value !== undefined && typeof value === "object" && Object.keys(value).length > 0;
  });
  if (activeMounts.length > 0 && !projectConfig.build.adapter) {
    const sections = activeMounts
      .map((entry) => (entry.project ? `"${entry.project.key}"` : `"${entry.server!.basePath}"`))
      .join(", ");
    throw new Error(
      `project.json declares dynamic section(s) ${sections} served by extension mounts, but ` +
        `build.adapter is "static". Dynamic tables need a server-capable adapter — set ` +
        `build.adapter to "cloudflare-workers", "cloudflare-pages", "node", or "bun".`,
    );
  }

  // ── 2. Clean output directory ───────────────────────────────────────────
  if (clean && existsSync(outDir)) {
    rmSync(outDir, { force: true, recursive: true });
  }
  mkdirSync(outDir, { recursive: true });

  // ── 3. Discover routes ──────────────────────────────────────────────────
  if (!existsSync(pagesDir)) {
    throw new Error(`pages/ directory not found in ${projectRoot}`);
  }

  log("Discovering pages...");
  const staticRoutes = await discoverPages(pagesDir, formatRegistry);
  log(`  Found ${staticRoutes.length} page(s)`);

  // ── 3b. Load extension-contributed project sections ────────────────────
  log("Loading project sections...");
  const sections = await loadProjectSections(projectRoot, projectConfig, registry);
  const sectionKeys = Object.keys(sections);
  if (sectionKeys.length > 0) {
    log(`  Loaded ${sectionKeys.length} section(s): ${sectionKeys.join(", ")}`);
  }

  // ── 3c. Extension asset mounts (extensions.md §8.5) ─────────────────────
  // Directories published at a site URL — typically an external content source's co-located
  // Images. They resolve for image optimization below, and the files pages actually reference
  // Are copied into dist in step 7c.
  const { errors: mountErrors, mounts: assetMounts } = await loadAssetMounts(
    registry,
    projectConfig,
    projectRoot,
  );
  errors.push(...mountErrors);
  for (const message of mountErrors) {
    console.error(message);
  }
  if (assetMounts.length > 0) {
    log(
      `  Mounted ${assetMounts.length} asset dir(s): ${assetMounts.map((m) => m.urlPrefix).join(", ")}`,
    );
  }
  const assetRefs = new Set<string>();

  // ── 4. Expand dynamic routes ────────────────────────────────────────────
  const extensionHead = registry
    ? await collectExtensionHead(registry, projectConfig, projectRoot)
    : [];

  const routes = await expandDynamicRoutes(
    staticRoutes,
    projectRoot,
    sections,
    registry,
    projectConfig,
  );
  log(`  ${routes.length} route(s) after expansion`);

  let fileCount = 0;

  // ── 5. Compile site components ──────────────────────────────────────────
  const componentsDir = resolve(projectRoot, "components");
  const compiledComponentTags: string[] = [];
  const componentCSS = new Map<string, string>(); // TagName → CSS text
  const componentDefs = new Map<string, JxElement>(); // TagName → parsed component definition
  if (existsSync(componentsDir)) {
    log("Compiling components...");
    const componentExtensions = [".json", ...formatRegistry.documentExtensions("component")];
    const componentFiles = readdirSync(componentsDir).filter((f: string) =>
      componentExtensions.some((ext) => f.endsWith(ext)),
    );
    const componentOutDir = resolve(outDir, "components");
    mkdirSync(componentOutDir, { recursive: true });

    // Emitted modules are named after the component's `tagName` — the name the page's loader
    // `<script>` and the CSS sidecar both use. So a component whose source basename differs from
    // Its tag needs its `$elements` imports renamed to match, and those get resolved before the
    // Dependency itself is compiled. Hence: read every component's tag up front.
    const componentTagByPath = new Map<string, string>();
    for (const file of componentFiles) {
      const componentPath = resolve(componentsDir, file);
      try {
        const { tagName: depTag } = await readPageDocument(componentPath, formatRegistry);
        if (depTag) {
          componentTagByPath.set(componentPath, depTag);
        }
      } catch {
        // Left to the compile pass below, which reports the parse failure with its file context.
      }
    }

    for (const file of componentFiles) {
      try {
        const componentPath = resolve(componentsDir, file);
        const result = await compileElement(componentPath, {
          ...(projectConfig.$media ? { $media: projectConfig.$media } : {}),
          formats: formatRegistry,
          resolveElementPath: (refPath: string, currentDir: string | null) => {
            const depPath = currentDir ? resolve(currentDir, refPath) : resolve(refPath);
            const depTag = componentTagByPath.get(depPath);
            return depTag ? `./${depTag}.js` : refPath.replace(/\.json$/, ".js");
          },
          rewriteSrc: rewriteSidecarSrc,
        });
        for (const f of result.files) {
          // Name the output after the tag. `injectComponentScripts` emits
          // `<script src="/components/<tag>.js">` and the CSS sidecar is written as `<tag>.css`, so
          // A source basename here left the loader pointing at a file that was never written.
          // Basename is the fallback, and handles both / and \ — a forward-slash-only split left
          // The full drive path on Windows, so resolve() then wrote the sidecar back into the
          // Source tree instead of dist.
          const outName = f.tagName ? `${f.tagName}.js` : basename(f.path);
          writeFileSync(resolve(componentOutDir, outName), f.content, "utf8");
          if (f.tagName) {
            compiledComponentTags.push(f.tagName);
          }
          fileCount += 1;
        }

        // Pre-render component HTML scaffold and CSS sidecar
        const doc = await readPageDocument(componentPath, formatRegistry);
        if (doc.tagName) {
          componentDefs.set(doc.tagName, doc);
          const componentShadow = resolveShadowMode(doc, projectConfig.defaults);
          const css = buildComponentCSS(
            doc.tagName,
            doc.style,
            doc,
            projectConfig.$media ?? {},
            componentShadow,
          );
          if (css) {
            /*
             * A shadow component's sheet is linked from inside its own declarative shadow root, so
             * it is written to disk but kept OUT of the page-level map: a `:host`-rooted rule in
             * the document head matches nothing, and the duplicate request is pure cost.
             */
            if (componentShadow === null) {
              componentCSS.set(doc.tagName, css);
            }
            collectAssetRefs(css, assetMounts, assetRefs);
            writeFileSync(resolve(componentOutDir, `${doc.tagName}.css`), css, "utf8");
            fileCount += 1;
          }
        }
      } catch (error) {
        const err = error as Error;
        errors.push(`Error compiling component ${file}: ${err.message}`);
        console.error(`Error compiling component ${file}: ${err.message}`);
      }
    }
    log(
      `  Compiled ${compiledComponentTags.length} component(s): ${compiledComponentTags.join(", ")}`,
    );
  }

  // ── 5b. Collect server entries from components (for site-wide bundling) ──
  const siteServerEntries: { exportName: string; src: string }[] = [];
  if (projectConfig.build.adapter) {
    for (const [, doc] of componentDefs) {
      const entries = collectServerEntries(doc);
      for (const entry of entries) {
        const resolvedSrc = `./components/${entry.src.replace(/^\.\//, "")}`;
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
  const imageMetaCache: ImageMetaCache | null = cfImages ? new Map() : null;
  if (cfImages) {
    console.log(
      `images.service is "cloudflare" — srcsets use /cdn-cgi/image transform URLs. ` +
        `Ensure Image Transformations are enabled for your zone (Cloudflare dashboard → ` +
        `Images → Transformations); these URLs do not work on *.pages.dev / *.workers.dev previews.`,
    );
  }

  // Sitemap is generated from the route table when a production `url` is configured
  // (absolute <loc> URLs require it) and not explicitly disabled via build.sitemap: false.
  const siteUrl = projectConfig.url;
  const sitemapEnabled = Boolean(siteUrl) && projectConfig.build.sitemap !== false;
  const sitemapEntries: SitemapEntry[] = [];

  // Warned once per distinct prefix rather than once per route: one mistyped directory is one
  // Mistake, however many pages live under it.
  /*
   * Translation sets, computed from the whole route table before the first page is compiled: a
   * page's alternates include its siblings, which do not exist until every route is known.
   * Dynamic patterns are excluded — an unexpanded `:slug` is not a URL.
   */
  const alternateMap = localeAlternates(
    routes.filter((r) => !r.urlPattern.includes(":") && !r.urlPattern.includes("*")),
    i18n,
    siteUrl ?? "",
  );

  const warnedLocalePrefixes = new Set<string>();
  /*
   * A mistyped `rel` is silent: the tag is still valid HTML, still renders, and simply does
   * nothing — the stylesheet never loads, the canonical never consolidates. Warned once per
   * distinct value across the whole build, because the one that matters lives in the layout and is
   * therefore on every page.
   */
  const warnedRelations = new Set<string>();
  for (const route of routes) {
    const mismatch = undeclaredLocalePrefix(route.urlPattern, i18n);
    if (mismatch && !warnedLocalePrefixes.has(mismatch.segment)) {
      warnedLocalePrefixes.add(mismatch.segment);
      console.warn(
        `Routes under /${mismatch.segment}/ are served as "${i18n?.defaultLocale}" — ` +
          `i18n.locales declares "${mismatch.meant}", not "${mismatch.segment}". ` +
          `Rename the directory to "${mismatch.meant.toLowerCase()}" or declare the shorter tag.`,
      );
    }
    try {
      log(`  Compiling ${route.urlPattern} ...`);
      const result = await compilePage(
        route as unknown as SiteRoute,
        projectConfig,
        projectRoot,
        sections,
        imageCache,
        componentDefs,
        imageMetaCache,
        formatRegistry,
        registry,
        rewriteSidecarSrc,
        assetMounts,
        extensionHead,
        rewriteNpmAsset,
        i18n,
        alternateMap.get(route.urlPattern) ?? [],
        runtimeImports,
      );

      for (const relation of result.unregisteredRelations) {
        if (!warnedRelations.has(relation)) {
          warnedRelations.add(relation);
          console.warn(
            `<link rel="${relation}"> — "${relation}" is not an IANA link relation, and a ` +
              `relation nobody recognizes does nothing. Check the spelling, or use an absolute ` +
              `URI if it is an extension relation (RFC 8288 §2.1.2).`,
          );
        }
      }

      // Determine which component tags are fully static (for script omission)
      const staticTags = new Set<string>();
      for (const [tag, def] of componentDefs) {
        if (isComponentFullyStatic(def)) {
          staticTags.add(tag);
        }
      }

      // Inject component CSS and JS scripts
      if (compiledComponentTags.length > 0) {
        result.html = injectComponentScripts(
          result.html,
          compiledComponentTags,
          componentCSS,
          staticTags,
          result.files.map((f: { content: string }) => f.content).join("\n"),
          runtimeImports,
          runtimeAssetsUsed,
        );
      }

      // Mounted assets this page actually references — scanned from the finished HTML so a
      // Reference is caught wherever it came from (markdown image, hand-authored page, $head).
      collectAssetRefs(result.html, assetMounts, assetRefs);
      collectCspSources(result.html, cspSources);

      // Determine output path
      const outPath = routeToOutputPath(route.urlPattern, outDir, trailingSlash);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, result.html, "utf8");
      fileCount += 1;

      // Record a sitemap entry for this concrete page (skip unexpanded dynamic routes and
      // Pages that opted out via $sitemap: false). <loc> is built like the canonical URL so
      // The two always agree.
      const isConcrete = !route.urlPattern.includes(":") && !route.urlPattern.includes("*");
      if (sitemapEnabled && !result.excludeFromSitemap && isConcrete) {
        const routeAlternates = alternateMap.get(route.urlPattern) ?? [];
        sitemapEntries.push({
          /*
           * The route's own timestamp when it has one, and only then the template's. A concrete
           * route expanded from a collection carries the entry it was generated from
           * (`sourceMtime`), because `sourcePath` still points at the `[slug]` template — so
           * without this every post in an archive claims to have been edited the moment the
           * template was, which is precisely the signal `<lastmod>` exists to give.
           */
          lastmod:
            typeof route.sourceMtime === "string" && route.sourceMtime !== ""
              ? route.sourceMtime
              : toRfc3339(statSync(route.sourcePath).mtime),
          loc: new URL(route.urlPattern, siteUrl).href,
          ...(routeAlternates.length > 0 && { alternates: routeAlternates }),
        });
      }

      // Write serialized export sidecars alongside HTML (formats with exportTarget: true)
      for (const fmt of formatRegistry.withCapability("serialize")) {
        if (!fmt.exportTarget) {
          continue;
        }
        try {
          const content = (await fmt.call("serialize", result.doc, {
            buildScope: (state: Record<string, JxStateDefinition>) =>
              buildInitialScope(state, null),
            componentDefs,
            evaluateTemplate: (value: string, scope: Record<string, unknown>) => {
              if (!isTemplateString(value)) {
                return;
              }
              return evaluateStaticTemplate(value, scope) ?? value;
            },
            mode: "export",
          })) as string;
          if (content) {
            const sidecarPath = outPath.replace(/\.html$/, fmt.extensions[0]!);
            writeFileSync(sidecarPath, content, "utf8");
            fileCount += 1;
          }
        } catch (error) {
          const err = error as Error;
          errors.push(`Error exporting ${fmt.name} for ${route.urlPattern}: ${err.message}`);
        }
      }

      // Write any additional files (island modules, etc.)
      for (const file of result.files) {
        const filePath = resolve(dirname(outPath), file.path);
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, file.content, "utf8");
        fileCount += 1;
      }

      // Write server handler if present
      if (result.serverHandler) {
        const serverPath = resolve(dirname(outPath), "_server.js");
        writeFileSync(serverPath, result.serverHandler, "utf8");
        fileCount += 1;
      }
    } catch (error) {
      const err = error as Error;
      const msg = `Error compiling ${route.urlPattern}: ${err.message}`;
      errors.push(msg);
      console.error(msg);
    }
  }

  // ── 6b. Save image cache and copy variants to dist ──────────────────────
  if (imageCache && projectConfig.images.optimize) {
    // Prune only on fully successful builds — a route that failed to compile never
    // Touched its images, and pruning would evict their still-valid entries.
    saveCache(projectRoot, imageCache, { prune: errors.length === 0 });
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
    const { adapter } = projectConfig.build;
    log("Generating site-wide server worker...");

    const deduped = new Map<string, { exportName: string; src: string }>();
    for (const entry of siteServerEntries) {
      if (!deduped.has(entry.exportName)) {
        deduped.set(entry.exportName, entry);
      }
    }

    // Extension server mounts: static imports of the mount modules and used connector classes,
    // Inlined JSON options (the project's section manifest — identifiers only, never secrets).
    const { mounts, connectors } = buildMountSpecs(activeMounts, registry, projectConfig);
    if (mounts.length > 0) {
      log(
        `  Mounting ${mounts.length} extension route(s): ${mounts.map((m) => m.basePath).join(", ")}`,
      );
    }

    // Cloudflare Pages uses advanced mode (_worker.js inside the build output) — the
    // Functions/ directory convention only works from the project root, not from dist/.
    // A static-only Pages site needs no worker at all; sites with mounts always get one.
    const skipWorker = adapter === "cloudflare-pages" && deduped.size === 0 && mounts.length === 0;
    const workerSource = skipWorker
      ? null
      : compileSiteServer([...deduped.values()], { adapter, connectors, mounts });

    if (workerSource) {
      // Bundle the worker self-contained for the adapter's runtime (compiler.md §12): mount
      // Modules, connectors, hono, and user server functions are inlined, so dist deploys
      // Without node_modules or deploy-time bundling.
      const workerName = adapter === "cloudflare-pages" ? "_worker.js" : "worker.js";
      try {
        await bundleWorkerSource(workerSource, {
          adapter,
          outfile: resolve(outDir, workerName),
          projectRoot,
        });
        fileCount += 1;
        log(`  Generated dist/${workerName} (bundled, ${deduped.size} server function(s))`);
      } catch (error) {
        const msg = `Error bundling dist/${workerName}: ${(error as Error).message}`;
        errors.push(msg);
        console.error(msg);
      }

      if (adapter === "cloudflare-pages") {
        // Only invoke the worker for server routes; everything else stays static.
        writeFileSync(
          resolve(outDir, "_routes.json"),
          `${JSON.stringify({ exclude: [], include: ["/_jx/*"], version: 1 }, null, 2)}\n`,
          "utf8",
        );
        fileCount += 1;
      }
    }
  }

  // ── 6d. Bundle client sidecar modules (spec.md §12) ─────────────────────
  if (runtimeAssetsUsed.size > 0) {
    log(`Bundling ${runtimeAssetsUsed.size} client runtime module(s)...`);
    const runtime = await writeClientRuntime(
      { ...clientRuntime, assetPaths: [...runtimeAssetsUsed] },
      outDir,
    );
    fileCount += runtime.written;
    for (const error of runtime.errors) {
      errors.push(error);
      console.error(error);
    }
  }

  if (npmAssets.size > 0) {
    log(`Copying ${npmAssets.size} package asset(s)...`);
    for (const [assetPath, entryPath] of npmAssets) {
      const outfile = resolve(outDir, assetPath.replace(/^\//, ""));
      mkdirSync(dirname(outfile), { recursive: true });
      cpSync(entryPath, outfile);
      fileCount += 1;
      log(`  ${entryPath} → ${assetPath}`);
    }
  }

  if (sidecarBundles.size > 0) {
    log(`Bundling ${sidecarBundles.size} client sidecar module(s)...`);
    for (const [assetPath, bundle] of sidecarBundles) {
      try {
        const outfile = resolve(outDir, assetPath.replace(/^\//, ""));
        mkdirSync(dirname(outfile), { recursive: true });
        await bundleEntry(
          { entryPath: bundle.entryPath, outfile },
          { external: CLIENT_EXTERNALS, target: "browser" },
        );
        fileCount += 1;
        log(`  ${bundle.specifier} → ${assetPath}`);
      } catch (error) {
        const msg = `Error bundling sidecar "${bundle.specifier}": ${(error as Error).message}`;
        errors.push(msg);
        console.error(msg);
      }
    }
  }

  // ── 6e. Extension-emitted assets (extensions.md §8.4) ───────────────────
  // Section-owner classes with an `emit` capability contribute derived build artifacts
  // (search indexes, feeds, …). The host writes the returned files so extensions stay pure;
  // Paths are outDir-relative and guarded against traversal. Note the `public/` copy (7c)
  // Runs later and can shadow emitted files — same semantics as sitemap.xml.
  for (const entry of registry.emitters()) {
    const sectionKey = entry.project?.key;
    const sectionValue = sectionKey
      ? (projectConfig as unknown as Record<string, unknown>)[sectionKey]
      : undefined;
    if (
      sectionKey &&
      (sectionValue == null ||
        (typeof sectionValue === "object" && Object.keys(sectionValue).length === 0))
    ) {
      continue; // Section owner with nothing declared — same gating as sections/mounts
    }
    try {
      const emitted = (await entry.call("emit", sectionValue ?? null, {
        projectConfig,
        root: projectRoot,
        routes,
        sections,
      })) as { path: string; content: string | Uint8Array }[] | null;
      for (const file of emitted ?? []) {
        const target = resolve(outDir, file.path.replace(/^\//, ""));
        if (!target.startsWith(outDir + sep)) {
          throw new Error(`emit path escapes outDir: ${file.path}`);
        }
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, file.content);
        fileCount += 1;
        log(`  ${entry.name} emitted ${file.path}`);
      }
    } catch (error) {
      const msg = `Error in ${entry.name}.emit: ${(error as Error).message}`;
      errors.push(msg);
      console.error(msg);
    }
  }

  // ── 7. Generate redirects ───────────────────────────────────────────────
  if (projectConfig.redirects && Object.keys(projectConfig.redirects).length > 0) {
    log("Generating redirects...");
    const compiledUrls = new Set(routes.map((r) => r.urlPattern));
    const redirects = generateRedirects(projectConfig.redirects, outDir, {
      compiledUrls,
      trailingSlash: projectConfig.build.trailingSlash,
    });
    fileCount += redirects.files;
    errors.push(...redirects.errors);
  }

  // ── 7b. Generate sitemap.xml ────────────────────────────────────────────
  if (sitemapEnabled) {
    log(`Generating sitemap (${sitemapEntries.length} URL(s))...`);
    fileCount += generateSitemap(sitemapEntries, outDir);
  } else if (!siteUrl && projectConfig.build.sitemap !== false) {
    console.warn("sitemap.xml skipped — set `url` in project.json to enable sitemap generation.");
  }

  // ── 7c. Copy referenced mounted assets (extensions.md §8.5) ─────────────
  // Only files the compiled output references are copied, so a content source's entry files
  // Never land in dist. Runs before the public/ copy, which keeps shadowing everything.
  if (assetRefs.size > 0) {
    const { copied, missing } = copyMountedAssets(assetRefs, assetMounts, outDir);
    fileCount += copied;
    log(`Copying ${copied} mounted asset(s)...`);
    for (const url of missing) {
      console.warn(`Referenced asset not found: ${url}`);
    }
  }

  // ── 7c(ii). Copy public/ assets ─────────────────────────────────────────
  if (existsSync(publicDir)) {
    log("Copying public/ assets...");
    cpSync(publicDir, outDir, { recursive: true });
  }

  // ── 7d. Reference the sitemap from robots.txt ───────────────────────────
  // Runs after the public/ copy so it edits the deployed dist/robots.txt.
  if (sitemapEnabled) {
    fileCount += ensureRobotsSitemap(outDir, siteUrl);
  }

  // ── 7d.1 manifest.webmanifest and .well-known/security.txt ──────────────
  /*
   * After the public/ copy, and skipping anything already there. That skip is how an author ships
   * a **clearsigned** security.txt: signing needs a private key at build time, so the build cannot
   * do it, but `public/.well-known/security.txt` shadows this at zero cost.
   */
  {
    const generated = [buildManifest(projectConfig), buildSecurityTxt(projectConfig, new Date())];
    for (const output of generated) {
      for (const error of output.errors) {
        errors.push(error);
        console.error(error);
      }
      for (const warning of output.warnings) {
        console.warn(warning);
      }
    }
    const { skipped, written } = writeWellKnown(
      generated.flatMap((o) => o.files),
      outDir,
      existsSync,
    );
    fileCount += written;
    for (const path of skipped) {
      log(`  ${path} — kept the copy from public/`);
    }
  }

  // ── 7d.2 The service worker, or the tombstone that removes one ──────────
  /*
   * `serviceWorker: false` is not the same as omitting the key, and this is the one place in the
   * build where that distinction carries weight. A worker is sticky: deleting the file leaves
   * every previous visitor running the old one forever, because a 404 at that URL is not an
   * instruction to stop. `false` says "I had one" and emits the instruction.
   */
  {
    const sw = normalizeServiceWorker(projectConfig.serviceWorker);
    if (sw !== null) {
      const output = sw === false ? tombstoneServiceWorker() : buildServiceWorker(sw, outDir);
      for (const warning of output.warnings) {
        console.warn(warning);
      }
      for (const error of output.errors) {
        errors.push(error);
        console.error(error);
      }
      writeFileSync(join(outDir, output.path as string), output.source, "utf8");
      fileCount += 1;
      log(sw === false ? "  sw.js — tombstone (unregisters and clears)" : "  sw.js");
    }
  }

  // ── 7e. Response headers and the Jekyll opt-out ─────────────────────────
  // Also after the public/ copy, for the same reason — but PREPENDING rather than appending, since
  // A later `_headers` rule wins for a duplicate header name and the author's block must override.
  {
    const { errors: headerErrors, rules: securityRules } = buildHeaderRules(
      projectConfig.build,
      cspSources,
    );
    errors.push(...headerErrors);
    // Runs here, after every emitter, so it can see which of these files the build actually wrote.
    const rules = [...securityRules, ...contentTypeRules(outDir)];
    if (rules.length > 0) {
      log("Writing response headers...");
      fileCount += writeHeaders(outDir, rules);
      const { adapter } = projectConfig.build;
      if (adapter === "node" || adapter === "bun") {
        console.warn(
          `The "${adapter}" adapter serves no static assets, so dist/_headers is documentation ` +
            `rather than configuration — apply these headers at the reverse proxy in front of it.`,
        );
      }
    }
    fileCount += writeNoJekyll(outDir);
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

  return { errors, files: fileCount, routes: routes.length };
}

/**
 * Compile a single page within the site build context.
 *
 * Pipeline: load JSON → resolve layout → inject context → merge head → compile
 *
 * @param {SiteRoute} route
 * @param {ProjectConfig} projectConfig
 * @param {string} projectRoot
 * @param {Record<string, unknown>} [sections] - Extension-loaded project sections
 * @param {import("./image-cache.js").CacheManifest | null} [imageCache]
 * @param {Map<string, JxElement>} [componentDefs]
 * @param {ImageMetaCache | null} [imageMetaCache] - Set when images.service is "cloudflare"
 * @returns {Promise<{
 *   html: string;
 *   files: { path: string; content: string; tagName?: string }[];
 *   serverHandler: string | null;
 *   doc: JxDocument;
 * }>}
 *   Every parameter is required. There is exactly one caller and it passes all fifteen, so the
 *   defaults this list used to carry described no reachable call — and one of them, an identity
 *   `rewriteNpmAsset`, was a function that could never run pretending to be a safety net.
 */
async function compilePage(
  route: SiteRoute,
  projectConfig: ProjectConfig,
  projectRoot: string,
  sections: Record<string, unknown>,
  imageCache: CacheManifest | null,
  componentDefs: Map<string, JxElement>,
  imageMetaCache: ImageMetaCache | null,
  formatRegistry: FormatRegistry | undefined,
  registry: ExtensionRegistry | undefined,
  rewriteSidecarSrc: ((specifier: string, docDir: string | null) => string) | undefined,
  assetMounts: readonly AssetMount[],
  extensionHead: readonly JxHeadEntry[],
  rewriteNpmAsset: (specifier: string) => string,
  i18n: ResolvedI18n | null,
  alternates: readonly LocaleAlternate[],
  runtimeImports: Record<string, string>,
) {
  // Load the raw page document (.json natively, other formats via the registry)
  const pageDoc = await readPageDocument(route.sourcePath as string, formatRegistry);

  // Resolve layout (wraps page in layout with slot distribution)
  const layoutDoc = resolveLayout(pageDoc, projectConfig, projectRoot);

  // Extract head arrays before they get lost in the merge
  const pageHead = (pageDoc.$head ?? layoutDoc._pageHead ?? []) as JxHeadEntry[];
  const layoutHead = (layoutDoc.$head ?? []) as JxHeadEntry[];
  const pageTitle = (pageDoc.title ?? layoutDoc._pageTitle ?? null) as string | null;

  // Clean up internal properties
  delete layoutDoc._pageHead;
  delete layoutDoc._pageTitle;

  // Inject $site and $page context
  injectContext(layoutDoc, projectConfig, route, projectRoot, i18n);

  /*
   * The page's language and writing direction. `$lang` on the document wins over the locale its
   * route implies, and `dir` is emitted only when it is `rtl` or the author asked — `ltr` is
   * HTML's default and writing it on every page says nothing.
   */
  const language = pageLanguage({
    defaults: projectConfig.defaults,
    pageDir: typeof pageDoc.$dir === "string" ? pageDoc.$dir : undefined,
    pageLang: typeof pageDoc.$lang === "string" ? pageDoc.$lang : undefined,
    routeLocale: localeOfRoute(route.urlPattern, i18n),
  });

  // Resolve generic $prototype entries via .class.json imports (and lower registry classes)
  await resolvePrototypes(layoutDoc, route, projectRoot, {
    config: projectConfig,
    sections,
    ...(registry === undefined ? {} : { registry }),
    ...(rewriteSidecarSrc === undefined
      ? {}
      : {
          registerBundle: (specifier: string) => {
            rewriteSidecarSrc(specifier, null);
          },
        }),
  });

  // Build scope from resolved state so template strings in title/$head can be evaluated
  const scope = buildInitialScope(layoutDoc.state ?? {});

  // Determine the page title — resolve template strings against the scope
  let title = pageTitle ?? projectConfig.name ?? "Jx Site";
  if (typeof title === "string" && isTemplateString(title)) {
    title = (evaluateStaticTemplate(title, scope) as string | null) ?? (title as string);
  }

  // Resolve template strings in $head entries
  const resolvedPageHead = resolveHeadTemplates(pageHead, scope);
  const resolvedLayoutHead = resolveHeadTemplates(layoutHead, scope);

  // Resolve template strings in the document tree (innerHTML, textContent, style, attributes)
  // So that timing: "compiler" data is baked into the static HTML
  resolveDocTemplates(layoutDoc, scope);

  // Expand registered custom elements (apply $props, pre-render, mark static/prerendered).
  // Slot children are serialized to HTML strings during expansion — before compileStyles can walk
  // Them — so their static styles are collected here and injected as a page style block below.
  const slotCss: SlotCssCollector = {
    counter: { n: 0 },
    media: { ...projectConfig.$media, ...layoutDoc.$media },
    rules: [],
  };
  expandComponents(layoutDoc, componentDefs, slotCss, projectConfig.defaults);

  // Strip resolved timing: "compiler" state entries — they're now baked into the tree
  // And keeping them would cause isDynamic() to misclassify the page as dynamic.
  // Also strip resolved content arrays (from ContentCollection) that have been
  // Baked into unrolled map templates.
  if (layoutDoc.state) {
    // An array is only strippable if nothing that survives the build still reads it. A map
    // Expansion is one consumer, not the only one: the same array is routinely also read by a
    // Computed at runtime, and dropping it there left `state.rows` undefined in the browser while
    // The build reported success (issue #122). `timing: "compiler"` is excluded from this rescue —
    // That is the author declaring the entry build-time-only, so it is stripped as before.
    const strippable = new Set<string>();
    for (const [key, def] of Object.entries(layoutDoc.state)) {
      if (key === "$site" || key === "$page") {
        continue;
      }
      if (
        def &&
        typeof def === "object" &&
        !Array.isArray(def) &&
        (def as JxMutableNode).timing === "compiler"
      ) {
        delete layoutDoc.state[key];
      } else if (Array.isArray(def)) {
        strippable.add(key);
      }
    }
    // Iterated to a fixpoint: rescuing one array can reveal a read of another from its own def.
    let rescued = true;
    while (rescued) {
      rescued = false;
      const surviving = { ...layoutDoc.state } as Record<string, unknown>;
      for (const key of strippable) {
        delete surviving[key];
      }
      const haystack = JSON.stringify({ children: layoutDoc.children, state: surviving });
      for (const key of strippable) {
        if (referencesStateKey(haystack, key)) {
          strippable.delete(key);
          rescued = true;
        }
      }
    }
    for (const key of strippable) {
      delete layoutDoc.state[key];
    }
  }

  // Resolve bare npm specifiers in $head (e.g. "@pkg/name/file.css" → "/node_modules/@pkg/name/file.css")
  /*
   * Extension `head` contributions sit BELOW the project's own `$head`, so a project that writes
   * its own feed link keeps it — the same "author wins" rule every auto-injected entry follows.
   */
  /*
   * The registration script. Byte-identical on every page, so a strict `script-src` needs exactly
   * one hash for it (§14.3.1) — and it is only emitted when a worker actually exists, since a
   * tombstone must not be registered by the page that is trying to get rid of it.
   */
  const swConfig = normalizeServiceWorker(projectConfig.serviceWorker);
  const swHead: JxHeadEntry[] =
    swConfig === null || swConfig === false
      ? []
      : [{ tagName: "script", textContent: registrationScript(swConfig.scope ?? "/") }];

  const resolvedSiteHead = [
    // The manifest link and theme colour are first-party and unconditional once declared, so they
    // Sit with the extension contributions: below the project's own $head, which still wins.
    ...(manifestHeadEntries(projectConfig) as JxHeadEntry[]),
    ...swHead,
    ...extensionHead,
    ...resolveHeadBareSpecifiers(projectConfig.$head ?? [], rewriteNpmAsset),
  ];

  // Merge $head from site + layout + page
  const mergedHead = mergeHead(resolvedSiteHead, resolvedLayoutHead, resolvedPageHead, {
    title,
    charset: projectConfig.defaults?.charset ?? "utf8",
    ...(projectConfig.name != null && { siteName: projectConfig.name }),
    ...(projectConfig.url != null && { siteUrl: projectConfig.url }),
    ...(alternates.length > 0 && { alternates }),
    pageUrl: route.urlPattern,
  });

  // Merge project-level $media into the layout document so responsive queries are available
  if (projectConfig.$media) {
    layoutDoc.$media = { ...projectConfig.$media, ...layoutDoc.$media };
  }

  // Declaring a pure color-scheme query opts the page into the forced-scheme contract: restore
  // The visitor's persisted scheme before first paint (spec §9.5). Injected after the
  // Charset/viewport defaults and ahead of every preserved <style> block.
  if (Object.values(layoutDoc.$media ?? {}).some((q) => pureSchemeOf(String(q)) !== null)) {
    mergedHead.splice(2, 0, { tagName: "script", textContent: colorSchemePrePaintScript() });
  }

  /*
   * Responsive images. This runs whether or not `images.optimize` is on: the loading pass inside
   * it is governed by `images.lazyLoad`, and declining to generate variants for an image says
   * nothing about when the browser should fetch it.
   */
  if (projectConfig.images) {
    await transformImageNodes(
      layoutDoc,
      projectConfig.images as ImageConfig,
      projectRoot,
      imageCache,
      imageMetaCache ?? undefined,
      assetMounts,
    );
  }

  // Compile the document using the existing compiler
  const result = await compile(layoutDoc, {
    lang: language.lang,
    /*
     * The page-template tiers emit their own import map, and it defaulted to the CDN — so a page
     * that reached compile-static/compile-client kept loading its runtime from esm.sh even after
     * the self-hosting landed, because `injectComponentScripts` sees a map already present and
     * declines to add its own. Both halves have to name the same URLs.
     */
    ...(runtimeImports["@vue/reactivity"] === undefined
      ? {}
      : { reactivitySrc: runtimeImports["@vue/reactivity"] }),
    ...(runtimeImports["lit-html"] === undefined ? {} : { litHtmlSrc: runtimeImports["lit-html"] }),
    prePaintScheme: false, // Injected via the merged <head> above, not the target template
    projectStyle: projectConfig.style ?? null,
    ...(rewriteSidecarSrc === undefined
      ? {}
      : {
          rewriteSrc: (specifier: string) =>
            rewriteSidecarSrc(specifier, dirname(route.sourcePath as string)),
        }),
    title,
  });

  // Inject CSS rules collected from component slot content
  if (slotCss.rules.length > 0) {
    result.html = result.html.replace(
      "</head>",
      `<style>\n${slotCss.rules.join("\n")}\n</style>\n</head>`,
    );
  }

  // Post-process: inject merged <head> content into the compiled HTML
  result.html = injectHead(result.html, mergedHead, language);

  // Inject <script type="module"> for npm $elements (cherry-picked component imports)
  const npmElements = (layoutDoc.$elements ?? []).filter(
    (e: JxElement | string) => typeof e === "string" && !e.startsWith("./") && !e.startsWith("../"),
  );
  if (npmElements.length > 0) {
    /*
     * Bundled through the same sidecar path as a Function-def `$src`, with the `npm:` prefix the
     * resolver expects. A component package imports its own dependencies by bare specifier, and
     * the emitted import map only ever carried `@vue/reactivity` and `lit-html` — so linking the
     * package file directly left those imports unresolvable even before the URL was wrong.
     */
    const bundleNpmElement = (specifier: string) =>
      rewriteSidecarSrc === undefined ? specifier : rewriteSidecarSrc(`npm:${specifier}`, null);
    result.html = injectNpmElementScripts(result.html, npmElements as string[], bundleNpmElement);
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
    doc: layoutDoc,
    // A page opts out of the sitemap by setting `$sitemap: false` (interim escape hatch
    // Until draft filtering lands in the build pipeline).
    excludeFromSitemap: pageDoc.$sitemap === false,
    files: result.files,
    html: result.html,
    /*
     * Reported rather than warned about here: a mistyped `rel` almost always lives in the site or
     * layout `$head`, which means it is on every page, and the caller is the only scope that can
     * say it once instead of four hundred times.
     */
    unregisteredRelations: unregisteredHeadRelations(mergedHead),
    serverHandler,
  };
}

/**
 * Build the mount + connector specs for the generated worker (specs/extensions.md §11–§12).
 *
 * Mount options inline the extension-contributed sections from project.json — identifiers only,
 * never secrets (§13). Connector classes are included when any section entry names their
 * `connector.provider`; the import specifier comes from the descriptor's `connector.module` (bare
 * specifier — Workers cannot import filesystem paths).
 *
 * @param {FormatEntry[]} activeMounts - Server-mount classes with active sections
 * @param {ExtensionRegistry} registry
 * @param {ProjectConfig} projectConfig
 * @returns {{ mounts: SiteMountSpec[]; connectors: SiteConnectorSpec[] }}
 */
function buildMountSpecs(
  activeMounts: FormatEntry[],
  registry: ExtensionRegistry,
  projectConfig: ProjectConfig,
): { mounts: SiteMountSpec[]; connectors: SiteConnectorSpec[] } {
  if (activeMounts.length === 0) {
    return { connectors: [], mounts: [] };
  }

  const sections: Record<string, unknown> = {};
  for (const contribution of registry.projectContributions()) {
    const { key } = contribution.project!;
    if (key in projectConfig) {
      sections[key] = projectConfig[key];
    }
  }

  const mounts: SiteMountSpec[] = activeMounts.map((entry) => {
    const server = entry.server!;
    const { module } = server;
    if (typeof module !== "string" || module === "") {
      throw new Error(
        `Extension class "${entry.name}": server.module (a bare import specifier) is required ` +
          `to generate a deployable worker`,
      );
    }
    return {
      basePath: server.basePath,
      className: (entry.classDef.title as string | undefined) ?? entry.name,
      module,
      options: { basePath: server.basePath, sections },
      order: server.order ?? 100,
    };
  });

  // Used providers: any section entry object carrying a string `provider` field (the connector
  // Vocabulary, §12) marks that provider's class for import.
  const usedProviders = new Set<string>();
  for (const value of Object.values(sections)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    for (const sectionEntry of Object.values(value as Record<string, unknown>)) {
      const provider = (sectionEntry as { provider?: unknown } | null)?.provider;
      if (typeof provider === "string") {
        usedProviders.add(provider);
      }
    }
  }

  const connectors: SiteConnectorSpec[] = [];
  for (const entry of registry.connectors()) {
    const provider = String(entry.connector!.provider);
    if (!usedProviders.has(provider)) {
      continue;
    }
    const { module } = entry.connector!;
    if (typeof module !== "string" || module === "") {
      throw new Error(
        `Connector class "${entry.name}": connector.module (a bare import specifier) is ` +
          `required to generate a deployable worker`,
      );
    }
    connectors.push({
      className: (entry.classDef.title as string | undefined) ?? entry.name,
      module,
      provider,
    });
  }

  return { connectors, mounts };
}

/**
 * Gather every extension's `<head>` contribution, once, before the first page is built.
 *
 * Separate from `emit` because the two answer different questions at different times: `emit`
 * derives files from loaded content long after every page was written, while this derives entries
 * from CONFIGURATION and must run first. Gated like every other section capability — a class only
 * contributes when the project declares a non-empty value for its section key.
 */
async function collectExtensionHead(
  registry: ExtensionRegistry,
  projectConfig: ProjectConfig,
  projectRoot: string,
): Promise<JxHeadEntry[]> {
  const out: JxHeadEntry[] = [];
  for (const entry of registry.headProviders()) {
    const key = entry.project?.key;
    const sectionValue = key === undefined ? null : (projectConfig as Record<string, unknown>)[key];
    if (key !== undefined && (sectionValue === undefined || sectionValue === null)) {
      continue;
    }
    try {
      const contributed = (await entry.call("head", sectionValue ?? null, {
        projectConfig,
        root: projectRoot,
      })) as JxHeadEntry[] | null;
      out.push(...(contributed ?? []));
    } catch (error) {
      console.warn(`${entry.name} head capability failed: ${(error as Error).message}`);
    }
  }
  return out;
}

/**
 * Resolve template strings in $head entries against the compiled scope.
 *
 * @param {JxHeadEntry[]} headEntries
 * @param {Record<string, unknown>} scope
 * @returns {JxHeadEntry[]}
 */
function resolveTemplatesDeep(value: unknown, scope: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    return isTemplateString(value) ? (evaluateStaticTemplate(value, scope) ?? value) : value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => resolveTemplatesDeep(v, scope));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, resolveTemplatesDeep(v, scope)]),
    );
  }
  return value;
}

function resolveHeadTemplates(headEntries: JxHeadEntry[], scope: Record<string, unknown>) {
  return headEntries.map((entry: JxHeadEntry) => {
    if (!entry || typeof entry !== "object") {
      return entry;
    }
    const resolved = { ...entry };
    if (resolved.attributes) {
      resolved.attributes = { ...resolved.attributes };
      for (const [k, v] of Object.entries(resolved.attributes)) {
        if (typeof v === "string" && isTemplateString(v)) {
          resolved.attributes[k] =
            (evaluateStaticTemplate(v, scope) as string | boolean | null) ??
            (v as string | boolean);
        }
      }
    }
    if (typeof resolved.textContent === "string" && isTemplateString(resolved.textContent)) {
      resolved.textContent =
        (evaluateStaticTemplate(resolved.textContent, scope) as string | null) ??
        resolved.textContent;
    } else if (resolved.textContent !== null && typeof resolved.textContent === "object") {
      // A structured data block (§8.5): templates inside it resolve too, or a JSON-LD object could
      // Never reference the page it describes.
      resolved.textContent = resolveTemplatesDeep(resolved.textContent, scope) as Record<
        string,
        unknown
      >;
    }
    return resolved;
  });
}

/**
 * Resolve bare npm specifiers in $head entry attributes (href, src) to their copied `/assets/` URL.
 *
 * `"@shoelace-style/shoelace/dist/themes/light.css"` →
 * `"/assets/shoelace-style-shoelace-dist-themes-light.css"`.
 *
 * @param {JxHeadEntry[]} headEntries
 * @param {(specifier: string) => string} rewrite
 * @returns {JxHeadEntry[]}
 */
function resolveHeadBareSpecifiers(
  headEntries: JxHeadEntry[],
  rewrite: (specifier: string) => string,
) {
  return headEntries.map((entry: JxHeadEntry) => {
    if (!entry || typeof entry !== "object" || !entry.attributes) {
      return entry;
    }
    const resolved = { ...entry, attributes: { ...entry.attributes } };
    for (const key of ["href", "src"]) {
      const val = resolved.attributes[key];
      if (typeof val === "string" && isBareSpecifier(val)) {
        resolved.attributes[key] = rewrite(val);
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
 * @param {JxElement} template
 * @param {Record<string, unknown>} scope
 * @returns {JxElement}
 */
function expandMapTemplate(template: JxElement, scope: Record<string, unknown>): JxElement {
  if (!template || typeof template !== "object") {
    return template;
  }
  const node = {} as JxElement;
  for (const [k, v] of Object.entries(template)) {
    if (k === "children" && Array.isArray(v)) {
      node.children = (v as (string | JxElement)[]).map((child) => {
        if (typeof child === "string") {
          return child;
        }
        return expandMapTemplate(child, scope);
      });
    } else if (k === "style" && v && typeof v === "object") {
      const style: JxStyle = { ...(v as JxStyle) };
      for (const [sk, sv] of Object.entries(style)) {
        if (isTemplateString(sv)) {
          // Template evaluation yields a substituted scalar for style values.
          style[sk] = (evaluateMapTemplate(sv, scope) as string | number | undefined) ?? sv;
        }
      }
      node.style = style;
    } else if (k === "attributes" && v && typeof v === "object") {
      const attrs = { ...(v as Record<string, JxAttributeValue>) };
      for (const [ak, av] of Object.entries(attrs)) {
        if (isTemplateString(av)) {
          attrs[ak] = (evaluateMapTemplate(av, scope) as JxAttributeValue | undefined) ?? av;
        }
      }
      node.attributes = attrs;
    } else if (k === "$props" && v && typeof v === "object") {
      const props = { ...(v as Record<string, JsonValue>) };
      for (const [pk, pv] of Object.entries(props)) {
        if (isTemplateString(pv)) {
          const resolved = evaluateMapTemplate(pv, scope) as JsonValue | undefined;
          // Null = evaluation error → keep template string; undefined = missing data → use null
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
      const fn = new Function(
        "state",
        "$map",
        "item",
        "index",
        `return (${singleExprMatch[1]})`,
      ) as (
        state: Record<string, unknown>,
        $map: unknown,
        item: unknown,
        index: unknown,
      ) => unknown;
      return fn(scope, scope.$map, item, index);
    }
    const fn = new Function("state", "$map", "item", "index", `return \`${str}\``) as (
      state: Record<string, unknown>,
      $map: unknown,
      item: unknown,
      index: unknown,
    ) => unknown;
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
  if (!node || typeof node !== "object") {
    return;
  }

  if (typeof node.innerHTML === "string" && isTemplateString(node.innerHTML)) {
    const resolved = evaluateStaticTemplate(node.innerHTML, scope);
    if (resolved != null) {
      // Encode any remaining `${` as HTML entities so the compile phase won't
      // Re-interpret them as template expressions. After resolution, any `${` in the
      // Result is literal content (e.g., code examples), not an intentional template.
      node.innerHTML = String(resolved).replaceAll("${", "&#36;{");
    }
  }
  if (typeof node.textContent === "string" && isTemplateString(node.textContent)) {
    node.textContent =
      (evaluateStaticTemplate(node.textContent, scope) as string | null) ??
      (node.textContent as string | null);
  }
  if (node.style && typeof node.style === "object") {
    for (const [k, v] of Object.entries(node.style)) {
      if (typeof v === "string" && isTemplateString(v)) {
        node.style[k] =
          (evaluateStaticTemplate(v, scope) as string | number | JxStyle | undefined) ??
          (v as string | number | JxStyle);
      }
    }
  }
  if (node.attributes && typeof node.attributes === "object") {
    for (const [k, v] of Object.entries(node.attributes)) {
      if (typeof v === "string" && isTemplateString(v)) {
        node.attributes[k] = (evaluateStaticTemplate(v, scope) as JxAttributeValue | null) ?? v;
      }
    }
  }
  if (node.$props && typeof node.$props === "object") {
    for (const [k, v] of Object.entries(node.$props)) {
      if (typeof v === "string" && isTemplateString(v)) {
        node.$props[k] = (evaluateStaticTemplate(v, scope) as JsonValue | null) ?? v;
      }
    }
  }
  const rawChildren = node.children;
  // Legacy whole-children repeater: expand the items into the node's static children.
  // Only when the expansion actually produced nodes. `expandMappedArrayStatic` returns `null` when
  // `items` cannot be resolved at build time and `[]` when it resolves to an empty array — and `[]`
  // Is truthy, so an empty build-time list used to replace the repeater with nothing, discarding the
  // Definition the client needed. There is no prerendered output to preserve in that case, so the
  // Repeater is left in place for the client to bind (a page containing one is never zero-JS).
  if (isMappedArray(rawChildren)) {
    const expanded = expandMappedArrayStatic(rawChildren, scope);
    if (expanded && expanded.length > 0) {
      node.children = expanded;
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
      const child = node.children[i]!;
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
      // Array pseudo-element among siblings: expand its items in place, on the same
      // Produced-nothing rule as the whole-children branch above.
      if (isMappedArray(child)) {
        const expanded = expandMappedArrayStatic(child, scope);
        if (expanded && expanded.length > 0) {
          node.children.splice(i, 1, ...expanded);
          i += expanded.length;
          continue;
        }
      }
      resolveDocTemplates(child, scope);
      i += 1;
    }
  }
}

/**
 * Whether a serialized document fragment still reads a given state key — as a `${state.key}`
 * template, a bare `state.key` inside a handler or computed body, or a `#/state/key` $ref.
 *
 * @param {string} haystack - JSON-serialized document fragment
 * @param {string} key
 * @returns {boolean}
 */
function referencesStateKey(haystack: string, key: string): boolean {
  const escaped = key.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  return new RegExp(String.raw`\bstate\.${escaped}\b|#/state/${escaped}(?=["/])`).test(haystack);
}

/**
 * Statically expand a mapped array to its resolved item nodes when `items` resolves to an array at
 * build time, or null otherwise (leave the array node for client-side rendering).
 *
 * @param {JxMappedArray} arrayDef
 * @param {Record<string, unknown>} scope
 * @returns {(JxElement | string)[] | null}
 */
function expandMappedArrayStatic(
  arrayDef: JxMappedArray,
  scope: Record<string, unknown>,
): (JxElement | string)[] | null {
  const itemsSrc = arrayDef.items;
  let items: unknown = null;
  if (isRef(itemsSrc)) {
    items = resolveRefValue(itemsSrc.$ref, scope);
  } else if (Array.isArray(itemsSrc)) {
    items = itemsSrc;
  }
  const mapTemplate = arrayDef.map;
  if (!Array.isArray(items) || !mapTemplate) {
    return null;
  }
  return (items as unknown[]).map((item: unknown, index) => {
    const childScope = Object.create(scope) as Record<string, unknown>;
    childScope.$map = { index, item };
    childScope["$map/item"] = item;
    childScope["$map/index"] = index;
    const expanded = expandMapTemplate(mapTemplate, childScope);
    resolveDocTemplates(expanded, childScope);
    return expanded;
  });
}

/** Collector for CSS rules extracted from component slot content during expansion. */
interface SlotCssCollector {
  rules: string[];
  counter: { n: number };
  media: Record<string, string>;
}

/**
 * Walk the document tree and expand registered custom elements in-place. Applies $props via
 * preRenderComponentHtml, marks static/prerendered. Slot children get their static styles collected
 * into `slotCss` (assigning jxs-N classes) before being serialized to HTML.
 *
 * @param {JxElement | string} node
 * @param {Map<string, JxElement>} componentDefs
 * @param {SlotCssCollector} [slotCss]
 * @param {ProjectConfig["defaults"]} [defaults] - Read for `defaults.shadow` (spec.md §16.6)
 */
function expandComponents(
  node: JxElement | string,
  componentDefs: Map<string, JxElement>,
  slotCss?: SlotCssCollector,
  defaults?: ProjectConfig["defaults"],
) {
  if (!node || typeof node !== "object") {
    return;
  }
  if (Array.isArray(node)) {
    for (const n of node as (JxElement | string)[]) {
      expandComponents(n, componentDefs, slotCss, defaults);
    }
    return;
  }

  // Recurse into children first (bottom-up expansion)
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      expandComponents(child, componentDefs, slotCss, defaults);
    }
  }

  const def = componentDefs.get(node.tagName as string);
  if (def) {
    // JSON-authored instances pass props as literal `props.*` attribute keys (markdown directives
    // Are normalized to $props by the parser's expandDotPaths, but JSON is parsed verbatim).
    // Lift them into $props so the pre-render sees them, and strip them from attributes so they
    // Don't leak into the emitted HTML. Values stay raw strings — no coercion, matching the
    // Markdown path and the runtime's $props semantics. Explicit $props wins on key conflicts.
    if (node.attributes) {
      let lifted: NonNullable<JxElement["$props"]> | null = null;
      for (const [key, value] of Object.entries(node.attributes)) {
        if (key.startsWith("props.") && key.length > "props.".length) {
          lifted ??= {};
          // JxAttributeValue is JSON-representable (primitives or a $ref object), so the
          // Narrowing to JsonValue is sound.
          lifted[key.slice("props.".length)] = value as JsonValue;
          delete node.attributes[key];
        }
      }
      if (lifted) {
        node.$props = { ...lifted, ...node.$props };
      }
    }

    const slotContent =
      Array.isArray(node.children) && node.children.length > 0
        ? node.children
            .map((c: JxElement | string) => {
              if (slotCss && c && typeof c === "object") {
                collectStyles(c, slotCss.rules, slotCss.media, "", slotCss.counter, "jxs");
              }
              return renderStaticNode(c, {}, null);
            })
            .join("\n")
        : null;

    /*
     * In shadow mode the slotted children are NOT substituted into the prerendered markup: they
     * stay in the light tree as siblings of the template, where a real `<slot>` distributes them.
     * Passing them here instead would bake them into the shadow root, and the browser would then
     * render them twice.
     */
    const shadow = resolveShadowMode(def, defaults);
    const innerHTML = preRenderComponentHtml(def, node.$props || null, shadow ? null : slotContent);
    const isStatic = isComponentFullyStatic(def);

    /*
     * A declarative shadow root: markup the parser materializes before any script runs, which the
     * element then adopts rather than replaces (spec.md §16.6). The stylesheet link moves inside
     * it because a shadow root does not inherit the document's stylesheets — and it stays an
     * external `<link>`, so no Content-Security-Policy hash changes.
     */
    node.innerHTML = shadow
      ? `<template shadowrootmode="${shadow}">` +
        `<link rel="stylesheet" href="/components/${node.tagName}.css">` +
        `${innerHTML}</template>${slotContent ?? ""}`
      : innerHTML;
    delete node.children;

    // Resolve template-string host styles with props (per-instance values like background-image)
    if (def.style && node.$props) {
      const stateDefs: Record<string, JxStateDefinition> = { ...def.state };
      for (const [key, value] of Object.entries(node.$props)) {
        stateDefs[key] =
          key in stateDefs ? (value as JxStateDefinition) : (value as JxStateDefinition);
      }
      const scope = buildInitialScope(stateDefs, null);
      const resolvedStyle: Record<string, unknown> = {};
      for (const [prop, value] of Object.entries(def.style)) {
        if (typeof value === "string" && isTemplateString(value)) {
          const resolved = resolveStaticValue(value, scope);
          if (resolved != null) {
            resolvedStyle[prop] = resolved;
          }
        }
      }
      if (Object.keys(resolvedStyle).length > 0) {
        node.style = { ...node.style, ...resolvedStyle } as JxStyle;
      }
    }

    delete node.$props;

    if (isStatic) {
      node.$static = true;
    } else {
      node.$prerendered = true;
    }
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
 * @param {string} [islandSource] - Concatenated island modules emitted for this page
 * @param {Record<string, string>} [runtimeImports] - The import map's `imports` object
 * @param {Set<string>} [runtimeAssetsUsed] - Collects the asset paths an emitted import map names
 * @returns {string}
 */
function injectComponentScripts(
  html: string,
  allComponentTags: string[],
  cssMap = new Map<string, string>(),
  staticTags = new Set<string>(),
  islandSource = "",
  runtimeImports: Record<string, string> = {},
  runtimeAssetsUsed = new Set<string>(),
) {
  // A component reaches a page two ways: as a literal tag in the static HTML, or referenced only
  // From inside an island's client template — in which case the tag exists solely in the island's
  // Compiled JS and never in the HTML the page ships. Searching the HTML alone missed the second
  // Kind entirely, so its module was never loaded and the element sat in the DOM un-upgraded.
  const inHtml = (tag: string) => html.includes(`<${tag}`); // Matches <tag> and <tag ...>
  const inIsland = (tag: string) => islandSource.includes(`<${tag}`);
  const usedTags = allComponentTags.filter((tag: string) => inHtml(tag) || inIsland(tag));
  if (usedTags.length === 0) {
    return html;
  }

  // Inject CSS links in <head> for ALL components that have CSS sidecars
  const cssLinks = usedTags
    .filter((tag: string) => cssMap.has(tag))
    .map((tag: string) => `<link rel="stylesheet" href="/components/${tag}.css">`)
    .join("\n  ");
  let result = html;
  if (cssLinks) {
    result = result.replace("</head>", `  ${cssLinks}\n</head>`);
  }

  // Only inject JS for components that have non-static instances. An island-rendered instance is
  // Never prerendered, so it needs its module even when the component itself is fully static —
  // That module is what fills the element in client-side. This holds when the tag ALSO appears in
  // The static HTML: those instances are prerendered, but the ones the island creates are not.
  const jsTags = usedTags.filter((tag: string) => inIsland(tag) || !staticTags.has(tag));
  if (jsTags.length === 0) {
    return result;
  }

  // Build import map (needed for @vue/reactivity and lit-html)
  const importMap = renderImportMap(runtimeImports);
  for (const url of Object.values(runtimeImports)) {
    if (url.startsWith("/")) {
      runtimeAssetsUsed.add(url);
    }
  }

  const moduleScripts = jsTags
    .map((tag: string) => `<script type="module" src="/components/${tag}.js"></script>`)
    .join("\n  ");

  // Check if an import map already exists (from islands etc.)
  const hasImportMap = result.includes('<script type="importmap">');
  const injection = (hasImportMap ? "" : `${importMap}\n  `) + moduleScripts;

  return result.replace("</body>", `  ${injection}\n</body>`);
}

/**
 * Inject <script type="module"> tags for npm package $elements (cherry-picked component imports).
 *
 * Bare specifiers are BUNDLED to `/assets/`, not linked into node_modules. Bundling rather than
 * copying because a component package imports its own dependencies by bare specifier too, and the
 * import map only ever carried two entries.
 *
 * @param {string} html
 * @param {string[]} npmElements - Bare specifier strings, e.g.
 *   "@shoelace-style/shoelace/components/button/button.js"
 * @returns {string}
 */
function injectNpmElementScripts(
  html: string,
  npmElements: string[],
  rewrite: (specifier: string) => string,
) {
  const scripts = npmElements
    .map((spec: string) => `<script type="module" src="${rewrite(spec)}"></script>`)
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
function injectHead(
  html: string,
  headEntries: JxHeadEntry[],
  root: { lang: string; dir?: string },
) {
  const headHtml = renderHead(headEntries);

  // Replace the existing <head>...</head> block, preserving compiler-generated <style> and <script> blocks
  const headPattern = /<head>([\s\S]*?)<\/head>/i;
  const existingMatch = html.match(headPattern);
  let preservedBlocks = "";
  if (existingMatch) {
    const styles = existingMatch[1]!.match(/<style>[\s\S]*?<\/style>/gi);
    if (styles) {
      preservedBlocks += `\n  ${styles.join("\n  ")}`;
    }
    const scripts = existingMatch[1]!.match(/<script[\s\S]*?<\/script>/gi);
    if (scripts) {
      preservedBlocks += `\n  ${scripts.join("\n  ")}`;
    }
  }
  let result = html;
  if (headPattern.test(result)) {
    result = result.replace(headPattern, `<head>\n  ${headHtml}${preservedBlocks}\n</head>`);
  }

  // Set lang and dir on <html>. `dir` matters for the same reason `lang` does: without it, a
  // Right-to-left page renders left-to-right, and the default is not "unset" but "ltr".
  result = result.replace(/<html\s[^>]*>/i, (match: string) => {
    let tag = /lang=/.test(match)
      ? match.replace(/lang="[^"]*"/, `lang="${root.lang}"`)
      : match.replace("<html", `<html lang="${root.lang}"`);
    if (root.dir !== undefined) {
      tag = /\sdir=/.test(tag)
        ? tag.replace(/\sdir="[^"]*"/, ` dir="${root.dir}"`)
        : tag.replace("<html", `<html dir="${root.dir}"`);
    }
    return tag;
  });

  return result;
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

  // TrailingSlash: "never" or default
  return join(outDir, `${segments}.html`);
}

/**
 * Generate redirect files (HTML meta refresh and _redirects).
 *
 * @param {Record<string, string | { destination: string; status?: number }>} redirects
 * @param {string} outDir
 * @param {Set<string>} [compiledUrls] - URL patterns of compiled routes, for conflict warnings
 * @returns {number} Number of files written
 */
/**
 * Which statuses get an HTML fallback, and why each other one does not.
 *
 * An HTML meta-refresh is a _client-side_ redirect: the browser fetches the source, then navigates.
 * That is a reasonable stand-in for a 301 or a 303 on a host that ignores `_redirects`, and it is
 * actively wrong for everything else.
 */
const REDIRECT_HTML_POLICY: Record<number, { html: boolean; canonical: boolean; why: string }> = {
  // The permanent case: a canonical link is exactly the right signal.
  301: { canonical: true, html: true, why: "" },
  // Temporary — a canonical link would assert the permanence the status denies.
  302: { canonical: false, html: true, why: "" },
  // "See other, with GET" is what a meta-refresh already does.
  303: { canonical: false, html: true, why: "" },
  307: {
    canonical: false,
    html: false,
    why: "307 preserves the request method and body; a meta-refresh silently converts POST to GET",
  },
  308: {
    canonical: false,
    html: false,
    why: "308 preserves the request method and body; a meta-refresh silently converts POST to GET",
  },
};

/**
 * Emit `dist/_redirects` plus an HTML fallback for the literal sources whose status has one.
 *
 * @param {Record<
 *   string,
 *   string | { destination: string; status?: number } | { destination: string; rewrite: true }
 * >} redirects
 * @param {string} outDir
 * @param {{ compiledUrls?: Set<string>; trailingSlash?: string }} [opts]
 * @returns {{ files: number; errors: string[] }}
 */
function generateRedirects(
  redirects: Record<
    string,
    string | { destination: string; status?: number } | { destination: string; rewrite: true }
  >,
  outDir: string,
  opts: { compiledUrls?: Set<string>; trailingSlash?: string } = {},
) {
  let files = 0;
  const errors: string[] = [];
  const redirectLines: string[] = [];
  const normalizeUrl = (u: string) => (u.length > 1 && u.endsWith("/") ? u.slice(0, -1) : u);
  const compiled = new Set([...(opts.compiledUrls ?? [])].map((u) => normalizeUrl(u)));
  const trailingSlash = opts.trailingSlash ?? "always";

  for (const [source, target] of Object.entries(redirects)) {
    const dest = typeof target === "object" ? target.destination : target;
    const isRewrite = typeof target === "object" && "rewrite" in target && target.rewrite;
    const status = isRewrite
      ? 200
      : typeof target === "object" && "status" in target
        ? (target.status ?? 301)
        : 301;

    if (!isRewrite && REDIRECT_HTML_POLICY[status] === undefined) {
      errors.push(
        `Redirect "${source}" has status ${status}, which is not an RFC 9110 §15.4 redirection ` +
          `status. Use one of ${Object.keys(REDIRECT_HTML_POLICY).join(", ")}, or ` +
          `{ destination, rewrite: true } for a proxy.`,
      );
      continue;
    }

    redirectLines.push(`${source} ${dest} ${status}`);

    // A pattern source cannot be a file on disk, so it lives only in `_redirects`.
    if (source.includes(":") || source.includes("*")) {
      continue;
    }

    if (compiled.has(normalizeUrl(source))) {
      const what = isRewrite ? "rewrite" : "redirect";
      console.warn(
        `The ${what} "${source}" collides with a compiled page at the same route — ` +
          `remove one or the other.`,
      );
    }

    /*
     * A rewrite serves the destination's content AT the source URL. Writing an HTML file there
     * shadows the rewrite on hosts that honour `_redirects`, and turns it into a redirect on the
     * hosts that do not — so it is wrong in both directions. This was the bug.
     */
    if (isRewrite) {
      continue;
    }
    const policy = REDIRECT_HTML_POLICY[status]!;
    if (!policy.html) {
      continue;
    }

    const htmlPath = routeToOutputPath(source, outDir, trailingSlash);
    const canonical = policy.canonical
      ? `\n  <link rel="canonical" href="${escapeAttr(dest)}">`
      : `\n  <meta name="robots" content="noindex">`;
    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="0;url=${escapeAttr(dest)}">${canonical}
  <title>Redirecting...</title>
</head>
<body>
  <p>Redirecting to <a href="${escapeAttr(dest)}">${escapeHtml(dest)}</a>...</p>
</body>
</html>`;
    mkdirSync(dirname(htmlPath), { recursive: true });
    writeFileSync(htmlPath, html, "utf8");
    files += 1;
  }

  if (redirectLines.length > 0) {
    writeFileSync(join(outDir, "_redirects"), `${redirectLines.join("\n")}\n`, "utf8");
    files += 1;
  }

  return { errors, files };
}

/**
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str: string) {
  return String(str).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * @param {string} str
 * @returns {string}
 */
function escapeAttr(str: string) {
  return String(str).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

/**
 * Escape a value for inclusion in XML text (e.g. a sitemap `<loc>`). Handles the five predefined
 * XML entities — `&` must be first so the others aren't double-escaped.
 *
 * @param {string} str
 * @returns {string}
 */
function escapeXml(str: string) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/**
 * Write a sitemap.xml from the collected page entries (sitemaps.org urlset 0.9). Each entry emits a
 * `<loc>` plus a full RFC 3339 `<lastmod>`.
 *
 * The W3C Datetime profile sitemaps.org cites admits both `YYYY-MM-DD` and a complete timestamp.
 * The date-only form threw away the time and, with it, any way to tell two edits on one day apart.
 *
 * @param {{ loc: string; lastmod: string }[]} entries
 * @param {string} outDir
 * @returns {number} Number of files written
 */
/** A `Date` to RFC 3339 in UTC, without fractional seconds. */
function toRfc3339(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** The namespace `xhtml:link` alternates live in, declared only when some entry has them. */
const XHTML_NS = "http://www.w3.org/1999/xhtml";

interface SitemapEntry {
  loc: string;
  lastmod: string;
  alternates?: readonly LocaleAlternate[];
}

function generateSitemap(entries: SitemapEntry[], outDir: string) {
  if (entries.length === 0) {
    return 0;
  }
  const urls = entries
    .map((e) => {
      /*
       * Every member of a translation set lists every member including itself — that reciprocity
       * is what the annotation means, and a validator checks for it.
       */
      const links = (e.alternates ?? [])
        .map(
          (a) =>
            `    <xhtml:link rel="alternate" hreflang="${escapeXml(a.hreflang)}" ` +
            `href="${escapeXml(a.href)}"/>`,
        )
        .join("\n");
      return (
        `  <url>\n    <loc>${escapeXml(e.loc)}</loc>\n` +
        `    <lastmod>${e.lastmod}</lastmod>\n${links === "" ? "" : `${links}\n`}  </url>`
      );
    })
    .join("\n");
  // The namespace declaration is conditional: a monolingual sitemap should not carry a namespace
  // It never uses.
  const ns = entries.some((e) => (e.alternates?.length ?? 0) > 0)
    ? ` xmlns:xhtml="${XHTML_NS}"`
    : "";
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"${ns}>\n${urls}\n</urlset>\n`;
  writeFileSync(join(outDir, "sitemap.xml"), xml, "utf8");
  return 1;
}

/**
 * Ensure dist/robots.txt references the sitemap. Appends a `Sitemap:` line to an existing
 * robots.txt (creating a permissive default if none was copied from public/), unless one is already
 * present.
 *
 * @param {string} outDir
 * @param {string} siteUrl
 * @returns {number} Number of files newly created (0 if robots.txt already existed)
 */
function ensureRobotsSitemap(outDir: string, siteUrl: string) {
  const robotsPath = join(outDir, "robots.txt");
  const existed = existsSync(robotsPath);
  let content = existed ? readFileSync(robotsPath, "utf8") : "User-agent: *\nAllow: /\n";
  if (/^Sitemap:/im.test(content)) {
    return 0;
  }
  if (!content.endsWith("\n")) {
    content += "\n";
  }
  content += `\nSitemap: ${new URL("/sitemap.xml", siteUrl).href}\n`;
  writeFileSync(robotsPath, content, "utf8");
  return existed ? 0 : 1;
}
