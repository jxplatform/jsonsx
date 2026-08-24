/**
 * An icon that reaches no DOM, in each of the two ways this codebase can produce one.
 *
 * There are TWO key spaces here and they fail differently. Conflating them is not a hypothetical
 * mistake: the first version of this checker made it, passed, and certified a rail button that
 * renders a 20px hole.
 *
 * 1. **A tag written in a template** — `<sp-icon-x>` — resolves through `customElements`. An element
 *    the browser has never heard of is an `HTMLUnknownElement`: no shadow root, no content and no
 *    warning. The type checker is silent (the tag is a string in a template), the linter is silent,
 *    and happy-dom is as content to render nothing as Chrome is, so a test asserting
 *    `querySelector("sp-icon-x")` is not null PASSES while the icon draws nothing. Eleven shipped
 *    that way. Three named elements Spectrum has no such thing as.
 * 2. **A key on a record** — `icon: "sp-icon-x"` — resolves through a RESOLVER MAP, and never reaches
 *    `customElements` at all. `PanelRecord.icon` goes to `activity-bar.ts`'s `tabIcon()`, whose
 *    tail is `return fn ? fn(size || "s") : nothing`. A key with no row is not a missing element;
 *    it is zero nodes. Registering the element does nothing, because nothing ever constructs the
 *    tag.
 *
 * **The rule that decides which check applies is the SHAPE, not the string.** Both spaces are
 * spelled `sp-icon-*`, and one of the map's own rows — `sp-icon-git-branch` — is not a Spectrum
 * element at all but a hand-drawn inline `<svg>`, because the workflow set ships no Git family. A
 * checker that read that key as a tag would call a working, pixel-perfect glyph broken, and
 * "correcting" it to a real Spectrum name is exactly how a working icon gets deleted.
 *
 * So: tags are checked against the element registry, keys are checked against their resolver, and
 * the resolver that matters most is the one whose miss is SILENT. `commandIcon()` falls back to the
 * command's title, so a miss there degrades visibly and is a judgement call; `tabIcon()` falls back
 * to nothing, so a miss there is invisible and is a defect. Only the silent one is enforced.
 *
 * A dead ROW is checked too, and for a reason the git-branch regression demonstrated: the orphaned
 * row stayed behind and `tests/activity-bar.test.ts` went on exercising it, so the suite proved a
 * glyph rendered while the shipped panel pointed at a key nothing handled.
 */

import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";

const STUDIO = fileURLToPath(new URL("..", import.meta.url));
const MODULES = join(STUDIO, "../../node_modules");

/**
 * Registered elements no template of ours writes — a RATCHETING allow-list, the same idiom
 * `check-styles.ts` uses for its orphan classes, and for a sharper reason than tidiness.
 *
 * This cannot be a hard rule, because a registration is not always for our own markup: Spectrum
 * components register icons into their OWN shadow DOM. `sp-icon-chevron100` is imported by
 * `@spectrum-web-components/picker`'s `Picker.js` — deleting that row on the evidence that no
 * template of ours writes it would break every picker in the app, which is precisely the shape of
 * mistake this whole file exists to stop making. So the list is seeded with what is here today and
 * may only shrink: a NEW orphan is a failure, an old one is a debt with a name.
 *
 * Retiring one is a two-line change — delete the registry row and delete it here — but check first
 * whether an `sp-*` component imports it.
 */
const UNWRITTEN = new Set([
  "sp-icon-artboard",
  "sp-icon-brush",
  "sp-icon-chat",
  "sp-icon-checkmark",
  "sp-icon-chevron100",
  "sp-icon-copy",
  "sp-icon-distribute-bottom-edge",
  "sp-icon-distribute-space-vert",
  "sp-icon-distribute-top-edge",
  "sp-icon-file-single-web-page",
  "sp-icon-full-screen",
  "sp-icon-info",
  "sp-icon-preview",
  "sp-icon-properties",
  "sp-icon-view-list",
  "sp-icon-visibility",
]);

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

