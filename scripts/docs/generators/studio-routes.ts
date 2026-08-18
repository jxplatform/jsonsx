// Generates docs/extending/reference/studio-routes.md from @jxsuite/protocol's
// STUDIO_ROUTES and PROBLEM_TYPES tables. Both are imported (typed, canonical);
// The group headings are parsed from each source's section banners so the docs
// Mirror the tables' own organization.
//
// The problem types belong on this page rather than their own: a backend
// Implementer reading the route table needs the failure vocabulary in the same
// Breath, and splitting them is how the failure half went undocumented before.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { STUDIO_PROTOCOL_VERSION, STUDIO_ROUTES } from "@jxsuite/protocol/routes";
import { PROBLEM_MEDIA_TYPE } from "@jxsuite/protocol/problem";
import { PROBLEM_TYPES } from "@jxsuite/protocol/problems";
import { BANNER, frontmatter } from "./shared.ts";

const ROOT = resolve(import.meta.dir, "../../..");

/** Escape markdown table cell content. */
function cell(text: string): string {
  return text.replaceAll("|", String.raw`\|`).replaceAll("\n", " ");
}

/** Parse the key → group-heading mapping from a source's `// ─── <Heading> ───` banners. */
function parseGroups(
  file = "packages/protocol/src/routes.ts",
  tableName = "export const STUDIO_ROUTES",
  entry = /^ {2}(\w+): route\(/,
): Map<string, string> {
  const source = readFileSync(join(ROOT, file), "utf8");
  const table = source.slice(source.indexOf(tableName));
  const groups = new Map<string, string>();
  let current = "General";
  for (const line of table.split("\n")) {
    const banner = line.match(/\/\/ ─+ (.+?) ─+/);
    if (banner) {
      current = banner[1]!.trim();
      continue;
    }
    const key = entry.exec(line);
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

  lines.push(...problemSection());
  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * The failure vocabulary, rendered from the same registry the server answers with.
 *
 * Generated rather than written, for the reason the whole registry exists: a hand-maintained list
 * of failure types is a list that stops matching the server, and the client keying on it has no way
 * to find out.
 */
function problemSection(): string[] {
  const groups = parseGroups(
    "packages/protocol/src/problems.ts",
    "export const PROBLEM_TYPES",
    /^ {2}(\w+): problem\(/,
  );
  const lines = [
    "## Failures",
    "",
    `Every failure is an RFC 9457 problem document at \`${PROBLEM_MEDIA_TYPE}\`. The \`type\` URI is what a client keys on; \`detail\` is the line a human reads, and \`title\` describes the type rather than the occurrence. The status belongs to the type — a type answerable with two statuses is two types.`,
    "",
    "`error` is emitted as a deprecated alias of `detail` for one release, so a client written against the older shape keeps working. Do not write new readers against it.",
    "",
  ];

  const byGroup = new Map<string, [string, (typeof PROBLEM_TYPES)[keyof typeof PROBLEM_TYPES]][]>();
  for (const [key, declared] of Object.entries(PROBLEM_TYPES)) {
    const group = groups.get(key) ?? "General";
    const bucket = byGroup.get(group) ?? [];
    bucket.push([key, declared]);
    byGroup.set(group, bucket);
  }

  for (const [group, types] of byGroup) {
    lines.push(
      `### ${group}`,
      "",
      "| Name | Status | Type | Title | Extensions |",
      "| --- | --- | --- | --- | --- |",
    );
    for (const [key, declared] of types) {
      const extensions = declared.extensions?.map((e) => `\`${e}\``).join(", ") ?? "—";
      lines.push(
        `| \`${key}\` | ${declared.status} | \`${declared.type}\` | ${cell(declared.title)} | ${extensions} |`,
      );
    }
    lines.push("");
  }
  return lines;
}
