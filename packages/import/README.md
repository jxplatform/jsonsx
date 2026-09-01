# @jxsuite/import

Clone a live website into a Jx project: capture the rendered DOM with headless Chrome, diff computed styles against UA defaults, extract design tokens and responsive breakpoints, download assets, detect the shared layout across pages, componentize recurring subtrees (optionally refined by an OpenAI-compatible LLM), and emit a ready-to-edit Jx project.

## CLI

```sh
jx-import <url> [options]

  --out <dir>              Output directory (default: ~/jx-imports/<hostname>)
  --depth <n>              Max crawl depth (default: 2, 0 = single page)
  --max-pages <n>          Max pages to capture (default: 25)
  --max-nodes-per-page <n> Skip styles/assets for pages above this (default: 5000)
  --no-styles              Skip CSS capture
  --no-assets              Skip asset download
  --no-crawl               Single page only (equivalent to --depth 0)
  --no-scroll              Skip scroll-to-bottom (faster, may miss lazy content)
  --no-robots              Ignore robots.txt
  --no-components          Skip component extraction
  --min-instances <n>      Min recurring instances to extract a component (default: 2)
  --min-depth <n>          Min subtree depth to consider for componentization (default: 2)
  --ai-components          Use an LLM to refine component names and props
  --ai-model <model>       Model for AI componentization (default: gpt-4o-mini)
  --verify                 After import, build and screenshot-diff vs the original
  --min-fidelity <n>       Fail (exit 1) below this average fidelity 0..100 (default: 25)
  --verify-threshold <n>   Per-pixel colour tolerance 0..1 for the diff (default: 0.15)
  --verify-viewport-only   Diff only the first viewport instead of the whole page
```

### What `--verify` can fail on

`--verify` builds the emitted project, serves it, screenshots every page and pixel-diffs each against a reference captured during the import. The run exits non-zero when any of three things is true: the project did not build cleanly, a page could not be rendered, or the average fidelity is below `--min-fidelity`.

`--verify-threshold` is **not** that bar. It is pixelmatch's per-pixel colour tolerance: it decides when two pixels count as the same colour, so it moves the score without ever deciding the outcome. `--min-fidelity` is the bar, and it defaults to a deliberately low `25`, a floor for "this is not a clone of anything" rather than a quality target. A faithful import of a complicated site still lands well under 100 for reasons no importer can fix (a rotating hero, a font rendering a hair differently).

`verify/report.json` carries the whole picture: per-page fidelity, the console errors and failed or 404'd requests each rendered page produced, and any build errors. When a page scores badly, read `failedRequests` first, because a percentage cannot tell you that fifteen images 404'd and that list can.

**Comparing two runs.** The reference screenshot is captured fresh each time, so two runs of the same URL are not directly comparable. On a site with a rotating hero the spread across identical runs has been measured at around 4 points, which is wide enough to hide a small regression. Compare a fidelity number against another run of the same code, not against one from a different session.

Environment: `CHROME_PATH` (explicit browser binary; otherwise `google-chrome-stable`, `google-chrome`, `chromium-browser`, or `chromium` is discovered on PATH), `OPENAI_API_KEY` and `OPENAI_BASE_URL` for `--ai-components`.

## Programmatic API

The orchestrator behind the CLI and the Studio "Import" tab:

```ts
import { importSite } from "@jxsuite/import/run";

const result = await importSite(
  {
    url: "https://example.com",
    outDir: "/abs/path/to/project", // must be empty or absent
    maxDepth: 1,
    ai: { apiKey, baseUrl, model }, // optional LLM naming pass
    signal: abortController.signal,
  },
  (e) => console.log(`[${e.phase}] ${e.message}`),
);
```

Lower-level building blocks (capture, style diffing, crawling, layout detection, componentization, emit, verify) are exported from the package root; `./capture`, `./to-jx`, `./emit`, `./run` and `./verify` are also addressable as subpaths. See `src/index.ts`.

Verification (`verify` option / `--verify`) additionally needs `@jxsuite/compiler` (an optional dependency) to build the emitted project before screenshot-diffing it.
