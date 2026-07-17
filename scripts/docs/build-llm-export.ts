// Emits LLM/agent-friendly exports of the docs corpus into the built site:
//   Dist/llms.txt — nav-ordered index (llms.txt convention)
//   Dist/docs/full-docs.json — the whole corpus as structured entries
// (The client search index is emitted by @jxsuite/search during `jx build`.)
//
// Runs as a post-build step of the jxsuite.com site build (see its package.json)
// So nothing derived is committed.
//
// Usage: bun scripts/docs/build-llm-export.ts [distDir]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const DOCS_DIR = join(ROOT, "docs");
const SITE_URL = "https://jxsuite.com";
const DIST = resolve(process.argv[2] ?? join(ROOT, "sites/jxsuite.com/dist"));

if (!existsSync(DIST)) {
  console.error(`No build output at ${DIST} — run the site build first.`);
  process.exit(2);
}

interface NavNode {
  path: string;
  label: string;
  children?: NavNode[];
}

interface DocEntry {
  slug: string;
  url: string;
  title: string;
  description: string;
  section: string;
  markdown: string;
}

/** Frontmatter fields + body of a docs page. */
function readPage(slug: string): { title: string; description: string; body: string } | null {
  const file = existsSync(join(DOCS_DIR, `${slug}.md`))
    ? join(DOCS_DIR, `${slug}.md`)
    : join(DOCS_DIR, slug, "index.md");
  if (!existsSync(file)) {
    return null;
  }
  const source = readFileSync(file, "utf8");
  const match = source.match(/^---\n([\s\S]*?)\n---\n/);
  const fm = match ? (Bun.YAML.parse(match[1]!) as Record<string, unknown>) : {};
  return {
    body: match ? source.slice(match[0].length) : source,
    description: typeof fm.description === "string" ? fm.description : "",
    title: typeof fm.title === "string" ? fm.title : slug,
  };
}

const nav = JSON.parse(readFileSync(join(DOCS_DIR, "nav.json"), "utf8")) as {
  sections: NavNode[];
};

// Nav-ordered corpus: each section landing first, then its children.
const entries: DocEntry[] = [];
for (const section of nav.sections) {
  for (const node of [section, ...(section.children ?? [])]) {
    const page = readPage(node.path);
    if (!page) {
      continue;
    }
    entries.push({
      description: page.description,
      markdown: page.body,
      section: section.label,
      slug: node.path,
      title: page.title,
      url: `${SITE_URL}/docs/${node.path}/`,
    });
  }
}

// ── llms.txt ──────────────────────────────────────────────────────────────────
const llms: string[] = [
  "# Jx Suite",
  "",
  "> Jx Suite is a visual site builder (Jx Studio), a JSON-native component format, and a static-site compiler working on plain files. These docs cover using Studio, the Jx framework format, and extending Jx.",
  "",
];
for (const section of nav.sections) {
  llms.push(`## ${section.label}`, "");
  for (const node of [section, ...(section.children ?? [])]) {
    const entry = entries.find((e) => e.slug === node.path);
    if (entry) {
      llms.push(`- [${entry.title}](${entry.url}): ${entry.description}`);
    }
  }
  llms.push("");
}
writeFileSync(join(DIST, "llms.txt"), `${llms.join("\n").trimEnd()}\n`, "utf8");

// ── full-docs.json ────────────────────────────────────────────────────────────
mkdirSync(join(DIST, "docs"), { recursive: true });
writeFileSync(join(DIST, "docs/full-docs.json"), JSON.stringify(entries, null, 2), "utf8");

console.log(`llm export: ${entries.length} pages → llms.txt, full-docs.json`);
