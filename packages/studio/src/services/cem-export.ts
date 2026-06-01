/** Collect slot elements from the document tree. */
export function collectSlots(node: JxMutableNode | null | undefined, slots: string[] = []) {
  if (node?.tagName === "slot") {
    slots.push(node.attributes?.name || "");
  }
  if (Array.isArray(node?.children))
    node.children.forEach((c: JxMutableNode | string) =>
      collectSlots(typeof c === "string" ? undefined : c, slots),
    );
  return slots;
}

/**
 * Generate and download a CEM 2.1.0 manifest for the current document.
 *
 * @param {{ document: JxMutableNode }} S - Studio state
 * @param {{
 *   defCategory: (d: unknown) => string;
 *   normParam: (p: unknown) => unknown;
 *   collectCssParts: (node: JxMutableNode) => { name: string }[];
 * }} helpers
 */
export function exportCemManifest(
  S: { document: JxMutableNode },
  helpers: {
    defCategory: (d: unknown) => string;
    normParam: (p: unknown) => unknown;
    collectCssParts: (node: JxMutableNode) => { name: string }[];
  },
) {
  const { defCategory, normParam, collectCssParts } = helpers;
  const doc = S.document;
  const tagName = doc.tagName;
  if (!tagName || !tagName.includes("-")) return;

  const state = doc.state || {};
  const members = [];
  const attributes = [];
  const events = [];
  const seenEvents = new Set();

  for (const [key, d] of Object.entries(state)) {
    if (key.startsWith("#")) continue; // private

    const cat = defCategory(d);

    if (cat === "function") {
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
      if (Array.isArray(d.emits)) {
        for (const ev of d.emits) {
          if (ev.name && !seenEvents.has(ev.name)) {
            seenEvents.add(ev.name);
            events.push({
              name: ev.name,
              ...(ev.type ? { type: ev.type } : {}),
              ...(ev.description ? { description: ev.description } : {}),
            });
          }
        }
      }
    } else if (cat === "state") {
      members.push({
        kind: "field",
        name: key,
        ...(d.type ? { type: { text: d.type } } : {}),
        ...(d.default !== undefined ? { default: String(d.default) } : {}),
        ...(d.description ? { description: d.description } : {}),
        ...(d.attribute ? { attribute: d.attribute } : {}),
        ...(d.reflects ? { reflects: true } : {}),
        ...(d.deprecated
          ? { deprecated: typeof d.deprecated === "string" ? d.deprecated : true }
          : {}),
      });
      if (d.attribute) {
        attributes.push({
          name: d.attribute,
          ...(d.type ? { type: { text: d.type } } : {}),
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
    .map(([name, val]) => ({ name, default: String(val) }));

  // CSS parts
  const cssParts = collectCssParts(doc).map((p) => ({ name: p.name }));

  const manifest = {
    schemaVersion: "2.1.0",
    modules: [
      {
        kind: "javascript-module",
        path: "",
        declarations: [
          {
            kind: "class",
            name: tagName,
            tagName,
            members,
            ...(attributes.length ? { attributes } : {}),
            ...(events.length ? { events } : {}),
            ...(slots.length ? { slots } : {}),
            ...(cssProperties.length ? { cssProperties } : {}),
            ...(cssParts.length ? { cssParts } : {}),
          },
        ],
      },
    ],
  };

  const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${tagName}.cem.json`;
  a.click();
  URL.revokeObjectURL(url);
}
