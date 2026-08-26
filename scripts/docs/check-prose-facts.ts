/**
 * Prove a prose rewrite did not quietly drop a claim.
 *
 * Rewriting 139,000 words is the one operation that can make documentation worse while every other
 * gate stays green: `docs:check` sees valid frontmatter, `docs:links` sees resolving links, and the
 * page still reads well, because the sentence that carried the dropped condition is simply gone. A
 * reviewer reading only the new text cannot catch that. Reading both is the job, and this is what
 * makes the reading tractable.
 *
 * **Losses block, gains report.** A prose pass has no business deleting a code block, a link, a
 * keystroke or an image, so those are hard failures. It may well add a `## Related` section or an
 * orienting sentence, so additions are printed and left to the author to justify.
 *
 * The advisory band is where the real risk is, and the most valuable line in it is the modality
 * delta. This corpus uses `never` 264 times and `always` 86 times, and in documentation those are
 * contract language rather than intensifiers: "a date with no time zone uses UTC, never the machine
 * that happens to be building the site" is a build-reproducibility guarantee. A rewrite that
 * softens one to "usually" moves no identifier and no number, so nothing else in this script would
 * notice. It is advisory because a legitimate rewrite moves those words constantly, and a blocking
 * rule would train everyone to wave it through.
 *
 * **What it cannot catch.** A claim carried by ordinary words. "Studio builds the site first, so
 * what opens is what you are looking at" can lose its second clause without moving a single token
 * this script extracts. That is what the human read is for, and a clean report is not a substitute
 * for it.
 *
 * The diff is the WORKING TREE against `base`, not a committed range, because the per-page protocol
 * runs this before committing. Point `--base` at the branch point, not at `main`: a rewrite stacked
 * on a link-normalisation change would otherwise read every rewritten `./i18n.md` link as a loss
 * and its `/docs/framework/site/i18n` replacement as an unrelated addition. Two forms of the same
 * destination are still two different strings, and this script compares strings.
 *
 * Usage: `bun scripts/docs/check-prose-facts.ts [--base <ref>] [paths…]`
 */

import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");

export interface Facts {
  /** Fenced block BODIES, without the info string. A prose pass must not touch one. */
  fences: string[];
  /** The info strings themselves, which a docs fix may legitimately add. */
  fenceLangs: string[];
  /** Every link and image target. */
  targets: string[];
  /** `:kbd[⌘S]` and friends. */
  keys: string[];
  /** Image references, which are also screenshot-lock entries. */
  images: string[];
  /** Backticked identifiers. */
  code: string[];
  /** Bold spans, which in this corpus are usually literal UI labels. */
  bold: string[];
  /** Bare numbers outside code, where thresholds live. */
  numbers: string[];
  /** The words that carry a contract rather than a tone. */
  modality: string[];
  words: number;
}

