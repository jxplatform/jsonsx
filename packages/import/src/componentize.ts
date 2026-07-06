import type { JxElement } from "@jxsuite/schema/types";

export interface ComponentizeOptions {
  minInstances?: number;
  minDepth?: number;
}

export interface ExtractedComponent {
  $id: string;
  tagName: string;
  template: JxElement;
  instanceCount: number;
}

export interface ComponentizeResult {
  components: Map<string, ExtractedComponent>;
  rewrittenPages: Map<string, JxElement>;
}

interface SubtreeLocation {
  pageRoute: string;
  path: number[];
  node: JxElement;
}

function nodeDepth(node: JxElement | string): number {
  if (typeof node === "string") {
    return 0;
  }
  let max = 0;
  if (Array.isArray(node.children)) {
    for (const c of node.children) {
      max = Math.max(max, nodeDepth(c as JxElement | string));
    }
  }
  return 1 + max;
}

function structuralHash(node: JxElement | string): string {
  if (typeof node === "string") {
    return "#text";
  }
  const tag = node.tagName ?? "div";
  const childHashes: string[] = [];
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      childHashes.push(structuralHash(child as JxElement | string));
    }
  }
  if (node.textContent) {
    childHashes.push("#text");
  }
  return `<${tag}>${childHashes.join(",")}`;
}

function collectLeafValues(node: JxElement | string, prefix: string, out: Map<string, string>) {
  if (typeof node === "string") {
    out.set(`${prefix}.$text`, node);
    return;
  }
  if (node.textContent) {
    out.set(`${prefix}.textContent`, node.textContent as string);
  }
  if (node.attributes) {
    for (const [k, v] of Object.entries(node.attributes)) {
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        out.set(`${prefix}.attr.${k}`, String(v));
      }
    }
  }
  if (Array.isArray(node.children)) {
    for (let i = 0; i < node.children.length; i++) {
      collectLeafValues(node.children[i] as JxElement | string, `${prefix}.${i}`, out);
    }
  }
}

function leafPathToStateName(leafPath: string): string {
  const parts = leafPath.split(".").slice(1);
  const meaningful: string[] = [];
  for (const p of parts) {
    if (p === "$text" || p === "textContent") {
      meaningful.push("text");
    } else if (p === "attr") {
      continue;
    } else if (/^\d+$/.test(p)) {
      continue;
    } else {
      meaningful.push(p);
    }
  }
  if (meaningful.length === 0) {
    meaningful.push("value");
  }
  const raw = meaningful.join("_");
  return raw.replaceAll(/[^a-zA-Z0-9_]/g, "");
}

function applyStateInterpolation(
  node: JxElement | string,
  prefix: string,
  varyingPaths: Set<string>,
  nameMap: Map<string, string>,
): JxElement | string {
  if (typeof node === "string") {
    const key = `${prefix}.$text`;
    if (varyingPaths.has(key)) {
      return `\${state.${nameMap.get(key)}}`;
    }
    return node;
  }

  const result: JxElement = { ...node };

  if (node.textContent) {
    const key = `${prefix}.textContent`;
    if (varyingPaths.has(key)) {
      result.textContent = `\${state.${nameMap.get(key)}}`;
    }
  }

  if (node.attributes) {
    result.attributes = { ...node.attributes };
    for (const [k] of Object.entries(node.attributes)) {
      const key = `${prefix}.attr.${k}`;
      if (varyingPaths.has(key)) {
        result.attributes[k] = `\${state.${nameMap.get(key)}}`;
      }
    }
  }

  if (Array.isArray(node.children)) {
    result.children = node.children.map((child, i) =>
      applyStateInterpolation(child as JxElement | string, `${prefix}.${i}`, varyingPaths, nameMap),
    ) as JxElement[];
  }

  return result;
}

function toPascalCase(str: string): string {
  return str
    .split(/[-_\s]+/)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase())
    .join("");
}

function toKebabCase(base: string, index: number): string {
  return `component-${base}-${index}`;
}

function setNodeAt(root: JxElement, path: number[], replacement: JxElement): JxElement {
  if (path.length === 0) {
    return replacement;
  }

  const result: JxElement = { ...root };
  if (Array.isArray(root.children)) {
    result.children = [...root.children] as JxElement[];
    const head = path[0]!;
    const rest = path.slice(1);
    if (rest.length === 0) {
      (result.children as JxElement[])[head] = replacement;
    } else {
      const child = result.children[head];
      if (typeof child !== "string") {
        (result.children as JxElement[])[head] = setNodeAt(child as JxElement, rest, replacement);
      }
    }
  }
  return result;
}

function collectSubtrees(
  node: JxElement,
  pageRoute: string,
  path: number[],
  minDepth: number,
  out: SubtreeLocation[],
) {
  // Skip root node (path.length === 0) — don't componentize entire pages
  if (path.length > 0 && nodeDepth(node) >= minDepth) {
    out.push({ pageRoute, path: [...path], node });
  }
  if (Array.isArray(node.children)) {
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i];
      if (typeof child !== "string") {
        collectSubtrees(child as JxElement, pageRoute, [...path, i], minDepth, out);
      }
    }
  }
}

