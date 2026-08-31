// Releases a spec: bumps the header + footer version, restamps **Updated:** to today, and prepends
// A `## Changelog` entry. This is the low-friction path that makes the release gate
// (check-spec-release.ts) cheap to satisfy, so spec versions stay meaningful.
//
// The `-draft` suffix is derived from the header **Status:** — Implemented specs release without
// It, everything else keeps it (check-spec-status.ts enforces the same rule). To graduate a spec,
// Set `**Status:** Implemented` first, then bump: the suffix drops automatically.
//
// The next version is computed from the HIGHER of this file and the same file on the base branch,
// So a branch forked before a release cannot re-mint a number main has already used. `--base <ref>`
// Overrides the ref; see resolveBaseVersion below for why it reads the tip rather than a merge base.
//
// Usage:
//   `bun run spec:bump <spec.md> <major|minor|patch|stable> -m "<what changed>"`
// E.g.
//   `bun run spec:bump server.md patch -m "Clarify proxy resolution order in §6.3"`
//   `bun run spec:bump server.md patch --base upstream/main -m "..."`
//
// Bump levels: `major` = breaking change to a documented contract, `minor` = additive (new
// Sections/behavior), `patch` = editorial (wording, examples, non-normative clarification),
// `stable` = graduate a 0.x spec to 1.0.0. While a spec is pre-1.0 (all of them today) the
// Release-please bump-minor-pre-major policy applies: `major` moves the minor, `minor` and
// `patch` both move the patch. That is the policy the reconstructed history was derived under.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { endsInHardBreak } from "../lib/unwrap-prose.ts";
import { parseSpecSource, splitVersion, versionFloor } from "./lib/spec-status.ts";

const ROOT = resolve(import.meta.dir, "../..");
const SPECS_DIR = join(ROOT, "specs");

const BUMPS = new Set(["major", "minor", "patch", "stable"]);
const CHANGELOG_HEADING = /^##\s+Changelog\s*$/;
const FOOTER_VERSION_LINE = /Specification v[0-9][A-Za-z0-9.-]*/;
const STATUS_LINE = /^\*\*Status:\*\*/;

function die(message: string): never {
  console.error(`spec:bump: ${message}`);
  console.error(
    '\nUsage: bun run spec:bump <spec.md> <major|minor|patch|stable> -m "<what changed>"\n' +
      "  major = breaking contract change, minor = additive, patch = editorial,\n" +
      "  stable = graduate a 0.x spec to 1.0.0\n" +
      "  (pre-1.0: major moves the minor, minor and patch both move the patch)\n" +
      "  --base <ref>  the branch whose released version is the floor (default origin/main, main)",
  );
  process.exit(1);
}

// ─── Arguments ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const messageFlag = args.findIndex((a) => a === "-m" || a === "--message");
if (messageFlag === -1) {
  die('a changelog summary is required (-m "<what changed>")');
}
const summary = (args[messageFlag + 1] ?? "").replaceAll(/\s+/g, " ").trim();
if (!summary) {
  die("the changelog summary (-m) is empty");
}
const baseFlag = args.indexOf("--base");
const explicitBase = baseFlag === -1 ? null : (args[baseFlag + 1] ?? null);
if (baseFlag !== -1 && (!explicitBase || explicitBase.startsWith("-"))) {
  // Without this, `--base -m "..."` swallows the message flag as a ref and reports "no such git
  // Ref", which sends you looking at your remotes instead of at your command line.
  die(`--base needs a git ref (got ${explicitBase ? `"${explicitBase}"` : "nothing"})`);
}
// Only the flags actually present consume an index. `baseFlag + 1` is 0 when --base is absent,
// Which would eat the spec name.
const consumed = new Set([messageFlag, messageFlag + 1]);
if (baseFlag !== -1) {
  consumed.add(baseFlag);
  consumed.add(baseFlag + 1);
}
const positional = args.filter((_, i) => !consumed.has(i));
const [rawSpec, bump] = positional;
if (!rawSpec) {
  die("which spec? e.g. server.md");
}
if (!bump || !BUMPS.has(bump)) {
  die(`bump must be one of major|minor|patch|stable (got "${bump ?? ""}")`);
}