const FENCE_BLOCK = /^```([\S ]*)\n([\s\S]*?)^```$/gm;
const IMAGE = /!\[[^\]]*\]\(([^)\s]+)/g;
const LINK = /(?<!!)\[[^\]]*\]\(([^)\s]+)/g;
const KBD = /:kbd\[[^\]]*\]/g;
const CODE_SPAN = /`([^`\n]+)`/g;
const BOLD = /\*\*([^*\n]+)\*\*/g;
const MODALITY =
  /\b(never|always|only|must|must not|cannot|all|none|every|required|optional|refuses|fail-closed)\b/gi;

/**
 * Extract the machine-checkable claims of one document.
 *
 * @param {string} source
 * @returns {Facts}
 */
export function factsOf(source: string): Facts {
  // The body and the info string are separated deliberately: adding a missing language tag is a
  // Docs FIX, and comparing the whole block would report all 44 of them as lost code.
  const blocks = [...source.matchAll(FENCE_BLOCK)];
  const fences = blocks.map((m) => m[2] ?? "");
  const fenceLangs = blocks.map((m) => (m[1] ?? "").trim());
  const prose = source.replaceAll(FENCE_BLOCK, "");
  const all = (re: RegExp, group = 0) => [...prose.matchAll(re)].map((m) => m[group] ?? "");
  const codeless = prose.replaceAll(CODE_SPAN, " ");
  return {
    bold: all(BOLD, 1),
    code: all(CODE_SPAN, 1),
    fenceLangs,
    fences,
    images: all(IMAGE, 1),
    keys: all(KBD),
    modality: all(MODALITY).map((m) => m.toLowerCase()),
    numbers: [...codeless.matchAll(/(?<![\w.])\d[\d,.]*/g)].map((m) => m[0]),
    targets: [...all(LINK, 1), ...all(IMAGE, 1)],
    words: prose.split(/\s+/).filter(Boolean).length,
  };
}

/** What `before` had that `after` does not, counted as a multiset. */
export function lost(before: string[], after: string[]): string[] {
  const pool = [...after];
  const missing: string[] = [];
  for (const item of before) {
    const at = pool.indexOf(item);
    if (at === -1) {
      missing.push(item);
    } else {
      pool.splice(at, 1);
    }
  }
  return missing;
}

export interface FileReport {
  file: string;
  /** Losses. Any entry here fails the run. */
  blocking: string[];
  /** Gains and soft deltas, for the author to justify in the pull request body. */
  advisory: string[];
}

/**
 * Compare one file's claims before and after.
 *
 * @param {string} file
 * @param {string} before
 * @param {string} after
 * @returns {FileReport}
 */
export function compare(file: string, before: string, after: string): FileReport {
  const a = factsOf(before);
  const b = factsOf(after);
  const blocking: string[] = [];
  const advisory: string[] = [];

  const band1: [string, keyof Facts][] = [
    ["fenced code body", "fences"],
    ["link or image target", "targets"],
    ["keystroke", "keys"],
    ["image", "images"],
  ];
  for (const [label, key] of band1) {
    for (const item of lost(a[key] as string[], b[key] as string[])) {
      blocking.push(`${label} removed: ${JSON.stringify(item.slice(0, 90))}`);
    }
  }

  const band2: [string, keyof Facts][] = [
    ["fence language", "fenceLangs"],
    ["identifier", "code"],
    ["bold label", "bold"],
    ["number", "numbers"],
    ["modality word", "modality"],
  ];
  for (const [label, key] of band2) {
    for (const item of lost(a[key] as string[], b[key] as string[])) {
      advisory.push(`${label} gone: ${JSON.stringify(item.slice(0, 60))}`);
    }
    for (const item of lost(b[key] as string[], a[key] as string[])) {
      advisory.push(`${label} new:  ${JSON.stringify(item.slice(0, 60))}`);
    }
  }
  for (const [label, key] of band1) {
    for (const item of lost(b[key] as string[], a[key] as string[])) {
      advisory.push(`${label} added: ${JSON.stringify(item.slice(0, 90))}`);
    }
  }

  const delta = a.words === 0 ? 0 : Math.round(((b.words - a.words) / a.words) * 100);
  if (Math.abs(delta) >= 20) {
    advisory.push(`word count ${delta > 0 ? "+" : ""}${delta}% (${a.words} to ${b.words})`);
  }

  return { advisory, blocking, file };
}

function git(args: string[]): string | undefined {
  const proc = Bun.spawnSync(["git", ...args], { cwd: ROOT, stderr: "ignore" });
  return proc.exitCode === 0 ? proc.stdout.toString() : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const baseAt = args.indexOf("--base");
  const base = baseAt === -1 ? "origin/main" : (args[baseAt + 1] ?? "origin/main");
  const named = args
    .filter((a, i) => !a.startsWith("--") && i !== baseAt + 1)
    .map((p) => relative(ROOT, resolve(p)));

  const changed =
    named.length > 0
      ? named
      : (git(["diff", "--name-only", base]) ?? "").split("\n").filter((f) => f.endsWith(".md"));

  const reports: FileReport[] = [];
  for (const file of changed.filter(Boolean)) {
    const before = git(["show", `${base}:${file}`]);
    if (before === undefined) {
      continue; // A new file has nothing to lose.
    }
    let after: string;
    try {
      after = readFileSync(resolve(ROOT, file), "utf8");
    } catch {
      continue;
    }
    reports.push(compare(file, before, after));
  }

  const blocking = reports.filter((r) => r.blocking.length > 0);
  for (const r of reports) {
    if (r.blocking.length === 0 && r.advisory.length === 0) {
      continue;
    }
    console.log(`\n${r.file}`);
    for (const b of r.blocking) {
      console.log(`  LOST  ${b}`);
    }
    for (const a of r.advisory) {
      console.log(`        ${a}`);
    }
  }

  if (blocking.length > 0) {
    console.error(
      `\nfact diff: ${blocking.length} file(s) lost a code block, a link, a keystroke or an image. ` +
        "A prose rewrite does not remove those; restore them or say why in the pull request.",
    );
    process.exit(1);
  }
  console.log(
    `\nfact diff: ${reports.length} file(s) compared against ${base}; nothing was lost. ` +
      "Adjudicate every advisory line above in the pull request body.",
  );
}

if (import.meta.main) {
  await main();
}
