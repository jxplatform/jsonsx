/**
 * Attached-context.js — the composer's "attach context" message-content convention.
 *
 * Attached context (current page, selected element) is embedded into the user message
 * content after a delimiter line: it's the only channel the LLM sees (the streaming
 * payload carries message content only) and it persists with the session for free.
 * The chat view splits the content back apart to show chips instead of the raw block.
 *
 * The delimiter is a soft convention — a model echoing it would at worst render stray
 * chips (no security impact; assistant markdown is sanitized separately).
 *
 * @license MIT
 */

export const ATTACHED_CONTEXT_DELIMITER = "---- attached context ----";

export interface ContextChip {
  kind: "page" | "selection";
  /** Short chip label, e.g. the page path or `<h1>`. */
  label: string;
  /** The context line embedded into the message content. */
  detail: string;
}

/** Serialize the composer text plus attached-context chips into one message content. */
export function buildMessageWithContext(text: string, chips: ContextChip[]): string {
  if (chips.length === 0) {
    return text;
  }
  const lines = chips.map((c) => c.detail).join("\n");
  return `${text}\n\n${ATTACHED_CONTEXT_DELIMITER}\n${lines}`;
}

/** Split a user message back into its typed body and any attached-context lines. */
export function splitAttachedContext(content: string): { body: string; contextLines: string[] } {
  const idx = content.indexOf(`\n\n${ATTACHED_CONTEXT_DELIMITER}\n`);
  if (idx === -1) {
    return { body: content, contextLines: [] };
  }
  const body = content.slice(0, idx);
  const rest = content.slice(idx + ATTACHED_CONTEXT_DELIMITER.length + 3);
  return {
    body,
    contextLines: rest
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0),
  };
}
