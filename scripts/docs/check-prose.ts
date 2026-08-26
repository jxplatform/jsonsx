/**
 * Keep the documentation reading like a person wrote it.
 *
 * The vocabulary rules in the style guide worked: across 163,533 words this corpus has no hit for
 * delve, seamless, comprehensive, crucial, pivotal, "at its core" or "let's dive in", no decorative
 * horizontal rules, and no "Key takeaways" heading. What it had instead was punctuation, at a rate
 * no person writes: an em dash every forty-four words. So the bans below mostly guard ground that
 * is already clean, and the one number that is not yet zero is carried as debt.
 *
 * **Two tiers, and the difference is whether the target is zero.**
 *
 * A `ban` is a mark or a phrase that is wrong every time it appears, so it is simply forbidden and
 * an exception needs an allow entry saying why this instance is not what the rule is about. There
 * are eight of those today and each one is a fact about the world: a JS realm is a spec term, the
 * status glyphs in the locale table are the app's own, and the style guide has to be able to quote
 * the phrases it bans.
 *
 * A `budget` is a per-file count that may only fall. It is DEBT, not configuration. The count is
 * checked in both directions: above its entry fails, and below its entry also fails, because a
 * number left high after a file was fixed is a number nobody will lower later. Each rewrite deletes
 * its files' entries, and when the map empties the rule hardens into a ban.
 *
 * **That has now happened.** The em dash was carried as debt across 131 pages and reached zero, so
 * it is a ban and `budgets` is empty. The machinery stays because the surfaces still outside this
 * corpus, the marketing pages and the package READMEs, will need it; its tests run against a
 * fixture rather than a real page, so a page reaching zero can no longer break them.
 *
 * **What is deliberately not here.** Sentence length, `rather than`, `X, not Y.`, bold labels on
 * list items, forced triples, and the animated-software verbs (`names`, `carries`, `holds`) are all
 * measurable and none of them is gated. A budget on a cadence whose target is not zero asserts that
 * the fifth instance is wrong while the fourth was fine, which is not a claim anyone can defend at
 * review time; and the bold-label rule in particular would fire on about a thousand bullets whose
 * label is a real button the style guide REQUIRES to be bold. They are style-guide rules for a
 * person to apply, and `--report` prints their counts without failing anything.
 *
 * Rules judge segments from `lib/prose.ts`, never raw lines, so a bare em dash in a table cell
 * stays the data value it is and a `:::doc-note` marker is not mistaken for a sentence.
 *
 * Usage: `bun scripts/docs/check-prose.ts [--report] [--ratchet] [paths…]`
 */

import { readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { Ctx, Segment } from "./lib/prose.ts";
import { segment } from "./lib/prose.ts";

const ROOT = resolve(import.meta.dir, "../..");
const RULES_PATH = join(ROOT, "scripts/docs/prose.json");

export interface Rule {
  id: string;
  tier: "ban" | "budget";
  regex: string;
  flags?: string;
  /** Where the rule applies. Omitted means everywhere. */
  contexts?: Ctx[];
  hint: string;
}

export interface AllowEntry {
  id: string;
  file: string;
  /** Must be a substring of the offending segment, so rewording the line retires the entry. */
  text: string;
  evidence?: string;
  reason?: string;
}

export interface ProseConfig {
  rules: Rule[];
  budgets: Record<string, Record<string, number>>;
  allow: AllowEntry[];
}

export interface Hit {
  id: string;
  file: string;
  line: number;
  col: number;
  match: string;
  /** The trimmed segment, for the report. */
  excerpt: string;
  /** The whole segment, untruncated. Allow entries match against this. */
  context: string;
}

/** A bare em dash in a table cell is the value "none", written by the reference generators. */
function isDataCell(seg: Segment): boolean {
  return seg.ctx === "tableCell" && /^[—–]$/.test(seg.raw.trim());
}

/**
 * An en dash between numbers or between two code spans is a range, and ranges are correct.
 *
 * The flanking test reads the RAW text, because the masker blanks a code span and `h1`-`h6` would
 * otherwise look like a dash between two spaces.
 *
 * @param {Segment} seg
 * @param {number} index
 * @returns {boolean}
 */
export function isRange(seg: Segment, index: number): boolean {
  const before = seg.raw[index - 1] ?? "";
  const after = seg.raw[index + 1] ?? "";
  return /[\d`\]]/.test(before) && /[\d`]/.test(after);
}

/**
 * Every hit one rule makes in one file.
 *
 * @param {Rule} rule
 * @param {Segment[]} segments
 * @param {string} file
 * @returns {Hit[]}
 */
export function hitsOf(rule: Rule, segments: Segment[], file: string): Hit[] {
  const re = new RegExp(
    rule.regex,
    rule.flags?.includes("g") ? rule.flags : `${rule.flags ?? ""}g`,
  );
  const hits: Hit[] = [];
  for (const seg of segments) {
    if (rule.contexts && !rule.contexts.includes(seg.ctx)) {
      continue;
    }
    if (rule.id === "em-dash" && isDataCell(seg)) {
      continue;
    }
    for (const m of seg.text.matchAll(re)) {
      if (rule.id === "en-dash" && isRange(seg, m.index)) {
        continue;
      }
      hits.push({
        col: seg.col + m.index,
        context: seg.raw,
        excerpt: seg.raw.trim().slice(0, 100),
        file,
        id: rule.id,
        line: seg.line,
        match: m[0],
      });
    }
  }
  return hits;
}

/**
 * Whether an allow entry covers this hit. It matches against the whole segment rather than the
 * truncated excerpt, so an entry can quote any part of a long paragraph; and it matches on text
 * rather than a line number, so rewording the line retires the entry. That staleness is the
 * property the whole allow mechanism rests on.
 *
 * @param {Hit} hit
 * @param {AllowEntry[]} allow
 * @param {Set<AllowEntry>} used
 * @returns {boolean}
 */
export function isAllowed(hit: Hit, allow: AllowEntry[], used: Set<AllowEntry>): boolean {
  for (const entry of allow) {
    if (entry.id === hit.id && entry.file === hit.file && hit.context.includes(entry.text)) {
      used.add(entry);
      return true;
    }
  }
  return false;
}

/** Files the gate reads: every published docs page that a generator does not own. */
export function corpusFiles(): string[] {
  const docs = [...new Bun.Glob("**/*.md").scanSync({ cwd: join(ROOT, "docs") })]
    .map((f) => `docs/${f}`)
    .filter((f) => f !== "docs/README.md")
    .filter((f) => !/^generated: true$/m.test(readFileSync(join(ROOT, f), "utf8")));
  return [...docs, "README.md", "PROSE-REWRITE.md"].toSorted();
}

export interface Report {
  violations: string[];
  /** Per file, per rule, what the gate counted. Feeds `--ratchet`. */
  counts: Record<string, Record<string, number>>;
}

/**
 * Run every rule over every file and compare against the bans, the budgets and the allow list.
 *
 * The staleness checks over `budgets` and `allow` only run on a full sweep. Scanning one page
 * cannot tell a stale entry from one whose file simply was not read, and reporting every other
 * entry as stale is what would make the per-page workflow unusable.
 *
 * @param {ProseConfig} config
 * @param {string[]} files
 * @param {boolean} full
 * @returns {Report}
 */
export function check(config: ProseConfig, files: string[], full = true): Report {
  const violations: string[] = [];
  const counts: Record<string, Record<string, number>> = {};
  const used = new Set<AllowEntry>();
  const byId = new Map(config.rules.map((r) => [r.id, r]));

  for (const file of files) {
    const segments = segment(readFileSync(join(ROOT, file), "utf8"));
    for (const rule of config.rules) {
      const hits = hitsOf(rule, segments, file).filter((h) => !isAllowed(h, config.allow, used));
      if (hits.length === 0) {
        continue;
      }
      (counts[file] ??= {})[rule.id] = hits.length;
      if (rule.tier === "ban") {
        for (const h of hits) {
          violations.push(`[${h.id}] ${h.file}:${h.line}:${h.col} ${rule.hint}
      ${h.excerpt}`);
        }
      }
    }
  }

  // Budgets, both directions. A count that fell and was not written down is a count nobody lowers.
  for (const rule of config.rules) {
    if (rule.tier !== "budget") {
      continue;
    }
    for (const file of files) {
      const actual = counts[file]?.[rule.id] ?? 0;
      const budget = config.budgets[file]?.[rule.id];
      if (budget === undefined) {
        if (actual > 0) {
          violations.push(
            `[${rule.id}] ${file}: ${actual} with no budget entry. ${rule.hint} ` +
              "New prose is held to zero; run --ratchet if this file is pre-existing debt.",
          );
        }
        continue;
      }
      if (actual > budget) {
        violations.push(`[${rule.id}] ${file}: ${actual} exceeds its budget of ${budget}.`);
      } else if (actual < budget) {
        violations.push(
          `[${rule.id}] ${file}: ${actual} is below its budget of ${budget} — lower it. ` +
            "Run --ratchet for the corrected map.",
        );
      }
    }
  }

  if (!full) {
    return { counts, violations };
  }

  // A budget naming a file or a rule that no longer exists is stale in the direction that hides work.
  for (const [file, byRule] of Object.entries(config.budgets)) {
    if (!files.includes(file)) {
      violations.push(`[budget] ${RULES_PATH}: budget for "${file}", which is not in the corpus.`);
      continue;
    }
    for (const id of Object.keys(byRule)) {
      if (!byId.has(id)) {
        violations.push(`[budget] ${RULES_PATH}: budget names unknown rule "${id}".`);
      }
    }
  }

  for (const entry of config.allow) {
    if (!used.has(entry)) {
      violations.push(
        `[allow] ${RULES_PATH}: stale allow entry [${entry.id}] for ${entry.file} ` +
          `text ${JSON.stringify(entry.text)} matched nothing — remove it.`,
      );
    }
    if (entry.evidence === undefined && entry.reason === undefined) {
      violations.push(
        `[allow] ${RULES_PATH}: allow entry [${entry.id}] for ${entry.file} needs evidence or reason.`,
      );
    }
  }

  return { counts, violations };
}

/** Cadence measures the style guide asks a person to judge. Never a failure. */
function cadence(files: string[]): void {
  const measures: Record<string, number> = {};
  const bump = (k: string, n = 1) => {
    measures[k] = (measures[k] ?? 0) + n;
  };
  for (const file of files) {
    const segments = segment(readFileSync(join(ROOT, file), "utf8"));
    for (const seg of segments) {
      if (seg.ctx === "tableCell" || seg.ctx === "heading") {
        continue;
      }
      bump("rather than", (seg.text.match(/\brather than\b/g) ?? []).length);
      bump("X, not Y.", (seg.text.match(/,\s+not\s+[^.;:]{1,60}\./g) ?? []).length);
      bump("quietly", (seg.text.match(/\bquietly\b/g) ?? []).length);
      for (const s of seg.text.split(/(?<=[.!?])\s+/)) {
        const words = s.split(/\s+/).filter(Boolean).length;
        if (words > 40) {
          bump("sentences over 40 words");
        } else if (words > 30) {
          bump("sentences over 30 words");
        }
      }
      if (seg.ctx === "listItem" && /^\s*\*\*[^*]+\*\*\s*[:—–-]/.test(seg.raw)) {
        bump("bullets opening with a bold label");
      }
    }
  }
  console.log(`prose report over ${files.length} file(s). None of these fails the build.\n`);
  for (const [k, v] of Object.entries(measures).toSorted((a, b) => b[1] - a[1])) {
    console.log(`  ${String(v).padStart(5)}  ${k}`);
  }
  console.log(
    "\nThese are style-guide judgements, not gate rules. See docs/extending/contributing/docs.md.",
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const named = args.filter((a) => !a.startsWith("--")).map((p) => relative(ROOT, resolve(p)));
  const files = named.length > 0 ? named : corpusFiles();
  const config = JSON.parse(readFileSync(RULES_PATH, "utf8")) as ProseConfig;

  if (args.includes("--report")) {
    cadence(files);
    return;
  }

  const { counts, violations } = check(config, files, named.length === 0);

  if (args.includes("--ratchet")) {
    const budgets: Record<string, Record<string, number>> = {};
    for (const file of files.toSorted()) {
      const forFile: Record<string, number> = {};
      for (const rule of config.rules) {
        if (rule.tier === "budget" && (counts[file]?.[rule.id] ?? 0) > 0) {
          forFile[rule.id] = counts[file]?.[rule.id] ?? 0;
        }
      }
      if (Object.keys(forFile).length > 0) {
        budgets[file] = forFile;
      }
    }
    console.log(JSON.stringify(budgets, undefined, 2));
    return;
  }

  if (violations.length === 0) {
    console.log(`prose: ${files.length} file(s) clean against ${config.rules.length} rule(s).`);
    return;
  }
  console.error(`\nprose: ${violations.length} violation(s):`);
  for (const v of violations) {
    console.error(`  ${v}`);
  }
  process.exit(1);
}

if (import.meta.main) {
  await main();
}
