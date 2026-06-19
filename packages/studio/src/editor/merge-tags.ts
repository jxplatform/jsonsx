/**
 * Merge tags — enumerate insertable `${…}` template tokens from the document's state.
 *
 * Powers the inline-edit "Insert data" menu (Mailchimp-style merge tags). Given the document's
 * state definitions plus the live resolved scope, produces a flat list of accessor paths the author
 * can drop into editable text: top-level `state.*` names, nested object paths, array `.length`, and
 * — when editing inside a repeater — `item`, `item.*`, and `index`.
 *
 * Pure and DOM-free: callers pass the data in, this returns plain descriptors.
 */

import { defCategory } from "../panels/signals-panel";
import { dataTypeLabel, unwrapSignal } from "../panels/data-explorer";

export interface MergeTag {
  /** Insertion token placed between `${` and `}`, e.g. `state.user.name`, `item.title`, `index`. */
  token: string;
  /** Display path shown in the menu (currently identical to `token`). */
  label: string;
  /** Type + short value preview, e.g. `string · "Alice"`, `Array(4)`, `{3}`. */
  hint: string;
  /** Source category — `defCategory` of the root def, or `"repeater"` for item/index entries. */
  category: string;
}

/** Levels of nesting walked beneath each root name. */
const DEPTH_CAP = 3;
/** Maximum object keys enumerated per level (mirrors the data-explorer tree cap). */
const BREADTH_CAP = 30;

/** Type label plus a short value preview for primitives. */
function previewHint(value: unknown): string {
  const v = unwrapSignal(value);
  const typeLabel = dataTypeLabel(v);
  if (v === null || v === undefined || typeof v === "object") {
    return typeLabel; // Null / pending / Array(n) / {n}
  }
  const text =
    typeof v === "string" ? (v.length > 24 ? `"${v.slice(0, 24)}…"` : `"${v}"`) : String(v);
  return `${typeLabel} · ${text}`;
}

/**
 * Walk a resolved value, appending nested-path tags to `out`. Arrays contribute a `.length` tag and
 * stop (index access is context-dependent); plain objects recurse up to the depth/breadth caps.
 */
function walk(value: unknown, prefix: string, category: string, depth: number, out: MergeTag[]) {
  if (depth >= DEPTH_CAP) {
    return;
  }
  const v = unwrapSignal(value);
  if (v === null || v === undefined || typeof v !== "object") {
    return;
  }
  if (Array.isArray(v)) {
    const token = `${prefix}.length`;
    out.push({ category, hint: `number · ${v.length}`, label: token, token });
    return;
  }
  const keys = Object.keys(v).slice(0, BREADTH_CAP);
  for (const key of keys) {
    if (key.startsWith("$")) {
      continue; // Internal keys ($children, $ref, reactive plumbing) are not author-facing
    }
    const childVal = (v as Record<string, unknown>)[key];
    const childPrefix = `${prefix}.${key}`;
    out.push({ category, hint: previewHint(childVal), label: childPrefix, token: childPrefix });
    walk(childVal, childPrefix, category, depth + 1, out);
  }
}

/**
 * Build the list of insertable merge tags for the current editing context.
 *
 * @param state - The document's `state` definitions (`tab.doc.document.state`), used for names and
 *   classification (functions are skipped — they are not text-insertable values).
 * @param scope - The live resolved scope (`panel.liveCtx.scope`) for type/preview hints and the
 *   nested-property walk. May be null before the canvas has rendered.
 * @param localScope - The editing element's recorded render scope (`elToScope.get(el)`). When it
 *   carries a `$map` (repeater) context, `item` / `item.*` / `index` tags are appended.
 */
export function buildMergeTags(
  state: Record<string, unknown> | null | undefined,
  scope: Record<string, unknown> | null | undefined,
  localScope: Record<string, unknown> | null = null,
): MergeTag[] {
  const out: MergeTag[] = [];
  const defs = state ?? {};
  const scp = scope ?? {};

  for (const [name, def] of Object.entries(defs)) {
    if (name.startsWith("$")) {
      continue;
    }
    const category = defCategory(def);
    if (category === "function") {
      continue; // Handlers/functions aren't insertable as text values
    }
    const value = scp[name];
    const token = `state.${name}`;
    out.push({ category, hint: previewHint(value), label: token, token });
    walk(value, token, category, 0, out);
  }

  if (localScope) {
    const map = unwrapSignal(localScope.$map) as { item?: unknown; index?: unknown } | undefined;
    if (map && typeof map === "object") {
      out.push({ category: "repeater", hint: previewHint(map.item), label: "item", token: "item" });
      walk(map.item, "item", "repeater", 0, out);
      out.push({
        category: "repeater",
        hint: previewHint(map.index),
        label: "index",
        token: "index",
      });
    }
  }

  return out;
}
