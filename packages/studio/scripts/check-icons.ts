/**
 * Every `sp-icon-*` a template names must be a registered element.
 *
 * A custom element the browser has never heard of is not an error. It is an `HTMLUnknownElement`
 * with no shadow root, zero content and no warning — an empty box exactly the size of the gap where
 * the icon should be. Nothing fails: not the type checker (the tag is a string in a template), not
 * the linter, not a single test, because happy-dom is just as content to render nothing as Chrome
 * is. The only way this surfaces is a person looking at the app and noticing an icon is absent.
 *
 * That is how eleven of them shipped. Two were on surfaces you cannot miss — the Problems rail
 * button and the Navigator's dock toggle — and were reported by hand; the other nine had never been
 * mentioned. Three of the eleven named icons **Spectrum does not ship at all**
 * (`sp-icon-git-branch`, `sp-icon-rail-left-open`, `sp-icon-rail-left-close`): the rail pair was
 * written by symmetry with `rail-right-open`/`close`, which do exist, and could never have
 * resolved.
 *
 * So this check asks two questions, and the second is the one a registry alone cannot answer:
 *
 * 1. **Is every tag used in `src/` registered** in `ui/spectrum.ts`? Bare side-effect imports are
 *    tree-shaken by Bun's bundler despite Spectrum's `sideEffects` declaration, which is why that
 *    file registers each element explicitly and why a new icon is easy to forget.
 * 2. **Does every registered element exist in the package?** A row naming a module that is not there
 *    is a build error, so this half is cheap — but it is what turns "I added the row" into "the
 *    icon will render", and it is the half that would have caught the rail pair at the moment
 *    someone typed it.
 *
 * Tags are read from two shapes: `<sp-icon-x>` in a template, and `icon: "sp-icon-x"` on a panel or
 * command record, which is the form the Problems button used.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";

const STUDIO = new URL("..", import.meta.url).pathname;
const MODULES = join(STUDIO, "../../node_modules");

/** `sp-icon-rail-right-open` → `IconRailRightOpen`, the module Spectrum names it by. */
export function elementNameFor(tag: string): string {
  const words = tag.replace(/^sp-icon-/, "").split("-");
  return `Icon${words.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("")}`;
}

/**
 * The class each tag is registered with, and the specifier it was imported from.
 *
 * Read from the import rather than derived from the tag, because the elements come from TWO
 * packages — `icons-workflow` for the app's icons and `icons-ui` for a handful of control glyphs
 * like `IconChevron100`. A check that assumed one of them would report the other's as missing,
 * which is a false alarm about a working icon, and the class this file exists to prevent is the
 * opposite one.
 */
export function iconImports(spectrumSource: string): Map<string, string> {
  const from = new Map<string, string>();
  for (const m of spectrumSource.matchAll(
    /import\s*\{\s*(Icon[A-Za-z0-9]+)\s*\}\s*from\s*"([^"]+)"/g,
  )) {
    from.set(m[1]!, m[2]!);
  }
  return from;
}

/** Every `sp-icon-*` a source file names, mapped to the files that name it. */
export function iconTagsUsed(root: string): Map<string, string[]> {
  const used = new Map<string, string[]>();
  const note = (tag: string, file: string) => {
    const at = used.get(tag);
    if (at) {
      if (!at.includes(file)) {
        at.push(file);
      }
      return;
    }
    used.set(tag, [file]);
  };
  for (const rel of new Glob("**/*.ts").scanSync(root)) {
    const text = readFileSync(join(root, rel), "utf8");
    for (const m of text.matchAll(/<(sp-icon-[a-z0-9-]+)/g)) {
      note(m[1]!, rel);
    }
    for (const m of text.matchAll(/icon:\s*"(sp-icon-[a-z0-9-]+)"/g)) {
      note(m[1]!, rel);
    }
  }
  return used;
}

/** Every tag `ui/spectrum.ts` registers. */
export function iconTagsRegistered(spectrumSource: string): Set<string> {
  return new Set([...spectrumSource.matchAll(/"(sp-icon-[a-z0-9-]+)"/g)].map((m) => m[1]!));
}

/**
 * The two rules, over stated inputs.
 *
 * Pure so a test can hand it a registry that is wrong — the shipped tree is correct by
 * construction, so a checker that only ever reads the real files can never exercise the branch that
 * reports a problem, and the branch that reports a problem is the whole point of it.
 *
 * @param used Tag → the files naming it.
 * @param registered Tags `ui/spectrum.ts` maps to an element.
 * @param imported Element name → the specifier it is imported from.
 * @param installed Whether a specifier resolves to a file on disk.
 */
export function iconProblems(
  used: Map<string, string[]>,
  registered: Set<string>,
  imported: Map<string, string>,
  installed: (specifier: string) => boolean,
): string[] {
  const problems: string[] = [];
  for (const [tag, files] of [...used].toSorted(([a], [b]) => a.localeCompare(b))) {
    if (!registered.has(tag)) {
      problems.push(
        `${tag} is used by ${files.join(", ")} and is not registered in ui/spectrum.ts — ` +
          `it renders as an empty box`,
      );
    }
  }
  for (const tag of [...registered].toSorted()) {
    const element = elementNameFor(tag);
    const specifier = imported.get(element);
    if (!specifier) {
      problems.push(`${tag} maps to ${element}, which ui/spectrum.ts never imports`);
      continue;
    }
    if (!installed(specifier)) {
      problems.push(`${tag} imports ${specifier}, which is not installed`);
    }
  }
  return problems;
}

/**
 * {@link iconProblems}, against the real tree.
 *
 * @returns The problems, and how many distinct icons the tree names — the reporter prints the
 *   second on success, and re-deriving it would walk `src/` twice.
 */
export function checkIcons(): { problems: string[]; iconsUsed: number } {
  const used = iconTagsUsed(join(STUDIO, "src"));
  const source = readFileSync(join(STUDIO, "src/ui/spectrum.ts"), "utf8");
  const registered = iconTagsRegistered(source);
  const imported = iconImports(source);
  const problems = iconProblems(used, registered, imported, (specifier) =>
    existsSync(join(MODULES, specifier)),
  );
  return { problems, iconsUsed: used.size };
}

/**
 * Print the verdict and hand back an exit code — the shape `check-pane-singletons.ts` and
 * `check-styles.ts` use, and for the reason their docstrings give: a function that RETURNS the code
 * is one a test can run, where a `process.exit` inside `import.meta.main` is one nothing can.
 *
 * @returns 0 when every icon resolves, 1 when one does not.
 */
export function report(problems: string[], iconsUsed: number): number {
  if (problems.length > 0) {
    console.error(`\n❌ icons: ${problems.length} problem(s)\n`);
    for (const line of problems) {
      console.error(`   ${line}`);
    }
    console.error(
      "\n   An unregistered custom element is not an error — it is an empty box the size of\n" +
        "   the missing icon. Register it in `src/ui/spectrum.ts`, and check the element name\n" +
        "   exists: Spectrum ships `rail-right-open`/`close` and no left-hand pair.\n",
    );
    return 1;
  }
  console.log(
    `✓ check-icons: ${iconsUsed} icon(s) used, all registered and all shipped by Spectrum.`,
  );
  return 0;
}

if (import.meta.main) {
  const { problems, iconsUsed } = checkIcons();
  process.exit(report(problems, iconsUsed));
}
