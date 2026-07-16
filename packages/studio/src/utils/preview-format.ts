/**
 * Display formatting for live expression-preview values, shared by the parent-side snapshot
 * evaluator (services/preview-eval.ts) and the in-iframe live evaluator (canvas/iframe-eval.ts) so
 * both realms badge values with identical truncation rules. Dependency-light and DOM-free (the
 * strip-events pattern) so importing it never grows the iframe bundle.
 */

const MAX_BADGE_LENGTH = 48;

/** Format a runtime value as a short badge string. */
export function formatPreviewValue(value?: unknown): string {
  if (value === undefined) {
    return "undefined";
  }
  let text: string;
  try {
    text =
      typeof value === "string" ? JSON.stringify(value) : (JSON.stringify(value) ?? "undefined");
  } catch {
    text = String(value);
  }
  if (text.length > MAX_BADGE_LENGTH) {
    text = `${text.slice(0, MAX_BADGE_LENGTH - 1)}…`;
  }
  return text;
}
