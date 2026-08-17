/**
 * The lens/companion mutation gate — prove the derived-pane tests can tell right from wrong.
 *
 * **Why a mutation gate and not more tests.** Three review rounds each found ~10 defects in the
 * derived pane (§18.4) and each fixed the named ones. The third measured why: it flipped the
 * workstream's lens/companion discriminators one at a time, and seven behaviours turned out to be
 * indistinguishable from their opposite across eight thousand tests. This file is the standing
 * version of that measurement: a table of mutants, each with the ONE test file expected to catch
 * it, run for real. A mutant that survives is a red gate naming the behaviour that is unprotected.
 *
 * **The table is built by walking the DIFF, not by walking the fixes — and that is the whole of
 * round four's finding.** The previous table had 51 rows and was assembled from the defects each
 * round had repaired, which is a list of what somebody already thought about. An independent
 * enumeration of the workstream's diff found 32 discriminators the table did not name; eleven of
 * them, applied one at a time against a 101-file union of 3015 tests, killed nothing at all. Three
 * were `void` render-input reads whose siblings ONE LINE AWAY were in the table. Two were the
 * second half of an invariant the table protected only the first half of. Six whole modules in the
 * diff had no entry of any kind. A table of remembered defects will always have that shape; a table
 * walked from the diff can be checked.
 *
 * **How to repeat the enumeration.** From `packages/studio`:
 *
 *     { git diff -U0 -- src styles | grep '^+' | grep -v '^+++'
 *       sed 's/^/+/' src/workspace/pane-derive.ts; }              # …and any other untracked file
 *     | grep -vE '^\+\s*(\*|/\*|//)'                              # drop comments
 *     | grep -E 'derived|derivation|sourcePaneId|paneId|pane\.id|\blens\b|companion|preset|
 *                activePaneId|PRIMARY_PANE|SECONDARY_PANE|OfPane\(|paneOfTab|paneById|\bpanes\b'
 *
 * That is ~400 added lines. A line is a DISCRIMINATOR when it CHOOSES — a condition, a ternary, a
 * filter predicate, a pane-scoped resolution, a `void` read that exists to establish tracking. An
 * import, a type, an object-literal key, a bare accessor and a re-export choose nothing and get no
 * row; neither does a line whose inversion no state the app can reach could observe, which is dead
 * code rather than a defect (see the note below on the diff seed). Everything left is the table
 * below — grouped by file in the diff's own order — so the next reader can re-run the command and
 * check the result against the ids here. **The gate prints its own denominator**: how many
 * discriminators it measures, how they were enumerated, and what it deliberately does not measure —
 * see {@link printBoundary} and {@link OUTSIDE_THE_TABLE}. A kill count with no denominator reads
 * as "everything", and the honest denominator is "the behaviours somebody wrote a row for".
 *
 * **It fails both ways.** A `find` string that no longer appears — or appears twice — fails just as
 * loudly as a surviving mutant, because a mutant that cannot be applied is a mutant that proves
 * nothing. Renaming a discriminator therefore means visiting this file, which is the point: the
 * entry says in one sentence what goes wrong if the line is wrong, and that sentence is the only
 * place several of these behaviours are written down at all. **An exclusion carries a `find` too**
 * — round four's other finding. Both `browserOnly` rows had `edits: []`, so `.tab-derivation` could
 * be renamed out of existence and they would print green forever: notes wearing a mutant's clothes.
 * An excluded row's edit is never RUN, but its `find` is resolved with every other row's, before
 * anything is executed. One of the two is gone entirely — it named "a breakpoint lens's artboard is
 * fitted to its own pane", which has no implementing line separate from `fitKey`'s lens suffix and
 * `zoomOf`, both of which are in the table and killed. A row pointing at nothing is worse than no
 * row: it reads like coverage.
 *
 * **The exclusion list is now EMPTY, and that is round five's finding.** `browserOnly` still
 * exists, because a claim about a computed HEIGHT genuinely cannot be killed by a unit test —
 * happy-dom lays nothing out and every rect is 0×0. But the one row still carrying it was excluded
 * for the wrong noun: its reason was true of the height and the mutant edited the DECLARATION, and
 * happy-dom resolves the CASCADE perfectly well. `getComputedStyle` on an element in the document
 * returns the padding and border a stylesheet gave it, so `lens-chrome.test.ts` reads `shell.css`
 * off disk, renders the chip `derivationChipTpl` emits beside the chip `tabChip` emits, and
 * compares the two boxes — which also closes the rename hole the `find` could not: rename
 * `.tab-derivation` in all four of its places and the `find` still matches once, while the test
 * goes red. An exclusion is available for the next honest one; there is none today. What remains
 * uncovered by any unit test is the resulting GEOMETRY, and {@link OUTSIDE_THE_TABLE} says so in
 * the gate's own output rather than in a row that cannot fail.
 *
 * **What is deliberately NOT here.** A mutation nothing can observe is not a defect, it is dead
 * code, and a table entry for one would be a test of a fact the app does not have. `derivationFor`
 * seeding a fresh diff lens from `shell.git.diffState` was exactly that once `applyDerivation`
 * learned to clear a comparison that is not the source document's: the seed is overwritten inside
 * the same synchronous `run`, before any frame. It is written as `null` because that is the honest
 * value, and the CLEAR carries the behaviour and the mutant.
 *
 * Round four found six more of that shape and DELETED them rather than giving them rows, which is
 * the only honest way to answer "no test can tell": a second `_diffLoads.delete` reachable only
 * through a writer that already forgets; a `hit.layoutFile === path` guard whose false branch the
 * line above it makes unreachable; a `surfacesShowingTab(tab).length > 0` guard in front of a call
 * `classifyOps` has already gated in the same statement sequence; and — the largest, nine lines
 * across two panels — every `void pane.derived?.…` render-input read in `tab-strip.ts` and
 * `pane-context.ts`. Those two effects call `render()` synchronously, so the values their templates
 * read are already dependencies; the `void` lines restated them and could each be inverted with
 * nothing in the suite able to notice. `studio.ts`'s look identical and are NOT dead — that effect
 * calls `scheduleCanvasRender`, and `renderCanvasImpl` runs in a rAF, outside the tracking. Four of
 * them are in the table and all four die.
 *
 * Runs from `packages/studio`. One test FILE per mutant, not the suite, plus one baseline run per
 * distinct file — it belongs in the `checks` job beside `check-pane-singletons.ts`, not in the
 * per-workspace matrix.
 *
 * **If this process is killed with `SIGKILL`** it leaves at most ONE file mutated on disk: the one
 * named in the last `✓`/`✗`/`?` line it printed. `git diff` shows the injected edit and `git
 * checkout -- <that file>` removes it. Every other exit — a throw, a failed `expect`, a Ctrl-C —
 * restores in a `finally`; see {@link runMutant} and {@link main}.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { baselineProblemOf, MAX_OUTPUT, verdictOf } from "./mutant-verdict";
import type { Verdict } from "./mutant-verdict";

/** One source edit: a precise substring and what replaces it. Must match EXACTLY once. */
interface Edit {
  find: string;
  replace: string;
}

/**
 * A behaviour, the edit that breaks it, and the test file that must notice.
 *
 * `edits` rather than a single pair because a few mutants need a companion import to stay loadable
 * — the interesting edit plus the line that lets it run is still one mutant.
 */
interface Mutant {
  /** `file:line` of the discriminator, for the message. */
  id: string;
  /** Path relative to `packages/studio`. */
  file: string;
  /**
   * The edits. **Never empty, including for a `browserOnly` row**: an excluded mutant is not RUN,
   * but its `find` is still resolved against the file, so renaming the line it is about turns the
   * gate red instead of leaving a note that can never fail.
   */
  edits: Edit[];
  /** The one test file expected to fail. Relative to `packages/studio`. */
  test: string;
  /** What is wrong with the app if this mutant lives. One sentence, user-visible. */
  means: string;
  /** Set when the behaviour is LAYOUT and no happy-dom assertion can fail on it. */
  browserOnly?: string;
}

/**
 * A discriminator the walk found that this table carries NO ROW for, and where it stands instead.
 *
 * **A gate that states its own boundary is worth more than one that implies it has none.** The
 * table below is not the whole of the enumeration and never was; printing a kill count and nothing
 * else invites the reading that everything discriminating in the workstream is measured here. What
 * is measured here is exactly {@link MUTANTS}. This list is the rest, named — so a reader can check
 * it against a re-run of the command in the header rather than taking a number on trust.
 *
 * An entry is a CLASS, not an instance, when the class is what the reader needs: "every read the
 * existing suite already kills" is one fact about ~70 lines, and listing them one by one would be a
 * second table nobody maintains. An entry that names one line is a line whose protection is
 * genuinely thin.
 */
interface OutsideRow {
  /** What is not rowed. */
  what: string;
  /** Where the behaviour stands instead — never "nowhere" without saying so in those words. */
  standing: string;
}

