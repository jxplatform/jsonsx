/**
 * "Does this file's markup have a stylesheet?" — the orphan rule of `scripts/check-styles.ts`,
 * asked of ONE source file instead of the whole tree.
 *
 * The gate itself reports a count over `src/**` and a ratcheting allow-list, which is the right
 * shape for CI and the wrong shape for a panel's own test file: it cannot say _which_ surface
 * regressed, and it stays green while a specific panel goes back to inline `style=` attributes as
 * long as the new name is added to the list. A per-file question fails in the PR that reintroduces
 * it, names the class, and needs no allow-list of its own.
 *
 * Both extractors are the gate's, so "emitted" and "defined" mean exactly what CI means by them.
 */
import { Glob } from "bun";
import { join } from "node:path";
import {
  ALLOWED_ORPHANS,
  extractDefinedClasses,
  extractEmittedClasses,
} from "../scripts/check-styles";

const ROOT = join(import.meta.dir, "..");

/**
 * Every class name any `styles/*.css` file defines a rule for.
 *
 * Narrower than the gate on purpose: `index.html`'s `<style>` block and the CSS templates injected
 * into the canvas iframe from `src/` also count as definitions there, and neither is where a
 * panel's chrome belongs. A caller of this module is asking about a panel.
 */
async function definedClasses(): Promise<Set<string>> {
  const out = new Set<string>();
  for await (const rel of new Glob("styles/*.css").scan(ROOT)) {
    for (const name of extractDefinedClasses(await Bun.file(join(ROOT, rel)).text())) {
      out.add(name);
    }
  }
  return out;
}

/**
 * Class names `rel` puts in the DOM that no stylesheet defines — allow-listed ones included, so a
 * caller sees a name it is responsible for even while the gate is still tolerating it.
 *
 * @param rel Package-relative path, e.g. `src/panels/statement-editor.ts`.
 */
export async function unstyledClassesOf(rel: string): Promise<string[]> {
  const defined = await definedClasses();
  const source = await Bun.file(join(ROOT, rel)).text();
  return [...extractEmittedClasses(source).keys()]
    .filter((name) => !defined.has(name) && !ALLOWED_ORPHANS.has(name))
    .toSorted();
}

/** Every class name `rel` puts in the DOM — the set of elements it is answerable for. */
export async function emittedClassesOf(rel: string): Promise<Set<string>> {
  const source = await Bun.file(join(ROOT, rel)).text();
  return new Set(extractEmittedClasses(source).keys());
}

/**
 * Elements under `root` that {@link emittedClassesOf} names AND that carry an inline `style`.
 *
 * The point of the sweep: an inline attribute outranks every stylesheet rule, so one left behind is
 * a rule in `styles/*.css` that silently does nothing. Rendered as `tag[declarations]` strings
 * because a failure has to say WHICH element and WHAT it declares — an element count does not
 * survive being read six months later. Elements another module renders into the same subtree
 * (`ui/field-row.ts`'s rows, `ui/formula-chips.ts`'s chips) are not this file's to answer for.
 */
export function inlineStyledOwn(root: ParentNode, own: Set<string>): string[] {
  return [...root.querySelectorAll("[style]")]
    .filter((el) => [...el.classList].some((name) => own.has(name)))
    .map((el) => `${el.tagName.toLowerCase()}[${el.getAttribute("style")}]`);
}
