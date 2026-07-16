/**
 * Component test props (M6) — the previewParams mirror for component docs. A non-instantiated
 * component definition renders on the canvas with its state defaults; "test values" let the author
 * pick per-prop values that the canvas render seeds into the definition's state, so templates,
 * dataScope snapshots, and live/snapshot expression previews all see real data.
 *
 * Pure and DOM-free: {@link componentPropEntries} derives the editable prop rows from the doc's
 * state (the same plain-data entries the CEM export publishes as fields), and
 * {@link substitutePreviewProps} rebuilds a render doc with chosen values seeded — never mutating
 * the source document (the substitutePreviewParams contract).
 */

import type { JsonValue } from "./types";
import type { JxMutableNode } from "@jxsuite/schema/types";

/** One editable prop row: the state key and its current default value (undefined = none). */
export interface ComponentPropEntry {
  name: string;
  value: JsonValue | undefined;
}

/** Whether the doc is a component definition (a custom-element root) rather than a page. */
export function isComponentDoc(doc: JxMutableNode | null | undefined): boolean {
  return typeof doc?.tagName === "string" && doc.tagName.includes("-");
}

/**
 * Classify a state entry as a prop (plain data the CEM export publishes as a field): naked
 * literals/arrays/objects and expanded/typed signal defs — never expressions, computeds, functions,
 * templates, or $prototype data sources (overriding those would clobber behavior, the boundPropKey
 * rule).
 */
function propShape(def: unknown): "literal" | "signal" | null {
  if (def === null || typeof def === "number" || typeof def === "boolean") {
    return "literal";
  }
  if (typeof def === "string") {
    return def.includes("${") ? null : "literal"; // Template strings render computed values.
  }
  if (Array.isArray(def)) {
    return "literal";
  }
  if (typeof def === "object") {
    const d = def as Record<string, unknown>;
    if (d.$expression || d.$compute || d.$prototype || d.$handler) {
      return null;
    }
    // An expanded signal ({default}) or a typed prop def ({type}/schema keywords) seeds through
    // Its `default`; any other plain object is a Shape-1 naked value.
    return "default" in d || "type" in d ? "signal" : "literal";
  }
  return null;
}

/**
 * The component's editable prop entries, derived from the doc's state — non-private plain-data
 * entries with their current default values (the CEM-export "field" subset).
 */
export function componentPropEntries(doc: JxMutableNode | null | undefined): ComponentPropEntry[] {
  const state = (doc?.state ?? {}) as Record<string, unknown>;
  const out: ComponentPropEntry[] = [];
  for (const [name, def] of Object.entries(state)) {
    if (name.startsWith("#")) {
      continue; // Private entries are not props (the CEM-export rule).
    }
    const shape = propShape(def);
    if (!shape) {
      continue;
    }
    const value =
      shape === "signal"
        ? ((def as { default?: JsonValue }).default as JsonValue | undefined)
        : (def as JsonValue);
    out.push({ name, value });
  }
  return out;
}

/**
 * Rebuild `renderDoc` with the chosen test-prop values seeded into its state: a literal entry is
 * replaced by the value; a signal/typed entry keeps its metadata and gets the value as `default`
 * (exactly what buildScope reads). Pure — returns a shallow rebuild; the render doc shares node
 * references with the tab's source document, so in-place mutation would corrupt the edited doc.
 */
export function substitutePreviewProps(
  renderDoc: JxMutableNode,
  props: Record<string, JsonValue>,
): JxMutableNode {
  const state = { ...((renderDoc.state ?? {}) as Record<string, unknown>) };
  let seeded = false;
  for (const [name, value] of Object.entries(props)) {
    const shape = propShape(state[name]);
    if (!shape) {
      continue; // Unknown/behavioral entries are never overridden by a stale test value.
    }
    state[name] =
      shape === "signal" ? { ...(state[name] as Record<string, unknown>), default: value } : value;
    seeded = true;
  }
  if (!seeded) {
    return renderDoc;
  }
  return { ...renderDoc, state } as JxMutableNode;
}
