# @jxsuite/import

Clone a live website into a Jx project: capture the rendered DOM with headless Chrome, diff
computed styles against UA defaults, extract design tokens and responsive breakpoints, download
assets, detect the shared layout across pages, componentize recurring subtrees (optionally refined
by an OpenAI-compatible LLM), and emit a ready-to-edit Jx project.

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
  --verify-threshold <n>   Pixel diff threshold 0..1 (default: 0.15)
```

Environment: `CHROME_PATH` (explicit browser binary; otherwise `google-chrome-stable`,
`google-chrome`, `chromium-browser`, or `chromium` is discovered on PATH), `OPENAI_API_KEY` and
`OPENAI_BASE_URL` for `--ai-components`.

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

Lower-level building blocks (capture, style diffing, crawling, layout detection, componentization,
emit, verify) are exported from the package root — see `src/index.ts`.

Verification (`verify` option / `--verify`) additionally needs `@jxsuite/compiler` (an optional
dependency) to build the emitted project before screenshot-diffing it.
