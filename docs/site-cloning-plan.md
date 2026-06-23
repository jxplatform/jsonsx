# Site Cloning → Jx — Plan

**Status:** Draft
**Date:** 2026-06-22
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

## 8. Phase 2 — Assets

- Collect URLs from `img[src]`, `source[srcset]`, `[style*=url(]`, `link[rel=stylesheet]` fonts,
  inline `<svg>` (keep inline), favicon.
- Download same-origin + CDN assets into `public/assets/`, rewrite references to relative paths.
- Skip/flag cross-origin tracking/analytics; never download `<script>`.

## 9. Phase 3 — Crawl (whole-site trace)

- Same-origin BFS from the root, seeded by `<a href>` discovery on each captured page.
- Caps: `--depth` (default 2), `--max-pages` (default 25), `robots.txt` respect, URL-normalize +
  dedupe (strip hash, trailing slash, tracking params).
- One Jx page per route under `pages/`, route → file path mapping mirrors the URL structure.
- **Layout detection:** subtrees identical across ≥2 pages (header/nav/footer) get hoisted into a
  `layouts/base.json` with a `$slot`/children seam; pages reference it via `$layout`.

## 10. Phase 4 — Componentization (heuristics → AI)

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
