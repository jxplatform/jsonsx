import elementsMeta from "../../data/elements-meta.json";

/** @typedef {{ label: string; tag: string; description: string }} SlashCommand */

const TAG_LABELS = /** @type {Record<string, string>} */ ({
  p: "Paragraph",
  h1: "Heading 1",
  h2: "Heading 2",
  h3: "Heading 3",
  h4: "Heading 4",
  h5: "Heading 5",
  h6: "Heading 6",
  blockquote: "Blockquote",
  div: "Div",
  section: "Section",
  article: "Article",
  aside: "Aside",
  main: "Main",
  header: "Header",
  footer: "Footer",
  nav: "Nav",
  search: "Search",
  ul: "Bulleted List",
  ol: "Numbered List",
});

const groups = /** @type {Record<string, string[]>} */ (elementsMeta.$convertGroups || {});

/**
 * Get the list of tags the current element can be converted to.
 *
 * @param {string} currentTag
 * @param {boolean} isEmpty
 * @returns {SlashCommand[]}
 */
export function getConvertTargets(currentTag, isEmpty) {
  const def = /** @type {Record<string, unknown> | undefined} */ (
    /** @type {Record<string, Record<string, unknown>>} */ (elementsMeta.$defs)?.[currentTag]
  );
  if (!def?.$convertTo) return [];

  const groupNames =
    isEmpty && def.$convertToWhenEmpty
      ? /** @type {string[]} */ (def.$convertToWhenEmpty)
      : [/** @type {string} */ (def.$convertTo)];

  /** @type {Set<string>} */
  const tags = new Set();
  for (const name of groupNames) {
    for (const tag of groups[name] || []) {
      if (tag !== currentTag) tags.add(tag);
    }
  }

  return [...tags].map((tag) => ({
    label: TAG_LABELS[tag] || tag.charAt(0).toUpperCase() + tag.slice(1),
    tag,
    description: "",
  }));
}
