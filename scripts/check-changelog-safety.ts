/**
 * The CI half of the changelog-safety gate. The rule, the reasoning, and the failure it prevents
 * are all in `commitlint.config.ts` — read that first; this file only applies it to a commit
 * range.
 *
 * Both halves exist because they fail at different moments and neither covers the other:
 *
 * - `.husky/commit-msg` runs commitlint as you commit. It is the fast feedback, and it is BYPASSABLE
 *   (`--no-verify`), which is how `feat(compiler): responsive images — <picture> …` reached `main`
 *   in the first place and quietly deleted `schema` and `starters` from three consecutive
 *   releases.
 * - This runs in the `checks` job over the pull request's own commits, where nothing can skip it.
 *
 * It reads the rule from `commitlint.config.ts` rather than restating it, so the hook and the gate
 * cannot drift into disagreeing about which subjects are safe.
 *
 * Merge commits are skipped: release-please cannot parse them as conventional commits (its log is
 * full of "commit could not be parsed: Merge pull request #…"), so their subjects never reach a
 * changelog and cannot trigger the defect.
 *
 *     bun scripts/check-changelog-safety.ts                       # origin/main..HEAD
 *     bun scripts/check-changelog-safety.ts --from <sha> --to <sha>
 */

import { changelogSafetyAdvice, findChangelogUnsafeParts } from "../commitlint.config.ts";

export interface UnsafeCommit {
  sha: string;
  subject: string;
  parts: ReturnType<typeof findChangelogUnsafeParts>;
}

/** A `git log` record: the sha, then the raw message, both NUL-terminated. */
const RECORD = "%H%x00%B%x00";

/**
 * Split `git log --format=RECORD` output back into commits. Exported for the test, which would
 * otherwise have to shell out to git to exercise anything.
 */
export function parseLog(stdout: string): { sha: string; message: string }[] {
  const fields = stdout.split("\0");
  const commits: { sha: string; message: string }[] = [];
  // Fields arrive in pairs; a trailing empty field after the final NUL is expected.
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const sha = fields[i].trim();
    if (sha) {
      commits.push({ sha, message: fields[i + 1] });
    }
  }
  return commits;
}

/** The commits in `log` whose changelog-bound text carries an angle-bracket tag. */
export function findUnsafeCommits(commits: { sha: string; message: string }[]): UnsafeCommit[] {
  return commits
    .map((c) => ({
      sha: c.sha,
      subject: c.message.split("\n")[0] ?? "",
      parts: findChangelogUnsafeParts(c.message),
    }))
    .filter((c) => c.parts.length > 0);
}

export function report(unsafe: UnsafeCommit[]): string {
  return unsafe
    .map((c) => {
      const where = c.parts.map((p) => p.part).join(" and ");
      return `  ${c.sha.slice(0, 8)} ${c.subject}\n      ${where} ${changelogSafetyAdvice(c.parts)}`;
    })
    .join("\n");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const arg = (flag: string) => {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
  };
  const from = arg("--from") ?? "origin/main";
  const to = arg("--to") ?? "HEAD";

  // `--no-merges` is what keeps a "Merge pull request #…" subject from being judged by a rule
  // Written for conventional commits.
  const proc = Bun.spawnSync(["git", "log", "--no-merges", `--format=${RECORD}`, `${from}..${to}`]);
  if (proc.exitCode !== 0) {
    console.error(
      `git log ${from}..${to} failed — is the range fetched?\n${proc.stderr.toString()}`,
    );
    process.exit(1);
  }

  const commits = parseLog(proc.stdout.toString());
  const unsafe = findUnsafeCommits(commits);
  if (unsafe.length === 0) {
    console.log(`${commits.length} commit(s) in ${from}..${to}: all changelog-safe.`);
    process.exit(0);
  }

  console.error(
    `${unsafe.length} of ${commits.length} commit(s) in ${from}..${to} would be dropped from ` +
      "their own release:\n",
  );
  console.error(report(unsafe));
  console.error(
    "\nAmend the subject (`git rebase -i` for an older commit) and force-push. The same rule runs " +
      "locally via .husky/commit-msg.",
  );
  process.exit(1);
}
