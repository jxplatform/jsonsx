/**
 * Catalog — what THIS backend can offer a project (specs/extensions.md §9.2).
 *
 * The available half of the pair whose enabled half is `buildExtensionsPayload`. Two sources, and
 * the split is the point:
 *
 * 1. The shipped first-party catalogue (`@jxsuite/catalog`), which is data generated from the
 *    `extensions/` tree, so core keeps no dependency on an extension package (§2).
 * 2. The project's own dependencies, scanned for anything exporting a `jx-extension.json`.
 *
 * Both are then annotated with two facts only a backend holds: whether the PROJECT resolves the
 * package, and whether THIS HOST does. Those are probed rather than declared, because what a
 * desktop build stages and what a Worker bundles are different facts and neither is knowable from a
 * package list — which is also why the catalogue is a platform capability instead of a constant.
 *
 * **`installed` is answered here rather than by the client**, because `listPackages` does not mean
 * one thing across backends: the dev server's own packages route drops a declared dependency it
 * cannot resolve under `node_modules`, while desktop's reads the manifest and keeps it. A surface
 * deciding "do I need to install this first?" from that would be right on one backend and wrong on
 * the other.
 *
 * @docs extending/extensions/first-party
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { listCatalog } from "@jxsuite/catalog";
import { buildExtensionRegistry } from "@jxsuite/schema/extension-registry";
import { createNodeFormatIO, probeExtension } from "@jxsuite/compiler/format-host";
import type { ExtensionCatalogEntry, ExtensionSectionInfo } from "@jxsuite/protocol";

/** The well-known manifest filename, mirroring `@jxsuite/schema`'s `EXTENSION_MANIFEST`. */
const MANIFEST = "jx-extension.json";

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  jx?: string;
}

/** Read a project's package.json, or null when it has none or it will not parse. */
function readPackageJson(projectRoot: string): PackageJson | null {
  const path = resolve(projectRoot, "package.json");
  if (!existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PackageJson;
  } catch {
    // A project mid-edit should cost the catalogue its discovered half, not the whole response.
    return null;
  }
}

/** Every dependency name a project declares, runtime and dev alike. */
function declaredDependencies(projectRoot: string): string[] {
  const pkg = readPackageJson(projectRoot);
  return pkg === null
    ? []
    : [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
}

/**
 * Load one extension through the REGISTRY rather than reading its manifest directly.
 *
 * Discovery and enablement then agree by construction: this is the same loader `project.json` will
 * run, so a package that builds here is one that will build there, and a package that throws here
 * throws with the message that names the fix. `FormatEntry`'s constructor is pure data and never
 * imports an implementation module, so this stays JSON reads.
 *
 * @param {string} projectRoot
 * @param {string} name - Bare package specifier
 * @returns {Promise<{ sections; formats; title?; description? } | { problem: string }>}
 */
async function loadEntry(
  projectRoot: string,
  name: string,
): Promise<
  | { description?: string; formats: string[]; sections: ExtensionSectionInfo[]; title?: string }
  | { problem: string }
> {
  try {
    const registry = await buildExtensionRegistry(
      [name],
      createNodeFormatIO(projectRoot),
      resolve(projectRoot, "project.json"),
    );
    const [info] = registry.extensions;
    if (!info) {
      return { problem: `"${name}" did not load as an extension` };
    }
    const sections: ExtensionSectionInfo[] = [];
    const formats = new Set<string>();
    for (const cls of info.classes) {
      if (cls.project) {
        const { key, title } = cls.project;
        sections.push({ key, ...(typeof title === "string" ? { title } : {}) });
      }
      for (const ext of cls.extensions) {
        formats.add(ext);
      }
    }
    return {
      formats: [...formats].toSorted(),
      sections,
      ...(info.manifest.title === undefined ? {} : { title: info.manifest.title }),
      ...(info.manifest.description === undefined
        ? {}
        : { description: info.manifest.description }),
    };
  } catch (error) {
    return { problem: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Whether a package that failed to resolve nonetheless MEANT to be an extension.
 *
 * `"jx"` is not what a host resolves — the registry goes through the exports map and nothing else,
 * which is why the probe is authoritative. But reading it separates "this package got its exports
 * map wrong" from "this package is not an extension", and that is the difference between a silent
 * omission and a row that says what is broken. It is the first job the field has ever had.
 *
 * @param {string} projectRoot
 * @param {string} name
 * @returns {boolean}
 */
function declaresJxField(projectRoot: string, name: string): boolean {
  const path = resolve(projectRoot, "node_modules", name, "package.json");
  if (!existsSync(path)) {
    return false;
  }
  try {
    return typeof (JSON.parse(readFileSync(path, "utf8")) as PackageJson).jx === "string";
  } catch {
    return false;
  }
}

/**
 * The catalogue for one project: the shipped first-party entries, then anything its own
 * dependencies declare.
 *
 * Every first-party entry is returned whether or not the project has it, because the whole purpose
 * is to advertise what could be turned on. A discovered entry is only ever one the project already
 * depends on.
 *
 * @param {string} projectRoot - Absolute path to the project
 * @returns {Promise<ExtensionCatalogEntry[]>}
 */
export async function buildExtensionCatalog(projectRoot: string): Promise<ExtensionCatalogEntry[]> {
  const entries: ExtensionCatalogEntry[] = [];
  const seen = new Set<string>();

  for (const meta of listCatalog()) {
    seen.add(meta.name);
    const found = probeExtension(projectRoot, meta.name);
    entries.push({
      description: meta.description,
      docs: meta.docs,
      installed: found.project,
      name: meta.name,
      sections: meta.sections,
      source: "first-party",
      title: meta.title,
      ...(meta.formats ? { formats: meta.formats } : {}),
      ...(meta.requires ? { requires: meta.requires } : {}),
      // Bundled means "resolves without a project install": the host answers for it, and the
      // Project does not have to.
      ...(found.host && !found.project ? { bundled: true } : {}),
    });
  }

  for (const name of declaredDependencies(projectRoot)) {
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    const found = probeExtension(projectRoot, name);
    if (!found.project) {
      if (declaresJxField(projectRoot, name)) {
        entries.push({
          installed: true,
          name,
          problem:
            `declares "jx" but does not export "./${MANIFEST}", so no host can resolve its ` +
            `manifest — add that entry to its exports map`,
          sections: [],
          source: "project",
        });
      }
      continue;
    }
    const loaded = await loadEntry(projectRoot, name);
    if ("problem" in loaded) {
      entries.push({
        installed: true,
        name,
        problem: loaded.problem,
        sections: [],
        source: "project",
      });
      continue;
    }
    entries.push({
      installed: true,
      name,
      sections: loaded.sections,
      source: "project",
      ...(loaded.title === undefined ? {} : { title: loaded.title }),
      ...(loaded.description === undefined ? {} : { description: loaded.description }),
      ...(loaded.formats.length > 0 ? { formats: loaded.formats } : {}),
      ...(found.host ? { bundled: true } : {}),
    });
  }

  return entries;
}
