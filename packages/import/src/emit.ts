import { join, dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import type { JxElement } from "@jxsuite/schema/types";
import { componentize } from "./componentize.ts";
import type { ComponentizeOptions } from "./componentize.ts";

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
  layout?: JxElement;
  /** $media breakpoints to seed into project.json. */
  breakpoints?: Record<string, string>;
  /** Phase 4: componentization options. Pass false to skip. */
  componentizeOptions?: ComponentizeOptions | false;
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
  sourceUrl,
  pages,
  layout,
  breakpoints,
  componentizeOptions,
}: MultiEmitOptions): Promise<{ files: string[] }> {
  await mkdir(join(outDir, "pages"), { recursive: true });
  await mkdir(join(outDir, "layouts"), { recursive: true });
  await mkdir(join(outDir, "components"), { recursive: true });
  await mkdir(join(outDir, "public"), { recursive: true });

  const projectJson: Record<string, unknown> = {
    title: title || "Imported Site",
    description: `Imported from ${sourceUrl}`,
    imports: {},
  };

  if (breakpoints && Object.keys(breakpoints).length > 0) {
    projectJson.$media = breakpoints;
  }

  const files: string[] = [];

  // Phase 4: componentize pages
  let finalPages = pages;
  const componentFiles = new Map<string, JxElement>();

  if (componentizeOptions !== false) {
    const compResult = componentize(pages, componentizeOptions ?? {});
    if (compResult.components.size > 0) {
      finalPages = compResult.rewrittenPages;

      for (const [fileName, comp] of compResult.components) {
        const compDoc: JxElement = {
          ...comp.template,
          $id: comp.$id,
          tagName: comp.tagName,
        };

        // Build state from the template's interpolated values
        const state: Record<string, string> = {};
        extractStateDefaults(comp.template, state);
        if (Object.keys(state).length > 0) {
          compDoc.state = state;
        }

        componentFiles.set(fileName, compDoc);
      }
    }
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
      pageDoc.$elements = [...elementRefs, ...(pageDoc.$elements ?? [])] as JxElement[];
    }
    const pagePath = join(outDir, route);
    await mkdir(dirname(pagePath), { recursive: true });
    await Bun.write(pagePath, `${JSON.stringify(pageDoc, null, 2)}\n`);
    files.push(pagePath);
  }

  // Write layout
  const layoutPath = join(outDir, "layouts", "base.json");
  const layoutDoc: JxElement = layout ?? { tagName: "div", children: [] };
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
    const match = node.match(/^\$\{state\.([^}]+)\}$/);
    if (match && !(match[1] in out)) {
      out[match[1]] = "";
    }
    return;
  }
  if (typeof node.textContent === "string") {
    const match = node.textContent.match(/^\$\{state\.([^}]+)\}$/);
    if (match && !(match[1] in out)) {
      out[match[1]] = "";
    }
  }
  if (node.attributes) {
    for (const v of Object.values(node.attributes)) {
      if (typeof v === "string") {
        const match = v.match(/^\$\{state\.([^}]+)\}$/);
        if (match && !(match[1] in out)) {
          out[match[1]] = "";
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
