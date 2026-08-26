// Generates docs/framework/reference/formulas.md from the @jxsuite/formulas catalog.
// The catalog itself is generated from packages/formulas/formulas/*/formula.json, so
// This page cannot drift from what ships.

import { catalog } from "@jxsuite/formulas/catalog";
import type { CemParameter } from "@jxsuite/schema/types";
import { BANNER, frontmatter } from "./shared.ts";

/** Render one parameter row. */
function parameterRow(param: string | CemParameter): string {
  if (typeof param === "string") {
    return `| \`${param}\` | — | — |`;
  }
  const type =
    typeof param.type === "object" && param.type !== null && "text" in param.type
      ? String((param.type as { text: string }).text)
      : param.type !== undefined
        ? JSON.stringify(param.type)
        : "—";
  return `| \`${param.name}\`${param.optional ? " (optional)" : ""} | ${type} | ${param.description ?? "—"} |`;
}

/** Render the formula-catalog reference page. */
export function generateFormulas(): string {
  const lines: string[] = [
    frontmatter({
      description:
        "Every composite formula that ships with Jx — name, parameters, and the pure expression it expands to.",
      title: "Formula catalog",
    }),
    BANNER,
    "",
    "# Formula catalog",
    "",
    "These composite formulas ship with Jx and appear in Studio's formula palette. Inserting one copies its pure `$expression` body into your document — there is no runtime dependency on this catalog. The blessed operator set the bodies draw from is in the [operator reference](/docs/framework/reference/operators/).",
    "",
  ];

  for (const entry of catalog.toSorted((a, b) => a.name.localeCompare(b.name))) {
    lines.push(`## ${entry.name}`, "", entry.description, "");
    if (entry.parameters.length > 0) {
      lines.push("| Parameter | Type | Description |", "| --- | --- | --- |");
      for (const param of entry.parameters) {
        lines.push(parameterRow(param));
      }
      lines.push("");
    }
    lines.push("```json", JSON.stringify(entry.expression, null, 2), "```", "");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
