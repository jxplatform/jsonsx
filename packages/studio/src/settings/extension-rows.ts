/// <reference lib="dom" />
/**
 * The Extensions row model — what this project could turn on, what it has, and what is on.
 *
 * Its own module because BOTH the section that renders the rows and the commands that act on them
 * need it, and one shared definition is what keeps "what the switch shows" and "what the verb
 * refuses" a single answer. It is also what stops the two forming an import cycle.
 *
 * Three sources, and the split is the point: the catalogue says what is OFFERED, the package list
 * says what is HERE, and `project.json` says what is ON. None can answer for the others, which is
 * why the row carries all three rather than a single "state".
 */

import { getExtensionCatalog, getExtensions } from "../format/format-host";
import { projectState } from "../store";
import type { PackageInfo } from "../types";
import type { ProjectConfig } from "@jxsuite/schema/types";

/** Where a row came from — decides its group heading and whether Remove is offered. */
export type ExtensionOrigin = "catalog" | "installed" | "configured";

/** One rendered row: an offer, its state in this project, and why it may not be actionable. */
export interface ExtensionRow {
  /** Package name — the row key, and what addPackage/removePackage take. */
  name: string;
  /** The string that is (or would be) in `project.json` `extensions[]`. */
  specifier: string;
  title: string;
  description?: string | undefined;
  /** `project.json` keys this extension owns. */
  sections: string[];
  origin: ExtensionOrigin;
  enabled: boolean;
  installed: boolean;
  /** The host resolves it without a project install, so enabling is a config write alone. */
  bundled: boolean;
  /** Why this backend cannot run it, as one sentence. Absent means it can. */
  unavailable?: string | undefined;
  /** Enabled but not installed — the state that fails the next build. */
  broken: boolean;
}

/** The live project configuration, or an empty one before a project is open. */
export function projectConfig(): ProjectConfig {
  return (projectState?.projectConfig ?? {}) as ProjectConfig;
}

/** The specifiers `project.json` currently enables. */
export function enabledSpecifiers(): string[] {
  return projectConfig().extensions ?? [];
}

/**
 * Compose the rows.
 *
 * `sections` for an ENABLED row comes from the extensions payload, because the backend resolved
 * that one for real; for an offer it comes from the catalogue, which is the only source that can
 * describe a package the project has not installed yet.
 *
 * @param {PackageInfo[] | null} packages - The project's dependencies, when they have been read
 * @returns {ExtensionRow[]}
 */
export function buildRows(packages: PackageInfo[] | null = null): ExtensionRow[] {
  const enabled = new Set(enabledSpecifiers());
  const installed = new Set((packages ?? []).map((p) => p.name));
  const resolved = new Map(getExtensions().map((e) => [e.name, e]));
  const rows: ExtensionRow[] = [];

  for (const entry of getExtensionCatalog()) {
    const specifier = entry.specifier ?? entry.name;
    const here = entry.installed ?? installed.has(entry.name);
    const bundled = entry.bundled ?? false;
    const info = resolved.get(entry.name);
    rows.push({
      broken: enabled.has(specifier) && !here && !bundled,
      bundled,
      enabled: enabled.has(specifier),
      installed: here,
      name: entry.name,
      origin: entry.source === "first-party" ? "catalog" : "installed",
      sections: info
        ? info.contributions.map((c) => c.project.key)
        : entry.sections.map((s) => s.key),
      specifier,
      title: entry.title ?? entry.name,
      ...(entry.description === undefined ? {} : { description: entry.description }),
      ...(entry.problem === undefined ? {} : { unavailable: entry.problem }),
    });
  }

  // Anything project.json names that the backend did not describe. It can still be turned OFF,
  // Which is what matters most for exactly the rows nothing can explain.
  for (const specifier of enabled) {
    if (rows.some((row) => row.specifier === specifier)) {
      continue;
    }
    const info = resolved.get(specifier);
    rows.push({
      broken: !installed.has(specifier) && info === undefined,
      bundled: false,
      enabled: true,
      installed: installed.has(specifier),
      name: specifier,
      origin: "configured",
      sections: info ? info.contributions.map((c) => c.project.key) : [],
      specifier,
      title: info?.title ?? specifier,
      ...(info?.description === undefined ? {} : { description: info.description }),
    });
  }

  return rows;
}