const OUTSIDE_THE_TABLE: readonly OutsideRow[] = [
  {
    standing:
      "PROTECTED, but not here. Each was flipped once, one at a time, against the union of test " +
      "files that import its module, and an existing assertion failed. A row would add ~3s of gate " +
      "time apiece to re-prove a thing a test already proves; what the table is for is the " +
      "discriminator whose protection nobody could otherwise see. The cost of the omission is " +
      "real and worth stating: if the test that happens to cover one of these is later rewritten, " +
      "this gate will not notice.",
    what: "the discriminators in the diff that the existing suite already kills",
  },
  {
    standing:
      "DELETED. `markConsumed`'s empty-list guard, `renderPane`'s `kind === \"lens\" ||` disjunct, " +
      "`runUnsplit`'s `activePaneId === PRIMARY ? SECONDARY : activePaneId` fallback, " +
      "`gitChangeFor`'s null-path guard, `rawDocOf`'s `toRaw`, `pane.derive`'s `|| null` and its " +
      "trailing `target.activeTabId = null`, and the chip branch's `_lastActive`/`_overflowing` " +
      "resets. Each was verified unreachable or value-identical before removal, and the reason is " +
      "written at the line that used to be there. A mutation nothing can observe is not a gap in " +
      "the table; it is dead code, and the honest answer is to delete it rather than to invent an " +
      "assertion for it.",
    what: "the lines whose inversion no state the app can reach could observe",
  },
  {
    standing:
      "NOT COVERED BY ANY UNIT TEST, and no exclusion pretends otherwise. happy-dom performs no " +
      "layout: every rect is 0×0 and every computed HEIGHT is 0 whether a rule is right or wrong. " +
      "The DECLARATIONS underneath are covered — the cascade does resolve, which is what took the " +
      "exclusion list to zero — but the resulting geometry belongs to `packages/studio:verify` and " +
      "to the screenshot lane. Named here rather than rowed, because a row that cannot fail reads " +
      "as coverage.",
    what: "every claim about rendered GEOMETRY — the one-chip strip's height, the ⟲ trigger's fit at the 320px splitter floor, the preset popover's placement, a breakpoint lens's artboard fit",
  },
];

