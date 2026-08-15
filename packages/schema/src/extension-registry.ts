/**
 * Extension registry — manifest-driven discovery of extension packages (specs/extensions.md).
 *
 * A project declares extensions in project.json (`"extensions": ["@jxsuite/parser", ...]`); each
 * extension package ships a `jx-extension.json` manifest enumerating its classes and schema
 * fragments. Hosts resolve `<specifier>/jx-extension.json` (bare specifiers through the package's
 * exports map, project-first), read each listed `.class.json`, and dispatch through the declared
 * admission blocks (`format` | `project` | `server` | `connector`) and capability roles.
 *
 * All I/O is injected via FormatHostIO so the same module serves node and browser hosts. The
 * format-dispatch view reuses FormatRegistry (including its extension/capability conflict checks).
 */

import { FormatEntry, FormatRegistry } from "./format-registry";
import type { FormatHostIO } from "./format-registry";

export type {
  CapabilityInfo,
  ConnectorBlock,
  ExtensionCapability,
  FormatHostIO,
  ProjectBlock,
  ServerBlock,
} from "./format-registry";
export { EXTENSION_CAPABILITIES, FormatEntry, FormatRegistry } from "./format-registry";

/** The well-known manifest filename every extension package exports. */
export const EXTENSION_MANIFEST = "jx-extension.json";

export interface ExtensionManifest {
  name: string;
  title?: string;
  description?: string;
  classes?: Record<string, string>;
  /**
   * Schema fragments the package contributes: `project` (project.json sections), `document` ($paths
   * shapes), and `fields` — a fragment whose `$defs` members are unioned into the per-project
   * field-schema resource (extension field extras, specs/extensions.md §5.3).
   */
  schemas?: { project?: string; document?: string; fields?: string };
}

export interface ExtensionInfo {
  /** The project.json `extensions` entry that produced this extension. */
  specifier: string;
  /** Resolved absolute path of the jx-extension.json manifest. */
  manifestPath: string;
  manifest: ExtensionManifest;
  /** Class entries in manifest order. */
  classes: FormatEntry[];
  /** Resolved absolute fragment paths, when the manifest declares them. */
  schemas: { project?: string; document?: string; fields?: string };
}

export type SchemaFragmentKind = "project" | "document" | "fields";

export class ExtensionRegistry {
  #extensions: ExtensionInfo[];
  #classes: FormatEntry[];
  #formats: FormatRegistry;

  constructor(extensions: ExtensionInfo[]) {
    this.#extensions = extensions;
    this.#classes = extensions.flatMap((e) => e.classes);

    // Class names are the $prototype-visible namespace: duplicates across extensions are a
    // Configuration error (a project-local `imports` entry may still shadow a manifest class —
    // That overlay happens at the host, not here).
    const byName = new Map<string, string>();
    for (const ext of extensions) {
      for (const cls of ext.classes) {
        const prior = byName.get(cls.name);
        if (prior && prior !== ext.specifier) {
          throw new Error(
            `Extension conflict: "${prior}" and "${ext.specifier}" both provide a class named "${cls.name}"`,
          );
        }
        byName.set(cls.name, ext.specifier);
      }
    }

    // Section keys are exclusive (specs/extensions.md §3.1).
    const byKey = new Map<string, FormatEntry>();
    for (const entry of this.#classes) {
      if (!entry.project) {
        continue;
      }
      const prior = byKey.get(entry.project.key);
      if (prior) {
        throw new Error(
          `Extension conflict: "${prior.name}" and "${entry.name}" both claim the project section "${entry.project.key}"`,
        );
      }
      byKey.set(entry.project.key, entry);
    }

    // Server mounts own disjoint /_jx/ subtrees (specs/extensions.md §11).
    const byBasePath = new Map<string, FormatEntry>();
    for (const entry of this.#classes) {
      if (!entry.server) {
        continue;
      }
      const { basePath } = entry.server;
      if (!basePath.startsWith("/_jx/")) {
        throw new Error(
          `Extension "${entry.name}": server basePath "${basePath}" must be under /_jx/`,
        );
      }
      const prior = byBasePath.get(basePath);
      if (prior) {
        throw new Error(
          `Extension conflict: "${prior.name}" and "${entry.name}" both mount "${basePath}"`,
        );
      }
      byBasePath.set(basePath, entry);
    }

    // The format-dispatch view; its constructor enforces (extension, capability) exclusivity.
    this.#formats = new FormatRegistry(this.#classes.filter((e) => e.extensions.length > 0));
  }

  get extensions(): readonly ExtensionInfo[] {
    return this.#extensions;
  }

  /** Every class entry across all extensions, in declaration order. */
  get classes(): readonly FormatEntry[] {
    return this.#classes;
  }

  /** File-extension dispatch view (parse/serialize/discover/load lookups). */
  get formats(): FormatRegistry {
    return this.#formats;
  }

  byName(name: string): FormatEntry | undefined {
    return this.#classes.find((e) => e.name === name);
  }

  /** Classes owning a project.json section, in declaration order. */
  projectContributions(): FormatEntry[] {
    return this.#classes.filter((e) => e.project !== null);
  }

  byProjectKey(key: string): FormatEntry | undefined {
    return this.#classes.find((e) => e.project?.key === key);
  }

