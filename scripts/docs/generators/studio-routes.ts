// Generates docs/extending/reference/studio-routes.md from @jxsuite/protocol's
// STUDIO_ROUTES table. Route data is imported (typed, canonical); the group
// Headings are parsed from the source's section banners so the docs mirror the
// Table's own organization.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { STUDIO_PROTOCOL_VERSION, STUDIO_ROUTES } from "@jxsuite/protocol/routes";
import { BANNER, frontmatter } from "./shared.ts";

const ROOT = resolve(import.meta.dir, "../../..");

/** Escape markdown table cell content. */
function cell(text: string): string {
  return text.replaceAll("|", String.raw`\|`).replaceAll("\n", " ");
}

/** Parse the route-key → group-heading mapping from the source's `// ─── <Heading> ───` banners. */
function parseGroups(): Map<string, string> {
  const source = readFileSync(join(ROOT, "packages/protocol/src/routes.ts"), "utf8");
  const table = source.slice(source.indexOf("export const STUDIO_ROUTES"));
  const groups = new Map<string, string>();
  let current = "General";
  for (const line of table.split("\n")) {
    const banner = line.match(/\/\/ ─+ (.+?) ─+/);
    if (banner) {
      current = banner[1]!.trim();
      continue;
    }
    const key = line.match(/^ {2}(\w+): route\(/);
    if (key) {
      groups.set(key[1]!, current);
    }
  }
  return groups;
}

/** Render the protocol route reference page. */
export function generateStudioRoutes(): string {
  const groups = parseGroups();

  const lines: string[] = [
    frontmatter({
      description:
        "Every route in the Studio Backend Protocol — method, path, contract summary, and how Studio degrades when an optional route is absent.",
      title: "Protocol route reference",
    }),
    BANNER,
    "",
    "# Protocol route reference",
    "",
    `The canonical Studio Backend Protocol route table (protocol version ${STUDIO_PROTOCOL_VERSION}), from \`@jxsuite/protocol\`. The dev server is the reference implementation; any backend serving these shapes can host Studio. Optional routes back optional platform-adapter members — Studio degrades without them as described.`,
    "",
  ];

  const byGroup = new Map<string, [string, (typeof STUDIO_ROUTES)[keyof typeof STUDIO_ROUTES]][]>();
  for (const [key, route] of Object.entries(STUDIO_ROUTES)) {
    const group = groups.get(key) ?? "General";
    const bucket = byGroup.get(group) ?? [];
    bucket.push([key, route]);
    byGroup.set(group, bucket);
  }

  for (const [group, routes] of byGroup) {
    lines.push(
      `## ${group}`,
      "",
      "| Route | Method | Path | Summary | Optional | Degradation |",
      "| --- | --- | --- | --- | --- | --- |",
    );
    for (const [key, route] of routes) {
      lines.push(
        `| \`${key}\` | ${route.method} | \`${route.path}\` | ${cell(route.summary)} | ${route.optional ? "yes" : "no"} | ${route.degradation ? cell(route.degradation) : "—"} |`,
      );
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
