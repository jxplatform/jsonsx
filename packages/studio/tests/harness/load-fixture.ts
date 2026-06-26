/**
 * Load-fixture.js — load a Jx site fixture into the shapes the headless harness expects.
 *
 * Reads a site (default: `sites/test-blank/`) from disk and returns the page document, project
 * config, and a component list for `buildSystemPrompt`. Crucially, all file writes (Layer 3
 * component/page creation) are redirected into a **throwaway temp copy** of the site — the real
 * fixture is never mutated, honoring the testing-plan §10.3 guardrail ("never edit the test-blank
 * fixtures").
 *
 * See docs/ai-assistant-headless-harness.md §3 Step 2.
 */

import { cpSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");

/**
 * @param {object} [opts]
 * @param {string} [opts.site] - Path to the source site, relative to repo root.
 * @param {string} [opts.page] - Page file to load as the working document, relative to the site.
 * @returns {{
 *   document: Record<string, unknown>;
 *   projectConfig: Record<string, unknown>;
 *   components: Array<{ name: string; path: string }>;
 *   projectRoot: string;
 *   saveFile: (relPath: string, content: string) => Promise<void>;
 *   readWritten: (relPath: string) => string;
 * }}
 */
export function loadFixture({ site = "sites/test-blank", page = "pages/index.json" } = {}) {
  const srcRoot = join(REPO_ROOT, site);

  // Throwaway temp copy: writes land here, the source fixture stays pristine.
  const tmpRoot = mkdtempSync(join(tmpdir(), "jx-harness-"));
  cpSync(srcRoot, tmpRoot, { recursive: true });

  const document = readJson(join(tmpRoot, page));
  const projectConfig = readJson(join(tmpRoot, "project.json"));
  const components = listComponents(tmpRoot);

  /** Every file the model wrote, in order. */
  const writes: { relPath: string; content: string }[] = [];

  async function saveFile(relPath: string, content: string): Promise<void> {
    const dest = join(tmpRoot, relPath);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);
    writes.push({ relPath, content });
  }

  /** Read a file the model wrote, to assert on it in the scorer. */
  function readWritten(relPath: string): string {
    return readFileSync(join(tmpRoot, relPath), "utf8");
  }

  return {
    document,
    projectConfig,
    components,
    projectRoot: tmpRoot,
    saveFile,
    readWritten,
    writes,
  };
}

function readJson(p: string): Record<string, unknown> {
  return JSON.parse(readFileSync(p, "utf8"));
}

/**
 * List `components/*.json` as `{ name, path }` — the shape `buildProjectSummary` consumes (it reads
 * `.tag || .name || .path`).
 */
function listComponents(root: string): { name: string; path: string }[] {
  const dir = join(root, "components");
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  return files.map((f) => ({ name: f.replace(/\.json$/, ""), path: `components/${f}` }));
}