/**
 * Every `sp-icon-*` TAG a template writes, mapped to the files that write it.
 *
 * Only the `<sp-icon-x` shape. A quoted `"sp-icon-x"` is a resolver key and belongs to
 * {@link iconKeysDeclared} — reading it here is the conflation this file exists to prevent.
 */
export function iconTagsUsed(root: string): Map<string, string[]> {
  const used = new Map<string, string[]>();
  for (const rel of new Glob("**/*.ts").scanSync(root)) {
    const text = readFileSync(join(root, rel), "utf8");
    for (const m of text.matchAll(/<(sp-icon-[a-z0-9-]+)/g)) {
      const at = used.get(m[1]!);
      if (at) {
        if (!at.includes(rel)) {
          at.push(rel);
        }
        continue;
      }
      used.set(m[1]!, [rel]);
    }
  }
  return used;
}

/** Every tag `ui/spectrum.ts` registers as an element. */
export function iconTagsRegistered(spectrumSource: string): Set<string> {
  return new Set([...spectrumSource.matchAll(/\["(sp-icon-[a-z0-9-]+)",/g)].map((m) => m[1]!));
}

/**
 * The keys `tabIcon()` has a row for.
 *
 * Scoped to the function body rather than the file, so a tag appearing in a row's VALUE — which is
 * what a row is made of — is never mistaken for a second key.
 */
export function resolverKeys(activityBarSource: string): Set<string> {
  const start = activityBarSource.indexOf("export function tabIcon");
  if (start === -1) {
    throw new Error("check-icons: activity-bar.ts no longer exports tabIcon — update this check");
  }
  const body = activityBarSource.slice(start, activityBarSource.indexOf("\n}", start));
  return new Set([...body.matchAll(/"(sp-icon-[a-z0-9-]+)":/g)].map((m) => m[1]!));
}

/**
 * Every `icon:` key a **panel record** declares, mapped to where it is declared.
 *
 * Scoped to `registerPanel(` calls that are ON the rail, because those are the only records whose
 * icon reaches `tabIcon()` — `railButton()` is its one caller. A command record's `icon` goes to
 * `commandIcon()`, which falls back to the title; a settings section's is documented as reserved
 * and read by nobody. Neither is silent, so neither is enforced here, and sweeping them in is what
 * inflated the first version's count to 83 icons "all registered" while three rail buttons drew
 * nothing.
 */
export function iconKeysDeclared(root: string): Map<string, string> {
  const declared = new Map<string, string>();
  for (const rel of new Glob("**/*.ts").scanSync(root)) {
    const text = readFileSync(join(root, rel), "utf8");
    for (const call of text.matchAll(/registerPanel\(\{/g)) {
      const open = call.index! + call[0].length - 1;
      let depth = 0;
      let end = open;
      for (let i = open; i < text.length; i += 1) {
        if (text[i] === "{") {
          depth += 1;
        } else if (text[i] === "}") {
          depth -= 1;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      const record = text.slice(open, end);
      // `rail: false` means no button, and `railButton()` is `tabIcon`'s only caller — so an icon
      // On an off-rail panel reaches nothing at all, and demanding a row for it would be demanding
      // A row that can never run. Insert, State, Logic and Activity are all reachable by name
      // Instead of by number, which is the point of the flag.
      if (/\brail:\s*false/.test(record)) {
        continue;
      }
      const icon = /\bicon:\s*"(sp-icon-[a-z0-9-]+)"/.exec(record);
      if (icon) {
        const line = text.slice(0, open + icon.index!).split("\n").length;
        declared.set(icon[1]!, `${rel}:${line}`);
      }
    }
  }
  return declared;
}

/**
 * The three rules, over stated inputs.
 *
 * Pure so a test can hand it a registry that is wrong — the shipped tree is correct by
 * construction, so a checker that only ever reads the real files can never exercise the branch that
 * reports a problem, and the branch that reports a problem is the whole point of it.
 */
export function iconProblems(input: {
  /** Tag → the files writing `<tag`. */
  tags: Map<string, string[]>;
  /** Tags `ui/spectrum.ts` maps to an element. */
  registered: Set<string>;
  /** Element name → the specifier it is imported from. */
  imported: Map<string, string>;
  /** Keys `tabIcon()` has a row for. */
  rows: Set<string>;
  /** Panel-record key → where it is declared. */
  keys: Map<string, string>;
  /** Whether a specifier resolves to a file on disk. */
  installed: (specifier: string) => boolean;
}): string[] {
  const { imported, installed, keys, registered, rows, tags } = input;
  const problems: string[] = [];

  for (const [tag, files] of [...tags].toSorted(([a], [b]) => a.localeCompare(b))) {
    if (!registered.has(tag)) {
      problems.push(
        `<${tag}> is written by ${files.join(", ")} and ui/spectrum.ts registers no such ` +
          `element — it renders as an empty box`,
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
    if (!tags.has(tag) && !UNWRITTEN.has(tag)) {
      problems.push(
        `${tag} is registered as an element and no template writes <${tag}> — delete the row, ` +
          `or add the tag to UNWRITTEN in this file with the component that needs it`,
      );
    }
  }

  for (const [key, where] of [...keys].toSorted(([a], [b]) => a.localeCompare(b))) {
    if (!rows.has(key)) {
      problems.push(
        `${where} declares icon "${key}" and tabIcon() has no row for it — the rail button ` +
          `renders NOTHING (registering the element does not help; the tag is never constructed)`,
      );
    }
  }

  for (const row of [...rows].toSorted()) {
    if (!keys.has(row)) {
      problems.push(
        `tabIcon() has a row for "${row}" and no RAIL panel declares it — a dead row is what lets ` +
          `a test go on proving a glyph renders while the shipped panel points elsewhere`,
      );
    }
  }

  return problems;
}

/**
 * {@link iconProblems}, against the real tree.
 *
 * @returns The problems, plus the two counts the reporter prints on success.
 */
export function checkIcons(): { problems: string[]; tagCount: number; keyCount: number } {
  const src = join(STUDIO, "src");
  const tags = iconTagsUsed(src);
  const keys = iconKeysDeclared(src);
  const spectrum = readFileSync(join(src, "ui/spectrum.ts"), "utf8");
  const activityBar = readFileSync(join(src, "panels/activity-bar.ts"), "utf8");
  const problems = iconProblems({
    imported: iconImports(spectrum),
    installed: (specifier) => existsSync(join(MODULES, specifier)),
    keys,
    registered: iconTagsRegistered(spectrum),
    rows: resolverKeys(activityBar),
    tags,
  });
  return { keyCount: keys.size, problems, tagCount: tags.size };
}

/**
 * Print the verdict and hand back an exit code — the shape `check-pane-singletons.ts` and
 * `check-styles.ts` use, and for the reason their docstrings give: a function that RETURNS the code
 * is one a test can run, where a `process.exit` inside `import.meta.main` is one nothing can.
 *
 * @returns 0 when every icon reaches the DOM, 1 when one does not.
 */
export function report(problems: string[], tagCount: number, keyCount: number): number {
  if (problems.length > 0) {
    console.error(`\n❌ icons: ${problems.length} problem(s)\n`);
    for (const line of problems) {
      console.error(`   ${line}`);
    }
    console.error(
      "\n   Two key spaces, two fixes. A TAG (`<sp-icon-x>`) needs a row in `src/ui/spectrum.ts`,\n" +
        "   and the element has to be one Spectrum ships — it has `rail-right-open`/`close` and no\n" +
        '   left-hand pair, and no Git family at all. A KEY (`icon: "sp-icon-x"` on a panel record)\n' +
        "   needs a row in `tabIcon()` in `src/panels/activity-bar.ts`; registering the element does\n" +
        "   NOT help, because a key that misses returns `nothing` before any tag is constructed.\n",
    );
    return 1;
  }
  console.log(
    `✓ check-icons: ${tagCount} tag(s) registered and shipped, ${keyCount} panel key(s) resolved.`,
  );
  return 0;
}

if (import.meta.main) {
  const { keyCount, problems, tagCount } = checkIcons();
  const code = report(problems, tagCount, keyCount);
  process.exit(code);
}
