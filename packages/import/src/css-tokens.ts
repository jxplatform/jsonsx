/**
 * Extract CSS custom properties from retained stylesheets and replace resolved computed values with
 * var(--name) references. Hoists token declarations for project.json.$style.
 */

import type { DiffedStyle } from "./style-diff.ts";

export interface TokenExtractionResult {
  /**
   * Custom property declarations to hoist into project.json.$style (e.g. { "--brand-blue":
   * "#3b82f6" }).
   */
  tokens: Record<string, string>;
  /** Number of value replacements made across all diffed styles. */
  replacements: number;
}

/**
 * Normalize a CSS color value for comparison. Handles common variations: - rgb(r, g, b) vs rgb(r g
 * b) - Trailing semicolons/whitespace
 */
function normalizeValue(val: string): string {
  return val
    .trim()
    .replace(/\s*;\s*$/, "")
    .replaceAll(/,\s*/g, ", ")
    .replaceAll(/\s+/g, " ");
}

/**
 * Build a reverse map: resolved CSS value → var(--name). When multiple custom properties resolve to
 * the same value, prefer shorter names (heuristic: shorter names are more likely to be semantic
 * tokens).
 */
function buildValueToVarMap(props: Map<string, string>): Map<string, string> {
  const valueToVar = new Map<string, string>();

  // Sort by name length ascending so shorter (more semantic) names win ties
  const sorted = [...props.entries()].toSorted((a, b) => a[0].length - b[0].length);

  for (const [name, value] of sorted) {
    const normalized = normalizeValue(value);
    if (!valueToVar.has(normalized)) {
      valueToVar.set(normalized, `var(${name})`);
    }
  }

  return valueToVar;
}

const TOKEN_ELIGIBLE_PROPS = new Set([
  "color",
  "backgroundColor",
  "borderColor",
  "borderTopColor",
  "borderRightColor",
  "borderBottomColor",
  "borderLeftColor",
  "outlineColor",
  "textDecorationColor",
  "fill",
  "stroke",
  "caretColor",
  "columnRuleColor",
  "boxShadow",
  "textShadow",
  "background",
  "backgroundImage",
  "borderTop",
  "borderRight",
  "borderBottom",
  "borderLeft",
  "border",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "lineHeight",
  "letterSpacing",
  "gap",
  "rowGap",
  "columnGap",
  "borderRadius",
  "borderTopLeftRadius",
  "borderTopRightRadius",
  "borderBottomLeftRadius",
  "borderBottomRightRadius",
  "padding",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "margin",
  "marginTop",
  "marginRight",
  "marginBottom",
  "marginLeft",
  "maxWidth",
  "width",
]);

/**
 * Replace resolved computed values with var(--name) references in diffed styles. Also collects the
 * set of custom properties actually used (for hoisting into project.json).
 *
 * Mutates the diffed styles in place for efficiency.
 *
 * @param customProperties - Map of CSS custom property name → resolved value, as extracted by
 *   captureStyles() in-browser.
 */
export function applyTokens(
  diffedStyles: DiffedStyle[],
  customProperties: Record<string, string>,
): TokenExtractionResult {
  const props = new Map(Object.entries(customProperties));
  if (props.size === 0) {
    return { tokens: {}, replacements: 0 };
  }

  const valueToVar = buildValueToVarMap(props);
  const usedTokens = new Map<string, string>();
  let replacements = 0;

  for (const el of diffedStyles) {
    for (const [prop, value] of Object.entries(el.style)) {
      if (!TOKEN_ELIGIBLE_PROPS.has(prop)) {
        continue;
      }
      if (typeof value !== "string") {
        continue;
      }
      // Already a var() reference
      if (value.startsWith("var(")) {
        continue;
      }

      const normalized = normalizeValue(value);
      const varRef = valueToVar.get(normalized);
      if (varRef) {
        el.style[prop] = varRef;
        replacements += 1;

        // Track which token was used so we can hoist its declaration
        const varName = varRef.slice(4, -1); // "var(--x)" → "--x"
        usedTokens.set(varName, props.get(varName)!);
      }
    }
  }

  // Sort tokens alphabetically for stable output
  const tokens: Record<string, string> = {};
  for (const name of [...usedTokens.keys()].toSorted()) {
    tokens[name] = usedTokens.get(name)!;
  }

  return { tokens, replacements };
}