const MUTANTS: Mutant[] = [
  // ─── canvas/canvas-surface.ts — the pane-scoped resolvers ───────────────────
  {
    edits: [
      {
        find:
          `    derived?.kind === "lens" ? paneById(derived.sourcePaneId)?.activeTabId ` +
          `: pane?.activeTabId;`,
        replace: `    pane?.activeTabId;`,
      },
    ],
    file: "src/canvas/canvas-surface.ts",
    id: "canvas-surface.ts · tabOfPane lens hop",
    means: "a lens pane draws nothing — the whole derivation resolves through this one hop",
    test: "tests/pane-derive.test.ts",
  },
  {
    edits: [
      {
        find: `    if (tabOfPane(pane.id)?.id === tab.id) {`,
        replace: `    if (pane.activeTabId === tab.id) {`,
      },
    ],
    file: "src/canvas/canvas-surface.ts",
    id: "canvas-surface.ts · surfacesShowingTab takes the lens hop too",
    means:
      "a lens's stage is in no patch fan-out and no escalation — the projection freezes on the " +
      "last full render while the pane beside it updates",
    test: "tests/canvas-patcher.test.ts",
  },
  {
    edits: [
      {
        find: `      out.push(surfaceForPane(pane.id));\n    }\n  }\n  return out;`,
        replace: `      return [surfaceForPane(pane.id)];\n    }\n  }\n  return out;`,
      },
    ],
    file: "src/canvas/canvas-surface.ts",
    id: "canvas-surface.ts · surfacesShowingTab is PLURAL",
    means:
      "one document on two stages patches only the first; the second stops applying patches with " +
      "a wrong picture on screen and not one counter moving",
    test: "tests/canvas-patcher.test.ts",
  },
  {
    edits: [{ find: `    const base = derived.mode;`, replace: `    const base = "design";` }],
    file: "src/canvas/canvas-surface.ts",
    id: "canvas-surface.ts · canvasModeOfPane lens mode",
    means: "a Code lens draws the design board instead of the editor",
    test: "tests/canvas-render.test.ts",
  },
  {
    edits: [
      {
        find: `    return ui?.preview && (base === "edit" || base === "design") ? "preview" : base;`,
        replace: `    return base;`,
      },
    ],
    file: "src/canvas/canvas-surface.ts",
    id: "canvas-surface.ts · the preview toggle composes onto a lens's mode",
    means:
      "the author puts the page into Preview and the lens beside it keeps drawing artboards — " +
      "two panes on one document disagreeing about whether it is a preview",
    test: "tests/canvas-surface.test.ts",
  },
  {
    edits: [
      {
        find:
          `  if (derived?.kind === "lens" && derived.preset === "breakpoint") {\n` +
          `    return derived.media;\n  }`,
        replace: `  if (false as boolean) {\n    return null;\n  }`,
      },
    ],
    file: "src/canvas/canvas-surface.ts",
    id: "canvas-surface.ts · activeMediaOfPane lens branch",
    means:
      "a breakpoint lens reports the SOURCE tab's breakpoint, so every consumer of it — the " +
      "active artboard, its header, the panel a click resolves to — names the wrong one",
    test: "tests/canvas-surface.test.ts",
  },

  // ─── canvas/canvas-utils.ts — the geometry a lens owns ──────────────────────
  {
    edits: [
      {
        find: `  if (derived?.kind === "lens") {\n    return derived.zoom;\n  }`,
        replace: `  if (false as boolean) {\n    return 1;\n  }`,
      },
    ],
    file: "src/canvas/canvas-utils.ts",
    id: "canvas-utils.ts · zoomOf lens READ",
    means: "the zoom pod in a lens reports the pane beside it",
    test: "tests/canvas-utils.test.ts",
  },
  {
    edits: [{ find: `    derived.zoom = zoom;\n    return;`, replace: `    void derived;` }],
    file: "src/canvas/canvas-utils.ts",
    id: "canvas-utils.ts · setZoomOf lens WRITE",
    means: "zooming a lens zooms the pane beside it — the author's own document changes scale",
    test: "tests/canvas-utils.test.ts",
  },
  {
    edits: [
      {
        find:
          '  const lens = derivationOfPane(surface.paneId)?.kind === "lens" ' +
          '? `::${surface.paneId}` : "";',
        replace: `  const lens = "";`,
      },
    ],
    file: "src/canvas/canvas-utils.ts",
    id: "canvas-utils.ts · fitKey lens suffix",
    means: "the lens and the pane it derives from share ONE declared fit and re-frame each other",
    test: "tests/canvas-utils.test.ts",
  },
  {
    edits: [
      {
        find: `  const activeMedia = activeMediaOfPane(surface.paneId);\n  for (const p of surface.panels) {`,
        replace: `  const activeMedia = tabOfSurface(surface)?.session.ui.activeMedia ?? null;\n  for (const p of surface.panels) {`,
      },
    ],
    file: "src/canvas/canvas-utils.ts",
    id: "canvas-utils.ts · updateActivePanelHeaders",
    means: "the artboard header marked active in a breakpoint lens is the source tab's breakpoint",
    test: "tests/canvas-utils.test.ts",
  },

  // ─── canvas/canvas-helpers.ts ───────────────────────────────────────────────
  {
    edits: [
      {
        find: `import { activeCanvasSurface, activeMediaOfPane } from "./canvas-surface";`,
        replace:
          `import { activeCanvasSurface, tabOfPane } from "./canvas-surface";\n` +
          `const activeMediaOfPane = (paneId: string): string | null =>\n` +
          `  tabOfPane(paneId)?.session.ui.activeMedia ?? null;`,
      },
    ],
    file: "src/canvas/canvas-helpers.ts",
    id: "canvas-helpers.ts · panelOfSurface breakpoint",
    means:
      "a lens's \"current panel\" is the SOURCE pane's breakpoint, so the block bar, the " +
      "style context and every panel-relative measurement address the wrong artboard",
    test: "tests/canvas-helpers.test.ts",
  },

  // ─── canvas/canvas-patcher.ts — surgical patching with two stages ───────────
  {
    edits: [{ find: `  if (!panes?.has(paneId)) {`, replace: `  if (!panes) {` }],
    file: "src/canvas/canvas-patcher.ts",
    id: "canvas-patcher.ts · the consumed mark is PER PANE",
    means:
      "one document in two panes means the first doc-effect to arrive eats the only mark, and " +
      "the second pane full-renders every surgically patched edit while `skippedFullRenders` " +
      "reports a win — workstream 1's result inverted and reported as a success",
    test: "tests/canvas-patcher.test.ts",
  },
  {
    edits: [
      {
        find: `  panes.delete(paneId);\n  if (panes.size === 0) {\n    _consumed.delete(raw);\n  }`,
        replace: `  void paneId;`,
      },
    ],
    file: "src/canvas/canvas-patcher.ts",
    id: "canvas-patcher.ts · the mark is ONE-SHOT",
    means:
      "a tab switch and every repeat trigger skip the full render they need, because the mark " +
      "from one edit never clears",
    test: "tests/canvas-patcher.test.ts",
  },
  {
    edits: [
      {
        find: `    const mode = canvasModeOfPane(candidate.paneId);\n    return mode === "design" || mode === "edit";`,
        replace: `    void candidate;\n    return true;`,
      },
    ],
    file: "src/canvas/canvas-patcher.ts",
    id: "canvas-patcher.ts · only a stage that CAN patch is marked as patched",
    means:
      "opening Code beside a page and typing marks the lens as patched, its doc-effect returns " +
      "before `scheduleCanvasRender`, and the source fast path — the only thing that refreshes a " +
      "source-mode Monaco — never runs: the Code view sits frozen and is counted as a win",
    test: "tests/canvas-patcher.test.ts",
  },
  {
    edits: [
      {
        find: `  const patchable = patchableSurfaces(tab);\n  if (patchable.length === 0) {`,
        replace: `  const patchable = patchableSurfaces(tab);\n  if (patchable.length !== showing.length) {`,
      },
    ],
    file: "src/canvas/canvas-patcher.ts",
    id: "canvas-patcher.ts · a showing stage that cannot patch is SKIPPED, not a rejection",
    means:
      "opening a Code lens beside a page kills surgical patching for the page itself — every " +
      "keystroke rejects as `mode-source` and full-renders both stages",
    test: "tests/canvas-patcher.test.ts",
  },
  {
    edits: [
      {
        find: `  for (const surface of patchable) {\n    const { panels } = surface;`,
        replace: `  for (const surface of showing) {\n    const { panels } = surface;`,
      },
    ],
    file: "src/canvas/canvas-patcher.ts",
    id: "canvas-patcher.ts · readiness is asked of the stages that will TAKE the patch",
    means:
      "a Code lens has no artboards, so asking it for ready panels rejects every batch as " +
      "`no-panels` — the same defect as the row above, arriving through the other gate",
    test: "tests/canvas-patcher.test.ts",
  },
  {
    edits: [
      {
        find: `  for (const surface of surfacesShowingTab(tab)) {\n    _ctx?.scheduleCanvasRender(surface.paneId);`,
        replace: `  for (const surface of surfacesShowingTab(tab).slice(0, 1)) {\n    _ctx?.scheduleCanvasRender(surface.paneId);`,
      },
    ],
    file: "src/canvas/canvas-patcher.ts",
    id: "canvas-patcher.ts · an escalation repaints EVERY stage that was handed the patch",
    means:
      "a document on two stages was handed the patch in both, so a failure leaves the second one " +
      "showing a DOM that no longer matches its document, with nothing scheduled to fix it",
    test: "tests/canvas-patcher.test.ts",
  },

  // ─── canvas/iframe-host.ts — the generation each frame checks against ───────
  {
    edits: [
      {
        find: `      if (!stage) {\n        recordEscalation("host-stage-unresolved");\n        continue;\n      }\n      const gen = stage.renderGeneration;`,
        replace: `      const gen = stage?.renderGeneration ?? 0;`,
      },
    ],
    file: "src/canvas/iframe-host.ts",
    id: "iframe-host.ts · a stage we cannot name is a stage we cannot patch",
    means:
      "a host whose surface is mid-mutation is posted gen `0`, the frame answers " +
      "`patch-behind-render`, the same failing lookup swallows the escalation, `posted` was " +
      "incremented so nothing throws, and the edit disappears with no counter moving",
    test: "tests/canvas-idle.test.ts",
  },
  {
    edits: [
      {
        find: `        recordEscalation("host-stage-unresolved");\n        continue;`,
        replace: `        continue;`,
      },
    ],
    file: "src/canvas/iframe-host.ts",
    id: "iframe-host.ts · the skipped host MOVES A COUNTER",
    means:
      '"nothing was posted and nothing was wrong" and "nothing was posted because we could not ' +
      'name the stage" become the same answer in `__jxCanvasPerf`',
    test: "tests/canvas-idle.test.ts",
  },
  {
    edits: [
      {
        find:
          `      const gen = stage.renderGeneration;\n` +
          `      // Only the host that originated this edit already has the DOM the patch describes. A`,
        replace:
          `      const gen = allCanvasSurfaces()[0]?.renderGeneration ?? stage.renderGeneration;\n` +
          `      // Only the host that originated this edit already has the DOM the patch describes. A`,
      },
      {
        find: `import { canvasBaseOrigin } from "./canvas-origin";`,
        replace:
          `import { canvasBaseOrigin } from "./canvas-origin";\n` +
          `import { allCanvasSurfaces } from "./surface-registry";`,
      },
    ],
    file: "src/canvas/iframe-host.ts",
    id: "iframe-host.ts · the generation is resolved PER HOST",
    means:
      "one number fanned to every host rendering the tab: whichever pane had rendered more " +
      "recently holds the higher `renderedGen` and silently stops applying patches",
    test: "tests/two-pane-hosts.test.ts",
  },

  // ─── canvas/iframe-entry.ts ─────────────────────────────────────────────────
  {
    edits: [
      {
        find: `        channel.post({ gen, kind: "patchError", message: "patch-behind-render" });\n        return;`,
        replace: `        return;`,
      },
    ],
    file: "src/canvas/iframe-entry.ts",
    id: "iframe-entry.ts · a frame that is BEHIND says so",
    means:
      "the frame drops the edit and returns, so the parent never escalates and the stage keeps a " +
      "picture that does not match its document",
    test: "tests/iframe-entry.test.ts",
  },

  // ─── canvas/canvas-render.ts — what a derived stage draws ───────────────────
  {
    edits: [
      {
        find: `    const derived = derivationOfPane(surface.paneId);\n    if (derived) {`,
        replace: `    const derived = derivationOfPane(surface.paneId);\n    if (false as boolean) {`,
      },
    ],
    file: "src/canvas/canvas-render.ts",
    id: "canvas-render.ts · unresolved derivation notice",
    means: "a companion with nothing to show draws a blank stage with no way out",
    test: "tests/canvas-render.test.ts",
  },
  {
    edits: [
      {
        find: `renderDerivationNotice(surface, derived.reason || "Looking for something to show here…");`,
        replace: `renderDerivationNotice(surface, derived.reason);`,
      },
    ],
    file: "src/canvas/canvas-render.ts",
    id: "canvas-render.ts · a derivation with no sentence yet still has words",
    means:
      "`reason` is empty for every answer that is not `unavailable`, so a companion in its first " +
      "frame draws an empty state with an empty message — a blank card that reads as a broken pane",
    test: "tests/canvas-render.test.ts",
  },
  {
    edits: [
      {
        find: `  if (staleDerivation?.status === "unavailable" && staleDerivation.reason) {`,
        replace: `  if (false as boolean && staleDerivation) {`,
      },
    ],
    file: "src/canvas/canvas-render.ts",
    id: "canvas-render.ts · a RESOLVED derivation that went stale says so",
    means:
      "a companion that already opened a document goes stale in silence, still drawing a file " +
      "it is no longer about — and a Code lens mounts a second Monaco model on one URI",
    test: "tests/canvas-render.test.ts",
  },
  {
    edits: [
      {
        find: `      staleDerivation.kind === "companion" ? tab : null,`,
        replace: `      null,`,
      },
    ],
    file: "src/canvas/canvas-render.ts",
    id: "canvas-render.ts · the stale notice NAMES the document a companion still holds",
    means:
      'the strip draws a real chip with a real ✕ for `base.json` while the stage says "This page ' +
      'has no layout." — both true, about different things, with nothing saying why the named ' +
      "file is not drawn or how to get it back",
    test: "tests/canvas-render.test.ts",
  },
  {
    edits: [
      {
        find: `    derivationOfPane(surface.paneId)?.kind !== "lens" &&`,
        replace: `    true &&`,
      },
    ],
    file: "src/canvas/canvas-render.ts",
    id: "canvas-render.ts · no Document Header in a lens",
    means: "two frontmatter cards edit one document side by side",
    test: "tests/canvas-render.test.ts",
  },
  {
    edits: [
      {
        find: `  const lensDiff = paneDiff?.kind === "lens" && paneDiff.preset === "diff";`,
        replace: `  const lensDiff = false as boolean;`,
      },
    ],
    file: "src/canvas/canvas-render.ts",
    id: "canvas-render.ts · a diff lens draws its OWN comparison",
    means: "a Diff lens renders whatever file the Git panel last opened",
    test: "tests/canvas-render.test.ts",
  },
  {
    edits: [
      {
        find: `    lens?.kind === "lens" && lens.preset === "breakpoint" ? (lens.media ?? "base") : null;`,
        replace: `    null;`,
      },
    ],
    file: "src/canvas/canvas-render.ts",
    id: "canvas-render.ts · a breakpoint lens draws ONE artboard",
    means: "the breakpoint lens is a second copy of the whole design board",
    test: "tests/canvas-render.test.ts",
  },
  {
    edits: [
      {
        find: `    lens?.kind === "lens" && lens.preset === "breakpoint" ? (lens.media ?? "base") : null;`,
        replace: `    lens?.kind === "lens" && lens.preset === "breakpoint" ? (lens.media ?? "") : null;`,
      },
    ],
    file: "src/canvas/canvas-render.ts",
    id: "canvas-render.ts · BASE is an artboard name, not an absence",
    means:
      "a Base breakpoint lens matches no panel, takes the `chosen.length > 0` fallback and draws " +
      "the whole design board — the one media the row above cannot tell from a deleted one",
    test: "tests/canvas-render.test.ts",
  },
  {
    edits: [
      {
        find: `      if (lensDiff) {\n        renderDerivationNotice(surface, paneDiff.reason || "Loading this file's changes…");\n        return;\n      }`,
        replace: `      if (false as boolean) {\n        return;\n      }`,
      },
    ],
    file: "src/canvas/canvas-render.ts",
    id: "canvas-render.ts · a diff lens never takes the design fallback",
    means: "a diff lens whose comparison has not landed writes the SOURCE tab's canvas mode",
    test: "tests/canvas-render.test.ts",
  },

  // ─── commands/live-context.ts ───────────────────────────────────────────────
  {
    edits: [
      { find: `    ctx.pane.count = workspace.panes.length;`, replace: `    ctx.pane.count = 1;` },
    ],
    file: "src/commands/live-context.ts",
    id: "live-context.ts · the pane count counts PANES",
    means:
      "it counted the focused pane's strip, so a split grid answered 1 and a grid with no open " +
      "document answered 0 — and `probe.state()` publishes this to the screenshot pipeline",
    test: "tests/commands-live-context.test.ts",
  },
  {
    edits: [
      {
        find: `    ctx.pane.derived = workspace.panes.some((pane) => pane.derived !== null);`,
        replace: `    ctx.pane.derived = false;`,
      },
    ],
    file: "src/commands/live-context.ts",
    id: "live-context.ts · a derived pane in the grid is REPORTED",
    means:
      "declared and never assigned — every `ctx.pane.derived` predicate is permanently off, and " +
      "the assistant and the screenshot pipeline both read the hard-coded answer",
    test: "tests/commands-live-context.test.ts",
  },

  // ─── files/files.ts — what a companion's opener actually does ───────────────
  {
    edits: [
      {
        find: `  if (wanted !== undefined && holder && holder.id !== wanted) {`,
        replace: `  if (wanted !== undefined && holder) {`,
      },
    ],
    file: "src/files/files.ts",
    id: "files.ts · a tab already in the requested pane is still ACTIVATED",
    means:
      "re-opening the document a pane is already showing takes the third case's early return, so " +
      "the request is swallowed and the keyboard never arrives in the pane that was named",
    test: "tests/files.test.ts",
  },
  {
    edits: [
      {
        find: `    if (holder.activeTabId === tabId) {\n      return;\n    }\n    moveTabToPane(tabId, wanted);`,
        replace: `    moveTabToPane(tabId, wanted);`,
      },
    ],
    file: "src/files/files.ts",
    id: "files.ts · revealOpenTab leaves another pane's ACTIVE tab where it is",
    means:
      "a companion resolving to the document the author is editing yanks it out of their pane " +
      "and into the assistant one, and the follow then re-resolves against whatever landed in " +
      "its place — the oscillation the third case exists to stop",
    test: "tests/files.test.ts",
  },
  {
    edits: [
      {
        find: `  await openFileInTab(path, { focus: false, paneId, preview: true });`,
        replace: `  await openFileInTab(path, { focus: true, paneId, preview: true });`,
      },
    ],
    file: "src/files/files.ts",
    id: "files.ts · a following pane does not take the keyboard",
    means:
      "every retarget of a companion moves the caret out of the document the author is typing " +
      "in — and a following pane that steals focus has nothing left to follow",
    test: "tests/files.test.ts",
  },

  // ─── panels/block-action-bar.ts ─────────────────────────────────────────────
  {
    edits: [
      {
        find: `import { activeCanvasSurface, stageContaining } from "../canvas/canvas-surface";`,
        replace: `import { stageContaining, surfacesShowingTab } from "../canvas/canvas-surface";\nconst activeCanvasSurface = () => surfacesShowingTab(activeTab.value)[0] ?? { wrap: null };`,
      },
    ],
    file: "src/panels/block-action-bar.ts",
    id: "block-action-bar.ts · the bar is clipped against the FOCUSED pane's stage",
    means:
      "with a document displayed in two panes the bar is clipped against whichever pane comes " +
      "first in the grid, and the keyboard is returned to a stage the author is not typing in",
    test: "tests/block-action-bar-coverage-gaps.test.ts",
  },

  // ─── panels/jump-bar.ts ─────────────────────────────────────────────────────
  {
    edits: [
      {
        find: `    command: derived ? "pane.pin" : "palette.openFiles",`,
        replace: `    command: "palette.openFiles",`,
      },
    ],
    file: "src/panels/jump-bar.ts",
    id: "jump-bar.ts · a derived pane's leading verb is Keep",
    means: "the address bar of a following pane offers Open, and never offers the way to stop it",
    test: "tests/lens-chrome.test.ts",
  },
  {
    edits: [
      {
        find: `  const segments = jumpSegments(tabOfPane(paneId), derivationOfPane(paneId));`,
        replace: `  const segments = jumpSegments(tabOfPane(paneId), null);`,
      },
    ],
    file: "src/panels/jump-bar.ts",
    id: "jump-bar.ts · the bar asks about ITS pane's derivation",
    means: "the derived pane's address bar is drawn as an ordinary one, Keep and all",
    test: "tests/jump-bar.test.ts",
  },

  // ─── panels/pane-context.ts ─────────────────────────────────────────────────
  {
    edits: [
      {
        find: `  const lens = derivationOfPane(paneId)?.kind === "lens";`,
        replace: `  const lens = derivationOfPane(paneId)?.kind === "companion";`,
      },
    ],
    file: "src/panels/pane-context.ts",
    id: "pane-context.ts · a lens draws no axis that WRITES",
    means: "the Editor and View pickers in a lens flip the mode of the document beside it",
    test: "tests/lens-chrome.test.ts",
  },
  {
    edits: [
      {
        find: `  const deriveReason = deriveRefusal(paneId);`,
        replace: `  const deriveReason = registry?.disabledReason("pane.derive") ?? null;`,
      },
    ],
    file: "src/panels/pane-context.ts",
    id: "pane-context.ts · the preset menu answers about ITS pane",
    means:
      "a pane's own menu reports the focused pane's answer, so every row in the unfocused " +
      "pane's menu is disabled the moment the author clicks the lens beside it",
    test: "tests/lens-chrome.test.ts",
  },
  {
    edits: [
      {
        find: `  for (const media of tab && !derived ? declaredMedia(tab) : []) {`,
        replace: `  for (const media of tab ? declaredMedia(tab) : []) {`,
      },
    ],
    file: "src/panels/pane-context.ts",
    id: "pane-context.ts · a derived pane is offered no breakpoint rows",
    means: "a lens's own menu lists breakpoint rows that can never run",
    test: "tests/lens-chrome.test.ts",
  },
  {
    edits: [
      {
        find: `  const media = activeMediaOfPane(paneId);`,
        replace: `  const media = (tabOfPane(paneId)?.session.ui.activeMedia ?? null) as string | null;`,
      },
    ],
    file: "src/panels/pane-context.ts",
    id: "pane-context.ts · the lens Context axis names ITS breakpoint",
    means:
      "the stage draws the Tablet artboard and the axis beside it says Base — the one axis " +
      "the preset is named after, lying about the preset",
    test: "tests/lens-chrome.test.ts",
  },
  {
    edits: [
      {
        find: `      disabled: deriveReason ?? presetRefusal(preset, paneId, null),`,
        replace: `      disabled: deriveReason,`,
      },
    ],
    file: "src/panels/pane-context.ts",
    id: "pane-context.ts · per-preset refusals reach the row",
    means: "Code over a pane already showing Code, and Layout over a page with none, are offered",
    test: "tests/lens-chrome.test.ts",
  },
  {
    edits: [
      { find: `                focusPane(row.pane);`, replace: `                void row.pane;` },
    ],
    file: "src/panels/pane-context.ts",
    id: "pane-context.ts · a menu row acts on the pane it is a row of",
    means:
      "the secondary pane's menu derives from the primary and its Unsplit closes the wrong " +
      "pane — by keyboard only, because pane focus is a pointerdown handler",
    test: "tests/lens-chrome.test.ts",
  },
  {
    edits: [
      {
        find: `      disabled: deriveReason ?? presetRefusal("breakpoint", paneId, media),`,
        replace: `      disabled: deriveReason,`,
      },
    ],
    file: "src/panels/pane-context.ts",
    id: "pane-context.ts · the breakpoint row carries its own refusal",
    means:
      "the one row `MODE_FOR_PRESET` was written for goes live over a document with no Design " +
      'view — "Same page at Base" opening a pane whose stage can only draw an empty artboard',
    test: "tests/lens-chrome.test.ts",
  },
  {
    edits: [
      {
        find: `      workspace.panes.length > 1 ? null : (registry?.get("pane.unsplit")?.requires ?? null),`,
        replace: `      null,`,
      },
    ],
    file: "src/panels/pane-context.ts",
    id: "pane-context.ts · Close Side Pane says why it cannot run",
    means: 'a live "Close Side Pane" on a grid that has no side pane, and no sentence saying so',
    test: "tests/lens-chrome.test.ts",
  },
  {
    edits: [
      {
        find: `              if (row.disabled === null) {`,
        replace: `              if (true) {`,
      },
    ],
    file: "src/panels/pane-context.ts",
    id: "pane-context.ts · a disabled row is inert, the focus included",
    means:
      "clicking a row that cannot act moves the author's keyboard into that pane anyway — and " +
      "throws `CommandUnavailableError` out of a click listener on the way",
    test: "tests/lens-chrome.test.ts",
  },
  {
    edits: [
      {
        find: `      ${"${"}lens ? nothing : readOnlyBannerTemplate(tab)}`,
        replace: `      ${"${"}readOnlyBannerTemplate(tab)}`,
      },
    ],
    file: "src/panels/pane-context.ts",
    id: "pane-context.ts · a lens draws no read-only banner",
    means:
      "the projection announces a collaboration session it is not in, twice on one screen, about " +
      "a document it does not own",
    test: "tests/lens-chrome.test.ts",
  },
  {
    edits: [
      {
        find: `  const mode = canvasModeOfPane(paneId);`,
        replace: `  const mode = tab.session.ui.canvasMode;`,
      },
    ],
    file: "src/panels/pane-context.ts",
    id: "pane-context.ts · the zoom pod is drawn from THIS pane's mode",
    means:
      "the pod asks what the shared TAB is showing, so a lens gets the controls of the pane " +
      "beside it — an `editZoom` slider over a stage drawing Design, or no pod at all over one " +
      "that has a fit",
    test: "tests/lens-chrome.test.ts",
  },
  {
    edits: [{ find: `  const zoom = stageZoom(surface);`, replace: `  const zoom = stageZoom();` }],
    file: "src/panels/pane-context.ts",
    id: "pane-context.ts · the pod READS this pane's scale",
    means: "a lens at 40% reports whatever the focused pane is at",
    test: "tests/lens-chrome.test.ts",
  },
  {
    edits: [
      {
        find: `${"${"}zoomButton("Zoom out (Ctrl+-)", "−", () => setUserZoom(stageZoom(surface) / 1.2, surface))}`,
        replace: `${"${"}zoomButton("Zoom out (Ctrl+-)", "−", () => setUserZoom(stageZoom() / 1.2))}`,
      },
    ],
    file: "src/panels/pane-context.ts",
    id: "pane-context.ts · the pod's − WRITES this pane's scale",
    means:
      "zooming out on the projection divides the focused pane's scale and writes the result onto " +
      "the focused pane — the author presses − on one pane and the other one shrinks",
    test: "tests/lens-chrome.test.ts",
  },
  {
    edits: [
      {
        find: `${"${"}zoomButton("Zoom in (Ctrl+=)", "+", () => setUserZoom(stageZoom(surface) * 1.2, surface))}`,
        replace: `${"${"}zoomButton("Zoom in (Ctrl+=)", "+", () => setUserZoom(stageZoom() * 1.2))}`,
      },
    ],
    file: "src/panels/pane-context.ts",
    id: "pane-context.ts · the pod's + WRITES this pane's scale",
    means: "the same, magnifying — the two buttons are two expressions and only one was covered",
    test: "tests/lens-chrome.test.ts",
  },

  // ─── panels/properties-panel.ts ─────────────────────────────────────────────
  {
    edits: [
      {
        find: `\${deriveRefusal(workspace.activePaneId) === null ? openLayoutTpl() : nothing}`,
        replace: `\${openLayoutTpl()}`,
      },
    ],
    file: "src/panels/properties-panel.ts",
    id: "properties-panel.ts · Open Layout → is drawn only where it can run",
    means:
      "the chip is drawn in a lens-focused shell — the layout click that put it there focused " +
      "the lens — where `pane.derive` can only throw into a `void` that swallows it",
    test: "tests/properties-panel.test.ts",
  },

  // ─── panels/tab-strip.ts ────────────────────────────────────────────────────
  {
    edits: [
      {
        find:
          `    derived.kind === "lens" && derived.preset === "breakpoint"\n` +
          '      ? `${PRESET_LABELS.breakpoint} ${derived.media ? mediaDisplayName(derived.media) : "Base"}`\n' +
          `      : PRESET_LABELS[derived.preset];`,
        replace: `    PRESET_LABELS[derived.preset];`,
      },
    ],
    file: "src/panels/tab-strip.ts",
    id: "tab-strip.ts · the breakpoint chip names its breakpoint",
    means: 'every breakpoint lens\'s only chip reads "Same page at" and never says at WHAT',
    test: "tests/lens-chrome.test.ts",
  },
  {
    edits: [
      {
        find: `  if (derived && pane.tabOrder.length === 0) {`,
        replace: `  if (derived && derived.kind === "lens") {`,
      },
    ],
    file: "src/panels/tab-strip.ts",
    id: "tab-strip.ts · an unresolved companion draws its chip too",
    means: "a companion whose rule has not resolved has no chip and no ✕ — no way out of the pane",
    test: "tests/lens-chrome.test.ts",
  },
  {
    edits: [
      {
        find: `  const of = tabOfPane(pane.id) ?? tabOfPane(derived.sourcePaneId);`,
        replace: `  const of = tabOfPane(pane.id);`,
      },
    ],
    file: "src/panels/tab-strip.ts",
    id: "tab-strip.ts · the chip names what it is a projection OF",
    means:
      'an unresolved companion\'s chip says "no document" about a derivation that knows exactly',
    test: "tests/lens-chrome.test.ts",
  },
  {
    edits: [
      {
        find: `<span class="tab-derivation-of">${"${"}of ? tabLabel(of) : "no document"}</span>`,
        replace: `<span class="tab-derivation-of">${"${"}of ? tabLabel(of) : ""}</span>`,
      },
    ],
    file: "src/panels/tab-strip.ts",
    id: "tab-strip.ts · a chip whose source shows nothing SAYS SO",
    means:
      'the chip of a derivation whose source pane has no document reads "Code ·" and stops — a ' +
      "sentence with its subject missing, in the one row that says what the pane is",
    test: "tests/lens-chrome.test.ts",
  },
  {
    edits: [
      {
        find:
          `      class=\${classMap({ focused: isPaneFocused(pane.id), "tab-strip-row": true })}\n` +
          `      @mousedown=\${() => focusPane(pane.id)}`,
        replace:
          `      class=\${classMap({ focused: isPaneFocused(pane.id), "tab-strip-row": true })}\n` +
          `      @mousedown=\${() => void pane.id}`,
      },
    ],
    file: "src/panels/tab-strip.ts",
    id: "tab-strip.ts · the chip row focuses ITS pane",
    means:
      "a click on an unfocused derived pane's chip row reaches no cell of its own in the " +
      "one-stage shell, so its ✕ and everything else in the row run against the pane holding " +
      "the keyboard",
    test: "tests/lens-chrome.test.ts",
  },

  // ─── studio.ts — the per-pane render inputs and the drill-in ────────────────
  {
    edits: [{ find: `  const target = receivingPane();`, replace: `  const target = sidePane();` }],
    file: "src/studio.ts",
    id: 'studio.ts · "Edit definition" lands in a pane that can OWN the tab',
    means:
      "the definition lands in a lens's `tabOrder`, where `tabOfPane` hops straight past it — " +
      "the read-back gets the SOURCE tab and §14.2's `openedFrom` is skipped without a sound",
    test: "tests/studio-shell.test.ts",
  },
  {
    edits: [
      {
        find: `      if (doc && consumePatchedDocument(doc, paneId)) {`,
        replace: `      if (doc && consumePatchedDocument(doc, PRIMARY_PANE)) {`,
      },
    ],
    file: "src/studio.ts",
    id: "studio.ts · each pane consumes ITS OWN patch mark",
    means:
      "the side pane's doc-effect answers with the primary's mark, so one pane skips a render it " +
      "owed and the other repeats one it did not",
    test: "tests/studio-shell.test.ts",
  },
  {
    edits: [{ find: `    void derived?.status;`, replace: `    void 0;` }],
    file: "src/studio.ts",
    id: "studio.ts · a derivation's STATUS is a render input",
    means:
      "a diff lens whose comparison lands goes `loading` → `ready` with no other reactive write " +
      'anywhere near the pane, so the stage goes on drawing "Loading this file\'s changes…" over ' +
      "a comparison it is already holding",
    test: "tests/studio-shell.test.ts",
  },
  {
    edits: [{ find: `    void derived?.reason;`, replace: `    void 0;` }],
    file: "src/studio.ts",
    id: "studio.ts · a derivation's SENTENCE is a render input",
    means:
      "the stage keeps printing the previous reason a derivation was unavailable for — a diff " +
      "lens that could not be read, whose file is saved back to HEAD, never says so",
    test: "tests/studio-shell.test.ts",
  },
  {
    edits: [
      {
        find: `      void derived.mode;\n      void derived.media;`,
        replace: `      void 0;`,
      },
    ],
    file: "src/studio.ts",
    id: "studio.ts · a lens's MODE and MEDIA are render inputs",
    means:
      "a preset change and a breakpoint change live on the derivation rather than on the tab, so " +
      "without them the lens keeps drawing whatever it was created with",
    test: "tests/studio-shell.test.ts",
  },
  {
    edits: [
      {
        find: `  installDerivationEffects(paneId, derivationDeps);`,
        replace: `  void installDerivationEffects;`,
      },
    ],
    file: "src/studio.ts",
    id: "studio.ts · the shell INSTALLS the follow",
    means:
      "§18.4's whole follow never runs in the app: every derived pane is a static projection of " +
      "the frame it was created in, and no behavioural test in the package noticed",
    test: "tests/studio-shell.test.ts",
  },
  {
    edits: [
      {
        find: `const derivationDeps: DerivationDeps = { loadDiff: loadDiffForLens, openFileInPane };`,
        replace: `const derivationDeps: DerivationDeps = { loadDiff: () => Promise.resolve(null), openFileInPane };`,
      },
    ],
    file: "src/studio.ts",
    id: "studio.ts · the Diff lens's reader is the GIT one",
    means:
      'every Diff lens says "Could not read this file\'s comparison against HEAD." forever — the ' +
      "follow is installed and asks a reader that answers nothing",
    test: "tests/studio-shell.test.ts",
  },

  // ─── workspace/workspace.ts — the grid facts ────────────────────────────────
  {
    edits: [
      {
        find:
          `    return pane.derived?.kind === "lens"\n` +
          `      ? (paneById(pane.derived.sourcePaneId)?.activeTabId ?? null)\n` +
          `      : pane.activeTabId;`,
        replace: `    return pane.activeTabId;`,
      },
    ],
    file: "src/workspace/workspace.ts",
    id: "workspace.ts · activeTabId lens hop",
    means:
      'focusing a lens makes the Inspector, ⌘S and undo all print "no document" over a stage ' +
      "that is visibly drawing one",
    test: "tests/pane-derive.test.ts",
  },
  {
    edits: [
      {
        find: `  if (target.derived) {\n    `,
        replace: `  if (target.derived?.kind === "companion") {\n    `,
      },
    ],
    file: "src/workspace/workspace.ts",
    id: "workspace.ts · receivingPane releases a LENS",
    means:
      "⌘\\ and Compare With land a tab in a lens, where `tabOfPane` hops straight past it — " +
      "the document is in no strip and on no stage",
    test: "tests/panes.test.ts",
  },
  {
    edits: [
      {
        find: `  if (target.derived) {\n    `,
        replace: `  if (target.derived?.kind === "lens") {\n    `,
      },
    ],
    file: "src/workspace/workspace.ts",
    id: "workspace.ts · receivingPane releases a COMPANION too",
    means:
      "a companion that has just been handed an unrelated document keeps following, loses " +
      "its chip and its ✕, and Pin promotes the wrong file",
    test: "tests/panes.test.ts",
  },
  {
    edits: [
      {
        find: `  if (survivor.derived?.sourcePaneId === pane.id) {\n    survivor.derived = null;\n  }`,
        replace: `  void survivor;`,
      },
    ],
    file: "src/workspace/workspace.ts",
    id: "workspace.ts · D4, a survivor stops deriving from a pane that has left",
    means:
      "the survivor's `sourcePaneId` names nothing: `tabOfPane` answers null and the grid holds " +
      "a stage drawing a document that no longer has a pane",
    test: "tests/pane-derive.test.ts",
  },
  {
    edits: [
      {
        find: `  return pane.tabOrder.length === 0 && pane.derived === null;`,
        replace: `  return pane.tabOrder.length === 0;`,
      },
    ],
    file: "src/workspace/workspace.ts",
    id: "workspace.ts · a pane's SUBJECT may be its derivation",
    means:
      "a lens's `tabOrder` is empty by design, so §18.1 rule 3 collapses the pane the instant it " +
      "is created — and again on every `detachTab`",
    test: "tests/pane-derive.test.ts",
  },
  {
    edits: [
      {
        find: `  const derived = workspace.panes.find((pane) => pane.derived !== null);\n  if (derived?.id === PRIMARY_PANE) {`,
        replace: `  const derived = undefined as Pane | undefined;\n  if (derived?.id === PRIMARY_PANE) {`,
      },
    ],
    file: "src/workspace/workspace.ts",
    id: "workspace.ts · Close Side Pane's subject is the DERIVED pane",
    means:
      "the chip's ✕ and the menu row both focus their own pane first, so with a derived PRIMARY " +
      "the command reads the focus and closes the pane holding the author's work instead",
    test: "tests/lens-chrome.test.ts",
  },
  {
    edits: [
      {
        find: `    derived.derived = null;\n    if (!paneIsEmpty(derived)) {\n      return;\n    }`,
        replace: `    derived.derived = null;`,
      },
    ],
    file: "src/workspace/workspace.ts",
    id: "workspace.ts · a derived PRIMARY that still owns a document keeps its pane",
    means:
      "ending a companion's projection collapses the grid anyway, taking the second pane with it " +
      "— the author pressed a projection's exit and lost the pane they were working in",
    test: "tests/lens-chrome.test.ts",
  },

  // ─── workspace/pane-derive.ts — the resolver, the follow, the commands ──────
  {
    edits: [
      {
        find: `    if (derived.diff?.filePath === path) {`,
        replace: `    if (derived.diff !== null) {`,
      },
    ],
    file: "src/workspace/pane-derive.ts",
    id: "pane-derive.ts · a diff lens targets the SOURCE document",
    means: "the lens renders a frozen comparison of whatever file the Git panel last opened",
    test: "tests/pane-derive.test.ts",
  },
  {
    edits: [
      {
        find: `(file) => file.path === path && (file.status === "M" || file.status === "A"),`,
        replace: `(file) => file.path === path,`,
      },
    ],
    file: "src/workspace/pane-derive.ts",
    id: "pane-derive.ts · only M and A have a pair of texts to compare",
    means: "Diff is offered for an untracked or deleted file, and the comparison cannot be built",
    test: "tests/pane-derive.test.ts",
  },
  {
    edits: [
      {
        find:
          `    return canvasModeOfTab(source) === "source"\n` +
          `      ? "a source pane that is not already showing Code"\n      : null;`,
        replace: `    return null;`,
      },
    ],
    file: "src/workspace/pane-derive.ts",
    id: "pane-derive.ts · Code is refused over a pane already showing Code",
    means: "two Monaco models on one URI — real Monaco throws and the Code pane comes up blank",
    test: "tests/pane-derive.test.ts",
  },
  {
    edits: [
      {
        find:
          `    return getEffectiveLayoutPath(source.doc.document.$layout as string | false | undefined) ===\n` +
          `      null\n` +
          `      ? "a page with a layout — this one declares none"\n      : null;`,
        replace: `    return null;`,
      },
    ],
    file: "src/workspace/pane-derive.ts",
    id: "pane-derive.ts · Layout is refused on a page that declares none",
    means:
      "a companion pane holding a derivation, no tabs, no strip and no stage, that will not " +
      "collapse",
    test: "tests/pane-derive.test.ts",
  },
  {
    edits: [
      {
        find: `  if (needed && !source.capabilities.modes.includes(needed)) {`,
        replace: `  if (false as boolean) {`,
      },
    ],
    file: "src/workspace/pane-derive.ts",
    id: "pane-derive.ts · a preset the document cannot host is refused",
    means:
      'a settings document is offered "Same page at Base" and "Component definition" — a lens ' +
      "whose stage can only draw an empty artboard, and a rule that can never resolve",
    test: "tests/pane-derive.test.ts",
  },
  {
    edits: [
      {
        find: `  if (derived.preset === "code" && canvasModeOfTab(source) === "source") {`,
        replace: `  if (false as boolean) {`,
      },
    ],
    file: "src/workspace/pane-derive.ts",
    id: "pane-derive.ts · a Code lens refuses while the source pane shows Code",
    means:
      "one click on the source pane's Editor axis puts both panes in Code over one file — two " +
      "Monaco models on one URI, which real Monaco throws on inside a floating promise",
    test: "tests/pane-derive.test.ts",
  },
  {
    edits: [
      {
        find:
          `    if (derived.preset === "diff" && target.status !== "ready") {\n` +
          `      derived.diff = null;\n    }`,
        replace: `    void target.status;`,
      },
    ],
    file: "src/workspace/pane-derive.ts",
    id: "pane-derive.ts · a stale comparison is CLEARED, not kept",
    means:
      "the stage goes on drawing another file's comparison because `if (!gitDiffState)` " +
      "never fires — round one's finding 4, behind a comment claiming it was fixed",
    test: "tests/pane-derive.test.ts",
  },
  {
    edits: [
      {
        find: `    if (_diffLoads.get(paneId)?.failed && _diffLoads.get(paneId)?.path === path) {`,
        replace: `    if (false as boolean) {`,
      },
    ],
    file: "src/workspace/pane-derive.ts",
    id: "pane-derive.ts · a comparison that could not be read STAYS unreadable",
    means:
      'the pane says "Loading this file\'s changes…" for the rest of the session while asking ' +
      "for nothing — the next frame overwrites the refusal the load wrote",
    test: "tests/pane-derive.test.ts",
  },
  {
    edits: [
      {
        find: `          select: hit ? (hit.layoutPath as JxPath) : null,`,
        replace: `          select: null,`,
      },
    ],
    file: "src/workspace/pane-derive.ts",
    id: "pane-derive.ts · the layout companion carries the node that was CLICKED",
    means:
      '"Open Layout →" drops the author into a layout file with nothing selected and leaves them ' +
      "to find the header again by eye — the regression the deleted `openLayoutAtNode` prevented",
    test: "tests/pane-derive.test.ts",
  },
  {
    edits: [{ find: `      void source?.doc.document?.$layout;`, replace: `      void 0;` }],
    file: "src/workspace/pane-derive.ts",
    id: "pane-derive.ts · the layout companion observes $layout",
    means: "changing a page's layout in the Inspector leaves the companion on the old file",
    test: "tests/pane-derive.test.ts",
  },
  {
    edits: [{ find: `    void pane.activeTabId;`, replace: `    void 0;` }],
    file: "src/workspace/pane-derive.ts",
    id: "pane-derive.ts · the follow observes THIS pane's own tab",
    means:
      "closing the document a companion opened strands the pane: `applyDerivation` forgets the " +
      "memo when the pane shows nothing, and with no tracked input for the close there is no " +
      "next frame to forget it in — the fix and the comment describing it, one call apart",
    test: "tests/pane-derive.test.ts",
  },
  {
    /* TWO EDITS, because the interesting one needs `toRaw` back. The point of the mutant is a read
       that returns the SAME tab and SUBSCRIBES TO NOTHING — swapping the argument to `paneId`
       would change the answer as well as the subscription, and three existing tests already catch
       that. This one is the pure loss of the observation. */
    edits: [
      {
        find: `import { effect } from "../reactivity";`,
        replace: `import { effect, toRaw } from "../reactivity";`,
      },
      {
        find: `       that field HERE. */\n    const source = tabOfPane(derived.sourcePaneId);`,
        replace:
          `       that field HERE. */\n` +
          `    const held = toRaw(paneById(derived.sourcePaneId) ?? {}) as { activeTabId?: string };\n` +
          `    const source = workspace.tabs.get(held.activeTabId ?? "") ?? null;`,
      },
    ],
    file: "src/workspace/pane-derive.ts",
    id: "pane-derive.ts · the follow observes the SOURCE pane's active tab",
    means:
      "the docstring's central claim, inverted: a companion stops following. Switching document " +
      "in the pane you are working in leaves the pane beside it showing the layout — or the " +
      "component definition — of the page you left",
    test: "tests/pane-derive.test.ts",
  },
  {
    edits: [
      {
        find: `  if (preset === "layout" || preset === "component") {`,
        replace: `  if (preset === "layout") {`,
      },
    ],
    file: "src/workspace/pane-derive.ts",
    id: "pane-derive.ts · component builds a COMPANION, not a lens",
    means:
      "the Component definition preset becomes a second copy of the page: a pane that owns no " +
      "tab, opens no definition, and refuses Pin — the whole preset, silently replaced",
    test: "tests/pane-derive.test.ts",
  },
  {
    edits: [
      {
        find: `  return pane && pane.activeTabId !== null && pane.derived === null ? null : DERIVE_REQUIRES;`,
        replace: `  return pane && pane.derived === null ? null : DERIVE_REQUIRES;`,
      },
    ],
    file: "src/workspace/pane-derive.ts",
    id: "pane-derive.ts · deriving needs an open document to derive FROM",
    means:
      "the ⟲ trigger is live on the welcome screen and every row in its menu runs `pane.derive` " +
      "for a pane with nothing in it — a `RangeError` out of a click handler",
    test: "tests/pane-derive.test.ts",
  },
  {
    edits: [
      {
        find: `  void Promise.resolve(opening).then(() => {\n    selectInPane(paneId, target);\n  });`,
        replace: `  void opening;\n  selectInPane(paneId, target);`,
      },
    ],
    file: "src/workspace/pane-derive.ts",
    id: "pane-derive.ts · the layout selection lands AFTER the open",
    means:
      '"Open Layout →" drops the author at the top of a layout file with nothing selected, left ' +
      "to find by eye the header they clicked — the regression the deleted `openLayoutAtNode` " +
      "existed to prevent. The real opener is `async`; only an async fixture can see it",
    test: "tests/pane-derive.test.ts",
  },
  {
    edits: [
      {
        find: `        live?.kind !== "lens" ||\n        live.preset !== "diff" ||\n`,
        replace: ``,
      },
    ],
    file: "src/workspace/pane-derive.ts",
    id: "pane-derive.ts · a landing comparison checks the pane is still THERE",
    means:
      "pressing ✕ on a loading Diff lens leaves `_diffLoads` holding the request — `closePane` is " +
      "not a derivation write — so the read lands on `undefined` and reports a git failure the " +
      "author never caused",
    test: "tests/pane-derive.test.ts",
  },
  {
    edits: [
      {
        find: `  return pane && pane.activeTabId !== null && pane.derived === null ? null : DERIVE_REQUIRES;`,
        replace: `  return pane && pane.activeTabId !== null ? null : DERIVE_REQUIRES;`,
      },
    ],
    file: "src/workspace/pane-derive.ts",
    id: "pane-derive.ts · a derived pane cannot derive again",
    means: "a lens derives from itself or from the pane it is already projecting",
    test: "tests/pane-derive.test.ts",
  },
  {
    edits: [
      {
        find: `  return pane?.derived?.kind === "companion" && pane.activeTabId ? null : PIN_REQUIRES;`,
        replace: `  return pane?.derived && pane.activeTabId ? null : PIN_REQUIRES;`,
      },
    ],
    file: "src/workspace/pane-derive.ts",
    id: "pane-derive.ts · Pin is refused for a lens",
    means: "Pin mints a second tab for a path that already has one — the §14.1 violation",
    test: "tests/pane-derive.test.ts",
  },
  {
    edits: [
      {
        find: `  if (derivation.sourcePaneId === paneId || !paneById(derivation.sourcePaneId)) {`,
        replace: `  if (false as boolean) {`,
      },
    ],
    file: "src/workspace/pane-derive.ts",
    id: "pane-derive.ts · D1, a derivation names another pane in the grid",
    means:
      "a self-derivation is an infinite `tabOfPane` hop; a dangling one is a stage with no pane",
    test: "tests/pane-derive.test.ts",
  },
  {
    edits: [{ find: `    _diffLoads.delete(paneId);`, replace: `    void paneId;` }],
    file: "src/workspace/pane-derive.ts",
    id: "pane-derive.ts · writing a derivation FORGETS the pane's in-flight diff answer",
    means:
      "a new derivation inherits the previous one's answer: the load for the old document is " +
      "still keyed to this pane, so the new lens asks for nothing and shows the old file's state",
    test: "tests/pane-derive.test.ts",
  },
  {
    edits: [
      {
        find: `    if (pane.tabOrder.length > 0 || pane.activeTabId !== null) {`,
        replace: `    if (false as boolean) {`,
      },
    ],
    file: "src/workspace/pane-derive.ts",
    id: "pane-derive.ts · D2, a lens owns no tab",
    means: "a tab sits in a lens's `tabOrder` where `tabOfPane` hops straight past it",
    test: "tests/pane-derive.test.ts",
  },
  {
    edits: [
      {
        find: `  if (derived.resolved !== null && tabOfPane(paneId) === null) {\n    derived.resolved = null;\n  }`,
        replace: `  void paneId;`,
      },
    ],
    file: "src/workspace/pane-derive.ts",
    id: "pane-derive.ts · the companion memo does not outlive the document",
    means:
      "closing the document a companion opened strands the pane — the memo says the answer is " +
      'already on screen, the stage says "Looking for something to show here…", and only Unsplit ' +
      "gets the author out",
    test: "tests/pane-derive.test.ts",
  },
  {
    edits: [
      {
        find: `  if (!wanted || !tab || (target.path !== null && tab.documentPath !== target.path)) {`,
        replace: `  if (!wanted || !tab) {`,
      },
    ],
    file: "src/workspace/pane-derive.ts",
    id: "pane-derive.ts · selectInPane writes only the document it is about",
    means: "a selection meant for the layout lands in whatever document the pane happens to show",
    test: "tests/pane-derive.test.ts",
  },
  {
    edits: [
      {
        find: `      hit?.layoutFile ??\n      getEffectiveLayoutPath(`,
        replace: `      undefined ??\n      getEffectiveLayoutPath(`,
      },
    ],
    file: "src/workspace/pane-derive.ts",
    id: "pane-derive.ts · the layout companion opens the file the CLICK came from",
    means: "clicking a header from a nested layout opens the page's own `$layout` — the wrong file",
    test: "tests/pane-derive.test.ts",
  },
  {
    edits: [
      {
        find: `    return derived.resolved === null\n      ? {`,
        replace: `    return false\n      ? {`,
      },
    ],
    file: "src/workspace/pane-derive.ts",
    id: "pane-derive.ts · a component companion HOLDS when the click resolves to nothing",
    means: "the pane flickers between a definition and an empty state as the author works",
    test: "tests/pane-derive.test.ts",
  },
  {
    edits: [
      {
        find: `  if (derived.preset === "breakpoint" && !declaredMedia(source).includes(derived.media)) {`,
        replace: `  if (false as boolean) {`,
      },
    ],
    file: "src/workspace/pane-derive.ts",
    id: "pane-derive.ts · a breakpoint the document stopped declaring is unavailable",
    means: "the lens silently falls back to the whole design board under a chip naming one size",
    test: "tests/pane-derive.test.ts",
  },
  {
    edits: [
      {
        find: `  if (path === null || !change || _diffLoads.get(paneId)?.path === path) {`,
        replace: `  if (path === null || !change) {`,
      },
    ],
    file: "src/workspace/pane-derive.ts",
    id: "pane-derive.ts · one in-flight diff load per pane",
    means: "a failed comparison is re-requested on every frame, forever",
    test: "tests/pane-derive.test.ts",
  },
  {
    edits: [
      {
        find: `        _diffLoads.get(paneId)?.path !== path\n      ) {`,
        replace: `        false\n      ) {`,
      },
    ],
    file: "src/workspace/pane-derive.ts",
    id: "pane-derive.ts · a comparison that lands LATE is dropped",
    means:
      "a `gitShow` issued for the previous document lands after the source pane switched, writes " +
      "onto the lens, and `derivedTarget` then reports `ready`: the pane draws the previous " +
      "file's diff under a chip naming the current one",
    test: "tests/pane-derive.test.ts",
  },
  {
    edits: [
      {
        find: `      void shell.layoutSelection;`,
        replace: `      void 0;`,
      },
    ],
    file: "src/workspace/pane-derive.ts",
    id: "pane-derive.ts · the layout follow observes the hit",
    means: '"Open Layout →" is a one-shot: the pane freezes on the first header the author clicked',
    test: "tests/pane-derive.test.ts",
  },
  {
    edits: [
      {
        find: `      void source?.session.ui.canvasMode;`,
        replace: `      void 0;`,
      },
    ],
    file: "src/workspace/pane-derive.ts",
    id: "pane-derive.ts · the Code lens observes the source pane's editor kind",
    means:
      "the refusal that keeps two Monaco models off one URI is never computed, so the stage " +
      "mounts the second model anyway — the answer exists and nothing asks for it",
    test: "tests/pane-derive.test.ts",
  },
  {
    edits: [
      {
        find: `      void source?.session.selection;`,
        replace: `      void 0;`,
      },
    ],
    file: "src/workspace/pane-derive.ts",
    id: "pane-derive.ts · the component follow observes the selection",
    means: "the component companion never re-points — it is a static pane wearing a follow's chip",
    test: "tests/pane-derive.test.ts",
  },
  {
    edits: [
      {
        find: `  const mode = preset === "code" ? "source" : preset === "diff" ? "git-diff" : "design";`,
        replace: `  const mode = "design";`,
      },
    ],
    file: "src/workspace/pane-derive.ts",
    id: "pane-derive.ts · each preset builds the canvas mode its pane draws in",
    means: "a Code lens draws the design board and a Diff lens never enters `git-diff` at all",
    test: "tests/pane-derive.test.ts",
  },
  {
    edits: [
      {
        find: `    media: preset === "breakpoint" ? media : null,`,
        replace: `    media: null,`,
      },
    ],
    file: "src/workspace/pane-derive.ts",
    id: "pane-derive.ts · a breakpoint lens keeps the size it was asked for",
    means: "every breakpoint lens draws Base under a chip naming the size the author chose",
    test: "tests/pane-derive.test.ts",
  },

  /* ─── styles/shell.css ───────────────────────────────────────────────────────
     THE LAST EXCLUSION, AND IT WAS WRONG. This row carried `browserOnly` with the reason "a
     one-chip strip keeping the tab row's height is a COMPUTED-HEIGHT claim, and happy-dom lays
     nothing out". Every word of that is true of the HEIGHT and none of it is true of the
     DECLARATION the mutant edits: happy-dom resolves the CASCADE, so `getComputedStyle` on an
     element in the document returns the padding and border a stylesheet gave it, and the padding is
     what the height rests on. The reason was about the wrong noun.
     The exclusion also could not go red on a rename, which is the failure mode an exclusion is
     supposed to be protected from: rename `.tab-derivation` in all four of its places and the
     `find` below still matches once, because it names neither the class nor the file's structure.
     `lens-chrome.test.ts` closes both ends — it reads the stylesheet from disk, renders the chip
     `derivationChipTpl` actually emits beside the chip `tabChip` emits, and compares the two boxes
     against each other. A rename on either side fails it; so does a stylesheet that did not load.
     The height itself is still nobody's here: it belongs to `packages/studio:verify` and a
     screenshot, and shell.css says so at the rule.
     **This list is now empty.** An honest exclusion is still available — see {@link Mutant.browserOnly} —
     but every claim in the table is executed. */
  {
    edits: [
      {
        find: `  padding: 4px 10px;\n  border-bottom: 2px solid transparent;`,
        replace: `  padding: 0;\n  border-bottom: 2px solid transparent;`,
      },
    ],
    file: "styles/shell.css",
    id: "shell.css · a derivation chip's row keeps the tab row's vertical box",
    means: "the derived pane's strip collapses against the tab row in the pane beside it",
    test: "tests/lens-chrome.test.ts",
  },
];

