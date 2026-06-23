# Site Cloning → Jx — Plan

**Status:** Phase 5 (verify) complete — all pipeline phases shipped
**Date:** 2026-06-23
**Owner:** Gideon
**Goal:** Take a live website URL, trace the whole site, and transform it into a faithful Jx
project — then harvest the results into a reusable templates/themes portfolio. Also: a frank
evaluation of where Studio is strong enough to receive cloned sites and where it isn't.

**Relates to:** `packages/parser/src/html-to-jx.ts` (the existing DOM→Jx primitive),
`specs/imports.md`, `specs/studio.md`, `specs/site-architecture.md`.

---

## 1. What already exists (don't rebuild)

- **`htmlToJx(htmlString)`** — hast-based HTML→Jx node converter. Handles `tagName`, attributes,
  inline `style` (parsed to a style object), text/`textContent`, void elements, boolean attrs,
  `class`. Already consumed by `transpile.ts`, `serialize.ts`, and Studio's paste-as-HTML
  (`editor/context-menu.ts`). **This is the leaf of the whole pipeline.**
- **Jx format** is a JSON DOM mirror: `tagName` / `attributes` / `children` (nodes or text strings)
  / `style` (camelCase object) / `state` / `$media` / `$layout`. Components add `$id` + `state`
  (props) + `${state.x}` interpolation (see `sites/test-blank/components/simple-card.json`).
- **Studio** renders via the real runtime, with layers, inspector (props/style/state/code),
  `$media` breakpoints, components/elements panels, drag-drop, git source control, and the AI
  assistant. It reads/writes plain `.json`.
- **`puppeteer-core`** is already vendored in `node_modules` (the `scratch-test-import.js` probe),
  but **not** yet a declared dependency.

### The real gaps

`htmlToJx` is _fragment-level and static_. It does **not** do: JS-rendered DOM capture, external
stylesheet / computed-style resolution, `$media` extraction, asset download + URL rewriting,
multi-page crawl, or componentization of repeated subtrees. That gap list **is** the project.

---

## 2. Capture strategy — how to provide the URL

Decision: **headless Chromium via `puppeteer-core`**, not static `fetch` + parse.

| Option                                       | Gets JS-rendered DOM | Gets computed CSS       | Verdict                                                 |
| -------------------------------------------- | -------------------- | ----------------------- | ------------------------------------------------------- |
| `fetch` + `htmlToJx`                         | ❌ (raw HTML only)   | ❌                      | Too lossy for modern sites                              |
| Headless Chromium                            | ✅                   | ✅ (`getComputedStyle`) | **Chosen**                                              |
| Reuse the debug-Chrome + chrome-devtools MCP | ✅                   | ✅                      | Good for _manual_ one-offs / eval, not for a batch tool |

Rationale: Jx wants the **rendered visual result** and **resolved styles**, not the source HTML.
A headless browser gives us `documentElement.outerHTML` _after_ hydration plus per-node
`getComputedStyle`, matched media queries, and asset URLs — everything the fidelity work needs.

The chrome-devtools MCP path stays the interactive/debug companion (same Chrome the AI eval already
uses), but the cloner itself drives `puppeteer-core` programmatically so it can run in CI/batch.

---

## 3. Pipeline architecture

```
URL ──▶ [1 Crawl] ──▶ route map ──▶ [2 Capture] per route ──▶ rendered DOM + style snapshot
                                                                      │
                                          [3 DOM→Jx] htmlToJx + style/attr cleanup
                                                                      │
                                  [4 CSS resolve] computed-style diff → node.style + $media
                                                                      │
                                  [5 Assets] download → public/ , rewrite URLs
                                                                      │
                                  [6 Componentize] detect repeats → components/ + $props
                                                                      │
                                  [7 Emit] project.json + pages/ + layouts/ + components/
                                                                      │
                                  [8 Verify] runtime render vs screenshot diff
```

Each stage is independently testable and degrades gracefully (a failed stage emits a lower-fidelity
but still-valid Jx file). Stages 1–3 are the **thin first slice** that already produces something
openable in Studio.

