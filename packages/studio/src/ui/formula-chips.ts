/// <reference lib="dom" />
/**
 * Formula chips — a horizontal presentation layer summarizing an expression tree as left-to-right
 * chips (spec §19.9). The `target` chain unrolls deepest-first: the head chip is the innermost
 * target operand (ref/literal), followed by each operator up to the root. Nested non-target
 * operands render as parenthesized group chips. Pure presentation — no editing logic; clicking a
 * chip reports the node path to the caller.
 */

import { html, nothing } from "lit-html";
import { isJsonObject, isRef } from "@jxsuite/schema/guards";

import type { TemplateResult } from "lit-html";
import type { EditorPreview } from "./expression-editor";

type NodePath = (string | number)[];

interface ChainLink {
  node: Record<string, unknown>;
  path: NodePath;
}

interface Chain {
  /** The innermost target operand (ref/literal), absent for target-less roots. */
  head: { value: unknown; path: NodePath } | null;
  /** Operator nodes, deepest target first → outermost operator last. */
  links: ChainLink[];
}

function isExprNode(value: unknown): value is Record<string, unknown> {
  return isJsonObject(value) && typeof value.operator === "string";
}

/** Human label for a pointer ref: strips the #/state/ and window#/ prefixes. */
function refLabel(ref: string): string {
  if (ref.startsWith("#/state/")) {
    return ref.slice("#/state/".length);
  }
  if (ref.startsWith("window#/")) {
    return ref.slice("window#/".length).replaceAll("/", ".");
  }
  return ref || "?";
}

/** Compact label for a non-node operand (ref or literal). */
function operandLabel(value: unknown): string {
  if (isRef(value)) {
    return refLabel(value.$ref);
  }
  if (isExprNode(value)) {
    return `(${chipSummary(value)})`;
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  return String(value);
}

/** The chain path for `hops` target descents below `basePath`. */
function targetPath(basePath: NodePath, hops: number): NodePath {
  return [...basePath, ...Array.from({ length: hops }, () => "target")];
}

/** Unroll a node's target chain into head operand + operator links (deepest first). */
function unrollChain(node: Record<string, unknown>, basePath: NodePath): Chain {
  // Collect the chain root-first, then materialize each link's path from its descent depth.
  const nodes: Record<string, unknown>[] = [];
  let current: Record<string, unknown> = node;
  for (;;) {
    nodes.push(current);
    const next = current.target;
    if (isExprNode(next)) {
      current = next;
    } else {
      break;
    }
  }
  const deepest = nodes.at(-1)!;
  const head: Chain["head"] =
    "target" in deepest || deepest.target !== undefined
      ? { path: targetPath(basePath, nodes.length), value: deepest.target }
      : null;
  const rootFirst = nodes.map((n, i) => ({ node: n, path: targetPath(basePath, i) }));
  return { head, links: rootFirst.toReversed() };
}

/** Compact one-line text form of a node: head operand followed by the operator chain. */
export function chipSummary(node: unknown): string {
  if (!isExprNode(node)) {
    return operandLabel(node);
  }
  const { head, links } = unrollChain(node, []);
  const parts: string[] = [];
  if (head) {
    parts.push(operandLabel(head.value));
  }
  for (const link of links) {
    parts.push(String(link.node.operator));
  }
  return parts.join(" › ");
}

// ─── Rendering ──────────────────────────────────────────────────────────────

const CHIP_STYLE =
  "display:inline-flex;align-items:center;gap:4px;max-width:180px;padding:1px 7px;" +
  "border:1px solid var(--spectrum-gray-300, #3c3c3c);border-radius:10px;cursor:pointer;" +
  "background:var(--spectrum-gray-100, #232323);color:var(--spectrum-gray-800, #d0d0d0);" +
  "font-size:11px;font-family:var(--spectrum-code-font-family, monospace);line-height:18px";

/** Live value badge — same styling convention as the expression editor's `.expr-live-badge`. */
function renderChipBadge(preview: EditorPreview | null | undefined, pathKey: string) {
  const text = preview?.values.get(pathKey);
  if (text === undefined) {
    return nothing;
  }
  return html`
    <span
      class="expr-live-badge"
      title=${text}
      style="font-family:var(--spectrum-code-font-family, monospace);font-size:10px;line-height:16px;padding:0 5px;border-radius:4px;background:var(--spectrum-gray-200, #323232);color:var(--spectrum-seafoam-900, #35a690);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:120px;flex-shrink:1"
      >${text}</span
    >
  `;
}

function renderChip(
  label: string,
  path: NodePath,
  onSelect: (path: NodePath) => void,
  preview: EditorPreview | null | undefined,
  group = false,
) {
  return html`
    <button
      type="button"
      class=${group ? "formula-chip formula-chip--group" : "formula-chip"}
      data-path=${path.join("/")}
      style=${CHIP_STYLE}
      title=${label}
      @click=${() => onSelect(path)}
    >
      <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:110px"
        >${label}</span
      >
      ${renderChipBadge(preview, path.join("/"))}
    </button>
  `;
}

/** Collect group chips for a link's non-target expression operands (value/initial/cases). */
function groupChips(
  link: ChainLink,
  onSelect: (path: NodePath) => void,
  preview: EditorPreview | null | undefined,
): TemplateResult[] {
  const chips: TemplateResult[] = [];
  const add = (operand: unknown, path: NodePath) => {
    if (isExprNode(operand)) {
      chips.push(renderChip(`(${chipSummary(operand)})`, path, onSelect, preview, true));
    }
  };
  const { value, initial, cases } = link.node;
  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) {
      add(item, [...link.path, "value", i]);
    }
  } else {
    add(value, [...link.path, "value"]);
  }
  add(initial, [...link.path, "initial"]);
  if (isJsonObject(cases)) {
    for (const [key, operand] of Object.entries(cases)) {
      add(operand, [...link.path, "cases", key]);
    }
  }
  add(link.node.default, [...link.path, "default"]);
  return chips;
}

/**
 * Render an expression node as a horizontal chip pipeline. Each chip carries the node's live value
 * badge when a preview is supplied; clicking a chip calls `onSelect` with the node path.
 */
export function renderFormulaChips(
  node: unknown,
  onSelect: (path: NodePath) => void,
  opts: { preview?: EditorPreview | null; path?: NodePath } = {},
): TemplateResult {
  if (!isExprNode(node)) {
    return html`${nothing}`;
  }
  const preview = opts.preview ?? null;
  const basePath = opts.path ?? [];
  const { head, links } = unrollChain(node, basePath);

  const chips: TemplateResult[] = [];
  if (head) {
    chips.push(renderChip(operandLabel(head.value), head.path, onSelect, preview));
  }
  for (const link of links) {
    chips.push(
      renderChip(String(link.node.operator), link.path, onSelect, preview),
      ...groupChips(link, onSelect, preview),
    );
  }

  return html`
    <div
      class="formula-chips"
      style="display:flex;flex-wrap:wrap;gap:4px;align-items:center;padding:2px 0 6px"
    >
      ${chips}
    </div>
  `;
}
