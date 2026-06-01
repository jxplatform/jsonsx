/**
 * Gen-webdata.js — Extract web platform data from @webref packages
 *
 * Produces studio/webdata.json with: - Categorized HTML elements for the blocks panel - CSS
 * property names + initial values for autocomplete - Event handler names from IDL - All
 * non-obsolete tag names
 *
 * Usage: bun run studio/gen-webdata.js
 */

import { listAll as listElements } from "@webref/elements";
import css from "@webref/css";
import idl from "@webref/idl";
import { writeFileSync } from "node:fs";

// ─── Element categories for the blocks panel ─────────────────────────────────

const CATEGORIES: Record<string, string[]> = {
  Structure: [
    "div",
    "section",
    "article",
    "aside",
    "main",
    "header",
    "footer",
    "nav",
    "search",
    "hgroup",
  ],
  Text: [
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "p",
    "span",
    "a",
    "strong",
    "em",
    "small",
    "mark",
    "code",
    "pre",
    "blockquote",
    "q",
    "abbr",
    "time",
    "sub",
    "sup",
    "br",
    "hr",
    "wbr",
  ],
  Form: [
    "form",
    "input",
    "textarea",
    "select",
    "option",
    "optgroup",
    "button",
    "label",
    "fieldset",
    "legend",
    "output",
    "progress",
    "meter",
    "datalist",
  ],
  "List & Table": [
    "ul",
    "ol",
    "li",
    "dl",
    "dt",
    "dd",
    "table",
    "thead",
    "tbody",
    "tfoot",
    "tr",
    "th",
    "td",
    "caption",
    "colgroup",
    "col",
  ],
  Media: [
    "img",
    "picture",
    "source",
    "video",
    "audio",
    "track",
    "canvas",
    "iframe",
    "embed",
    "object",
  ],
  Interactive: ["details", "summary", "dialog", "menu"],
};

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const [elementsData, cssData, idlData] = await Promise.all([
    listElements(),
    css.listAll(),
    idl.parseAll(),
  ]);

  // 1. Collect all non-obsolete tags
  const tagSet: Set<string> = new Set();
  for (const { elements } of Object.values(/** @type {Record<string, any>} */ (elementsData))) {
    for (const el of elements) {
      if (!el.obsolete) tagSet.add(el.name);
    }
  }
  const allTags = [...tagSet].sort();

  // 2. Build categorized elements — only include tags that actually exist in @webref
  const categorized: Set<string> = new Set();
  /** @type {Record<string, { tag: string }[]>} */
  const elements = {};
  for (const [category, tags] of Object.entries(CATEGORIES)) {
    const valid = tags.filter((t) => tagSet.has(t));
    if (valid.length > 0) {
      elements[category] = valid.map((t) => ({ tag: t }));
      for (const t of valid) categorized.add(t);
    }
  }

  // Collect uncategorized HTML elements into "Other"
  const htmlTags: Set<string> = new Set();
  const elementsDataAny = elementsData as Record<string, any>;
  if (elementsDataAny.html) {
    for (const el of elementsDataAny.html.elements) {
      if (!el.obsolete) htmlTags.add(el.name);
    }
  }
  const other = [...htmlTags].filter((t) => !categorized.has(t)).sort();
  if (other.length > 0) {
    elements["Other"] = other.map((t) => ({ tag: t }));
  }

  // 3. Extract CSS properties (non-legacy, with camelCase name)
  const cssProps: [string, string][] = [];
  for (const prop of (cssData as any).properties) {
    if (prop.legacyAliasOf) continue;
    // Find the lowerCamelCase styleDeclaration entry
    const decls = prop.styleDeclaration ?? [];
    const camel = decls.find((n: string) => !n.includes("-") && !/^[A-Z]/.test(n));
    if (!camel) continue;
    cssProps.push([camel, prop.initial || ""]);
  }
  cssProps.sort((a, b) => a[0].localeCompare(b[0]));

  // 4. Extract event handlers from IDL
  const handlerSet: Set<string> = new Set();
  for (const ast of Object.values(/** @type {Record<string, any>} */ (idlData))) {
    for (const def of /** @type {any[]} */ (ast)) {
      if (def.type !== "interface" && def.type !== "interface mixin") continue;
      for (const member of def.members) {
        if (
          member.type === "attribute" &&
          member.name?.startsWith("on") &&
          typeof member.idlType?.idlType === "string" &&
          member.idlType.idlType === "EventHandler"
        ) {
          handlerSet.add(member.name);
        }
      }
    }
  }
  const eventHandlers = [...handlerSet].sort();

  // 5. Write output
  const output = { elements, cssProps, eventHandlers, allTags };
  const json = JSON.stringify(output, null, 2);
  writeFileSync("studio/data/webdata.json", json);

  // Stats
  const cats = Object.entries(elements)
    .map(([k, v]) => `${k}: ${v.length}`)
    .join(", ");
  console.log(`Elements: ${cats}`);
  console.log(`CSS properties: ${cssProps.length}`);
  console.log(`Event handlers: ${eventHandlers.length}`);
  console.log(`All tags: ${allTags.length}`);
  console.log(`Written → studio/webdata.json (${(json.length / 1024).toFixed(1)} KB)`);
}

main();
