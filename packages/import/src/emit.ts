import { join, dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import type { JxElement } from "@jxsuite/schema/types";
import { componentize } from "./componentize.ts";
import { stripClasses } from "./strip-classes.ts";
import type { ComponentizeOptions, ComponentizeResult } from "./componentize.ts";

/**
 * The `$media` key the base width lives under — a number of CSS pixels, not a query.
 *
 * Studio's canvas reads it to size the default artboard (`utils/canvas-media.ts`), and an import
 * never wrote one, so every imported project's base canvas fell back to 320px while its narrowest
 * real breakpoint was three times that. Mirrors `settings/contexts-section.ts`'s `BASE_KEY`.
 */
const BASE_MEDIA_KEY = "--";

/** The width a `--<width>` breakpoint key names, for sorting. Non-numeric keys sort first. */
function mediaKeyWidth(key: string): number {
  const width = Number(key.replace(/^--/, ""));
  return Number.isFinite(width) ? width : -1;
}

export interface EmitResult {
  /** Absolute paths of every file written. */
  files: string[];
  /** How many source-site class names were removed on the way out. */
  classesStripped: number;
}

export interface EmitOptions {
  outDir: string;
  title: string;
  document: JxElement;
  sourceUrl: string;
  /** $media breakpoints to seed into project.json (Phase 1). */
  breakpoints?: Record<string, string>;
  /** The capture viewport width, written as the `$media` base entry. */
  baseWidth?: number;
  /** Phase 4: componentization options. Pass false to skip. */
  componentizeOptions?: ComponentizeOptions | false;
}

export interface MultiEmitOptions {
  outDir: string;
  title: string;
  sourceUrl: string;
  /** Map of route path (e.g. "pages/index.json") → Jx document. */
  pages: Map<string, JxElement>;
  /** Optional layout to write to layouts/base.json. */
  layout?: JxElement | undefined;
  /** $media breakpoints to seed into project.json. */
  breakpoints?: Record<string, string> | undefined;
  /** The capture viewport width, written as the `$media` base entry. */
  baseWidth?: number | undefined;
  /** Phase 4: componentization options. Pass false to skip. */
  componentizeOptions?: ComponentizeOptions | false | undefined;
  /** Pre-computed componentization result (from AI pass). Overrides componentizeOptions. */
  precomputedComponents?: ComponentizeResult | undefined;
  /** Font-face CSS rule texts to emit as public/assets/fonts.css (R2). */
  fontFaceRules?: string[] | undefined;
  /** URL rewrite map for fonts — maps original font URLs to local paths. */
  fontRewriteMap?: Map<string, string> | undefined;
  /** CSS custom property tokens to hoist into project.json.$style (R5). */
  styleTokens?: Record<string, string> | undefined;
}

export async function emitProject({
  outDir,
  title,
  document,
  sourceUrl,
  breakpoints,
  baseWidth,
  componentizeOptions,
}: EmitOptions): Promise<EmitResult> {
  return emitMultiPageProject({
    outDir,
    title,
    sourceUrl,
    pages: new Map([["pages/index.json", document]]),
    breakpoints,
    baseWidth,
    componentizeOptions,
  });
}

export async function emitMultiPageProject({
  outDir,
  title,
  pages,
  layout,
  breakpoints,
  baseWidth,
  componentizeOptions,
  precomputedComponents,
  fontFaceRules,
  fontRewriteMap,
  styleTokens,
}: MultiEmitOptions): Promise<EmitResult> {
  await mkdir(join(outDir, "pages"), { recursive: true });
  await mkdir(join(outDir, "layouts"), { recursive: true });
  await mkdir(join(outDir, "components"), { recursive: true });
  await mkdir(join(outDir, "public"), { recursive: true });

  /*
   * Only keys the project schema declares (#228). `title` and `description` are page-level keys and
   * `$style` is not a key at all, and all three made every imported project fail `jx validate` —
   * and, because Studio's Contexts editor validates the WHOLE configuration before saving, made an
   * imported project's base width uneditable, reporting `(root): must NOT have unevaluated
   * properties` three times while naming nothing.
   *
   * The source URL has no schema-legal home and does not get one. `$head`'s description meta is the
   * nearest candidate and the wrong one: it is the site's own user-facing description, and
   * "Imported from …" is provenance, not a description of the site. The importer reports it instead.
   */
  const projectJson: Record<string, unknown> = {
    name: title || "Imported Site",
    imports: {},
    images: { optimize: false },
  };

  if (baseWidth !== undefined) {
    projectJson.$media = { [BASE_MEDIA_KEY]: `${Math.round(baseWidth)}px` };
  }
  if (breakpoints && Object.keys(breakpoints).length > 0) {
    /* Ascending, and the base first. `$media` is a map, so its order IS the order Studio's Contexts
       list and the pane's size switcher offer these in; a crawl merged them in page-visit order,
       which is not an order at all. */
    const sorted = Object.entries(breakpoints).toSorted(
      ([a], [b]) => mediaKeyWidth(a) - mediaKeyWidth(b),
    );
    projectJson.$media = { ...(projectJson.$media as object), ...Object.fromEntries(sorted) };
  }

  if (styleTokens && Object.keys(styleTokens).length > 0) {
    projectJson.style = styleTokens;
  }

  const files: string[] = [];

  // Phase 4: componentize pages
  let finalPages = pages;
  const componentFiles = new Map<string, JxElement>();

  const compResult =
    precomputedComponents ??
    (componentizeOptions !== false ? componentize(pages, componentizeOptions ?? {}) : null);

  if (compResult && compResult.components.size > 0) {
    finalPages = compResult.rewrittenPages;

    for (const [fileName, comp] of compResult.components) {
      const compDoc: JxElement = {
        ...comp.template,
        $id: comp.$id,
        tagName: comp.tagName,
      };

      const state: Record<string, string> = {};
      extractStateDefaults(comp.template, state);
      if (Object.keys(state).length > 0) {
        compDoc.state = state;
      }

      componentFiles.set(fileName, compDoc);
    }
  }

  // R2: Emit @font-face CSS with URLs rewritten to local paths
  if (fontFaceRules && fontFaceRules.length > 0) {
    let fontCss = fontFaceRules.join("\n\n");
    if (fontRewriteMap) {
      // A @font-face rule carries the url() form its AUTHOR wrote — usually root-relative
      // ("/wp-content/.../lato.woff2"), sometimes protocol-relative. The rewrite map is keyed by the
      // Absolute URL the downloader resolved, so matching on that alone rewrote nothing: every
      // Downloaded font stayed unreferenced and the page fell back to system fonts.
      //
      // Replaced in ONE pass, longest form first. Replacing form by form re-scans text this loop
      // Already rewrote, and a bare pathname ("/a.woff2") then matches inside the local path it
      // Just produced ("/assets/fonts/a.woff2" to "/assets/fonts/assets/fonts/a.woff2").
      const byForm = new Map<string, string>();
      for (const [originalUrl, localPath] of fontRewriteMap) {
        const local = localPath.startsWith("public/")
          ? localPath.slice("public/".length)
          : localPath;
        const href = local.startsWith("/") ? local : `/${local}`;
        const forms = new Set([originalUrl]);
        try {
          const u = new URL(originalUrl);
          forms.add(`//${u.host}${u.pathname}${u.search}`);
          forms.add(`${u.pathname}${u.search}`);
        } catch {
          // Already a relative reference — the literal form is all there is.
        }
        for (const form of forms) {
          if (form) {
            byForm.set(form, href);
          }
        }
      }
      const forms = [...byForm.keys()].toSorted((a, b) => b.length - a.length);
      if (forms.length > 0) {
        const pattern = new RegExp(
          forms.map((f) => f.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)).join("|"),
          "g",
        );
        fontCss = fontCss.replaceAll(pattern, (m) => byForm.get(m) ?? m);
      }
    }
    const fontsDir = join(outDir, "public", "assets");
    await mkdir(fontsDir, { recursive: true });
    const fontsCssPath = join(fontsDir, "fonts.css");
    await Bun.write(fontsCssPath, fontCss);
    files.push(fontsCssPath);

    // Add fonts.css to project head
    if (!projectJson.$head) {
      projectJson.$head = [];
    }
    (projectJson.$head as unknown[]).push({
      tagName: "link",
      attributes: { rel: "stylesheet", href: "/assets/fonts.css" },
    });
  }

  const projectPath = join(outDir, "project.json");
  await Bun.write(projectPath, `${JSON.stringify(projectJson, null, 2)}\n`);
  files.push(projectPath);

  /*
   * Classes go here, at the last possible moment, and that placement is the whole design.
   *
   * `componentize` groups by structure and `ai-componentize` reads the template to choose a name —
   * `product-card` over `component-div-0` — and the class names are the strongest signal either has.
   * Stripping earlier would cost that; stripping later is impossible. So both passes see the source
   * site's classes, and nothing downstream of this line does.
   */
  let classesStripped = 0;
  for (const compDoc of componentFiles.values()) {
    classesStripped += stripClasses(compDoc);
  }
  for (const doc of finalPages.values()) {
    classesStripped += stripClasses(doc);
  }

  // Write components
  for (const [fileName, compDoc] of componentFiles) {
    const compPath = join(outDir, "components", fileName);
    await Bun.write(compPath, `${JSON.stringify(compDoc, null, 2)}\n`);
    files.push(compPath);
  }

  // Build $elements refs for component registration
  const elementRefs: JxElement[] =
    componentFiles.size > 0
      ? [...componentFiles.keys()].map(
          (f) => ({ $ref: `../components/${f}` }) as unknown as JxElement,
        )
      : [];

  // Write each page
  for (const [route, doc] of finalPages) {
    const pageDoc = { ...doc };
    if (elementRefs.length > 0) {
      pageDoc.$elements = [
        ...elementRefs,
        ...((pageDoc.$elements as JxElement[]) ?? []),
      ] as JxElement[];
    }
    const pagePath = join(outDir, route);
    await mkdir(dirname(pagePath), { recursive: true });
    await Bun.write(pagePath, `${JSON.stringify(pageDoc, null, 2)}\n`);
    files.push(pagePath);
  }

  // Write layout
  const layoutPath = join(outDir, "layouts", "base.json");
  const layoutDoc: JxElement = layout ?? {
    tagName: "div",
    children: [{ tagName: "slot" }],
  };
  if (elementRefs.length > 0 && layout) {
    (layoutDoc as Record<string, unknown>).$elements = [
      ...elementRefs,
      ...(((layoutDoc as Record<string, unknown>).$elements as JxElement[]) ?? []),
    ];
  }
  classesStripped += stripClasses(layoutDoc);
  await Bun.write(layoutPath, `${JSON.stringify(layoutDoc, null, 2)}\n`);
  files.push(layoutPath);

  return { classesStripped, files };
}

function extractStateDefaults(node: JxElement | string, out: Record<string, string>) {
  if (typeof node === "string") {
    const key = node.match(/^\$\{state\.([^}]+)\}$/)?.[1];
    if (key && !(key in out)) {
      out[key] = "";
    }
    return;
  }
  if (typeof node.textContent === "string") {
    const key = node.textContent.match(/^\$\{state\.([^}]+)\}$/)?.[1];
    if (key && !(key in out)) {
      out[key] = "";
    }
  }
  if (node.attributes) {
    for (const v of Object.values(node.attributes)) {
      if (typeof v === "string") {
        const key = v.match(/^\$\{state\.([^}]+)\}$/)?.[1];
        if (key && !(key in out)) {
          out[key] = "";
        }
      }
    }
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      extractStateDefaults(child as JxElement | string, out);
    }
  }
}