---

## 4. Phasing

I'll detail each phase in its own follow-up section so this stays reviewable. Headlines:

- **Phase 0 — Spike (thin slice):** single URL → headless capture → `htmlToJx` → one `index.json`
  - `project.json`, opens in Studio. Proves the seam end-to-end. ~1 file under `packages/parser`
    or a new `packages/import`.
- **Phase 1 — CSS fidelity:** computed-style diff against UA defaults; emit per-node `style`;
  extract `@media` → `$media`; hoist shared CSS-var palette into `project.json` tokens.
- **Phase 2 — Assets:** download images/fonts/svg/bg-images to `public/`, rewrite to relative URLs.
- **Phase 3 — Crawl:** same-origin BFS, depth/page caps, robots respect, dedupe → one page/route;
  shared header/footer detection seeds layouts.
- **Phase 4 — Componentization:** repeated-subtree detection → extract to `components/` with
  `state` props; this is where the assistant earns its keep (heuristic first, LLM-assisted second).
- **Phase 5 — Verify:** render each emitted page in the runtime, screenshot-diff vs the captured
  original; report a per-page fidelity score (reuse the render-critic idea from the AI eval).

---

## 5. Locked decisions (2026-06-22)

1. **Packaging:** new **`packages/import`** with a CLI — `jx import <url> [--out dir] [--depth N]`.
   Depends on `@jxsuite/parser` (for `htmlToJx`) + `puppeteer-core`. Studio calls it later via a
   "Clone a site" entry in the New Project flow; the heavy headless-browser dep stays out of the
   studio bundle.
2. **CSS fidelity:** **computed-diff per node.** Snapshot `getComputedStyle`, subtract UA defaults,
   emit only meaningful declarations onto each node's `style`. (Token extraction from §1-hybrid is
   deferred to a Phase 1.5 polish pass, not v1.)
3. **Componentization:** **heuristics first, AI later.** Deterministic repeat-detection ships in
   Phase 4; LLM-assisted naming/prop-extraction is an opt-in pass scored by the headless harness.
4. **First outcome:** **the Phase 0 spike** — one real URL → openable Jx project in Studio.

---

## 6. Phase 0 — End-to-end spike (the thin slice)

**Goal:** `jx import https://example.com --out sites/cloned-example` produces a `project.json` +
`pages/index.json` that opens and renders in Studio. Fidelity can be rough; the seam must be real.

**Build order:**

