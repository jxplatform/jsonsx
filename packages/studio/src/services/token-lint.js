/**
 * Token-lint.js — flags hard-coded values in a Jx document that match a project design token.
 *
 * Soft hints: findings are surfaced in tool-result summaries so the model can self-correct. Does
 * NOT fail mutations — see docs/ai-assistant-premium-components-plan.md §5 Phase 4.
 */

/** @typedef {{ path: string; property: string; value: string; suggestedToken: string }} TokenLintFinding */

/**
 * Build a reverse lookup from token values to token names. Normalizes hex colors to lowercase for
 * case-insensitive matching.
 *
 * @param {Record<string, string>} projectStyle
 * @returns {Map<string, string>}
 */
function buildTokenIndex(projectStyle) {
  const index = new Map();
  for (const [key, value] of Object.entries(projectStyle)) {
    if (!key.startsWith("--") || typeof value !== "string") continue;
    const norm = value.toLowerCase().trim();
    if (!index.has(norm)) {
      index.set(norm, key);
    }
  }
  return index;
}

/**
 * Check whether a CSS value is already a token reference.
 *
 * @param {string} value
 * @returns {boolean}
 */
function isTokenRef(value) {
  return typeof value === "string" && value.includes("var(--");
}

/**
 * Check whether a CSS value is a template expression (dynamic).
 *
 * @param {string} value
 * @returns {boolean}
 */
function isTemplate(value) {
  return typeof value === "string" && value.includes("${");
}

/**
 * Scan a Jx document for hard-coded style values that match a project design token.
 *
 * @param {object} doc - The Jx document (or subtree)
 * @param {Record<string, string>} projectStyle - The project.json style object
 * @returns {TokenLintFinding[]}
 */
export function flagHardcodedTokens(doc, projectStyle) {
  if (!doc || !projectStyle) return [];

  const tokenIndex = buildTokenIndex(projectStyle);
  if (tokenIndex.size === 0) return [];

  /** @type {TokenLintFinding[]} */
  const findings = [];

  function walk(node, pathPrefix) {
    if (!node || typeof node !== "object") return;

    if (node.style && typeof node.style === "object") {
      for (const [prop, val] of Object.entries(node.style)) {
        if (prop.startsWith("@")) continue;
        if (typeof val !== "string") continue;
        if (isTokenRef(val) || isTemplate(val)) continue;

        const norm = val.toLowerCase().trim();
        const token = tokenIndex.get(norm);
        if (token) {
          findings.push({
            path: pathPrefix,
            property: prop,
            value: val,
            suggestedToken: token,
          });
        }
      }
    }

    if (Array.isArray(node.children)) {
      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i];
        if (child && typeof child === "object") {
          walk(child, `${pathPrefix} > ${child.tagName || `[${i}]`}`);
        }
      }
    }
  }

  const tag = doc.tagName || "root";
  walk(doc, tag);
  return findings;
}

/**
 * Format findings as a human/model-readable hint string.
 *
 * @param {TokenLintFinding[]} findings
 * @returns {string}
 */
export function formatTokenHints(findings) {
  if (findings.length === 0) return "";
  const lines = findings.map(
    (f) => `- ${f.path} → ${f.property}: "${f.value}" — use var(${f.suggestedToken}) instead`,
  );
  return `Token hints (prefer design tokens over hard-coded values):\n${lines.join("\n")}`;
}
