import { join, dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import type { JxElement } from "@jxsuite/schema/types";

export interface EmitOptions {
  outDir: string;
  title: string;
  document: JxElement;
  sourceUrl: string;
  /** $media breakpoints to seed into project.json (Phase 1). */
  breakpoints?: Record<string, string>;
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
}

export async function emitProject({
  outDir,
  title,
  document,
  sourceUrl,
  breakpoints,
}: EmitOptions): Promise<{ files: string[] }> {
  return emitMultiPageProject({
    outDir,
    title,
    sourceUrl,
    pages: new Map([["pages/index.json", document]]),
    breakpoints,
  });
}

export async function emitMultiPageProject({
  outDir,
  title,
  sourceUrl,
  pages,
  layout,
  breakpoints,
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

  const projectPath = join(outDir, "project.json");
  await Bun.write(projectPath, `${JSON.stringify(projectJson, null, 2)}\n`);
  files.push(projectPath);

  // Write each page
  for (const [route, doc] of pages) {
    const pagePath = join(outDir, route);
    await mkdir(dirname(pagePath), { recursive: true });
    await Bun.write(pagePath, `${JSON.stringify(doc, null, 2)}\n`);
    files.push(pagePath);
  }

  // Write layout
  const layoutPath = join(outDir, "layouts", "base.json");
  const layoutDoc: JxElement = layout ?? { tagName: "div", children: [] };
  await Bun.write(layoutPath, `${JSON.stringify(layoutDoc, null, 2)}\n`);
  files.push(layoutPath);

  return { files };
}
