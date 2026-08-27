import { join, dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import type { JxElement } from "@jxsuite/schema/types";
import { componentize } from "./componentize.ts";
import type { ComponentizeOptions, ComponentizeResult } from "./componentize.ts";

export interface EmitOptions {
  outDir: string;
  title: string;
  document: JxElement;
  sourceUrl: string;
  /** $media breakpoints to seed into project.json (Phase 1). */
  breakpoints?: Record<string, string>;
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
  componentizeOptions,
}: EmitOptions): Promise<{ files: string[] }> {
  return emitMultiPageProject({
    outDir,
    title,
    sourceUrl,
    pages: new Map([["pages/index.json", document]]),
    breakpoints,
    componentizeOptions,
  });
}

export async function emitMultiPageProject({
  outDir,
  title,
  pages,
  layout,
  breakpoints,
  componentizeOptions,
  precomputedComponents,
  fontFaceRules,
  fontRewriteMap,
  styleTokens,
}: MultiEmitOptions): Promise<{ files: string[] }> {
  await mkdir(join(outDir, "pages"), { recursive: true });
  await mkdir(join(outDir, "layouts"), { recursive: true });
  await mkdir(join(outDir, "components"), { recursive: true });
  await mkdir(join(outDir, "public"), { recursive: true });

  const projectJson: Record<string, unknown> = {
    name: title || "Imported Site",
    imports: {},
    images: { optimize: false },
  };

  if (breakpoints && Object.keys(breakpoints).length > 0) {
    projectJson.$media = breakpoints;
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
  await Bun.write(layoutPath, `${JSON.stringify(layoutDoc, null, 2)}\n`);
  files.push(layoutPath);

  return { files };
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