export function componentize(
  pages: Map<string, JxElement>,
  options: ComponentizeOptions = {},
): ComponentizeResult {
  const minInstances = options.minInstances ?? 2;
  const minDepth = options.minDepth ?? 2;

  const allSubtrees: SubtreeLocation[] = [];
  for (const [route, doc] of pages) {
    collectSubtrees(doc, route, [], minDepth, allSubtrees);
  }

  const byHash = new Map<string, SubtreeLocation[]>();
  for (const loc of allSubtrees) {
    const hash = structuralHash(loc.node);
    if (!byHash.has(hash)) {
      byHash.set(hash, []);
    }
    byHash.get(hash)!.push(loc);
  }

  const candidates = [...byHash.entries()]
    .filter(([, locs]) => locs.length >= minInstances)
    .toSorted((a, b) => {
      const depthA = nodeDepth(a[1][0]!.node);
      const depthB = nodeDepth(b[1][0]!.node);
      if (depthB !== depthA) {
        return depthB - depthA;
      }
      return b[1].length - a[1].length;
    });

  const components = new Map<string, ExtractedComponent>();
  const claimed = new Set<string>();
  const replacements: {
    pageRoute: string;
    path: number[];
    tagName: string;
    props: Record<string, string>;
  }[] = [];

  let compIndex = 0;
  for (const [, locations] of candidates) {
    const unclaimed = locations.filter((loc) => {
      const locKey = `${loc.pageRoute}:${loc.path.join(".")}`;
      for (const c of claimed) {
        if (locKey.startsWith(c) || c.startsWith(locKey)) {
          return false;
        }
      }
      return true;
    });

    if (unclaimed.length < minInstances) {
      continue;
    }

    const allLeaves: Map<string, string>[] = unclaimed.map((loc) => {
      const leaves = new Map<string, string>();
      collectLeafValues(loc.node, "root", leaves);
      return leaves;
    });

    const allKeys = new Set<string>();
    for (const m of allLeaves) {
      for (const k of m.keys()) {
        allKeys.add(k);
      }
    }

    const varyingPaths = new Set<string>();
    for (const key of allKeys) {
      const values = allLeaves.map((m) => m.get(key) ?? "");
      if (new Set(values).size > 1) {
        varyingPaths.add(key);
      }
    }

    const nameMap = new Map<string, string>();
    const usedNames = new Set<string>();
    for (const vp of varyingPaths) {
      let name = leafPathToStateName(vp);
      if (usedNames.has(name)) {
        let suffix = 2;
        while (usedNames.has(`${name}${suffix}`)) {
          suffix += 1;
        }
        name = `${name}${suffix}`;
      }
      usedNames.add(name);
      nameMap.set(vp, name);
    }

    const baseTag = unclaimed[0]!.node.tagName ?? "div";
    const kebabName = toKebabCase(baseTag, compIndex);
    const pascalName = toPascalCase(kebabName);
    compIndex += 1;

    const state: Record<string, string> = {};
    for (const [leafPath, stateName] of nameMap) {
      state[stateName] = allLeaves[0]!.get(leafPath) ?? "";
    }

    const template = applyStateInterpolation(
      unclaimed[0]!.node,
      "root",
      varyingPaths,
      nameMap,
    ) as JxElement;

    const component: ExtractedComponent = {
      $id: pascalName,
      tagName: kebabName,
      template,
      instanceCount: unclaimed.length,
    };

    const fileName = `${kebabName}.json`;
    components.set(fileName, component);

    for (const loc of unclaimed) {
      const locKey = `${loc.pageRoute}:${loc.path.join(".")}`;
      claimed.add(locKey);

      const props: Record<string, string> = {};
      const leaves = new Map<string, string>();
      collectLeafValues(loc.node, "root", leaves);
      for (const [leafPath, stateName] of nameMap) {
        props[stateName] = leaves.get(leafPath) ?? "";
      }

      replacements.push({ pageRoute: loc.pageRoute, path: loc.path, tagName: kebabName, props });
    }
  }

  const rewrittenPages = new Map<string, JxElement>();
  for (const [route, doc] of pages) {
    rewrittenPages.set(route, structuredClone(doc));
  }

  const sortedReplacements = replacements.toSorted((a, b) => b.path.length - a.path.length);

  for (const rep of sortedReplacements) {
    const page = rewrittenPages.get(rep.pageRoute)!;
    const callSite: JxElement = { tagName: rep.tagName };
    const hasNonDefaultProps = Object.keys(rep.props).length > 0;
    if (hasNonDefaultProps) {
      callSite.$props = rep.props;
    }
    rewrittenPages.set(rep.pageRoute, setNodeAt(page, rep.path, callSite));
  }

  return { components, rewrittenPages };
}