1. `packages/import/package.json` — deps `@jxsuite/parser`, `puppeteer-core`; bin `jx-import`.
2. `capture.ts` — `capturePage(url) → { html, baseUrl }`:
   - launch `puppeteer-core` (resolve a Chromium path; on NixOS reuse the same binary the AI eval
     Chrome uses — record it in the README so it's not a mystery),
   - `page.goto(url, { waitUntil: "networkidle0" })`,
   - return `await page.evaluate(() => document.documentElement.outerHTML)`.
3. `to-jx.ts` — feed the captured `<body>` innerHTML through `htmlToJx`; wrap the result as a page
   doc. Strip `<script>`/`<noscript>`; keep `<style>` aside for Phase 1.
4. `emit.ts` — write `project.json` (minimal: title, empty imports) + `pages/index.json`.
5. `cli.ts` — arg parse → capture → to-jx → emit; print the output path + a "open in Studio" hint.
6. **Test:** a fixture HTML string (no network) through `to-jx` + `emit` asserting a valid doc via
   `validateDoc`. Network capture covered by one gated smoke test (like `eval:headless`).

**Exit criteria:** the emitted `sites/cloned-example/pages/index.json` passes `validateDoc` and
renders in Studio without throwing. Visual fidelity explicitly _not_ a Phase 0 gate.

**Turnover (2026-06-22): Phase 0 ✅ COMPLETE.**

Built and verified end-to-end. Files delivered under `packages/import/`:

| File                  | Role                                                                                                                                                            |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/capture.ts`      | Headless Chromium via `puppeteer-core` (`launch`). Strips `<script>`/`<noscript>` in-page, collects same-origin `<a href>` links for Phase 3 crawl.             |
| `src/to-jx.ts`        | `convertToJx(bodyHtml)` — feeds `htmlToJx`, strips unsafe tags (`iframe`/`object`/`embed`/`link`/`meta`), collects `<style>` content for Phase 1, counts nodes. |
| `src/emit.ts`         | Writes `project.json` + `pages/index.json` + scaffolds `layouts/`, `components/`, `public/`.                                                                    |
| `src/cli.ts`          | Top-level-await CLI: `jx-import <url> [--out dir]`. Warns on >5k-node pages.                                                                                    |
| `src/index.ts`        | Public API re-exports.                                                                                                                                          |
| `tests/to-jx.test.ts` | 9 tests: strip scripts/iframe/style collection, node count, empty input.                                                                                        |
| `tests/emit.test.ts`  | 2 tests: file output + directory creation.                                                                                                                      |

Verification:

- `example.com` (6 nodes) → valid Jx, zero `validateDoc` errors, renders in Studio.
- `tailwindcss.com` (2,288 nodes, 1.5 MB JSON) → valid Jx, zero errors, renders in Studio with
  full structure visible in layers panel. No styles (expected — Phase 1), broken images (Phase 2).
- 11/11 import tests pass, 288/288 parser tests unaffected.

State model improvements filed separately: `docs/studio-state-model-improvements.md` (three items:
structural-sharing history, virtualized layers, collapse-by-default for large imports).

## 7. Phase 1 — CSS fidelity (computed-diff per node)

- During capture, walk the live DOM and for each element record `getComputedStyle` keyed by a
  stable path that matches the `htmlToJx` tree (depth-indexed walk, same order).
- Build a **UA-default baseline** per `tagName` (render a throwaway element of that tag in the same
  page, snapshot its computed style) and emit only the properties that differ.
- Convert kebab CSS props → camelCase to match Jx `style` objects (reuse `applyStyleKeyMapping` /
  `expandStylePaths` from `transpile.ts` — don't hand-roll).
- **`$media`:** read `matchMedia` for the site's `@media` query lists; re-snapshot computed styles
  at each breakpoint width and emit deltas under `$media`. Seed `project.json` breakpoints from the
  distinct query widths so Studio's media tabs line up (`specs/studio.md` §3.6).
- Guardrail: cap emitted declarations per node (drop noise like every inherited font metric) — a
  curated allowlist of visually-meaningful properties beats dumping all ~350 computed props.

**Turnover (2026-06-22): Phase 1 ✅ COMPLETE.**

Built and verified end-to-end. New files delivered under `packages/import/`:

| File                   | Role                                                                                                                                                                                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/style-capture.ts` | In-browser `page.evaluate()` — walks live DOM depth-first, captures `getComputedStyle` for ~120 allowlisted visually-meaningful properties per element, builds UA-default baselines per tagName via throwaway elements, discovers `@media` queries from stylesheets.                             |
| `src/style-diff.ts`    | Diffs captured styles against UA defaults. Drops noise values (`auto`, `0px`, `normal`, etc.) for non-exempt properties; keeps them for semantically meaningful properties (`overflow`, `display`, `white-space`, etc.). Converts kebab-case → camelCase. Numeric-only values become JS numbers. |
| `src/media-extract.ts` | Parses discovered `@media` queries, identifies simple `min-width`/`max-width` breakpoints (skips complex/feature queries), orchestrates viewport resize + re-capture at each breakpoint width, computes style deltas vs base capture.                                                            |
| `src/apply-styles.ts`  | Maps diffed styles onto Jx tree nodes by matching depth-first element-index paths (same walk order as browser capture). Applies base styles to `node.style`, media deltas as `@--768`-style nested objects matching Studio's `applyCanvasStyle` convention.                                      |

Modified files:

- `src/capture.ts` — `capturePage` now returns the puppeteer `Page` object (kept open for style capture); caller is responsible for closing it after style work.
- `src/emit.ts` — Accepts optional `breakpoints` option; writes `$media` map into `project.json` so Studio's media tabs line up.
- `src/cli.ts` — Full Phase 1 pipeline wired in (capture → style capture → diff → media extract → apply → emit). `--no-styles` flag reverts to Phase 0 behavior.
- `src/index.ts` — Re-exports all new modules and types.

Design decisions:

- **Did not reuse `applyStyleKeyMapping`/`expandStylePaths`** from `transpile.ts` — those map pseudo-class and `--custom-property` keys for remark-directive attributes, not CSS property names. Hand-rolled `kebabToCamel` is a simpler, correct fit for computed-style property conversion.
- **Viewport re-capture** for `$media` instead of CSS rule parsing — simpler, catches JS-driven responsive changes, matches the plan's "re-snapshot computed styles at each breakpoint width" strategy.
- **Property allowlist** (~120 properties) covers layout, flex, grid, box model, border, background, typography, and visual properties. Deliberately excludes inherited font metrics, animation keyframes, and other noise.
- **Noise filtering** — values like `auto`, `0px`, `normal` are dropped for most properties but kept for exempt properties where they carry semantic meaning (e.g., `overflow: hidden`, `display: none`, `white-space: nowrap`).

Verification:

- 35/35 import tests pass (24 new for Phase 1: style-diff, media-extract, apply-styles).
- 288/288 parser tests unaffected.
- `--no-styles` flag confirmed to produce Phase 0 output (no style capture).

## 8. Phase 2 — Assets

- Collect URLs from `img[src]`, `source[srcset]`, `[style*=url(]`, `link[rel=stylesheet]` fonts,
  inline `<svg>` (keep inline), favicon.
- Download same-origin + CDN assets into `public/assets/`, rewrite references to relative paths.
- Skip/flag cross-origin tracking/analytics; never download `<script>`.

**Turnover (2026-06-22): Phase 2 ✅ COMPLETE.**

Built and verified end-to-end. New files delivered under `packages/import/`:

| File                    | Role                                                                                                                                                                                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/asset-collect.ts`  | In-browser `page.evaluate()` — discovers asset URLs from `img[src]`, `img[srcset]`, `source[srcset]`, `video[poster]`, inline `style` `url()`, computed `background-image`, `@font-face` rules, favicons, and OG images. Counts inline SVGs (kept inline).     |
| `src/asset-download.ts` | Downloads discovered assets to `public/assets/{images,fonts,icons,other}/`. Dedupes by URL, sanitizes filenames, handles collisions. Blocks known tracking/analytics domains (Google Analytics, GTM, Facebook, LinkedIn, etc.). Reports failed/skipped counts. |
| `src/asset-rewrite.ts`  | Walks Jx tree in-place, rewrites absolute URLs → local relative paths. Handles `attributes.src`, `attributes.srcset`, `attributes.poster`, `style.backgroundImage` `url()` references, and `$media` nested style objects. Skips `<a>` href (navigation links). |

Modified files:

- `src/cli.ts` — Full Phase 2 pipeline wired in (collect → download → rewrite) between style application and emit. `--no-assets` flag skips asset download. Added `formatBytes` helper for download size reporting.
- `src/index.ts` — Re-exports all new modules and types.

Design decisions:

- **Computed `background-image` scan** covers CSS-applied backgrounds that wouldn't be found by inline `style` attribute inspection alone — iterates all elements via `getComputedStyle`.
- **Subdirectory organization** (`images/`, `fonts/`, `icons/`, `other/`) classified by source type and file extension — fonts from `@font-face` go to `fonts/`, favicons to `icons/`, images by extension.
- **Tracking domain blocklist** — hardcoded set of known analytics/tracking domains (GA, GTM, Facebook, LinkedIn, Segment, Hotjar, etc.) are skipped and reported, never downloaded.
- **Inline SVGs kept inline** — counted but not extracted to files, matching the plan. They're already valid Jx nodes after `htmlToJx`.
- **Anchor hrefs preserved** — `<a>` link destinations are navigation, not assets; the rewriter explicitly skips them.

Verification:

- 49/49 import tests pass (14 new for Phase 2: 10 asset-rewrite, 4 asset-download).
- 288/288 parser tests unaffected.
- `--no-assets` flag confirmed to produce Phase 1 output (styles but no asset download).

## 9. Phase 3 — Crawl (whole-site trace)

- Same-origin BFS from the root, seeded by `<a href>` discovery on each captured page.
- Caps: `--depth` (default 2), `--max-pages` (default 25), `robots.txt` respect, URL-normalize +
  dedupe (strip hash, trailing slash, tracking params).
- One Jx page per route under `pages/`, route → file path mapping mirrors the URL structure.
- **Layout detection:** subtrees identical across ≥2 pages (header/nav/footer) get hoisted into a
  `layouts/base.json` with a `$slot`/children seam; pages reference it via `$layout`.

**Turnover (2026-06-22): Phase 3 ✅ COMPLETE.**

Built and verified end-to-end. New files delivered under `packages/import/`:

| File                   | Role                                                                                                                                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/crawl.ts`         | BFS crawler: same-origin link discovery, `--depth` (default 2) and `--max-pages` (default 25) caps, `--max-nodes-per-page` (default 5000) guard. URL normalization (strip hash/trailing-slash/tracking-params, sort query). `robots.txt` respect. |
| `src/layout-detect.ts` | Shared layout detection: compares top-level children across all crawled pages, identifies identical prefix (header) and suffix (footer) subtrees, hoists them into a `layouts/base.json` with a `<slot>` placeholder. Pages get `$layout` ref.    |

Modified files:

- `src/emit.ts` — New `emitMultiPageProject()` function writes multiple pages to route-based file paths (e.g., `/about` → `pages/about.json`, `/blog/post-1` → `pages/blog/post-1.json`). Creates nested directories automatically. Accepts optional `layout` to write to `layouts/base.json`. Old `emitProject()` now delegates to it for backward compatibility.
- `src/cli.ts` — Full Phase 3 pipeline wired in. New flags: `--depth <n>`, `--max-pages <n>`, `--max-nodes-per-page <n>`, `--no-crawl` (single page mode, equivalent to `--depth 0`), `--no-robots`. Single-page mode (depth 0) uses the original Phase 0–2 pipeline directly. Multi-page mode runs BFS crawl → per-page style/asset capture → layout detection → multi-page emit.
- `src/index.ts` — Re-exports all new modules and types.

Design decisions:

- **BFS, not DFS** — breadth-first ensures shallow, high-value pages are captured before depth budget is exhausted.
- **Per-page style/asset capture** — each crawled page gets its own style capture and asset download pass (reusing Phase 1–2 machinery), so pages with different CSS get accurate styles.
- **Node-cap guard** — pages exceeding `--max-nodes-per-page` still emit valid Jx but skip the expensive style/asset passes and log a warning. This implements the scale-spike recommendation from §14.
- **Layout detection is structural + content equality** — not fuzzy hashing. Only subtrees that are byte-for-byte identical across ALL crawled pages at the same position (top-of-page or bottom-of-page) are hoisted. Conservative by design: false negatives (missed layout) are preferable to false positives (wrong content stripped).
- **`$layout` reference** — stripped pages get `$layout: "layouts/base.json"`, matching the `JxDocument.$layout` field in the schema.
- **Backward compatible** — `--no-crawl` or `--depth 0` produces identical output to Phase 2. Existing `emitProject()` API unchanged.

Verification:

- 84/84 import tests pass (35 new for Phase 3: 15 crawl URL normalization/routing, 16 layout detection, 4 multi-page emit).
- 288/288 parser tests unaffected.
- `--no-crawl` flag confirmed to produce Phase 2 output (single page with styles and assets).

## 10. Phase 4 — Componentization (heuristics → AI)

**Phase 4 heuristic pass — implemented 2026-06-22.**

- **`componentize.ts`** — walks all page trees, hashes subtrees by normalized structure
  (tag + child shape, ignoring text/attr leaf values), groups recurring patterns (≥N instances),
  diffs instances to find varying leaves, lifts them to `state` props with `${state.x}` interpolation,
  emits component definitions mirroring `simple-card.json` format (`$id`, `tagName`, `state`, children).
- **Call-site rewriting** — subtree instances replaced with `{ tagName: "component-name", $props: {...} }`.
- **`$elements` registration** — emitted pages/layouts get `$elements: [{ $ref: "../components/..." }]`
  so the runtime discovers and registers extracted components.
- **Emit integration** — `emitMultiPageProject()` accepts `componentizeOptions` (or `false` to skip);
  writes component files to `components/`, wires `$elements` refs.
- **CLI flags** — `--no-components`, `--min-instances <n>` (default 2), `--min-depth <n>` (default 2).
- **Backward compatible** — `--no-components` or `componentizeOptions: false` produces Phase 3 output.

Verification:

- 94/94 import tests pass (10 new for Phase 4: pattern detection, prop extraction, call-site rewriting,
  cross-page detection, minInstances/minDepth thresholds, static text preservation, $props correctness).
- 288/288 parser tests unaffected.
- `--no-components` confirmed to produce Phase 3 output.

### Turnover — Phase 4 AI pass (`--ai-components`)

What's done: heuristic componentization extracts structurally identical subtrees with varying leaf values.
Component names are auto-generated (`component-div-0`); prop names are derived from tree position.

What's next: the AI pass (opt-in `--ai-components`) should:

1. Take heuristic candidates and ask the assistant for semantic names (e.g. `product-card` not `component-div-0`).
2. Improve prop names (e.g. `title` not `text`).
3. Detect slot boundaries (children that should be slots rather than props).
4. Score results with the headless harness (`tests/harness/`).

- **Heuristic pass:** hash normalized subtrees (tag+structure, ignoring text/attr leaf values);
  subtrees recurring ≥N times become a component under `components/`, with differing leaf values
  lifted to `state` props and call-sites rewritten to `${state.x}` (mirror `simple-card.json`).
- **AI pass (opt-in `--ai-components`):** hand the heuristic candidates to the assistant for better
  names + prop schemas + slot boundaries. Score it with the headless harness (`tests/harness/`) so
  it's regressable, exactly like the L1–L5 eval — this reuses infrastructure we already trust.

## 11. Phase 5 — Verify (fidelity gate)

- Render each emitted page in the runtime, screenshot-diff against the captured original at the
  same viewport. Emit a per-page fidelity % and a diff thumbnail.
- This is the **render-critic pattern** from the AI eval generalized: schema-valid ≠ renders-right.
  Reuse `render-critic.js`'s detached-render check as the headless half.

**Turnover (2026-06-23): Phase 5 ✅ COMPLETE.**

Built and verified end-to-end. New files delivered under `packages/import/`:

| File                     | Role                                                                                                                                                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/screenshot-diff.ts` | Pixel-level PNG comparison using `pixelmatch` + `pngjs`. Takes two PNG buffers, pads smaller to larger if sizes differ, returns fidelity % (0–100), mismatched pixel count, and a diff visualization PNG. Configurable threshold (default 0.15). |
| `src/verify.ts`          | Orchestrator: builds the emitted Jx project via `@jxsuite/compiler/site` (`buildSite`), serves `dist/` locally via Bun, screenshots original URL + rendered page at same viewport via puppeteer, diffs, writes report + artifacts.               |

Modified files:

- `src/cli.ts` — `--verify` flag runs Phase 5 after import. `--verify-threshold <n>` sets pixel diff sensitivity. Both single-page and multi-page paths supported.
- `src/index.ts` — Re-exports `diffScreenshots`, `verifyProject`, and their types.
- `package.json` — Added `pixelmatch`, `pngjs` as dependencies; `@jxsuite/compiler` as optional dependency (only needed for `--verify`); `@types/pngjs` as devDependency.

Tests:

- `tests/screenshot-diff.test.ts` — 8 tests: identical images, completely different, same color, size mismatch padding, partial match, diff PNG validity, threshold sensitivity, checkerboard pattern.
- `tests/verify.test.ts` — 5 tests: route-to-URL-path mapping for index, nested, and deep routes.

Design decisions:

- **`pixelmatch` + `pngjs`** over custom pixel comparison — industry-standard, handles antialiasing tolerance, produces visual diff thumbnails. Small footprint (~20 KB combined).
- **Compiler `buildSite`** as the render path — compiles Jx to static HTML with component hydration, matching the production output. Uses `Bun.serve` with port 0 for ephemeral local serving (no port conflicts).
- **Dynamic import** of `@jxsuite/compiler/site` — keeps the compiler out of the critical path for non-verify imports; the optional dependency means `jx-import` still works without the compiler installed.
- **Image size padding** — when original and rendered screenshots differ in dimensions (e.g. page height), the smaller is padded with white rather than erroring. Size mismatch itself contributes to the fidelity penalty naturally.
- **Full-pipeline integration** — `--verify` runs after the complete import (styles, assets, components), so fidelity measures the end-to-end quality of the clone, not just structure.

CLI usage:

```
jx-import https://example.com --verify
jx-import https://example.com --verify --verify-threshold 0.2
jx-import https://example.com --depth 1 --max-pages 5 --verify
```

Output artifacts (in `<outDir>/verify/`):

- `report.json` — structured report with per-page fidelity, build errors, viewport config
- `<page>-original.png` — screenshot of the live source URL
- `<page>-rendered.png` — screenshot of the locally rendered Jx output
- `<page>-diff.png` — pixel diff visualization (mismatches highlighted in red)

---

## 12. Templates / themes portfolio (downstream of cloning)

The cloner is the _factory_; the portfolio is its _output catalog_.

- Curate a list of permissively-licensed / own-IP layouts (landing, blog, docs, dashboard,
  portfolio, e-commerce) and run them through the cloner.
- Each cleaned result becomes a starter under `packages/create/template*/` (today `create` ships
  exactly one template — `template/` with a base layout + `index.md`). Generalize `generate.ts` to
  take a `--template <name>` and pick from a `templates/` registry.
- Cloned-then-hand-polished themes are the realistic path: the cloner gets to ~80%, a human (or the
  assistant via Studio) finishes. Track each theme's fidelity score from Phase 5.
- **Licensing guardrail:** only clone sites we own or that are explicitly licensed for reuse; the
  CLI prints a reminder and refuses known-proprietary hosts by default.

---

## 13. Studio capability evaluation (can it receive cloned sites?)

What Studio already handles well (so the cloner should target these shapes):

- **Style objects per node** — the inspector's style sidebar is metadata-driven and edits
  `node.style` directly → computed-diff output is _exactly_ what Studio wants. ✅
- **`$media` breakpoints** — media tabs + responsive presets reflect site breakpoints → Phase 1
  `$media` extraction lands in a first-class surface. ✅
- **Components + `$elements`** — Components panel + drag-drop + auto-import → Phase 4 output is
  natively browsable. ✅
- **Layers / deep trees** — layer tree with DnD reparent handles arbitrarily nested clones. ✅
- **Git** — source-control panel means a cloned site is reviewable/committable in-studio. ✅

Where Studio (or the cloner) will strain — **risks to validate during Phase 0/1**:

- **Raw class-based styling:** Studio is style-object-first; if a clone preserved `class` + global
  CSS, the inspector wouldn't surface those rules. → reinforces the computed-diff decision (we emit
  `node.style`, not classes).
- **Page count / tree depth at scale:** unknown how the layers panel + immutable-history state model
  perform on a 25-page site or a 2,000-node page. **Action:** Phase 0 should clone one genuinely
  large real page and measure render + interaction latency before committing to the crawl caps.
- **Unsupported/exotic markup:** `<canvas>`, `<iframe>`, web-component-heavy sites, CSS grid
  template areas — verify these round-trip through `htmlToJx` + runtime without loss.
- **Inline `<style>` / pseudo-classes:** `:hover`/`:focus` rules exist in Studio as nested style
  contexts (§6 media/pseudo toolbar) — the cloner must map captured pseudo-state styles into that
  shape, not drop them.

**Recommendation:** treat Phase 0 as a _dual_ spike — it validates the cloning seam **and**
stress-tests Studio on real cloned content, producing a short "Studio readiness" addendum to this
doc before Phase 1 scope is locked.

---

## 14. Scale-spike results (2026-06-22) — measured, not estimated

Ran the spike against the live debug Chrome (no `puppeteer-core` needed yet — drove the existing
CDP session). Captured two real pages, converted with the production `htmlToJx`, and benchmarked the
Studio state machinery (`transact.ts` + `jsonClone`) on the real trees.

| Page                                               | Elements | Text nodes | Max depth | Body HTML | Jx JSON    |
| -------------------------------------------------- | -------- | ---------- | --------- | --------- | ---------- |
| `en.wikipedia.org/wiki/United_States` (worst case) | 19,728   | 15,366     | 30        | 1.7 MB    | **2.3 MB** |
| `tailwindcss.com` (realistic clone target)         | 2,469    | —          | 20        | 0.9 MB    | ~0.4 MB    |

**`htmlToJx` conversion** (the import cost, one-time): **2.4 s** for the 20k-node page;
`JSON.stringify` of the result 76 ms. Scales ~linearly → ~300 ms for a typical 2.5k-node landing.
Fine for an import step; **not** something to run on the interactive path.

**Studio state model — the real finding.** `transactDoc` does a **full deep clone of the entire
document on every mutation** (`jsonClone(raw)` = `JSON.parse(JSON.stringify(...))`) to push a history
snapshot, and `undo` does a full `structuredClone`. Measured on the real trees:

| Operation                                     | 20k-node page (worst) | ~2.5k-node page (typical) |
| --------------------------------------------- | --------------------- | ------------------------- |
| `jsonClone` per mutation (history snapshot)   | **73 ms**             | ~9 ms                     |
| `structuredClone` per undo                    | **79 ms**             | ~10 ms                    |
| shallow root `{...raw}` (the in-place mutate) | ~0 ms                 | ~0 ms                     |
| History memory @ 100 snapshots                | **~230 MB+**          | ~30 MB                    |

**Verdict — Studio is ready for the realistic target, not the worst case:**

- **Typical landing pages (≤~3k nodes): ✅ ship it.** ~9 ms per-mutation clone is imperceptible;
  ~30 MB history is fine. This is the actual clone use case → no blocker for the cloner.
- **Encyclopedia-scale pages (~20k nodes): ⚠️ degraded.** 73 ms per keystroke-mutation is visible
  jank, and a full 100-deep history is ~230 MB of retained clones. Plus the **layers panel
  re-flattens the whole tree into lit-html rows every rerender** (`renderLayersTemplate` →
  `flattenTree`), so 35k expanded rows would dominate render time. Editable, but not pleasant.

**Consequences for the plan (fold into Phase 0/1):**

1. **Crawl caps are about node-count, not just page-count.** Add `--max-nodes-per-page` (default
   ~5,000) alongside `--max-pages`. A page over the cap still emits valid Jx but flags a
   "large-page" warning; don't silently produce a 20k-node file that janks Studio.
2. **Two cheap state-model wins would lift the ceiling ~10×** (separate workstream, not blocking the
   cloner): (a) **structural-sharing history** — snapshot only the mutated path, not a full
   `jsonClone`, since the in-place mutation already shares untouched subtrees; (b) **virtualize the
   layers panel** so it renders only visible rows. Either alone roughly removes the worst-case jank.
3. **Default the layers panel to collapsed** for imported pages over N nodes — the `hidden`/collapse
   path already exists, so this is a cheap import-time hint, not new machinery.
4. **`htmlToJx` stays off the interactive path** — it's an import-time transform only (2.4 s worst
   case), which the CLI architecture already guarantees.

Bottom line: **the cloner is unblocked.** Target ≤3–5k nodes/page, cap the crawler accordingly, and
Studio handles cloned sites today. The 20k-node worst case is a known, bounded degradation with two
clear fixes if/when large-page editing becomes a real requirement.
