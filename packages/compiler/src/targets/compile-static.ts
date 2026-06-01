/**
 * Compile-static.js — Static HTML compilation
 *
 * Compiles fully static Jx documents to plain HTML/CSS with zero JS. Dynamic child subtrees become
 * hydration islands (custom elements).
 */

import {
  isNodeDynamic,
  createCompileContext,
  resolveStaticValue,
  buildAttrs,
  compileStyles,
  escapeHtml,
} from "../shared";
import { emitElementModule } from "./compile-element";

/**
 * Compile a static document to HTML, with dynamic subtrees as islands.
 *
 * @param {JxMutableNode | Record<string, any>} raw - Raw JSON document (with $ref pointers
 *   preserved)
 * @param {Record<string, unknown>} opts
 * @returns {{ html: string; files: { path: string; content: string; tagName: string }[] }}
 */
export function compileStaticPage(
  raw: JxMutableNode | Record<string, any>,
  opts: Record<string, unknown>,
) {
  const { title, reactivitySrc, litHtmlSrc } = opts as JxMutableNode;

  const rootContext = createCompileContext(raw, null, raw.state ?? {}, raw.$media ?? {});
  const styleBlock = compileStyles(
    raw,
    raw.$media ?? {},
    (opts.projectStyle ?? null) as JxStyle | null,
  );
  const islands: { def: JxMutableNode; tagName: string; className: string }[] = [];
  const bodyContent = compileNode(raw, false, raw, rootContext, islands);

  /** @type {{ path: string; content: string; tagName: string }[]} */
  const files = [];
  let importMap = "";
  let moduleScripts = "";
  if (islands.length > 0) {
    for (const island of islands) {
      const moduleContent = emitElementModule(island.def, island.className, []);
      files.push({
        path: `_islands/${island.tagName}.js`,
        content: moduleContent,
        tagName: island.tagName,
      });
    }
    importMap = `<script type="importmap">
  {
    "imports": {
      "@vue/reactivity": "${reactivitySrc}",
      "lit-html": "${litHtmlSrc}"
    }
  }
  </script>`;
    moduleScripts = files
      .map(
        (/** @type {{ path: string }} */ f) => `<script type="module" src="./${f.path}"></script>`,
      )
      .join("\n  ");
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  ${importMap}
  ${styleBlock}
</head>
<body>
  ${bodyContent}
  ${moduleScripts}
</body>
</html>`;

  return { html, files };
}

// ─── Node compilation ─────────────────────────────────────────────────────────

/**
 * Compile a single Jx node to an HTML string. Dynamic nodes become hydration islands; static nodes
 * become plain HTML.
 *
 * @param {JxMutableNode} def
 * @param {boolean} dynamic
 * @param {JxMutableNode} raw
 * @param {any} context
 * @param {{ def: any; tagName: string; className: string }[]} islands
 * @returns {string}
 */
function compileNode(
  def: JxMutableNode,
  dynamic: boolean,
  raw: JxMutableNode,
  context: {
    scope: Record<string, unknown> | null;
    scopeDefs: Record<string, unknown>;
    media: Record<string, string>;
  },
  islands: { def: JxMutableNode; tagName: string; className: string }[],
): string {
  // String children are text nodes
  if (typeof def === "string") {
    return escapeHtml(def);
  }
  if (typeof def === "number" || typeof def === "boolean") {
    return escapeHtml(String(def));
  }
  if (!def || typeof def !== "object") return "";

  const nextContext = createCompileContext(
    raw,
    context.scope,
    raw?.state ?? context.scopeDefs,
    raw?.$media ?? context.media,
  );

  if (dynamic) {
    const n = islands.length;
    const tagName = `jx-island-${n}`;
    const className = `JxIsland${n}`;
    const elementDef = { ...(raw ?? def), tagName };
    islands.push({ def: elementDef, tagName, className });
    return `<${tagName}></${tagName}>`;
  }

  const tag = def.tagName ?? "div";
  const attrs = buildAttrs(def, nextContext.scope);
  const inner = buildInnerWithIslands(def, raw, nextContext, islands);

  return `<${tag}${attrs}>${inner}</${tag}>`;
}

/**
 * Build the inner HTML (textContent or children) for a node. For children, emit islands only for
 * those that are actually dynamic.
 *
 * @param {JxMutableNode} def
 * @param {JxMutableNode} raw
 * @param {any} context
 * @param {{ def: any; tagName: string; className: string }[]} islands
 * @returns {string}
 */
function buildInnerWithIslands(
  def: JxMutableNode,
  raw: JxMutableNode,
  context: {
    scope: Record<string, unknown> | null;
    scopeDefs: Record<string, unknown>;
    media: Record<string, string>;
  },
  islands: { def: JxMutableNode; tagName: string; className: string }[],
): string {
  const source = raw ?? def;

  if (source.textContent !== undefined) {
    const value = resolveStaticValue(source.textContent, context.scope);
    return value == null ? "" : escapeHtml(String(value));
  }
  if (source.innerHTML)
    return (resolveStaticValue(source.innerHTML, context.scope) as string) ?? source.innerHTML;
  if (Array.isArray(source.children)) {
    const rawChildren = raw?.children;
    return source.children
      .map((c, i: number) => {
        const child = c as unknown as JxMutableNode;
        const childDynamic = isNodeDynamic(child);
        const childRaw = (rawChildren?.[i] ?? c) as JxMutableNode;
        return compileNode(child, childDynamic, childRaw, context, islands);
      })
      .join("\n  ");
  }
  return "";
}
