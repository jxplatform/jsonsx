/**
 * Stylebook specimen-document generator — pure functions (no DOM) that turn the static element
 * catalog (data/stylebook-meta.json) plus the project's component registry into a plain JxDocument
 * the iframe canvas renders like any page. Each breakpoint panel renders the SAME generated doc in
 * a width-sized iframe, so `@media` blocks evaluate for real — this replaces the legacy parent-side
 * inline-style flatten (`buildStylebookElement`/`refreshStylebookStyles`).
 *
 * Two runtime facts shape {@link transposeStylebookStyle}:
 *
 * 1. The runtime's `applyStyle` emits `@media.selector` nesting but DROPS `selector.@media`
 *    (`emitNested` skips `@` keys) — the legacy flatten honored both orders, so tag rules' embedded
 *    `@name` blocks are HOISTED into the corresponding top-level `@name` block here.
 * 2. Tag-keyed rules on the generated root would restyle the card chrome (`div` rules hit chrome
 *    divs), so every tag rule `T` is re-keyed to `` `& .element-card-preview ${T}` `` — applyStyle
 *    resolves `&` to the root's `[data-jx=uid]` scope, confining the cascade to specimens.
 */

import { serializeJxPath } from "../canvas/path-mapping";
import type { StylebookEntry } from "./stylebook-panel";
import type { ComponentEntry } from "../files/components";
import type { JxPath } from "../state";
import type { JxMutableNode, JxStyle } from "@jxsuite/schema/types";

export interface StylebookDocResult {
  /** The specimen document (plain JSON — safe to post over the bridge). */
  doc: JxMutableNode;
  /** SerializeJxPath(path) → tag or compound ("ul li") for hit decoding. Chrome paths absent. */
  pathToTag: Map<string, string>;
  /** Tag/compound → the FIRST matching card's document path (selection-overlay measurement). */
  tagToCardPath: Map<string, JxPath>;
}

/** Selector-key classifier — a bare tag path like "p" or "table th" (mirrors style-panel's rule). */
function isTagPath(key: string): boolean {
  return (
    !key.startsWith(":") &&
    !key.startsWith(".") &&
    !key.startsWith("&") &&
    !key.startsWith("[") &&
    !key.startsWith("@") &&
    !key.startsWith("--")
  );
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** The specimen-scoping selector prefix (see module doc, runtime fact 2). */
const SPECIMEN_SCOPE = "& .element-card-preview";

/** Deep-merge `add` into `base` (objects merge, scalars overwrite; add wins). */
function mergeRules(
  base: Record<string, unknown> | undefined,
  add: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(add)) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? mergeRules(out[k], v) : v;
  }
  return out;
}

/** Drop nested `@` keys from a rule object (already-hoisted media can't nest deeper). */
function stripAtKeys(rule: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rule)) {
    if (isPlainObject(v) && k.startsWith("@")) {
      continue;
    }
    out[k] = isPlainObject(v) ? stripAtKeys(v) : v;
  }
  return out;
}

/**
 * Transform the merged effective document style into the generated root's style block: flat scalars
 * and `--` custom props stay at the top (inheritance into specimens), tag rules are re-keyed under
 * {@link SPECIMEN_SCOPE}, and `selector.@media` nesting is hoisted into top-level `@name` blocks
 * (both per the module doc). Shared by the doc generator and the live `styleUpdate` fast path so an
 * edit round-trips through the exact same transform.
 */
export function transposeStylebookStyle(effectiveStyle: JxStyle): JxStyle {
  const style = effectiveStyle as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const mediaOut: Record<string, Record<string, unknown>> = {};

  /** Re-key + hoist one tag rule subtree; returns the cleaned (media-free) rule. */
  const processTagRule = (
    rule: Record<string, unknown>,
    tagPath: string,
  ): Record<string, unknown> => {
    const cleaned: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rule)) {
      if (!isPlainObject(v)) {
        cleaned[k] = v;
        continue;
      }
      if (k.startsWith("@")) {
        if (k === "@--") {
          continue; // Base canvas width marker, not a real query.
        }
        const bucket = (mediaOut[k] ??= {});
        const sel = `${SPECIMEN_SCOPE} ${tagPath}`;
        bucket[sel] = mergeRules(
          bucket[sel] as Record<string, unknown> | undefined,
          stripAtKeys(v),
        );
        continue;
      }
      if (isTagPath(k)) {
        cleaned[k] = processTagRule(v, `${tagPath} ${k}`);
        continue;
      }
      cleaned[k] = v; // Pseudo/class/& sub-rules ride along under the re-keyed parent.
    }
    return cleaned;
  };

  for (const [k, v] of Object.entries(style)) {
    if (!isPlainObject(v)) {
      out[k] = v; // Flat scalars + -- custom props.
      continue;
    }
    if (k.startsWith("@")) {
      if (k === "@--") {
        continue;
      }
      // Media block: re-key tag rules inside; non-tag keys (scalars/pseudo) apply to the root.
      const bucket = (mediaOut[k] ??= {});
      for (const [mk, mv] of Object.entries(v)) {
        if (isPlainObject(mv) && isTagPath(mk)) {
          const sel = `${SPECIMEN_SCOPE} ${mk}`;
          bucket[sel] = mergeRules(bucket[sel] as Record<string, unknown> | undefined, mv);
        } else {
          bucket[mk] = mv;
        }
      }
      continue;
    }
    if (isTagPath(k)) {
      out[`${SPECIMEN_SCOPE} ${k}`] = processTagRule(v, k);
      continue;
    }
    out[k] = v;
  }

  for (const [mk, mv] of Object.entries(mediaOut)) {
    out[mk] = isPlainObject(out[mk]) ? mergeRules(out[mk] as Record<string, unknown>, mv) : mv;
  }
  return out as JxStyle;
}

