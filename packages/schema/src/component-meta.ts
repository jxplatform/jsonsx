/**
 * Component metadata, derived from a parsed component document.
 *
 * Discovery — "what components does this project have, and what props do they take" — is a pure
 * function of the document. It reads `tagName`, `state` and any `<slot>` in the tree; it executes
 * nothing. That distinction is what lets a backend with a no-project-JS posture discover JSON
 * components safely, which Jx Cloud could not do while this logic lived inside two Bun servers.
 *
 * It lives here because THREE backends need the same answer and two of them had already written it
 * twice: `packages/server/src/studio-api.ts` (the dev server's `/__studio/components`) and
 * `packages/desktop/src/project-session.ts`. A third copy in the cloud adapter would have made
 * "which entries in `state` count as props" a question with three answers.
 *
 * @license MIT
 */

import type { JsonValue } from "../types";

/** One `<slot>` found in a component's tree. */
export interface ComponentSlotDef {
  /** The slot's name; `""` for the unnamed slot. */
  name: string;
  /** Fallback children rendered when nothing is slotted in. */
  fallback?: unknown[];
}

/** One editable prop, derived from a `state` entry. */
export interface ComponentPropDef {
  name: string;
  type?: unknown;
  default?: JsonValue;
  format?: unknown;
}

/** What discovery reports for one component document. */
export interface ComponentMetaOut {
  tagName: string;
  $id: string | null;
  path: string;
  props: ComponentPropDef[];
  slots?: ComponentSlotDef[];
  hasElements: boolean;
}

/**
 * Collect slot definitions from a parsed component tree.
 *
 * Whitespace-only names count as unnamed (`""`), and only static `children` arrays are walked — a
 * slot produced by a `$map` or a `$switch` has no fixed identity to report.
 *
 * @param {unknown} node - A node of the component document.
 * @param {ComponentSlotDef[]} [out] - Accumulator, for the recursive walk.
 * @returns {ComponentSlotDef[]}
 */
export function collectSlotDefs(node: unknown, out: ComponentSlotDef[] = []): ComponentSlotDef[] {
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    return out;
  }
  const el = node as Record<string, unknown>;
  if (el.tagName === "slot") {
    const attrs = el.attributes as Record<string, unknown> | undefined;
    const rawName = attrs?.name;
    const name = typeof rawName === "string" ? rawName.trim() : "";
    const { children } = el;
    out.push({
      name,
      ...(Array.isArray(children) && children.length > 0 ? { fallback: children } : {}),
    });
  }
  if (Array.isArray(el.children)) {
    for (const c of el.children) {
      collectSlotDefs(c, out);
    }
  }
  return out;
}

/**
 * Whether a `state` entry is an editable prop.
 *
 * The shorthand form (`"title": "Hello"`) always is. The full form is one only when it is plain
 * data: a computed value, a handler or a prototype entry is machinery the author does not type
 * into, and offering it as a prop would put a text box in front of a function.
 *
 * @param {unknown} def - The `state` entry.
 * @returns {boolean}
 */
function isPropEntry(def: unknown): boolean {
  if (def == null) {
    return false;
  }
  if (typeof def !== "object") {
    return true;
  }
  const obj = def as Record<string, unknown>;
  return !obj.$prototype && !obj.$handler && !obj.$compute;
}

/**
 * Metadata for one component document, or null when the document is not a component.
 *
 * A component is a document whose `tagName` is a valid custom-element name — it must contain a
 * hyphen. That single test is what keeps a page or a data file from being reported as a component
 * when a whole project tree is scanned.
 *
 * @param {unknown} doc - The parsed document.
 * @param {string} path - Project-relative path, reported verbatim.
 * @returns {ComponentMetaOut | null}
 */
export function componentMetaFrom(doc: unknown, path: string): ComponentMetaOut | null {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return null;
  }
  const content = doc as Record<string, unknown>;
  const { tagName } = content;
  if (typeof tagName !== "string" || !tagName.includes("-")) {
    return null;
  }
  const slots = collectSlotDefs(content);
  const state = (content.state ?? {}) as Record<string, unknown>;
  return {
    $id: typeof content.$id === "string" && content.$id ? content.$id : null,
    hasElements: Array.isArray(content.$elements) && content.$elements.length > 0,
    path,
    props: Object.entries(state)
      .filter(([, def]) => isPropEntry(def))
      .map(([name, def]) => {
        if (typeof def !== "object" || def === null) {
          // Shorthand: the value IS the default, and its runtime type is the only type on offer.
          return { default: def as JsonValue, name, type: typeof def };
        }
        const obj = def as Record<string, unknown>;
        return {
          default: obj.default as JsonValue,
          format: obj.format,
          name,
          type: obj.type,
        };
      }),
    ...(slots.length > 0 ? { slots } : {}),
    tagName,
  };
}
