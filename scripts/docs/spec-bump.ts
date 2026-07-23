// Releases a spec: bumps the header + footer version, restamps **Updated:** to today, and prepends
// A `## Changelog` entry. This is the low-friction path that makes the release gate
// (check-spec-release.ts) cheap to satisfy, so spec versions stay meaningful.
//
// The `-draft` suffix is derived from the header **Status:** — Implemented specs release without
// It, everything else keeps it (check-spec-status.ts enforces the same rule). To graduate a spec,
// Set `**Status:** Implemented` first, then bump: the suffix drops automatically.
//
// Usage:
//   `bun run spec:bump <spec.md> <major|minor|patch|stable> -m "<what changed>"`
// E.g.
//   `bun run spec:bump server.md patch -m "Clarify proxy resolution order in §6.3"`
//
// Bump levels: `major` = breaking change to a documented contract, `minor` = additive (new
// Sections/behavior), `patch` = editorial (wording, examples, non-normative clarification),
// `stable` = graduate a 0.x spec to 1.0.0. While a spec is pre-1.0 (all of them today) the
// Release-please bump-minor-pre-major policy applies: `major` moves the minor, `minor` and
// `patch` both move the patch. That is the policy the reconstructed history was derived under.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseSpecSource, splitVersion } from "./lib/spec-status.ts";

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
      "  (pre-1.0: major moves the minor, minor and patch both move the patch)",
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
const positional = args.filter((_, i) => i !== messageFlag && i !== messageFlag + 1);
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

const next = nextOf(current, bump);

// The suffix follows the status, not the previous version.
const draft = parsed.headerStatus !== "Implemented";
const nextVersion = `${next.major}.${next.minor}.${next.patch}${draft ? "-draft" : ""}`;
const today = new Date().toISOString().slice(0, 10);

// ─── Rewrite the file ────────────────────────────────────────────────────────

const lines = source.split("\n");

// Header version, and the footer version line when the spec has one.
const versionIdx = lines.findIndex((l) => l.startsWith("**Version:**"));
lines[versionIdx] = `**Version:** ${nextVersion}`;
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
  lines.splice(statusIdx + 1, 0, `**Updated:** ${today}`);
} else {
  lines[updatedIdx] = `**Updated:** ${today}`;
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

console.log(`specs/${file}: ${parsed.headerVersion} → ${nextVersion} (${today})`);
console.log(`  ${entry}`);
console.log("\nNext: `bun run docs:generate` so the derived reference pages match.");