// ─── Runner ───────────────────────────────────────────────────────────────────

const ROOT = resolve(import.meta.dir, "..");

/** Every file this process has rewritten, with the bytes it must be restored to. */
const _originals = new Map<string, string>();

function restoreAll(): void {
  for (const [path, text] of _originals) {
    writeFileSync(path, text);
  }
  _originals.clear();
}

/**
 * Apply one mutant's edits to `text`, or say why they cannot be applied.
 *
 * Separated from the run so a `browserOnly` row's `find` is resolved on every gate without its
 * mutant ever being executed — which is what stops an exclusion being a note that cannot fail.
 *
 * @param {Mutant} mutant
 * @param {string} text
 * @returns {{ mutated: string; problem: null } | { mutated: null; problem: string }}
 */
function applyEdits(
  mutant: Mutant,
  text: string,
): { mutated: string; problem: null } | { mutated: null; problem: string } {
  let mutated = text;
  for (const edit of mutant.edits) {
    const count = mutated.split(edit.find).length - 1;
    if (count !== 1) {
      return {
        mutated: null,
        problem:
          `its \`find\` matched ${count} times in ${mutant.file} (expected exactly 1). The table ` +
          `is stale — the line it names has moved or been reworded:\n      ${edit.find.split("\n")[0]}`,
      };
    }
    mutated = mutated.replace(edit.find, edit.replace);
  }
  return { mutated, problem: null };
}

