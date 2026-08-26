/**
 * A commit subject that contains a raw `<tag>` DELETES A PACKAGE FROM ITS OWN RELEASE.
 *
 * The path is not obvious, so it is written out here rather than left to be rediscovered:
 *
 * 1. The subject reaches the changelog verbatim, and release-please writes the release pull request
 *    body with it HTML-ESCAPED — `<picture>` becomes `&lt;picture&gt;`. Correct so far.
 * 2. On merge, `Manifest.findMergedReleasePullRequests()` parses that body and immediately
 *    RE-SERIALISES it (`PullRequestBody.parse(...).toString()`) before handing it to
 *    `buildRelease()`. The parse step reads notes out of the DOM as `textContent`, which is DECODED
 *    — so the re-serialised body carries a live `<picture>` element.
 * 3. `buildRelease()` parses that body again. node-html-parser now sees a real, never-closed
 *    `<picture>`, swallows the `</details>` that should have ended the section, and the component's
 *    release notes stop being a `<details>` element of their own.
 * 4. The component is not found in the parsed release data, release-please logs "Pull request contains
 *    releases, but not for component: <name>" and SKIPS IT — no tag, no GitHub release, no npm
 *    publish, exit code 0.
 *
 * `feat(compiler): responsive images — <picture> per format, one owner for loading` did exactly
 * that: `schema` and `starters` silently fell out of three consecutive releases.
 * `@jxsuite/starters` stopped at 1.2.2 on npm while `@jxsuite/create@1.3.2` shipped depending on
 * `^1.5.0`, so `npm install @jxsuite/create` failed to resolve for anyone who tried it. And because
 * an un-tagged component has no "latest release" to measure from, release-please re-proposed it on
 * every subsequent run — which is what made merging a release pull request immediately open another
 * one, forever.
 *
 * The bug is upstream and still present in release-please 17.11.1 (the newest release as of this
 * commit), so the only defence is to keep the text out of the changelog. Backticks do NOT help —
 * the escaping happens on the raw text, and markdown never enters into it.
 *
 * Write the prose instead: "the picture element", `ext/{name}/{kind}/v{n}`, "real th table
 * headers".
 *
 * This file is the single definition. `scripts/check-changelog-safety.ts` imports `findAngleTags`
 * so the CI gate and the local commit hook can never disagree;
 * `scripts/check-changelog-safety.test.ts` tests it.
 *
 * Commitlint loads this file through `cosmiconfig-typescript-loader` (a jiti transpile), and
 * `scripts/check-changelog-safety.ts` loads it through Bun. Neither transpiler typechecks, so the
 * annotations below are proved by `bun run typecheck` — which is why `tsconfig.json` names this
 * file in its `include`. Keep the imports TYPE-ONLY: both loaders would otherwise have to resolve
 * `@commitlint/types` at runtime, and this module is deliberately runtime-dependency-free.
 */

import type { SyncRule, UserConfig } from "@commitlint/types";

/**
 * Anything a browser's HTML parser would treat as a tag: an element (`<picture>`, `</details>`,
 * `<img src="…">`) or a comment opener. Deliberately NOT matched: `a < b`, `->`, `<3` — the
 * character after `<` must start an element name for the round trip to produce an element.
 */
const ANGLE_TAG = /<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?>|<!--/g;

/** Every angle-bracket tag in `text`, in order, with duplicates collapsed. */
export function findAngleTags(text: string | null | undefined): string[] {
  if (!text) {
    return [];
  }
  const matches = text.match(ANGLE_TAG);
  return matches ? [...new Set(matches)] : [];
}

/**
 * A part of a commit message by the name the reports print, since that name is what tells an author
 * which line to amend. Both callers join these with " and ", so they read as prose.
 */
export type ChangelogPart = "subject" | "BREAKING CHANGE";

/** One changelog-bound part of a commit message that carries at least one angle-bracket tag. */
export interface ChangelogUnsafePart {
  /** Where in the message the tags are. */
  part: ChangelogPart;
  /** Every distinct tag found in `text`, in order of first appearance. */
  tags: string[];
  /** The offending text, verbatim, for the report to quote. */
  text: string;
}

/**
 * The parts of a commit message release-please copies into a changelog: the subject line, and the
 * text of any `BREAKING CHANGE:` note. The body is otherwise dropped, so it is not checked — a
 * commit may still explain itself with markup below the fold.
 *
 * @param message A full commit message.
 * @returns One entry per offending part.
 */
export function findChangelogUnsafeParts(message: string): ChangelogUnsafePart[] {
  const lines = message.replaceAll("\r\n", "\n").split("\n");
  const problems: ChangelogUnsafePart[] = [];

  const subject = lines[0] ?? "";
  const subjectTags = findAngleTags(subject);
  if (subjectTags.length > 0) {
    problems.push({ part: "subject", tags: subjectTags, text: subject });
  }

  // A BREAKING CHANGE note runs to the next blank line; release-please reproduces all of it.
  for (let i = 1; i < lines.length; i++) {
    if (!/^BREAKING[ -]CHANGE:/.test(lines[i] ?? "")) {
      continue;
    }
    const note: string[] = [];
    for (let j = i; j < lines.length; j++) {
      const line = lines[j] ?? "";
      if (line.trim() === "") {
        break;
      }
      note.push(line);
    }
    const text = note.join("\n");
    const tags = findAngleTags(text);
    if (tags.length > 0) {
      problems.push({ part: "BREAKING CHANGE", tags, text });
    }
    i += note.length;
  }

  return problems;
}

/** The advice is the same wherever the check fires, so both callers read it from here. */
export function changelogSafetyAdvice(problems: readonly ChangelogUnsafePart[]): string {
  const found = [...new Set(problems.flatMap((p) => p.tags))].join(", ");
  return (
    `contains ${found} — an angle-bracket tag here silently drops the package from its own ` +
    "release (see the header of commitlint.config.ts). Say it in prose, or use braces: " +
    "`ext/{name}/{kind}/v{n}`. Backticks do not help."
  );
}

/**
 * `parsed.raw` is the whole message; `SyncRule` types it as `string | null | undefined` because
 * `Commit` carries its non-standard fields through an index signature.
 */
const changelogSafeAngleBrackets: SyncRule = (parsed) => {
  const problems = findChangelogUnsafeParts(parsed.raw ?? "");
  if (problems.length === 0) {
    return [true, ""];
  }
  const where = problems.map((p) => p.part).join(" and ");
  return [false, `${where} ${changelogSafetyAdvice(problems)}`];
};

const config: UserConfig = {
  extends: ["@commitlint/config-conventional"],
  plugins: [
    {
      rules: {
        "changelog-safe-angle-brackets": changelogSafeAngleBrackets,
      },
    },
  ],
  rules: {
    // An error rather than a warning because the failure it prevents is SILENT: nothing goes
    // Red when it happens, a package simply stops being released. See this file's header.
    "changelog-safe-angle-brackets": [2, "always"],
    "subject-case": [2, "never", ["upper-case"]],
    "subject-empty": [2, "never"],
    "type-empty": [2, "never"],
    "type-enum": [
      2,
      "always",
      [
        "build",
        "chore",
        "ci",
        "docs",
        "feat",
        "fix",
        "perf",
        "refactor",
        "revert",
        "style",
        "test",
      ],
    ],
  },
};

export default config;
