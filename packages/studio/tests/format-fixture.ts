/**
 * Test fixture: seeds the studio's format host with the parser's Markdown format and provides a
 * platform `formatAction` mock that dispatches to the real implementation in-process (mimicking the
 * dev server's POST /__studio/format).
 */
import { readFileSync } from "node:fs";
import { Markdown } from "@jxsuite/parser/markdown";
import { setFormats } from "../src/format/format-host";
import type { StudioFormat } from "../src/format/format-host";

const classDef = JSON.parse(
  readFileSync(new URL(import.meta.resolve("@jxsuite/parser/Markdown.class.json")), "utf8"),
);

export const MARKDOWN_FORMAT: StudioFormat = {
  capabilities: Object.fromEntries(
    Object.entries(classDef.$defs?.methods ?? {})
      .filter(([, m]) => ["parse", "serialize", "discover", "load"].includes((m as any).role))
      .map(([key, m]) => [
        (m as any).role,
        {
          identifier: (m as any).identifier ?? key,
          timing: (m as any).timing ?? ["compiler", "server"],
        },
      ]),
  ),
  documentKinds: classDef.format.documentKinds ?? [],
  exportTarget: classDef.format.exportTarget === true,
  extensions: classDef.format.extensions,
  mediaType: classDef.format.mediaType ?? null,
  name: "Markdown",
  remote: classDef.format.remote === true,
  studio: classDef.$studio ?? null,
};

/** Seed the format host with the Markdown format. */
export function seedMarkdownFormat() {
  setFormats([MARKDOWN_FORMAT]);
}

/** Platform formatAction mock — runs the capability in-process. */
export async function mockFormatAction(payload: Record<string, unknown>) {
  const { format, action, source, doc, options } = payload as {
    format: string;
    action: string;
    source?: string;
    doc?: Record<string, unknown>;
    options?: Record<string, unknown>;
  };
  if (format !== "Markdown") {
    throw new Error(`Unknown format "${format}"`);
  }
  if (action === "parse") {
    return Markdown.parse(source ?? "");
  }
  if (action === "serialize") {
    return Markdown.serialize(doc ?? {}, options);
  }
  throw new Error(`Unsupported action "${action}"`);
}