/**
 * Apply one mutant's edits, run its test file, and answer whether the test NOTICED.
 *
 * @param {Mutant} mutant
 * @returns {Verdict}
 */
function runMutant(mutant: Mutant): Verdict {
  const path = resolve(ROOT, mutant.file);
  const original = readFileSync(path, "utf8");
  const { mutated, problem } = applyEdits(mutant, original);
  if (mutated === null) {
    return { aborted: false, killed: false, problem };
  }
  _originals.set(path, original);
  try {
    writeFileSync(path, mutated);
    /* Reading the result is its own module, because getting it wrong is silent: a child killed for
       outrunning `maxBuffer` comes back as a `SIGTERM`, and this gate read that as Ctrl-C and
       stopped — red on `main` for weeks with nobody at a keyboard. See `mutant-verdict.ts`. */
    return verdictOf(
      spawnSync("bun", ["test", "--isolate", mutant.test], {
        cwd: ROOT,
        encoding: "utf8",
        env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
        maxBuffer: MAX_OUTPUT,
      }),
      mutant.test,
    );
  } finally {
    writeFileSync(path, original);
    _originals.delete(path);
  }
}

/**
 * Run one test file against the UNMUTATED tree and demand it is green.
 *
 * **Without this the gate lies in the one direction it must not.** A kill is "the named test file
 * failed", and a file that was already failing fails under every mutant that names it — so one
 * broken test in `pane-derive.test.ts` would report all of its mutants dead. This file found that
 * in itself: a fixture mistake made a new test red, and the run before it printed a clean sweep.
 * The baseline costs one extra run per distinct file and closes the hole exactly.
 *
 * @param {string} test
 * @returns {string | null} The problem, or null when the file is green.
 */
