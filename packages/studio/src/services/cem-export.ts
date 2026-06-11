/// <reference lib="dom" />
import type { CemParameter, JxMutableNode, JxStateObject } from "@jxsuite/schema/types";
import { isFunctionDef, isJsonObject } from "@jxsuite/schema/guards";

/** Collect slot elements from the document tree. */
export function collectSlots(node: JxMutableNode | null | undefined, slots: string[] = []) {
  if (node?.tagName === "slot") {
    const name = node.attributes?.name;
    slots.push(typeof name === "string" ? name : "");
  }
  if (Array.isArray(node?.children)) {
    node.children.forEach((c: JxMutableNode | string) =>
      collectSlots(typeof c === "string" ? undefined : c, slots),
    );
  }
  return slots;
}

/**
 * Generate and download a CEM 2.1.0 manifest for the current document.
 *
 * @param {{ document: JxMutableNode }} S - Studio state
 * @param {{
 *   defCategory: (d: unknown) => string;
 *   normParam: (p: string | CemParameter) => CemParameter;
 *   collectCssParts: (node: JxMutableNode) => { name: string }[];
 * }} helpers
 */
export function exportCemManifest(
  S: { document: JxMutableNode },
  helpers: {
    defCategory: (d: unknown) => string;
    normParam: (p: string | CemParameter) => CemParameter;
    collectCssParts: (node: JxMutableNode) => { name: string }[];
  },
) {
  const { defCategory, normParam, collectCssParts } = helpers;
  const doc = S.document;
  const { tagName } = doc;
  if (!tagName || !tagName.includes("-")) {
    return;
  }

  const state = doc.state || {};
  const members: Record<string, unknown>[] = [];
  const attributes: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [];
  const seenEvents = new Set<string>();

  for (const [key, d] of Object.entries(state)) {
    if (key.startsWith("#")) {
      continue;
    } // Private

    const cat = defCategory(d);

    if (cat === "function") {
      if (isFunctionDef(d)) {
        members.push({
          kind: "method",
          name: key,
          ...(d.description ? { description: d.description } : {}),
          ...(d.parameters ? { parameters: d.parameters.map(normParam) } : {}),
          ...(d.deprecated
            ? { deprecated: typeof d.deprecated === "string" ? d.deprecated : true }
            : {}),
        });
        // Collect emits
        for (const ev of d.emits ?? []) {
          if (ev.name && !seenEvents.has(ev.name)) {
            seenEvents.add(ev.name);
            events.push({
              name: ev.name,
              ...(ev.type !== undefined ? { type: ev.type } : {}),
              ...(ev.description ? { description: ev.description } : {}),
            });
          }
        }
      } else if (isJsonObject(d)) {
        // Legacy $handler entry — emit a bare method member
        const { description } = d;
        members.push({
          kind: "method",
          name: key,
          ...(typeof description === "string" ? { description } : {}),
        });
      }
    } else if (cat === "state") {
      // Naked primitive values carry no metadata; object defs are signals/type defs.
      const def: JxStateObject | null = isJsonObject(d) ? (d as JxStateObject) : null;
      members.push({
        kind: "field",
        name: key,
        ...(def?.type ? { type: { text: def.type } } : {}),
        ...(def && def.default !== undefined ? { default: String(def.default) } : {}),
        ...(def?.description ? { description: def.description } : {}),
        ...(def?.attribute ? { attribute: def.attribute } : {}),
        ...(def?.reflects ? { reflects: true } : {}),
        ...(def?.deprecated
          ? { deprecated: typeof def.deprecated === "string" ? def.deprecated : true }
          : {}),
      });
      if (def?.attribute) {
        attributes.push({
          name: def.attribute,
          ...(def.type ? { type: { text: def.type } } : {}),
          fieldName: key,
        });
      }
    }
  }

  // Slots
  const slotNames = collectSlots(doc);
  const slots = slotNames.map((name: string) => ({
    name: name || "",
    ...(name ? {} : { description: "Default slot" }),
  }));

  // CSS custom properties
  const style = doc.style || {};
  const cssProperties = Object.entries(style)
    .filter(([k]) => k.startsWith("--"))
    .map(([name, val]) => ({ default: String(val), name }));

  // CSS parts
  const cssParts = collectCssParts(doc).map((p) => ({ name: p.name }));

  const manifest = {
    modules: [
      {
        declarations: [
          {
            kind: "class",
            members,
            name: tagName,
            tagName,
            ...(attributes.length > 0 ? { attributes } : {}),
            ...(events.length > 0 ? { events } : {}),
            ...(slots.length > 0 ? { slots } : {}),
            ...(cssProperties.length > 0 ? { cssProperties } : {}),
            ...(cssParts.length > 0 ? { cssParts } : {}),
          },
        ],
        kind: "javascript-module",
        path: "",
      },
    ],
    schemaVersion: "2.1.0",
  };

  const blob = new Blob([JSON.stringify(manifest, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${tagName}.cem.json`;
  a.click();
  URL.revokeObjectURL(url);
}
