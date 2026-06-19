/** Component registry — cached list of project components discovered via the platform. */

import { getPlatform } from "../platform";
import { projectState } from "../store";
import type { ComponentMeta } from "../types";
import type { JxMutableNode } from "@jxsuite/schema/types";

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
 * Build a fresh instance definition for a component: $props from prop defaults, plus the
 * component's slot fallback children cloned in as starting content so editors can edit from the
 * defaults. Children destined for a named slot carry a `slot` attribute (required for runtime
 * distribution); fallback for the default slot is inserted as-is. When the component has no slot
 * fallback, no `children` key is emitted so slotless instances stay atomic in the layers tree.
 *
 * @param {ComponentEntry} comp
 * @returns {JxMutableNode}
 */
export function buildComponentInstance(comp: ComponentEntry): JxMutableNode {
  const $props = Object.fromEntries(
    (comp.props ?? []).map((p) => [p.name, p.default !== undefined ? p.default : ""]),
  );
  const children: (JxMutableNode | string)[] = [];
  for (const slot of comp.slots ?? []) {
    for (const child of structuredClone(slot.fallback ?? [])) {
      if (!slot.name) {
        children.push(child);
      } else if (typeof child === "object" && child !== null && typeof child.tagName === "string") {
        // Preserve an author-set slot attribute (slot forwarding inside fallback).
        child.attributes = { slot: slot.name, ...child.attributes };
        children.push(child);
      } else {
        // Text and non-element nodes can't carry a slot attribute — wrap them.
        children.push({ attributes: { slot: slot.name }, children: [child], tagName: "span" });
      }
    }
  }
  return {
    $props,
    tagName: comp.tagName,
    ...(children.length > 0 ? { children } : {}),
  };
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
