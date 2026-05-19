/**
 * Shared panel utilities — portable helpers extracted from studio.js. These functions depend only
 * on store.js / state.js exports (no circular deps).
 */

/**
 * Convert a $media key like "--tablet" to a friendly display name "Tablet". "--" returns "Base".
 *
 * @param {any} name
 */
export function mediaDisplayName(name) {
  if (name === "--") return "Base";
  return (
    name
      .replace(/^--/, "")
      .replace(/-/g, " ")
      .replace(/\b\w/g, (/** @type {any} */ c) => c.toUpperCase()) || name
  );
}

/**
 * Ensure Lit's internal ChildPart markers are valid. If corrupted, clears the container so Lit
 * rebuilds from scratch on the next render.
 *
 * @param {HTMLElement} container
 */
export function ensureLitState(container) {
  // @ts-ignore — Lit stores a ChildPart on this private property
  const part = container["_$litPart$"];
  if (!part) return;
  const start = part._$startNode;
  const end = part._$endNode;
  const startBad = start && start.parentNode !== container;
  const endBad = (end && end !== container && end.parentNode !== container) || (!end && start);
  if (startBad || endBad) {
    console.warn("ensureLitState: clearing corrupted Lit state on", container.id || container);
    container.textContent = "";
    // @ts-ignore
    delete container["_$litPart$"];
  }
}

export const unsafeTags = new Set(["script", "style", "link", "iframe", "object", "embed"]);

/**
 * Generate a sensible default Jx node for a given tag name.
 *
 * @param {any} tag
 */
export function defaultDef(tag) {
  /** @type {any} */
  const def = { tagName: tag };
  if (/^h[1-6]$/.test(tag)) def.textContent = "Heading";
  else if (tag === "p") def.textContent = "Paragraph text";
  else if (
    tag === "span" ||
    tag === "strong" ||
    tag === "em" ||
    tag === "small" ||
    tag === "mark" ||
    tag === "code" ||
    tag === "abbr" ||
    tag === "q" ||
    tag === "sub" ||
    tag === "sup" ||
    tag === "time"
  )
    def.textContent = "Text";
  else if (tag === "a") {
    def.textContent = "Link";
    def.attributes = { href: "#" };
  } else if (tag === "button") def.textContent = "Button";
  else if (tag === "label") def.textContent = "Label";
  else if (tag === "legend") def.textContent = "Legend";
  else if (tag === "caption") def.textContent = "Caption";
  else if (tag === "summary") def.textContent = "Summary";
  else if (
    tag === "li" ||
    tag === "dt" ||
    tag === "dd" ||
    tag === "th" ||
    tag === "td" ||
    tag === "option"
  )
    def.textContent = "Item";
  else if (tag === "blockquote") def.textContent = "Quote";
  else if (tag === "pre") def.textContent = "Preformatted text";
  else if (tag === "input") def.attributes = { type: "text", placeholder: "Enter text..." };
  else if (tag === "img") def.attributes = { src: "", alt: "Image" };
  else if (tag === "iframe") def.attributes = { src: "" };
  else if (tag === "select") def.children = [{ tagName: "option", textContent: "Option 1" }];
  else if (tag === "ul" || tag === "ol") def.children = [{ tagName: "li", textContent: "Item" }];
  else if (tag === "dl")
    def.children = [
      { tagName: "dt", textContent: "Term" },
      { tagName: "dd", textContent: "Definition" },
    ];
  else if (tag === "table")
    def.children = [
      {
        tagName: "thead",
        children: [{ tagName: "tr", children: [{ tagName: "th", textContent: "Header" }] }],
      },
      {
        tagName: "tbody",
        children: [{ tagName: "tr", children: [{ tagName: "td", textContent: "Cell" }] }],
      },
    ];
  else if (tag === "details")
    def.children = [
      { tagName: "summary", textContent: "Summary" },
      { tagName: "p", textContent: "Detail content" },
    ];
  return def;
}