function baselineProblem(test: string): string | null {
  return baselineProblemOf(
    spawnSync("bun", ["test", "--isolate", test], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      maxBuffer: MAX_OUTPUT,
    }),
    test,
  );
}

/**
 * Say what this table measures and what it does not — in the gate's OWN output, every run.
 *
 * The kill count on its own is a number without a denominator: "86/86" reads as "everything", and
 * the honest denominator is "the 86 behaviours somebody wrote a row for". Everything printed here
 * is either derived from {@link MUTANTS} — so it cannot drift from the table — or comes from
 * {@link OUTSIDE_THE_TABLE}, which is a list rather than a figure, so the figure beside it is
 * derived too. There is deliberately no hand-typed total of "discriminators in the diff": that
 * number is the output of a walk, it goes stale the moment the diff moves, and the command that
 * produces it is in this file's header for a reader who wants to re-run it.
 *
 * @param {number} rows Rows actually executed this run.
 * @param {number} excluded Rows carried but not executed.
 */
function printBoundary(rows: number, excluded: number): void {
  const files = new Set(MUTANTS.map((mutant) => mutant.file));
  const tests = new Set(MUTANTS.map((mutant) => mutant.test));
  process.stdout.write(
    `\nthis gate's coverage boundary\n` +
      `  measured   ${rows} discriminator${rows === 1 ? "" : "s"}, one row each, ` +
      `across ${files.size} source files and ${tests.size} test files\n` +
      `  excluded   ${excluded}${excluded === 0 ? " — every row in the table is executed" : ""}\n` +
      `  enumerated by walking the workstream's own diff and keeping every line that CHOOSES — a\n` +
      `             condition, a ternary, a filter predicate, a pane-scoped resolution, a \`void\`\n` +
      `             read that exists to establish tracking. The command is in this file's header;\n` +
      `             it is re-runnable, and its output is what this table is checked against.\n` +
      `  NOT measured here (${OUTSIDE_THE_TABLE.length}):\n`,
  );
  for (const row of OUTSIDE_THE_TABLE) {
    process.stdout.write(`  · ${row.what}\n    ${row.standing}\n`);
  }
}

