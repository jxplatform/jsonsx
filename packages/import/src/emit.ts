import { join } from "node:path";
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

export async function emitProject({
  outDir,
  title,
  document,
  sourceUrl,
  breakpoints,
}: EmitOptions): Promise<{ files: string[] }> {
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

  const pagePath = join(outDir, "pages", "index.json");
  await Bun.write(pagePath, `${JSON.stringify(document, null, 2)}\n`);
  files.push(pagePath);

  const layoutPath = join(outDir, "layouts", "base.json");
  const baseLayout: JxElement = {
    tagName: "div",
    children: [],
  };
  await Bun.write(layoutPath, `${JSON.stringify(baseLayout, null, 2)}\n`);
  files.push(layoutPath);

  return { files };
}