  /** The class whose `resolvePaths` capability declares this `$paths` discriminator key. */
  byPathsDiscriminator(key: string): FormatEntry | undefined {
    return this.#classes.find((e) => e.capabilities.resolvePaths?.discriminator === key);
  }

  /** Classes declaring an `emit` capability (build-time asset emission), in declaration order. */
  emitters(): FormatEntry[] {
    return this.#classes.filter((e) => e.capabilities.emit !== undefined);
  }

  /**
   * Classes declaring a `head` capability (§8.6), in declaration order.
   *
   * Separate from `emit` because the two answer different questions at different times: `emit`
   * derives files from loaded content and runs long after every page was written, while `head`
   * derives `<head>` entries from CONFIGURATION and must run before the first page is built. A feed
   * needs both — the file from `emit`, the `<link rel="alternate">` from here.
   */
  headProviders(): FormatEntry[] {
    return this.#classes.filter((e) => e.capabilities.head !== undefined);
  }

  /** Classes declaring an `assets` capability (static asset mounts, §8.5), in declaration order. */
  assetProviders(): FormatEntry[] {
    return this.#classes.filter((e) => e.capabilities.assets !== undefined);
  }

  /** Server-mount classes, sorted by `server.order` (ascending; default 100), then name. */
  serverMounts(): FormatEntry[] {
    return this.#classes
      .filter((e) => e.server !== null)
      .toSorted(
        (a, b) =>
          (a.server?.order ?? 100) - (b.server?.order ?? 100) || a.name.localeCompare(b.name),
      );
  }

  /** Connection-provider classes (connector block). */
  connectors(): FormatEntry[] {
    return this.#classes.filter((e) => e.connector !== null);
  }

  /** Resolved fragment paths of the given kind, in extension declaration order. */
  schemaFragments(kind: SchemaFragmentKind): string[] {
    return this.#extensions
      .map((e) => e.schemas[kind])
      .filter((p): p is string => typeof p === "string");
  }
}

/**
 * Build a registry from a project's `extensions` list.
 *
 * Specifiers are bare package names (resolved project-first through the package's exports map) or
 * relative paths. Unlike the legacy imports scan, everything here is explicit — an unresolvable
 * manifest or class file is an error, not a silent skip.
 *
 * @param {string[] | undefined} extensions - The project.json `extensions` array
 * @param {FormatHostIO} io - Injected host I/O
 * @param {string} base - Reference file for relative resolution (convention: `<root>/project.json`)
 */
export async function buildExtensionRegistry(
  extensions: string[] | undefined,
  io: FormatHostIO,
  base: string,
): Promise<ExtensionRegistry> {
  const infos: ExtensionInfo[] = [];
  for (const specifier of extensions ?? []) {
    infos.push(await loadExtension(specifier, io, base));
  }
  return new ExtensionRegistry(infos);
}

async function loadExtension(
  specifier: string,
  io: FormatHostIO,
  base: string,
): Promise<ExtensionInfo> {
  let manifestPath: string;
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const dir = io.resolvePath(base, specifier);
    manifestPath = io.resolvePath(`${dir}/package.json`, `./${EXTENSION_MANIFEST}`);
  } else {
    try {
      manifestPath = io.resolvePath(base, `${specifier}/${EXTENSION_MANIFEST}`);
    } catch (error) {
      throw new Error(
        `Extension "${specifier}" is not resolvable: it must export ${EXTENSION_MANIFEST} ` +
          `(is the package installed, and does its exports map include it?): ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  let manifest: ExtensionManifest;
  try {
    manifest = (await io.loadJson(manifestPath)) as unknown as ExtensionManifest;
  } catch (error) {
    throw new Error(
      `Extension "${specifier}": cannot read manifest ${manifestPath}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  if (!manifest || typeof manifest !== "object" || typeof manifest.name !== "string") {
    throw new Error(`Extension "${specifier}": ${EXTENSION_MANIFEST} must declare a "name"`);
  }
  if (!specifier.startsWith(".") && manifest.name !== specifier) {
    throw new Error(
      `Extension "${specifier}": manifest name "${manifest.name}" does not match the specifier`,
    );
  }

  const classes: FormatEntry[] = [];
  for (const [name, ref] of Object.entries(manifest.classes ?? {})) {
    const classPath = io.resolvePath(manifestPath, ref);
    let classDef: Record<string, unknown>;
    try {
      classDef = await io.loadJson(classPath);
    } catch (error) {
      throw new Error(
        `Extension "${specifier}": cannot read class "${name}" at ${classPath}: ${errorMessage(error)}`,
        { cause: error },
      );
    }
    classes.push(new FormatEntry(name, classPath, classDef, io));
  }

  const schemas: ExtensionInfo["schemas"] = {};
  if (manifest.schemas?.project) {
    schemas.project = io.resolvePath(manifestPath, manifest.schemas.project);
  }
  if (manifest.schemas?.document) {
    schemas.document = io.resolvePath(manifestPath, manifest.schemas.document);
  }
  if (manifest.schemas?.fields) {
    schemas.fields = io.resolvePath(manifestPath, manifest.schemas.fields);
  }

  return { specifier, manifestPath, manifest, classes, schemas };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