/** Resolve a nested tag path ("table th") in a style object; null when absent. */
function resolveNestedStyle(
  style: Record<string, unknown>,
  tagPath: string,
): Record<string, unknown> | null {
  const parts = tagPath.split(" ");
  let obj: unknown = style;
  for (const part of parts) {
    if (!isPlainObject(obj)) {
      return null;
    }
    obj = obj[part];
  }
  return isPlainObject(obj) ? obj : null;
}

/** Whether the effective style customizes `tagPath` (directly or under any `@media` block). */
export function hasTagStyle(rootStyle: JxStyle, tagPath: string): boolean {
  const style = rootStyle as Record<string, unknown>;
  const direct = resolveNestedStyle(style, tagPath);
  if (direct && Object.keys(direct).length > 0) {
    return true;
  }
  for (const [key, val] of Object.entries(style)) {
    if (!key.startsWith("@") || !isPlainObject(val)) {
      continue;
    }
    const nested = resolveNestedStyle(val, tagPath);
    if (nested && Object.keys(nested).length > 0) {
      return true;
    }
  }
  return false;
}

/** Options for {@link buildStylebookDoc}. */
export interface BuildStylebookDocOpts {
  meta: { $sections: { label: string; elements: StylebookEntry[] }[] };
  components: ComponentEntry[];
  /** Merged document+project style (getEffectiveStyle output) — transposed here. */
  effectiveStyle: JxStyle;
  /** Merged $media map (getEffectiveMedia output) — becomes the doc's $media. */
  effectiveMedia: Record<string, string>;
  filter: string;
  customizedOnly: boolean;
  projectRoot: string | null;
}

/**
 * Build the specimen document + path↔tag maps. Deterministic: paths are recorded as the tree is
 * assembled, so the parent can decode `hit` paths and measure selection cards without reading the
 * iframe DOM.
 */