const file = basename(rawSpec).endsWith(".md") ? basename(rawSpec) : `${basename(rawSpec)}.md`;
const path = join(SPECS_DIR, file);
if (!existsSync(path)) {
  die(`no such spec: specs/${file}`);
}

// ─── Compute the next version ────────────────────────────────────────────────

const source = readFileSync(path, "utf8");
const parsed = parseSpecSource(source, file);
if (!parsed.headerVersion) {
  die(`specs/${file} has no **Version:** line`);
}
const current = splitVersion(parsed.headerVersion);
if (!current) {
  die(
    `specs/${file} version "${parsed.headerVersion}" is not MAJOR.MINOR.PATCH (optionally -draft)`,
  );
}

function gitSafe(gitArgs: string[]): string | null {
  try {
    return execFileSync("git", gitArgs, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/**
 * The version this spec already carries on the base branch, or null when that cannot be read.
 *
 * This existed because `spec:bump` used to read only the working file. A branch forked before a
 * release on main would see the old version, mint the next one, and land a number main had already
 * used — two changelog entries claiming `0.9.31-draft`. Nothing said so until the merge, where it
 * surfaced as check-spec-status's "changelog must run newest-first — 0.9.31-draft is not older than
 * 0.9.31-draft": true, but it names the ordering symptom, and the fix is renumbering the header,
 * the footer and every entry above the collision by hand.
 *
 * It reads the base's TIP, deliberately, which is where this differs from check-spec-release.ts.
 * That script asks "did the body change since I forked", which is a merge-base question. This asks
 * "is the number I am about to mint already taken", and only the tip knows.
 *
 * Every failure path returns null and the local version stands: an unfetched or missing ref, a
 * shallow clone, no network, or a spec that does not exist on the base yet because it is new. A
 * stale `origin/main` therefore under-reports rather than blocking — which is why the ref and the
 * version it found are printed whenever they move the answer.
 */
function resolveBaseVersion(): { ref: string; version: typeof current } | null {
  const candidates = explicitBase ? [explicitBase] : ["origin/main", "main"];
  for (const ref of candidates) {
    if (!gitSafe(["rev-parse", "--verify", `${ref}^{commit}`])) {
      // An explicit ref that does not resolve is a typo worth stopping for. A default one that
      // Does not is just a repo without it — try the next, then give up quietly.
      if (explicitBase) {
        die(`--base ${explicitBase}: no such git ref`);
      }
      continue;
    }
    // The ref exists but the spec does not: a spec added on this branch has no base version, which
    // Is not an error at any level. It simply has no floor.
    const text = gitSafe(["show", `${ref}:specs/${file}`]);
    if (!text) {
      return null;
    }
    const header = parseSpecSource(text, file).headerVersion;
    const version = header ? splitVersion(header) : null;
    return version ? { ref, version } : null;
  }
  return null;
}

const base = resolveBaseVersion();
/** Bump from whichever is higher, so the result clears what the base has already published. */
const { version: floor, raised } = versionFloor(current, base?.version ?? null);

/**
 * Pre-1.0 specs (every spec today) follow release-please's bump-minor-pre-major policy, the same
 * One the reconstructed history was derived under: a structural break moves the minor, everything
 * Else moves the patch. `stable` is the deliberate graduation to 1.0.0.
 */
function nextOf(v: typeof current, level: string): { major: number; minor: number; patch: number } {
  const preMajor = v.major === 0;
  if (level === "stable") {
    if (!preMajor) {
      die(`specs/${file} is already stable at ${v.raw}`);
    }
    return { major: 1, minor: 0, patch: 0 };
  }
  if (level === "major") {
    return preMajor
      ? { major: 0, minor: v.minor + 1, patch: 0 }
      : { major: v.major + 1, minor: 0, patch: 0 };
  }
  if (level === "minor") {
    return preMajor
      ? { major: 0, minor: v.minor, patch: v.patch + 1 }
      : { major: v.major, minor: v.minor + 1, patch: 0 };
  }
  return { major: v.major, minor: v.minor, patch: v.patch + 1 };
}

const next = nextOf(floor, bump);

// The suffix follows the status, not the previous version.
const draft = parsed.headerStatus !== "Implemented";
const nextVersion = `${next.major}.${next.minor}.${next.patch}${draft ? "-draft" : ""}`;
const today = new Date().toISOString().slice(0, 10);

// ─── Rewrite the file ────────────────────────────────────────────────────────

const lines = source.split("\n");

// Header version, and the footer version line when the spec has one.
/*
 * The header block is a labelled run — `**Version:** / **Status:** / **Updated:** / **License:**` —
 * and once the Markdown sweep lands, every line but the last carries a trailing `\` hard break to
 * hold it there (see scripts/lib/unwrap-prose.ts). Rewriting a line whole would drop the marker and
 * join the header into one sentence, so the marker is read off the line being replaced. Before the
 * sweep there is none to read and this is a no-op.
 */
const versionIdx = lines.findIndex((l) => l.startsWith("**Version:**"));
const versionBreak = endsInHardBreak(lines[versionIdx]!) ? "\\" : "";
lines[versionIdx] = `**Version:** ${nextVersion}${versionBreak}`;
const footerIdx = lines.findLastIndex((l) => FOOTER_VERSION_LINE.test(l));
if (footerIdx !== -1) {
  lines[footerIdx] = lines[footerIdx]!.replace(
    FOOTER_VERSION_LINE,
    `Specification v${nextVersion}`,
  );
}

// **Updated:** — restamp, or insert after **Status:** when the spec predates the field.
const updatedIdx = lines.findIndex((l) => l.startsWith("**Updated:**"));
if (updatedIdx === -1) {
  const statusIdx = lines.findIndex((l) => STATUS_LINE.test(l));
  if (statusIdx === -1) {
    die(`specs/${file} has no **Status:** line to anchor **Updated:** to`);
  }
  // Inserted mid-run, so it inherits the break of the line it follows.
  const statusBreak = endsInHardBreak(lines[statusIdx]!) ? "\\" : "";
  lines.splice(statusIdx + 1, 0, `**Updated:** ${today}${statusBreak}`);
} else {
  const updatedBreak = endsInHardBreak(lines[updatedIdx]!) ? "\\" : "";
  lines[updatedIdx] = `**Updated:** ${today}${updatedBreak}`;
}

// Prepend the changelog entry, creating the section if the spec has none.
const entry = `- **${nextVersion}** (${today}) — ${summary.endsWith(".") ? summary : `${summary}.`}`;
const changelogIdx = lines.findIndex((l) => CHANGELOG_HEADING.test(l));
if (changelogIdx === -1) {
  const block = ["## Changelog", "", entry];
  const tailIdx = lines.findLastIndex((l) => FOOTER_VERSION_LINE.test(l));
  if (tailIdx === -1) {
    while (lines.length > 0 && lines.at(-1)!.trim() === "") {
      lines.pop();
    }
    lines.push("", ...block, "");
  } else {
    let insertAt = tailIdx;
    let j = tailIdx - 1;
    while (j >= 0 && lines[j]!.trim() === "") {
      j -= 1;
    }
    if (j >= 0 && lines[j]!.trim() === "---") {
      insertAt = j;
    }
    lines.splice(insertAt, 0, ...block, "");
  }
} else {
  let insertAt = changelogIdx + 1;
  while (insertAt < lines.length && lines[insertAt]!.trim() === "") {
    insertAt += 1;
  }
  lines.splice(insertAt, 0, entry);
}

writeFileSync(path, lines.join("\n"), "utf8");

// Keep the committed form oxfmt-stable (specs are in nano-staged's *.md scope).
const fmt = Bun.spawnSync(["bunx", "oxfmt", path], { cwd: ROOT });
if (fmt.exitCode !== 0) {
  console.error(fmt.stderr.toString() || fmt.stdout.toString());
  process.exit(fmt.exitCode);
}

if (raised) {
  console.log(
    `specs/${file}: ${base!.ref} already released ${floor.raw}, so this bumps from there rather ` +
      `than from the local ${current.raw}.`,
  );
}
console.log(`specs/${file}: ${parsed.headerVersion} → ${nextVersion} (${today})`);
console.log(`  ${entry}`);
console.log("\nNext: `bun run docs:generate` so the derived reference pages match.");
