/**
 * Elements.ts — what belongs in a document's (or a project's) `$elements`, decided once.
 *
 * `$elements` is the list of component modules a document may use. Three surfaces wrote it, each
 * with its own idea of what "already imported" means, and plan §11.2 names all three: the Packages
 * panel's cherry-pick checkboxes, its "Add component…" picker, and the automatic push when a
 * component is dropped on the canvas. "One `enableElement()` / `disableElement()` service behind
 * all three. Today the same array is written three ways with no shared UI and no shared
 * validation."
 *
 * They really did disagree. The canvas drop matched a local component by `ref.endsWith(basename)`,
 * so `./components/card.json` counted `./vendor/card.json` as already imported and the drop
 * silently produced an element the page could not resolve. The picker checked nothing at all and
 * pushed a duplicate `$ref` every time you chose the same component twice. Only the checkbox knew
 * that a legacy full-package entry (`@acme/ui`) satisfies a cherry-picked one (`@acme/ui/card`), so
 * enabling one component through the picker left the package-wide import beside it.
 *
 * **Pure functions over the array.** They return the new list rather than writing it, because the
 * two levels persist differently and genuinely should: a document's `$elements` goes through
 * `transact` and is undoable, and the project's goes through `updateSiteConfig` and is not. What
 * they must not differ on is WHICH entries the list should hold.
 */

import { computeRelativePath } from "./components";
import type { ComponentEntry } from "./components";
import type { JxElement } from "@jxsuite/schema/types";

/** One `$elements` entry: an npm specifier, or a `$ref` to a file in this project. */
export type ElementsEntry = string | JxElement | { $ref: string };

/** The `$ref` of an entry, when it has one. */
function refOf(entry: ElementsEntry): string | null {
  return typeof entry === "object" && entry !== null && typeof entry.$ref === "string"
    ? entry.$ref
    : null;
}

/**
 * The npm specifier a component is imported by — its cherry-picked subpath, or the bare package.
 *
 * `null` for a project-local component, which is imported by path instead.
 */
export function npmSpecifier(comp: ComponentEntry): string | null {
  if (comp.source !== "npm" || !comp.package) {
    return null;
  }
  return comp.modulePath ? `${comp.package}/${comp.modulePath}` : comp.package;
}

/**
 * The entry that imports `comp` into a document at `fromPath`.
 *
 * `null` when the component can be named neither way — an npm entry with no package, or a local one
 * with no path — which is a registry the caller should not be writing from.
 */
export function elementsEntryFor(
  comp: ComponentEntry,
  fromPath: string | null,
): ElementsEntry | null {
  const specifier = npmSpecifier(comp);
  if (specifier) {
    return specifier;
  }
  return comp.path ? { $ref: computeRelativePath(fromPath, comp.path) } : null;
}

/**
 * Is `comp` already imported by this list?
 *
 * ONE rule, and it is the union of what the three call sites each knew separately:
 *
 * - An npm component matches its cherry-picked specifier **or** a legacy whole-package entry;
 * - A local component matches a `$ref` that resolves to the same file, compared on the resolved path
 *   rather than on its last segment — `endsWith("card.json")` called two different cards the same
 *   component, and the drop that trusted it produced an unresolvable element.
 */
export function hasElement(
  elements: readonly ElementsEntry[],
  comp: ComponentEntry,
  fromPath: string | null,
): boolean {
  const specifier = npmSpecifier(comp);
  if (specifier) {
    return elements.some(
      (entry) => typeof entry === "string" && (entry === specifier || entry === comp.package),
    );
  }
  if (!comp.path) {
    return false;
  }
  const wanted = normalizeRef(computeRelativePath(fromPath, comp.path));
  return elements.some((entry) => {
    const ref = refOf(entry);
    return ref !== null && normalizeRef(ref) === wanted;
  });
}

/** A `$ref` reduced to a comparable form: `./a/b.json`, `a/b.json` and `././a/b.json` are one file. */
function normalizeRef(ref: string): string {
  return ref.replace(/^(?:\.\/)+/, "");
}

/**
 * Import `comp`, and return the new list. Idempotent, and it drops what the new entry supersedes.
 *
 * Enabling a cherry-picked npm component removes the whole-package entry it replaces — otherwise
 * the page keeps pulling in every component of that package while the panel shows one ticked.
 */
export function enableElement(
  elements: readonly ElementsEntry[],
  comp: ComponentEntry,
  fromPath: string | null,
): ElementsEntry[] {
  const entry = elementsEntryFor(comp, fromPath);
  if (!entry) {
    return [...elements];
  }
  const specifier = npmSpecifier(comp);
  // The legacy whole-package import goes when a cherry-picked one arrives — but never when the
  // Component IS the package (`modulePath` absent), where the two are the same entry.
  const kept =
    specifier && comp.modulePath ? elements.filter((e) => e !== comp.package) : [...elements];
  return hasElement(kept, comp, fromPath) ? kept : [...kept, entry];
}

/** Remove `comp`'s import, and return the new list. Idempotent. */
export function disableElement(
  elements: readonly ElementsEntry[],
  comp: ComponentEntry,
  fromPath: string | null,
): ElementsEntry[] {
  const specifier = npmSpecifier(comp);
  if (specifier) {
    // Both spellings: a component ticked off must not stay imported through the package entry.
    return elements.filter(
      (entry) => !(typeof entry === "string" && (entry === specifier || entry === comp.package)),
    );
  }
  if (!comp.path) {
    return [...elements];
  }
  const wanted = normalizeRef(computeRelativePath(fromPath, comp.path));
  return elements.filter((entry) => {
    const ref = refOf(entry);
    return ref === null || normalizeRef(ref) !== wanted;
  });
}

/** Remove every entry belonging to `pkg` — what uninstalling a package leaves behind. */
export function removePackageElements(
  elements: readonly ElementsEntry[],
  pkg: string,
): ElementsEntry[] {
  return elements.filter(
    (entry) => typeof entry !== "string" || !(entry === pkg || entry.startsWith(`${pkg}/`)),
  );
}

/** Remove the entry naming `ref` exactly — the Packages panel's per-row × on a local import. */
export function removeElementRef(elements: readonly ElementsEntry[], ref: string): ElementsEntry[] {
  const wanted = normalizeRef(ref);
  return elements.filter((entry) => {
    const found = refOf(entry);
    return found === null || normalizeRef(found) !== wanted;
  });
}