export function buildStylebookDoc(opts: BuildStylebookDocOpts): StylebookDocResult {
  const pathToTag = new Map<string, string>();
  const tagToCardPath = new Map<string, JxPath>();
  const filter = opts.filter.toLowerCase();

  /** Register a specimen subtree's paths: root → tag; descendants → compound (legacy semantics). */
  const registerSpecimenPaths = (entry: StylebookEntry, path: JxPath, rootTag: string): void => {
    const compound = entry.tag === rootTag ? rootTag : `${rootTag} ${entry.tag}`;
    pathToTag.set(serializeJxPath(path), compound);
    const kids = entry.children ?? [];
    for (const [i, child] of kids.entries()) {
      registerSpecimenPaths(child, [...path, "children", i], rootTag);
    }
  };

  const specimenNode = (entry: StylebookEntry): JxMutableNode => {
    const attributes: Record<string, string> = { ...entry.attributes };
    if (entry.style) {
      attributes.style = entry.style; // Inline CSS text — legacy `el.style.cssText` parity.
    }
    return {
      tagName: entry.tag,
      ...(entry.text ? { textContent: entry.text } : {}),
      ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
      ...(entry.children ? { children: entry.children.map(specimenNode) } : {}),
    } as JxMutableNode;
  };

  /** A card wrapping one specimen; registers card/preview/specimen paths under `tag`. */
  const cardNode = (
    tag: string,
    label: string,
    specimen: JxMutableNode,
    cardPath: JxPath,
    entryForPaths: StylebookEntry | null,
  ): JxMutableNode => {
    pathToTag.set(serializeJxPath(cardPath), tag);
    pathToTag.set(serializeJxPath([...cardPath, "children", 0]), tag);
    const specimenPath = [...cardPath, "children", 0, "children", 0];
    if (entryForPaths) {
      registerSpecimenPaths(entryForPaths, specimenPath, tag);
    } else {
      pathToTag.set(serializeJxPath(specimenPath), tag);
    }
    if (!tagToCardPath.has(tag)) {
      tagToCardPath.set(tag, cardPath);
    }
    return {
      attributes: { class: "element-card" },
      children: [
        { attributes: { class: "element-card-preview" }, children: [specimen], tagName: "div" },
        { attributes: { class: "element-card-label" }, tagName: "div", textContent: label },
      ],
      tagName: "div",
    } as JxMutableNode;
  };

  const sections: JxMutableNode[] = [];
  const sectionNode = (label: string, cards: JxMutableNode[]): JxMutableNode =>
    ({
      attributes: { class: "sb-section" },
      children: [
        { attributes: { class: "sb-label" }, tagName: "div", textContent: label },
        { attributes: { class: "sb-body" }, children: cards, tagName: "div" },
      ],
      tagName: "div",
    }) as JxMutableNode;

  // Paths below mirror the assembled tree: root.children[si] = section; section.children[1] =
  // Sb-body; body.children[ci] = card. Sections are appended only when non-empty, so indices are
  // Computed from the OUTPUT arrays, not the input catalog.
  const sectionBodyPath = (): JxPath => ["children", sections.length, "children", 1];

  for (const section of opts.meta.$sections) {
    let entries = section.elements;
    if (filter) {
      entries = entries.filter(
        (e) => e.tag.includes(filter) || section.label.toLowerCase().includes(filter),
      );
    }
    if (opts.customizedOnly) {
      entries = entries.filter((e) => hasTagStyle(opts.effectiveStyle, e.tag));
    }
    if (entries.length === 0) {
      continue;
    }
    const bodyPath = sectionBodyPath();
    const cards = entries.map((entry, ci) =>
      cardNode(
        entry.tag,
        `<${entry.tag}>`,
        specimenNode(entry),
        [...bodyPath, "children", ci],
        entry,
      ),
    );
    sections.push(sectionNode(section.label, cards));
  }

  // Custom components from the registry — live custom elements registered via $elements.
  const $elements: (string | { $ref: string })[] = [];
  {
    let comps = opts.components;
    if (filter) {
      comps = comps.filter((c) => c.tagName.toLowerCase().includes(filter));
    }
    if (opts.customizedOnly) {
      comps = comps.filter((c) => hasTagStyle(opts.effectiveStyle, c.tagName));
    }
    if (comps.length > 0) {
      const bodyPath = sectionBodyPath();
      const cards = comps.map((comp, ci) => {
        const cardPath = [...bodyPath, "children", ci];
        const renderable = comp.source !== "npm" && comp.path?.endsWith(".json");
        if (renderable) {
          // Root-relative $ref: registerElements resolves it against docBase (the canvas origin).
          // Collapse leading slashes — an absolute projectRoot ("/home/…") would otherwise produce
          // A protocol-relative "//home/…" that URL-resolves to a foreign host.
          $elements.push({
            $ref: `/${opts.projectRoot ? `${opts.projectRoot}/` : ""}${comp.path}`.replace(
              /^\/+/,
              "/",
            ),
          });
          const attributes: Record<string, string> = {};
          for (const p of comp.props ?? []) {
            if (p.default !== undefined && p.default !== "false" && p.default !== "''") {
              attributes[p.name] = String(p.default).replaceAll(/^'|'$/g, "");
            }
          }
          const specimen = {
            tagName: comp.tagName,
            ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
          } as JxMutableNode;
          return cardNode(comp.tagName, `<${comp.tagName}>`, specimen, cardPath, null);
        }
        // Npm/format-class components can't be $ref-registered — placeholder box (legacy parity).
        const fallback = {
          attributes: { class: "sb-fallback" },
          tagName: "div",
          textContent: `<${comp.tagName}>`,
        } as JxMutableNode;
        return cardNode(comp.tagName, `<${comp.tagName}>`, fallback, cardPath, null);
      });
      sections.push(sectionNode("Components", cards));
    }
  }

  if (sections.length === 0) {
    sections.push({
      attributes: { class: "sb-empty" },
      tagName: "div",
      textContent: opts.customizedOnly ? "No customized elements" : "No matching elements",
    } as JxMutableNode);
  }

  const doc = {
    ...($elements.length > 0 ? { $elements } : {}),
    $media: opts.effectiveMedia,
    attributes: { class: "sb-root" },
    children: sections,
    style: transposeStylebookStyle(opts.effectiveStyle),
    tagName: "div",
  } as JxMutableNode;

  return { doc, pathToTag, tagToCardPath };
}