function main(): number {
  const started = Date.now();
  const survivors: Mutant[] = [];
  const broken: { mutant: Mutant; problem: string }[] = [];
  const excluded = MUTANTS.filter((m) => m.browserOnly);
  const live = MUTANTS.filter((m) => !m.browserOnly);

  /* EVERY row's `find` is resolved, excluded rows included and before anything is run: a stale
     table is a stale table whether or not its mutant would have been executed. */
  for (const mutant of MUTANTS) {
    const { problem } = applyEdits(mutant, readFileSync(resolve(ROOT, mutant.file), "utf8"));
    if (problem) {
      process.stderr.write(`\ncheck-lens-mutants: could not apply "${mutant.id}" — ${problem}\n`);
      return 1;
    }
  }

  for (const test of new Set(live.map((mutant) => mutant.test))) {
    const problem = baselineProblem(test);
    if (problem) {
      process.stderr.write(`\ncheck-lens-mutants: ${problem}\n`);
      return 1;
    }
  }

  for (const mutant of live) {
    const { killed, problem, aborted } = runMutant(mutant);
    if (aborted) {
      process.stderr.write(
        `\ncheck-lens-mutants: interrupted at "${mutant.id}". ${mutant.file} is restored.\n`,
      );
      return 130;
    }
    if (problem) {
      broken.push({ mutant, problem });
      process.stdout.write(`  ?  ${mutant.id}\n`);
      continue;
    }
    process.stdout.write(`  ${killed ? "✓" : "✗"}  ${mutant.id}\n`);
    if (!killed) {
      survivors.push(mutant);
    }
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  process.stdout.write(
    `\n${live.length - survivors.length - broken.length}/${live.length} mutants killed in ${seconds}s\n`,
  );

  if (excluded.length > 0) {
    process.stdout.write(`\nbrowser-only, not covered (${excluded.length}):\n`);
    for (const mutant of excluded) {
      process.stdout.write(`  · ${mutant.id}\n    ${mutant.browserOnly}\n`);
    }
  }
  printBoundary(live.length, excluded.length);

  for (const { mutant, problem } of broken) {
    process.stderr.write(`\ncheck-lens-mutants: could not apply "${mutant.id}" — ${problem}\n`);
  }
  for (const mutant of survivors) {
    process.stderr.write(
      `\ncheck-lens-mutants: MUTANT SURVIVED — ${mutant.id}\n` +
        `  ${mutant.file} still passes ${mutant.test} with this behaviour inverted.\n` +
        `  If the line is wrong: ${mutant.means}\n` +
        `  Nothing in the suite can tell right from wrong here. Write the test that can, or mark\n` +
        `  the mutant \`browserOnly\` with the reason no unit test could.\n`,
    );
  }
  return survivors.length + broken.length === 0 ? 0 : 1;
}

let code = 1;
try {
  code = main();
} finally {
  restoreAll();
}
process.exit(code);
