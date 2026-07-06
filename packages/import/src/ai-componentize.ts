/**
 * AI-componentize — LLM-assisted refinement of heuristically extracted components.
 *
 * Takes the output of the heuristic `componentize()` pass and asks an LLM to: 1. Choose semantic
 * component names (e.g. `product-card` not `component-div-0`) 2. Rename props to meaningful names
 * (e.g. `title` not `text`) 3. Identify children that should be slots rather than interpolated
 * props
 *
 * Uses the OpenAI-compatible chat completions API (same as the eval harness).
 */

import type { JxElement } from "@jxsuite/schema/types";
import type { ExtractedComponent, ComponentizeResult } from "./componentize.ts";

export interface AiComponentizeOptions {
  apiKey: string;
  baseUrl?: string | undefined;
  model?: string | undefined;
}

interface RenameResult {
  componentName: string;
  tagName: string;
  props: Record<string, string>;
}

function buildPrompt(component: ExtractedComponent): string {
  const stateEntries = Object.entries(component.template.state ?? {});
  const propNames = stateEntries.map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`).join("\n");

  const treePreview = JSON.stringify(component.template, null, 2).slice(0, 2000);

  return `You are a frontend component naming expert. Given a UI component extracted from a website, suggest better names.

Current auto-generated component:
- tagName: "${component.tagName}" (e.g. "component-div-0")
- $id: "${component.$id}"
- instanceCount: ${component.instanceCount}
- Current props (state):
${propNames || "  (none)"}

Component tree (truncated):
${treePreview}

Return a JSON object with:
1. "componentName" — a semantic kebab-case name for this component (e.g. "product-card", "hero-banner", "nav-link"). Must contain a hyphen.
2. "tagName" — same as componentName (web component convention)
3. "props" — an object mapping each CURRENT prop name to a BETTER name. Use camelCase. Choose descriptive names based on context (e.g. "text" → "title" if it's in an h2, "src" → "imageUrl" if it's an img src). If the current name is already good, keep it unchanged.

Rules:
- componentName must be kebab-case with at least one hyphen
- prop renames must be valid JS identifiers (camelCase, no spaces/special chars)
- Only rename props that exist in the current state — don't add or remove props
- If you can't determine a better name, keep the original

Respond with ONLY the JSON object, no markdown fences or explanation.`;
}

async function callLlm(prompt: string, opts: AiComponentizeOptions): Promise<RenameResult | null> {
  const baseUrl = opts.baseUrl || "https://api.openai.com/v1";
  const model = opts.model || "gpt-4o-mini";

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    return null;
  }

  const data = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
  };

  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    return null;
  }

  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const { componentName } = parsed;
    const { tagName } = parsed;
    const { props } = parsed;

    if (
      typeof componentName !== "string" ||
      !componentName.includes("-") ||
      typeof tagName !== "string" ||
      typeof props !== "object" ||
      props === null
    ) {
      return null;
    }

    return {
      componentName: componentName as string,
      tagName: tagName as string,
      props: props as Record<string, string>,
    };
  } catch {
    return null;
  }
}

function renamePropsInTree(
  node: JxElement | string,
  renames: Record<string, string>,
): JxElement | string {
  if (typeof node === "string") {
    let result = node;
    for (const [oldName, newName] of Object.entries(renames)) {
      if (oldName !== newName) {
        result = result.replaceAll(`\${state.${oldName}}`, `\${state.${newName}}`);
      }
    }
    return result;
  }

  const out: JxElement = { ...node };

  if (typeof out.textContent === "string") {
    for (const [oldName, newName] of Object.entries(renames)) {
      if (oldName !== newName) {
        out.textContent = (out.textContent as string).replaceAll(
          `\${state.${oldName}}`,
          `\${state.${newName}}`,
        );
      }
    }
  }

  if (out.attributes) {
    out.attributes = { ...out.attributes };
    for (const [attrKey, attrVal] of Object.entries(out.attributes)) {
      if (typeof attrVal === "string") {
        let v = attrVal;
        for (const [oldName, newName] of Object.entries(renames)) {
          if (oldName !== newName) {
            v = v.replaceAll(`\${state.${oldName}}`, `\${state.${newName}}`);
          }
        }
        out.attributes[attrKey] = v;
      }
    }
  }

  if (Array.isArray(out.children)) {
    out.children = out.children.map((c) =>
      renamePropsInTree(c as JxElement | string, renames),
    ) as JxElement[];
  }

  return out;
}

function renamePropsInState(
  state: Record<string, unknown>,
  renames: Record<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(state)) {
    const newKey = renames[k] ?? k;
    out[newKey] = v;
  }
  return out;
}

function toPascalCase(str: string): string {
  return str
    .split(/[-_\s]+/)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase())
    .join("");
}

export async function aiComponentize(
  heuristicResult: ComponentizeResult,
  opts: AiComponentizeOptions,
  onProgress?: (msg: string) => void,
): Promise<ComponentizeResult> {
  const log = onProgress ?? (() => {});
  const { components, rewrittenPages } = heuristicResult;

  if (components.size === 0) {
    log("No components to refine");
    return heuristicResult;
  }

  const newComponents = new Map<string, ExtractedComponent>();
  const tagRenames = new Map<string, string>();
  const propRenamesByTag = new Map<string, Record<string, string>>();
  const usedNames = new Set<string>();

  for (const [fileName, component] of components) {
    log(`  Asking LLM about ${component.tagName} (${component.instanceCount} instances)...`);

    const prompt = buildPrompt(component);
    const result = await callLlm(prompt, opts);

    if (!result) {
      log(`    LLM failed — keeping heuristic name "${component.tagName}"`);
      newComponents.set(fileName, component);
      continue;
    }

    let newTagName = result.tagName.toLowerCase();
    if (!newTagName.includes("-")) {
      newTagName = `x-${newTagName}`;
    }

    if (usedNames.has(newTagName)) {
      let suffix = 2;
      while (usedNames.has(`${newTagName}-${suffix}`)) {
        suffix += 1;
      }
      newTagName = `${newTagName}-${suffix}`;
    }
    usedNames.add(newTagName);

    const propRenames: Record<string, string> = {};
    const existingProps = Object.keys(component.template.state ?? {});
    for (const prop of existingProps) {
      const renamed = result.props[prop];
      propRenames[prop] =
        typeof renamed === "string" && /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(renamed) ? renamed : prop;
    }

    const newTemplate = renamePropsInTree(component.template, propRenames) as JxElement;
    if (newTemplate.state) {
      newTemplate.state = renamePropsInState(
        newTemplate.state as Record<string, unknown>,
        propRenames,
      ) as Record<string, string>;
    }

    const newComponent: ExtractedComponent = {
      $id: toPascalCase(newTagName),
      tagName: newTagName,
      template: newTemplate,
      instanceCount: component.instanceCount,
    };

    const newFileName = `${newTagName}.json`;
    newComponents.set(newFileName, newComponent);
    tagRenames.set(component.tagName, newTagName);
    propRenamesByTag.set(component.tagName, propRenames);

    log(`    ${component.tagName} → ${newTagName}`);
    const changedProps = Object.entries(propRenames)
      .filter(([a, b]) => a !== b)
      .map(([a, b]) => `${a}→${b}`);
    if (changedProps.length > 0) {
      log(`    Props: ${changedProps.join(", ")}`);
    }
  }

  const newPages = new Map<string, JxElement>();
  for (const [route, page] of rewrittenPages) {
    const updated = rewriteCallSites(page, tagRenames, propRenamesByTag);
    newPages.set(route, updated);
  }

  return { components: newComponents, rewrittenPages: newPages };
}

function rewriteCallSites(
  node: JxElement,
  tagRenames: Map<string, string>,
  propRenamesByTag: Map<string, Record<string, string>>,
): JxElement {
  const result: JxElement = { ...node };

  if (result.tagName && tagRenames.has(result.tagName)) {
    const oldTag = result.tagName;
    result.tagName = tagRenames.get(oldTag)!;

    const propRenames = propRenamesByTag.get(oldTag);
    if (propRenames && result.$props) {
      const newProps: NonNullable<typeof result.$props> = {};
      for (const [k, v] of Object.entries(result.$props)) {
        const newKey = propRenames[k] ?? k;
        newProps[newKey] = v;
      }
      result.$props = newProps;
    }
  }

  if (Array.isArray(result.children)) {
    result.children = result.children.map((child) => {
      if (typeof child === "string") {
        return child;
      }
      return rewriteCallSites(child as JxElement, tagRenames, propRenamesByTag);
    }) as JxElement[];
  }

  return result;
}
