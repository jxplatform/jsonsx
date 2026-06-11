/** Component registry — cached list of project components discovered via the platform. */

import { getPlatform } from "../platform";
import { projectState } from "../store";
import type { ComponentMeta } from "../types";

/** A discovered component: project components carry a file path; package components may not. */
export interface ComponentEntry extends Omit<ComponentMeta, "path"> {
  path?: string;
  source?: string;
  package?: string;
  modulePath?: string;
}

export let componentRegistry: ComponentEntry[] = [];
export let _componentRegistryLoaded = false;

export async function loadComponentRegistry() {
  try {
    const platform = getPlatform();
    componentRegistry = await platform.discoverComponents(projectState?.projectRoot || undefined);
    _componentRegistryLoaded = true;
  } catch {
    _componentRegistryLoaded = true;
  }
}

/**
 * @param {string | null} fromDocPath
 * @param {string} toCompPath
 */
export function computeRelativePath(fromDocPath: string | null, toCompPath: string) {
  if (!fromDocPath) {
    return `./${toCompPath}`;
  }
  const from = fromDocPath.replaceAll("\\", "/");
  const to = toCompPath.replaceAll("\\", "/");
  const fromDir = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "";
  const fromParts = fromDir.split("/").filter(Boolean);
  const toParts = to.split("/").filter(Boolean);
  let common = 0;
  while (
    common < fromParts.length &&
    common < toParts.length &&
    fromParts[common] === toParts[common]
  ) {
    common += 1;
  }
  const ups = fromParts.length - common;
  const remaining = toParts.slice(common);
  return (ups > 0 ? "../".repeat(ups) : "./") + remaining.join("/");
}
