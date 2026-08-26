// The docs sidebar manifest (`docs/nav.json`), and the one walk over it.
//
// The manifest is three levels — section → group → page — because the sidebar folds each group into
// Its own `<details>` and the page paths already carried that level (`studio/design/properties`)
// Long before anything rendered it. Two consumers read the file: `check-doc-refs.ts`, which holds it
// In bijection with `docs/**.md`, and `build-llm-export.ts`, which walks it for `llms.txt` ordering.
//
// They share this module rather than each recursing, because the walk is exactly what went wrong
// When the shape last changed: both loops were `[section, ...section.children]`, and a level neither
// Knew about is invisible rather than loud — a page nested one step deeper would simply stop being
// Checked, and stop being exported, with nothing failing to say so.
//
// **A section's `pages` and `groups` must BOTH be non-empty**, which is the one invariant here that
// Is about the compiler rather than about the docs. A mapped array whose `items` resolve to `[]` is
// Deliberately left in place rather than expanded (compiler.md §8.1, "An empty expansion is not a
// Collapse" — the list may still be populated at runtime), and a surviving repeater makes its node
// Dynamic. So an empty `groups` array would not render as "no groups": it would ship the reactive
// Runtime to every page in that section, for a sidebar that is otherwise pure prerendered HTML.
// That is why the section's own index page lives in `pages` as "Overview" instead of being rendered
// From `section.path`, and why "Start here" — ten pages with no sub-directory at all — is grouped.

import { readFileSync } from "node:fs";

export interface NavPage {
  path: string;
  label: string;
}

/**
 * One disclosure inside a section.
 *
 * A group has no path of its own. It opens when the current page is one of `pages` — exact
 * membership, not a path prefix — which is what lets a group exist without a shared path segment,
 * and what stops `/docs/studio/designer/` from opening the `studio/design` group.
 */
export interface NavGroup {
  label: string;
  pages: NavPage[];
}

export interface NavSection {
  /** The section's index page, and the prefix the sidebar opens the section on. */
  path: string;
  label: string;
  /** The section's own rows, `Overview` (i.e. `path`) first. Never empty — see the header. */
  pages: NavPage[];
  /** The section's disclosures. Never empty — see the header. */
  groups: NavGroup[];
}

export interface Nav {
  id: string;
  sections: NavSection[];
}

/** Whether `path` is `prefix` itself or sits under it — never a sibling that merely starts the same. */
export function isUnder(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** One section's pages, in the order the sidebar draws them: its own rows, then each group's. */
export function sectionPaths(section: NavSection): string[] {
  return [
    ...(section.pages ?? []).map((page) => page.path),
    ...(section.groups ?? []).flatMap((group) => group.pages.map((page) => page.path)),
  ];
}

/** Every page in the corpus, in reading order. */
export function navPaths(nav: Nav): string[] {
  return nav.sections.flatMap(sectionPaths);
}

/** Structural invariants, as human-readable problems. Empty means the manifest is well-formed. */
export function navProblems(nav: Nav): string[] {
  const problems: string[] = [];
  const empty = (what: string, where: string) =>
    `${what} in ${where} is empty — the sidebar's repeater over it would survive the build and ` +
    `make the page dynamic, shipping JS for a sidebar that is otherwise static (see this file's ` +
    `header, and compiler.md §8.1)`;

  for (const section of nav.sections) {
    const pages = section.pages ?? [];
    const groups = section.groups ?? [];

    if (pages.length === 0) {
      problems.push(empty("pages", `section "${section.path}"`));
    } else if (pages[0]!.path !== section.path) {
      problems.push(
        `section "${section.path}" does not lead with its own index page — expected ` +
          `pages[0].path to be "${section.path}", found "${pages[0]!.path}"`,
      );
    }
    if (groups.length === 0) {
      problems.push(empty("groups", `section "${section.path}"`));
    }

    for (const group of groups) {
      if (group.pages.length === 0) {
        problems.push(empty("pages", `group "${group.label}" of section "${section.path}"`));
      }
    }

    for (const path of sectionPaths(section)) {
      if (!isUnder(path, section.path)) {
        problems.push(`nav path "${path}" is not under its section "${section.path}"`);
      }
    }
  }
  return problems;
}

/** Parse the manifest at `path`. */
export function readNav(path: string): Nav {
  return JSON.parse(readFileSync(path, "utf8")) as Nav;
}
