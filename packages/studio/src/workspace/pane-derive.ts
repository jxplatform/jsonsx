/**
 * Derived panes (§18.4) — the pane beside this one, showing a projection of it.
 *
 * **Two families, one field.** `Pane.derived` carries either a LENS or a COMPANION, and the
 * distinction is not cosmetic — it is what keeps §14.1 intact:
 *
 * - A **lens** (`code`, `diff`, `breakpoint`) draws the SAME document the source pane owns, in a
 *   mode, at a breakpoint or against a diff of its own. It owns no tab at all, so no id maps to two
 *   documents and no document takes two ids. `canvas-surface.ts`'s `tabOfPane` takes one hop
 *   through `sourcePaneId`, and every pane-scoped renderer in the package starts working on it for
 *   free — which is also why the follow costs nothing: switching tabs in the source pane repaints
 *   the lens because it is the same reactive read.
 * - A **companion** (`layout`, `component`) shows a DIFFERENT document chosen by a rule from the
 *   source. That is an ordinary path-keyed tab this pane owns; the derivation only decides which of
 *   its tabs is on screen, which is what activation has always done.
 *
 * §14.1 is therefore SHARPENED rather than amended: **ownership is one-to-one, display is
 * many-to-one.** A tab id appears in at most one pane's `tabOrder`, and every verb that closes,
 * disposes, reorders, pins or MRU-tracks a tab resolves through `paneOfTab` — so it addresses the
 * owner and only the owner. `closeTab`, `detachTab`, `setTabPinned`, `moveTab`, `renameTab`,
 * `rememberClosedTab`, `ensureCollab`, `promoteMru` and `openFileInTab`'s dedupe need no change at
 * all: none of them can see a lens pane, whose `tabOrder` is empty.
 *
 * **What is NOT here, and why.** No derived Tab of any kind — no `derived:code:<path>` id sharing a
 * document, no off-map `Map<paneId, Tab>`. Both mint a second tab LIFETIME: the first costs four
 * exclusion predicates (MRU, reopen-closed, collab keying, close-all counting) that must each be
 * written and tested rather than assumed; the second costs a second disposal path, where one missed
 * `disposeTab` is an `effectScope` reacting to a document forever. Neither is needed once ownership
 * and display are separated.
 */

import { effect } from "../reactivity";
import { componentRegistry } from "../files/components";
import { getNodeAtPath, parentElementPath } from "../store";

import { canvasPerf } from "../canvas/canvas-perf";
import { canvasModeOfTab, tabOfPane } from "../canvas/canvas-surface";
import { parseMediaEntries } from "../utils/canvas-media";
import { getEffectiveLayoutPath, getEffectiveLocales, getEffectiveMedia } from "../site-context";
import { localeLabel, translationPathFor } from "@jxsuite/schema/locale";
import { shell } from "../shell";
import {
  activePane,
  detachTab,
  insertIntoPane,
  paneById,
  promoteTab,
  sidePane,
  workspace,
} from "./workspace";
import {
  argsSchema,
  enumArg,
  enumProperty,
  optionalStringArg,
  stringProperty,
} from "../commands/command-args";

import type { DerivationStatus, Pane, PaneDerivation } from "./workspace";
import type { AnyCommand } from "../commands/registry";
import type { Tab } from "../tabs/tab";
import type { GitDiffState, GitFileStatus } from "../types";
import type { JxPath } from "../state";

/** Every projection `pane.derive` offers, in the order the preset menu lists them. */
export const DERIVE_PRESETS = [
  "code",
  "layout",
  "component",
  "diff",
  "breakpoint",
  "locale",
] as const;

export type DerivePreset = (typeof DERIVE_PRESETS)[number];

/**
 * The canvas mode a preset needs the SOURCE document to DECLARE, for the presets that need one.
 *
 * `tab.capabilities.modes` is the format's own answer to "what can this document be shown as", and
 * the preset menu consulted it nowhere: over a document that declares `["settings", "stylebook",
 * "source"]` it still offered "Same page at Base" — a lens whose stage can only draw an empty
 * artboard — and "Component definition", whose rule can never resolve because nothing in a settings
 * form is a component instance. Both produced a pane the author then had to close.
 *
 * Two presets are absent, for two different reasons. `diff` needs no mode: a comparison is two
 * texts and every document has those, and it is already gated on the file having changes. `layout`
 * is gated on the layout RESOLVING, which {@link presetRefusal} checks directly.
 *
 * **That second gate is NOT a mode check in disguise, and a comment here said it was** — "a
 * document with no design board has no layout either". It is false: `getEffectiveLayoutPath` falls
 * back to `projectConfig.defaults.layout`, which every starter sets, so a document declaring
 * `["stylebook", "source"]` resolves the project's layout and IS offered the row. That is a
 * deliberate answer rather than an oversight — the companion opens a real layout document the
 * author can edit, unlike the empty artboard `breakpoint` would draw or the rule `component` could
 * never resolve — but it is a fact about the project's default, not about this document, so it is
 * pinned by a test (`per-preset refusals` · "Layout's gate is the layout RESOLVING") instead of
 * being asserted here in prose.
 */
const MODE_FOR_PRESET: Readonly<Partial<Record<DerivePreset, string>>> = {
  breakpoint: "design",
  code: "source",
  component: "design",
};

/** How a mode is spelled in a refusal — the words on the Editor axis, not the internal ids. */
const MODE_WORDS: Readonly<Record<string, string>> = { design: "Design", source: "Code" };

/** Said by a diff lens whose comparison came back empty. One sentence, one home. */
const DIFF_UNREADABLE = "Could not read this file's comparison against HEAD.";

/** What the derivation commands and the follow need from the rest of Studio. */
export interface DerivationDeps {
  /**
   * `files/files.ts`'s `openFileInPane` — read a document from disk and show it in a named pane,
   * browsing rather than committing and leaving the keyboard where it is.
   *
   * Injected rather than imported so this module owns no I/O and no test has to stand up a platform
   * to prove the follow memoises.
   */
  openFileInPane: (paneId: string, path: string) => void | Promise<void>;
  /**
   * Read one file's comparison against HEAD — `gitShow(HEAD)` plus the working copy.
   *
   * **The diff lens has to load its own, and that is the whole of finding 4.** It used to snapshot
   * `shell.git.diffState`: an app-level slot written only when the author clicks a file IN THE GIT
   * PANEL, carrying THAT file's path and never re-read. So the preset was refused for a page that
   * genuinely has changes, and when it was offered it could render a comparison of an unrelated
   * file under a label promising this pane's document. A lens draws the source pane's document or
   * it is not a lens.
   *
   * Resolves to `null` when the comparison cannot be produced; the pane says so rather than drawing
   * somebody else's file.
   */
  loadDiff: (path: string, fileStatus: string) => Promise<GitDiffState | null>;
  /**
   * Is there a file at this project-relative path? The locale companion's one question.
   *
   * Injected for the reason {@link openFileInPane} is, and asked at all for a sharper one:
   * {@link companionTarget} is pure and synchronous, so it cannot stat anything — and a companion
   * that answers with the path a translation WOULD have hands `openFileInPane` a file that is not
   * there, which fails into a blank pane under a chip naming a language. The pane has to be able to
   * say "there is no French copy of this yet", and only a read of the disk can tell it that.
   */
  fileExists: (path: string) => Promise<boolean>;
}

/**
 * A dependency set that does nothing — for callers that read DECLARATIONS rather than run verbs.
 *
 * The sibling of `commands/defaults.ts`'s `noopCommandDeps()`, and here for the same reason: the
 * command-level check, the chrome budget and the generated keyboard sheet all build the whole
 * command set to inspect its records, and every one of them would otherwise hand-write a stub for a
 * verb it will never call. One stub, named, beside the interface it satisfies.
 *
 * @returns {DerivationDeps}
 */
export function noopDerivationDeps(): DerivationDeps {
  return {
    fileExists: () => Promise.resolve(false),
    loadDiff: () => Promise.resolve(null),
    openFileInPane: () => {},
  };
}

/** The label each preset takes in the menu and in the derived pane's own strip chip. */
export const PRESET_LABELS: Readonly<Record<DerivePreset, string>> = {
  breakpoint: "Same page at",
  code: "Code",
  component: "Component definition",
  diff: "Diff vs HEAD",
  layout: "Layout",
  /* An UNFINISHED sentence, like `breakpoint`'s, because the row and the chip both finish it with
     the locale's own autonym — "Same page in français". Jx has no message catalogue (§13.3): a
     translation is a different file in a different directory, so this preset opens that file
     rather than re-rendering this one, and the label says "the same page" about the document
     rather than about the text on screen. */
  locale: "Same page in",
};

// ─── Reading ──────────────────────────────────────────────────────────────────

/**
 * The derivation a pane is drawing under, or null.
 *
 * Re-exported from `canvas/canvas-surface.ts`, which is where the pane-scoped RENDERERS already
 * resolve everything else and which this module imports from. One name, one answer.
 */
export { derivationOfPane } from "../canvas/canvas-surface";

/** What a derived pane SHOULD be showing right now. The pure half of the follow. */
export interface DerivedTarget {
  kind: "lens" | "companion";
  /** Lens: the canvas mode this pane draws in. Null for a companion. */
  mode: string | null;
  /** Lens (`breakpoint`): the media name, null for base. */
  media: string | null;
  /** Companion: the path this pane should show, or null to HOLD the one it has. */
  path: string | null;
  /**
   * Lens (`diff`): the document whose comparison this pane must still LOAD, or null when it has the
   * right one. The impure half acts on it; resolving it stays a read.
   */
  diffPath: string | null;
  /**
   * Companion (`locale`): the translation whose EXISTENCE this pane must still establish, or null
   * when the answer is already in hand. {@link diffPath}'s companion twin, and for the same reason —
   * the resolver decides WHAT to ask, {@link probeTranslationFor} asks it, and neither answer
   * carries a `probePath`, so the follow cannot re-enter.
   */
  probePath: string | null;
  /**
   * Companion (`layout`): the node to select once the document is on screen, or null.
   *
   * The deleted `openLayoutAtNode` existed precisely because "Open Layout →" dropped the author
   * into a layout file with nothing selected and left them to find the header again by eye. The
   * derivation carries it now — which is what `panels/properties-panel.ts`'s ledger entry claimed
   * for a release while nothing read `layoutPath` at all.
   */
  select: JxPath | null;
  status: DerivationStatus;
  /** Printed by the pane when `status` is `unavailable`. Empty otherwise. */
  reason: string;
}

/**
 * Resolve what `paneId` should be showing, from its derivation and its source pane.
 *
 * **Pure**: it reads state and returns an answer, writes nothing, and schedules nothing. That is
 * what makes the follow testable with no rAF, no platform and no canvas — the whole of the
 * derivation's decision-making is one function returning a value.
 *
 * "State" includes {@link _diffLoads}, which is module-scoped rather than on the derivation — a
 * read, and still no write. A comparison that came back empty has to be REMEMBERED somewhere the
 * resolver can see, because a terminal answer written straight onto `derived.status` is overwritten
 * by the next frame's resolve, and the pane then says "Loading…" forever while asking for nothing.
 *
 * @param {string} paneId
 * @returns {DerivedTarget | null} Null when this pane is not derived.
 */
export function derivedTarget(paneId: string): DerivedTarget | null {
  const derived = paneById(paneId)?.derived;
  if (!derived) {
    return null;
  }
  const source = tabOfPane(derived.sourcePaneId);
  if (!source) {
    return {
      diffPath: null,
      kind: derived.kind,
      media: null,
      mode: null,
      path: null,
      probePath: null,
      reason: "The pane this one follows has no document open.",
      select: null,
      status: "unavailable",
    };
  }
  if (derived.kind === "lens") {
    return lensTarget(paneId, derived, source);
  }
  return companionTarget(paneId, derived, source);
}

/** A lens's target: a mode, and for `breakpoint` a media the source document actually declares. */
function lensTarget(
  paneId: string,
  derived: Extract<PaneDerivation, { kind: "lens" }>,
  source: Tab,
): DerivedTarget {
  const base = {
    diffPath: null,
    kind: "lens" as const,
    media: derived.media,
    mode: derived.mode,
    path: null,
    probePath: null,
    select: null,
  };
  if (derived.preset === "diff") {
    /* THE SOURCE PANE'S DOCUMENT, resolved every time rather than snapshotted once. This branch
       used to read `derived.diff === null`, a copy of `shell.git.diffState` taken when the lens
       was made — so the lens went on rendering whatever file the Git panel had last opened, and
       switching the source tab changed nothing at all. */
    const path = source.documentPath;
    if (!gitChangeFor(path)) {
      return {
        ...base,
        reason: "Nothing to compare — this file matches HEAD.",
        status: "unavailable",
      };
    }
    /* …AND IT MUST STILL BE CURRENT. Matching the path alone made this a cache with no
       invalidation: a save moves the working tree under the comparison, and the artboards would go
       on tinting the text as it was when the lens opened. `diffRev` is stamped by the loader, so an
       injected comparison (which has none) is left alone rather than judged stale. */
    if (
      derived.diff?.filePath === path &&
      (derived.diffRev === undefined || derived.diffRev === shell.git.rev)
    ) {
      return { ...base, reason: "", status: "ready" };
    }
    /* A read that came back EMPTY is an answer, and it has to survive the next frame. The failure
       used to be written straight onto `derived.status`, where the follow's very next resolve
       overwrote it with `loading` — so a lens whose comparison could not be read said "Loading
       this file's changes…" for the rest of the session while asking for nothing. `_diffLoads`
       remembers per pane which path was asked and how it went, and the answer is composed here
       with every other one. */
    if (_diffLoads.get(paneId)?.failed && _diffLoads.get(paneId)?.path === path) {
      return { ...base, reason: DIFF_UNREADABLE, status: "unavailable" };
    }
    return { ...base, diffPath: path, reason: "", status: "loading" };
  }
  if (derived.preset === "code" && canvasModeOfTab(source) === "source") {
    /* TWO MONACO MODELS ON ONE URI, refused for as long as the state lasts rather than once at
       creation. `presetRefusal` decides whether a Code lens can be MADE; nothing decided whether
       it could still be drawn, and one click on the source pane's Editor axis put both panes in
       Code over the same file. Real Monaco throws `Cannot create model because a model with the
       same URI already exists` inside the floating `void mountSourceEditor(…)` in
       `canvas/canvas-render.ts` — an unhandled rejection and a blank Code pane. Unreachable before
       derived panes, because one pane could show one document once. */
    return {
      ...base,
      reason: "The pane this one follows is showing Code — one document has one editor.",
      status: "unavailable",
    };
  }
  if (derived.preset === "breakpoint" && !declaredMedia(source).includes(derived.media)) {
    return {
      ...base,
      reason: `This document does not declare a "${derived.media ?? "base"}" breakpoint.`,
      status: "unavailable",
    };
  }
  return { ...base, reason: "", status: "ready" };
}

/**
 * The source-control entry for `path`, when it has changes a comparison can be built from.
 *
 * `M`, `A` and `U`. `shell.git.status` is the project's whole answer to "what has changed", so a
 * diff lens can be offered for a page the author has never clicked in the Git panel, which is the
 * common case and was the refused one.
 *
 * The old rule was `M`/`A` alone, justified by "an untracked or deleted file has no pair of texts
 * to put side by side". That was never true — one side is the empty string, which is exactly what
 * `A` had always done — and it refused a comparison for a brand-new page the author had just
 * written.
 *
 * `D` is still absent, and deliberately: a LENS draws the document its source pane is showing, and
 * a deleted file cannot be open in a pane. An arm for it would be unreachable, which is a claim no
 * test could check. The Source Control panel opens deleted files instead, through its own tab.
 *
 * A `null` path needs no guard of its own: no entry in `files` has a null path, so the search
 * simply finds nothing, and a guard whose true branch returns what the false branch already returns
 * is a branch no test can distinguish.
 *
 * @param {string | null} path
 * @returns {GitFileStatus | null}
 */
function gitChangeFor(path: string | null): GitFileStatus | null {
  return (
    shell.git.status?.files.find(
      (file) =>
        file.path === path && (file.status === "M" || file.status === "A" || file.status === "U"),
    ) ?? null
  );
}

/**
 * A companion's target: the path the rule resolves to, or `null` to HOLD.
 *
 * **`null` is a hold, not a change**, and that is the difference between a usable following pane
 * and one nobody leaves open. Clicking a paragraph outside any component resolves to no definition;
 * blanking the pane on that click makes it flicker between a document and an empty state as the
 * author works, and this is the preset somebody leaves open all day.
 *
 * **A hold is only honest where the next gesture could answer differently.** `component` holds
 * because the author's next click may land inside one. `locale` does not: a document with no copy
 * in that language has no copy in it until somebody writes one, and a pane silently holding the
 * previous document under a chip saying "Same page in français" is a lie the author cannot see
 * through. That answer is `unavailable` with the sentence, which is what makes creating the
 * translation the obvious next move rather than a guess.
 */
function companionTarget(
  paneId: string,
  derived: Extract<PaneDerivation, { kind: "companion" }>,
  source: Tab,
): DerivedTarget {
  const base = { diffPath: null, kind: "companion" as const, media: null, mode: null };
  if (derived.preset === "layout") {
    /* THE FILE THE CLICKED CHROME CAME FROM, when there is one.
       `shell.layoutSelection` is a `LayoutHit`: the layout document the canvas hit test resolved
       and the node's path INSIDE it. Resolving the page's own `$layout` instead is a different
       answer for a nested chain — click a header contributed by `layouts/marketing.json`, which
       `layouts/base.json` wraps, and the page's `$layout` names the wrong one of the two. It is
       also the only thing that carries the SELECTION, which is what "Open Layout →" is for. The
       hit is transient — `iframe-host.ts` clears it the moment the author clicks page content —
       so the page's own layout remains the answer for a derivation created from the preset menu. */
    const hit = shell.layoutSelection;
    const path =
      hit?.layoutFile ??
      getEffectiveLayoutPath(source.doc.document.$layout as string | false | undefined);
    return path === null
      ? {
          ...base,
          path: null,
          probePath: null,
          reason: "This page has no layout.",
          select: null,
          status: "unavailable",
        }
      : {
          ...base,
          path,
          probePath: null,
          reason: "",
          /* A SELECTION only when a click produced one. `path` IS `hit.layoutFile` whenever there
             is a hit — the line above says so — so a second `hit.layoutFile === path` guard here
             was a condition with no false branch, and an unreachable branch is a claim nobody can
             check. What stops a node path from layout A landing inside layout B is
             {@link selectInPane}, which compares against the document actually on screen. */
          select: hit ? (hit.layoutPath as JxPath) : null,
          status: "ready",
        };
  }
  if (derived.preset === "locale") {
    /* WHERE THE TRANSLATION WOULD LIVE, which is a different question from whether it is there.
       `translationPathFor` is the same string math the build runs, so the path this resolves to is
       the path the site would serve; it answers null for a document no locale can address at all —
       a layout, a component, a file at the project root — and for a tag the project stopped
       declaring, which is the case {@link presetRefusal} cannot catch because it runs once. */
    const i18n = getEffectiveLocales();
    const wanted =
      source.documentPath === null || derived.locale === null
        ? null
        : translationPathFor(source.documentPath, derived.locale, i18n);
    if (wanted === null) {
      return {
        ...base,
        path: null,
        probePath: null,
        reason: "This document has no path in that locale.",
        select: null,
        status: "unavailable",
      };
    }
    /* AND WHETHER IT IS THERE, which this function cannot ask: it is pure and synchronous, and
       handing back a path for a file that does not exist makes `openFileInPane` fail into a blank
       pane — §18.4's last paragraph refuses exactly that. {@link _localeProbes} is the same shape
       {@link _diffLoads} is, for the same reason: a terminal answer written onto `derived.status`
       is overwritten by the next frame's resolve, so the pane would say "Loading…" forever about a
       file nobody is reading. */
    const probe = _localeProbes.get(paneId);
    if (probe?.path !== wanted || probe.exists === null) {
      return {
        ...base,
        path: null,
        probePath: wanted,
        reason: "",
        select: null,
        status: "loading",
      };
    }
    if (!probe.exists) {
      return {
        ...base,
        path: null,
        probePath: null,
        reason:
          `No ${localeLabel(derived.locale)} copy of this document yet — ` +
          "the Languages panel can create one.",
        select: null,
        status: "unavailable",
      };
    }
    return { ...base, path: wanted, probePath: null, reason: "", select: null, status: "ready" };
  }
  const path = componentPathUnderSelection(source);
  if (path === null) {
    return derived.resolved === null
      ? {
          ...base,
          path: null,
          probePath: null,
          reason: "Select an element inside a component to see its definition.",
          select: null,
          status: "unavailable",
        }
      : { ...base, path: null, probePath: null, reason: "", select: null, status: "ready" };
  }
  return { ...base, path, probePath: null, reason: "", select: null, status: "ready" };
}

/** Every size breakpoint a document declares, plus `null` for base. */
export function declaredMedia(tab: Tab): (string | null)[] {
  const { sizeBreakpoints } = parseMediaEntries(getEffectiveMedia(tab.doc.document.$media));
  return [null, ...sizeBreakpoints.map((bp) => bp.name)];
}

/* There is no `rawDocOf`. It read the document through `toRaw` under a docstring explaining that
   traversing the reactive proxy would make every node the walk touches a dependency — true of a
   read INSIDE an effect, and none of these are. **Tracking is a property of where a read happens,
   not of which object it happens on**: {@link derivedTarget} and {@link presetRefusal} are reached
   from `queueRetarget`'s rAF, from `loadDiffFor`'s `.then`, from a command's `run` and from
   `panels/pane-context.ts`'s click handler, and there is no active effect at any of those. So the
   `toRaw` bought nothing that being outside an effect had not already bought, and no state the app
   can reach could tell it from its absence. What the resolvers DO read is declared by
   {@link installDerivationEffects}, which is the only place a read of theirs is ever observed. */

/**
 * The component definition the selection sits inside, or null.
 *
 * Walks UP from the selected node, because the author clicks the paragraph and means the card. That
 * is also what makes the memo work: twenty clicks inside one `<my-card>` all resolve to the same
 * definition, so `applyDerivation` does nothing at all — no render, no host post, no file read.
 *
 * @param {Tab | null} tab
 * @returns {string | null}
 */
export function componentPathUnderSelection(tab: Tab | null): string | null {
  const [selected] = tab?.session.selection ?? [];
  if (!tab || !selected) {
    return null;
  }
  const doc = tab.doc.document;
  let path: JxPath | null = [...selected];
  while (path) {
    const node = getNodeAtPath(doc, path);
    const entry = node
      ? componentRegistry.find((candidate) => candidate.tagName === node.tagName)
      : null;
    if (entry?.path) {
      return entry.path;
    }
    path = parentElementPath(path) as JxPath | null;
  }
  return null;
}

// ─── Writing ─────────────────────────────────────────────────────────────────

/**
 * Make `paneId` a derived pane. The one writer of `Pane.derived`, with {@link clearPaneDerivation}.
 *
 * Refuses a derivation naming a pane that is not in the grid, or naming this pane — invariant D1,
 * asserted and never repaired: a self-derivation is an infinite `tabOfPane` hop, and a dangling
 * `sourcePaneId` is a stage drawing a document that has no pane.
 *
 * @param {string} paneId
 * @param {PaneDerivation} derivation
 */
export function setPaneDerivation(paneId: string, derivation: PaneDerivation): void {
  if (derivation.sourcePaneId === paneId || !paneById(derivation.sourcePaneId)) {
    throw new RangeError(
      `pane "${paneId}" cannot derive from "${derivation.sourcePaneId}" — a derivation names ` +
        `another pane that is in the grid`,
    );
  }
  writeDerivation(paneId, derivation);
}

/**
 * Write `pane.derived` and forget the answers the previous one had in hand — its comparison and its
 * translation probe alike. **The only writer, both ways.**
 *
 * A new derivation is a new question, so the previous one's answer is not an answer to it — and a
 * pane that has stopped deriving has no question at all. That was two `_diffLoads.delete` calls
 * under a comment reading "both writers forget it; nothing else may", which is an invariant stated
 * twice and enforced in neither place: only one of the two could be reached by a test, so inverting
 * the other was a mutation the whole suite could not see. One line, one call site each.
 *
 * `workspace.ts` writes `pane.derived = null` twice more — {@link receivingPane} and `closePane`'s
 * D4 — and deliberately does not route through here: those are grid facts, this module imports from
 * that one, and a pane can only derive AGAIN through {@link setPaneDerivation}, which forgets.
 */
function writeDerivation(paneId: string, derivation: PaneDerivation | null): void {
  const pane = paneById(paneId);
  if (pane) {
    _diffLoads.delete(paneId);
    _localeProbes.delete(paneId);
    pane.derived = derivation;
  }
}

/**
 * Stop deriving. The pane keeps whatever tabs it owns — a companion's document stays open, which is
 * exactly what Pin means — and a lens, owning none, becomes an empty pane its next collapse
 * removes.
 *
 * @param {string} paneId
 */
export function clearPaneDerivation(paneId: string): void {
  writeDerivation(paneId, null);
}

/**
 * Bring `paneId` into line with {@link derivedTarget}. Idempotent, and safe to run every frame.
 *
 * The only impure half of the follow, and it does exactly two things: it records the status the
 * pane draws, and — for a companion whose answer has CHANGED — it re-points the pane at the new
 * document. The memo is on `resolved`, the answer, not on the selection that produced it.
 *
 * @param {string} paneId
 * @param {DerivationDeps} deps
 */
export function applyDerivation(paneId: string, deps: DerivationDeps): void {
  const pane = paneById(paneId);
  const derived = pane?.derived;
  const target = derivedTarget(paneId);
  if (!pane || !derived || !target) {
    return;
  }
  canvasPerf.derivedResolves += 1;
  derived.status = target.status;
  derived.reason = target.reason;
  if (derived.kind === "lens") {
    /* Invariant D2, enforced rather than assumed: a lens owns NO tab. Anything sitting in its
       strip when the lens was created has already been handed back to the source pane by
       `pane.derive`; this is the belt to those braces, and it is what keeps `paneOfTab` — which
       every destructive tab verb resolves through — unable to name a lens pane at all.
       The tabs MOVE rather than being dropped: a detach with no insert would leave a live tab in
       `workspace.tabs` that no pane holds, which is a document nobody can reach and nobody can
       close. Nothing a derivation does may lose a document. */
    const source = paneById(derived.sourcePaneId);
    if (pane.tabOrder.length > 0 || pane.activeTabId !== null) {
      const owned = [...pane.tabOrder];
      for (const tabId of owned) {
        detachTab(tabId);
        if (source) {
          insertIntoPane(source, tabId);
        }
      }
      pane.activeTabId = null;
    }
    /* A DIFF LENS HOLDS A COMPARISON ONLY WHILE IT IS THE SOURCE DOCUMENT'S, and nothing enforced
       that. `derivedTarget` says `ready` for exactly the case where the one in hand is the right
       one; every other answer — the wrong file in hand after a tab switch, a source document with
       no changes, no source document at all — means the pane is holding somebody else's, and
       `canvas/canvas-render.ts` draws whatever is in this field rather than the notice beside it.
       Clearing it is what makes that file's `if (!gitDiffState)` fire. The previous release
       shipped a comment claiming this was fixed and no line that did it. */
    if (derived.preset === "diff" && target.status !== "ready") {
      derived.diff = null;
    }
    loadDiffFor(paneId, target, deps);
    return;
  }
  /* FIRST, unlike {@link loadDiffFor}, which is the last thing the lens half does. A probe that has
     not answered yet resolves to `path: null` — the hold — and the hold returns two statements
     below, so a call at the end of this function would never be reached by the one target that
     needs it. */
  probeTranslationFor(paneId, target, deps);
  /* THE MEMO IS ABOUT WHAT IS ON SCREEN, so it cannot outlive the document being on screen.
     A resolved companion owns a real tab, so `panels/tab-strip.ts` draws a real chip with a real
     ✕ — and closing it left the pane holding a derivation whose `resolved` still named the file
     that had just gone. `paneIsEmpty` counts the derivation as a subject so the pane stayed; the
     strip fell back to the derivation chip; and the stage said "Looking for something to show
     here…" for the rest of the session, because every following frame found `target.path ===
     derived.resolved` and did nothing. Forgetting the answer when the pane is showing nothing is
     what lets the next frame ask the question again. */
  if (derived.resolved !== null && tabOfPane(paneId) === null) {
    derived.resolved = null;
  }
  if (target.path === null || target.path === derived.resolved) {
    // Same document, possibly a different node inside it — clicking a second piece of layout chrome
    // Moves the selection without re-reading the file.
    selectInPane(paneId, target);
    return;
  }
  derived.resolved = target.path;
  canvasPerf.derivedRetargets += 1;
  const opening = deps.openFileInPane(paneId, target.path);
  if (target.select === null) {
    return;
  }
  /* The selection lands AFTER the open, because there is no tab to select in until then. Awaiting
     rather than firing both is what makes "Open Layout →" arrive at the node the author clicked
     instead of at the top of a file they now have to search. */
  void Promise.resolve(opening).then(() => {
    selectInPane(paneId, target);
  });
}

/**
 * Select `target.select` in whatever `paneId` is showing, when that is the document it is about.
 *
 * Idempotent, and it has to be: {@link applyDerivation} runs every frame the follow fires, and a
 * `session.selection` write is a reactive write that repaints the Inspector, the overlays and the
 * block bar. Comparing first is what keeps a following pane free.
 */
function selectInPane(paneId: string, target: DerivedTarget): void {
  const wanted = target.select;
  const tab = tabOfPane(paneId);
  if (!wanted || !tab || (target.path !== null && tab.documentPath !== target.path)) {
    return;
  }
  const [current] = tab.session.selection;
  if (current?.length === wanted.length && current.every((seg, i) => seg === wanted[i])) {
    return;
  }
  tab.session.selection = [[...wanted]];
}

/**
 * The comparison each diff lens has ASKED for, and how that went.
 *
 * Never cleared on COMPLETION, only when the wanted path changes, so the follow's next frame cannot
 * re-issue a failing request forever. `failed` is the half that was missing: the status
 * `loadDiffFor` wrote when the read came back empty was overwritten by the very next resolve, and
 * the pane went back to saying "Loading this file's changes…" permanently. A terminal answer has to
 * live where {@link lensTarget} — which composes every other answer — can see it.
 */
const _diffLoads = new Map<string, { path: string; rev: number; failed: boolean }>();

/**
 * Fetch the comparison a diff lens is missing, once.
 *
 * @param {string} paneId
 * @param {DerivedTarget} target
 * @param {DerivationDeps} deps
 */
function loadDiffFor(paneId: string, target: DerivedTarget, deps: DerivationDeps): void {
  const path = target.diffPath;
  const change = gitChangeFor(path);
  /* THE REVISION IS HALF THE KEY, and without it this memo is a cache with no invalidation: it
     asked once per PATH and never again, so a lens went on showing the comparison it read when it
     opened for as long as it stayed open. Reading `shell.git.rev` here also makes it a tracked
     input of the effect that calls this, so a save re-issues rather than waiting for something else
     to repaint. */
  const { rev } = shell.git;
  const asked = _diffLoads.get(paneId);
  if (path === null || !change || (asked?.path === path && asked.rev === rev)) {
    return;
  }
  _diffLoads.set(paneId, { failed: false, path, rev });
  deps
    .loadDiff(path, change.status)
    .then((state) => {
      const live = paneById(paneId)?.derived;
      if (
        live?.kind !== "lens" ||
        live.preset !== "diff" ||
        _diffLoads.get(paneId)?.path !== path
      ) {
        return;
      }
      if (state) {
        live.diff = state;
        live.diffRev = rev;
      } else {
        _diffLoads.set(paneId, { failed: true, path, rev });
      }
      /* Re-resolve rather than writing a status here: `ready` with the comparison in hand,
         `unavailable` with {@link DIFF_UNREADABLE} when the read came back empty — composed in the
         one function that composes every other answer, so the next frame agrees with this one. It
         cannot re-enter, because neither of those answers carries a `diffPath`. */
      applyDerivation(paneId, deps);
    })
    .catch((error: unknown) => {
      console.error("loadDiff error:", error);
    });
}

/**
 * Which translation each locale companion has ASKED about, and whether it is there.
 *
 * {@link _diffLoads}'s twin, and cleared by the same writer for the same reason. `exists` is
 * THREE-valued on purpose: `null` is "asked, no answer yet", which is the state the pane draws
 * "Loading…" for, and it cannot be folded into `false` — `false` is a terminal answer with a
 * sentence naming the language and offering to create the file, and showing that sentence for the
 * frame between the question and the answer would tell the author their translation is missing
 * every time they open the pane.
 */
const _localeProbes = new Map<string, { path: string; exists: boolean | null }>();

/**
 * Ask whether the translation a locale companion wants is on disk, once per wanted path.
 *
 * @param {string} paneId
 * @param {DerivedTarget} target
 * @param {DerivationDeps} deps
 */
function probeTranslationFor(paneId: string, target: DerivedTarget, deps: DerivationDeps): void {
  const path = target.probePath;
  if (path === null || _localeProbes.get(paneId)?.path === path) {
    return;
  }
  _localeProbes.set(paneId, { exists: null, path });
  deps
    .fileExists(path)
    .then((exists) => {
      const live = paneById(paneId)?.derived;
      /* THE ANSWER TO THE QUESTION THAT IS STILL BEING ASKED. A read issued for `fr` that lands
         after the author retargeted the pane at `de` would otherwise write `de`'s memo with `fr`'s
         answer — the same late-landing hazard {@link loadDiffFor} carries, and the same guard. */
      if (
        live?.kind !== "companion" ||
        live.preset !== "locale" ||
        _localeProbes.get(paneId)?.path !== path
      ) {
        return;
      }
      _localeProbes.set(paneId, { exists, path });
      /* Re-resolve rather than writing a status here, for {@link loadDiffFor}'s reason: both
         answers are composed by {@link companionTarget} beside every other one, and neither of
         them carries a `probePath`, so this cannot re-enter. */
      applyDerivation(paneId, deps);
    })
    .catch((error: unknown) => {
      console.error("fileExists error:", error);
    });
}

// ─── The follow ───────────────────────────────────────────────────────────────

/** One pending retarget per pane. A shared id would let one pane swallow the other's frame. */
const _retargetRafIds = new Map<string, number>();

/**
 * Run `applyDerivation` on the next frame, once per pane however many times it is asked.
 *
 * **Scheduled, never synchronous.** The effect below reads `workspace.panes`, and a retarget writes
 * `pane.tabOrder` through `openFileInPane` — an effect that triggers itself, which is the hazard
 * `panels/pane-grid.ts` names at its own reconciler. The rAF hop is the same shape
 * `scheduleCanvasRender` uses, for the same reason.
 */
function queueRetarget(paneId: string, deps: DerivationDeps): void {
  if (_retargetRafIds.has(paneId)) {
    return;
  }
  _retargetRafIds.set(
    paneId,
    requestAnimationFrame(() => {
      _retargetRafIds.delete(paneId);
      try {
        applyDerivation(paneId, deps);
      } catch (error) {
        console.error("applyDerivation error:", error);
      }
    }),
  );
}

/**
 * Subscribe ONE pane's follow. Called from `studio.ts`'s per-pane effect scope, so it is stopped
 * when the pane leaves the grid.
 *
 * **Most of the follow is STRUCTURAL, and that is still the design.** `tabOfPane(paneId)` reads the
 * source pane's `activeTabId`, so the render effects already installed for this pane track it and
 * repaint when the source pane switches document.
 *
 * **Every derivation subscribes, and this effect is where.** No preset "follows structurally and
 * declares nothing": the body below reads THIS pane's `activeTabId` and `tabOfPane(sourcePaneId)`
 * unconditionally, whatever the preset — `diff` and `breakpoint` are the two that add nothing on
 * top. An input a resolver consults and the effect does not observe is an answer nobody asks for:
 * this docstring claimed the `$layout` subscription for a release while the effect did not have it,
 * the Code lens's refusal against a source pane showing Code arrived the same way, and so did
 * {@link applyDerivation}'s memo-forget, whose comment described closing a companion's document
 * while nothing re-ran the follow when it closed.
 *
 * The list is BY INPUT rather than by preset, because `layout` declares two of them. Every input is
 * a HUMAN GESTURE rather than a keystroke — closing a tab in this pane, switching the source pane's
 * document, a layout click, a selection, a click on the Editor axis — except the page's own
 * `$layout`, whose per-transaction cost is stated at the read itself. `layout` follows the layout
 * HIT and `$layout`; `component` is the only preset that observes the SELECTION, and it memoises on
 * its answer; `code` observes the source pane's canvas mode, because the refusal that keeps two
 * Monaco models off one URI is a standing answer about a value one click changes.
 *
 * Each of those claims is a test rather than a sentence — see `pane-derive.test.ts`'s "the follow
 * NOTICES the close", "a companion re-resolves when the SOURCE pane switches document", "the layout
 * follow OBSERVES the hit", "changing the page's layout MOVES the companion", "clicking into a
 * component RE-POINTS the pane" and "a Code lens notices the source pane switching to Code".
 *
 * @param {string} paneId
 * @param {DerivationDeps} deps
 */
export function installDerivationEffects(paneId: string, deps: DerivationDeps): void {
  effect(() => {
    const pane = paneById(paneId);
    const derived = pane?.derived;
    if (!derived) {
      return;
    }
    /* THIS PANE'S OWN TAB, for both kinds, and its absence is the interesting value.
       `applyDerivation` forgets a companion's memo when the pane is showing nothing, so the next
       frame asks the question again — and there was no next frame. The tracked inputs were the
       SOURCE pane's tab and the selection, neither of which a `closeTab` in the following pane
       touches, so closing the document a layout companion had opened left the pane stranded behind
       a memo naming a file that was gone: the exact failure that comment describes, with the fix
       one call away from ever running. A lens reads it too, for one line's worth of the same
       reason: invariant D2 says a lens owns no tab, `applyDerivation` hands one back if it finds
       one, and an insertion nothing observes is an insertion nothing repairs.
       It costs one resolve per open or close in this pane — a gesture, not a keystroke — and no
       retarget, because the answer the memo compares against has not changed. */
    void pane.activeTabId;
    /* The rest of the tracked inputs, and only these: which tab the source pane is showing, and —
       for the presets that observe them — that tab's selection, editor kind and `$layout`. What
       the RESOLVERS read is not among them, because they run in `queueRetarget`'s rAF where no
       effect is active: an untracked read is untracked because of WHERE it happens. So typing,
       which replaces `tab.doc.document`, re-runs this effect only for the one preset that reads
       that field HERE. */
    const source = tabOfPane(derived.sourcePaneId);
    if (derived.kind === "lens" && derived.preset === "code") {
      /* The SOURCE pane's editor kind, and only this preset reads it. {@link lensTarget} refuses a
         Code lens for as long as the pane it follows is ALSO showing Code — two Monaco models on
         one URI — and that is a standing answer about a value one click on the Editor axis
         changes. Untracked, the refusal would be computed only on some later frame that
         re-resolved for another reason, and until then the stage mounts the second model, which is
         the throw the refusal exists to prevent. One human gesture per change, like the layout
         hit; nothing per keystroke. */
      void source?.session.ui.canvasMode;
    }
    if (derived.kind === "companion" && derived.preset === "component") {
      void source?.session.selection;
    }
    /* `locale` ADDS NOTHING, and the omission is the honest answer rather than a gap. The two
       inputs above — this pane's own tab and the source pane's — are exactly what it reads: the
       locale is fixed on the derivation, and the file it wants is a function of the source
       document's path. Its third input, the project's declared locales, CANNOT be tracked:
       `projectState` is a plain `let` (`store/state.ts`) that `setProjectState` replaces whole, so
       no effect anywhere observes it. Adding a locale in Project Settings therefore does not
       re-run this follow; the next retarget — any tab switch in either pane — picks it up, and
       {@link companionTarget} re-reads the list every time it resolves, so the pane cannot go on
       showing a locale the project has stopped declaring. A `void` read of a non-reactive value
       would look like a subscription and be none, which is the shape the `layout` preset shipped
       a release of. */
    if (derived.kind === "companion" && derived.preset === "layout") {
      /* The LAYOUT hit, which is what "Open Layout →" is a follow of. It changes only when the
         author clicks layout chrome (`iframe-host.ts` writes it) or clicks page content (which
         clears it) — a human gesture, not a keystroke — so it costs nothing to observe and it is
         the difference between a following layout pane and one frozen on the first header. */
      void shell.layoutSelection;
      /* AND the page's own `$layout`, which is the answer whenever there is no hit. The docstring
         above claimed this preset followed it while the effect did not read it at all: the
         resolver's read happens in the rAF, where nothing is tracking, so changing a page's layout
         in the Inspector left the companion on the old file with the pure half answering correctly
         and nothing calling it. An input a resolver consults and the effect does not observe is an
         answer nobody asks for.
         The cost is stated rather than hidden. `tab.doc.document` is replaced by every
         transaction, so this re-runs on a keystroke — but `queueRetarget` collapses a frame's
         worth into one rAF and `applyDerivation` memoises on the resolved PATH, so the expensive
         half (the file read) still happens exactly once per real change of layout. `component`
         does NOT read it, and its memo test is what holds that: it types twenty characters and
         asserts the resolve count does not move, which a per-transaction read here would break. */
      void source?.doc.document?.$layout;
    }
    queueRetarget(paneId, deps);
  });
}

// ─── Commands ─────────────────────────────────────────────────────────────────

/**
 * The refusal for a preset that cannot be built right now, or null when it can.
 *
 * **Run-time, not `enablement`** — the same shape `canvas.setMode` uses, and for the same reason:
 * `enablement` is ONE sentence for the whole command and five presets have five reasons. The menu
 * renders each row disabled with the sentence this returns, and `run` throws a `RangeError`
 * carrying it, so the tooltip and the refusal are the same words.
 *
 * `locale` takes a fourth argument, DEFAULTED rather than added to every call: the two callers that
 * ask about a breakpoint have nothing to say about a language, and a required parameter would have
 * made them pass a `null` that means nothing at those sites.
 *
 * @param {DerivePreset} preset
 * @param {string} sourcePaneId
 * @param {string | null} media
 * @param {string | null} locale
 * @returns {string | null}
 */
export function presetRefusal(
  preset: DerivePreset,
  sourcePaneId: string,
  media: string | null,
  locale: string | null = null,
): string | null {
  const source = tabOfPane(sourcePaneId);
  if (!source) {
    return "an open document";
  }
  /* WHAT THE DOCUMENT CAN BE SHOWN AS, asked before anything else. See {@link MODE_FOR_PRESET}:
     three of the five presets put the pane into a named canvas mode, and the menu offered all five
     over a document whose format declares neither. */
  const needed = MODE_FOR_PRESET[preset];
  if (needed && !source.capabilities.modes.includes(needed)) {
    return `a document with a ${MODE_WORDS[needed]} view — this one declares none`;
  }
  if (preset === "code") {
    /* Refused at CREATION, and refused again for as long as it lasts. Two Code views of one file
       is a second Monaco model on one URI, which real Monaco throws on; this predicate stops the
       lens being MADE that way, and {@link lensTarget} stops it being DRAWN that way when the
       source pane switches to Code afterwards. A comment here once claimed one predicate bought
       the whole of that safety, and one click on the Editor axis was enough to disprove it. */
    return canvasModeOfTab(source) === "source"
      ? "a source pane that is not already showing Code"
      : null;
  }
  if (preset === "diff") {
    /* Asked of THIS DOCUMENT's source-control status, not of an app-level slot. It read
       `shell.git.diffState === null`, which is written only when the author clicks a file in the
       Git panel — so the row was refused for a page that genuinely has changes, and offered for a
       page that does not the moment some other file's diff was on screen. */
    return gitChangeFor(source.documentPath) === null ? "a file with changes against HEAD" : null;
  }
  if (preset === "breakpoint") {
    return declaredMedia(source).includes(media)
      ? null
      : "a breakpoint this document declares — see Project Settings › Contexts";
  }
  if (preset === "layout") {
    /* REFUSED UP FRONT, because the answer is a stable fact about the document rather than a
       standing rule waiting on the author's next click. Offered anyway, choosing it published a
       derivation whose companion never opened anything: a pane holding a derivation and no tabs,
       which `paneIsEmpty` will not collapse, whose strip drew nothing and whose stage drew nothing.
       `component` is deliberately NOT refused the same way — "select an element inside a component"
       is a rule that resolves on the next click, which is the whole point of leaving it open. */
    return getEffectiveLayoutPath(source.doc.document.$layout as string | false | undefined) ===
      null
      ? "a page with a layout — this one declares none"
      : null;
  }
  if (preset === "locale") {
    /* THE PROJECT'S OWN LIST, read at the moment the menu is drawn. `projectState` is a plain
       module-level `let` replaced wholesale by `setProjectState`, so a locale added in Project
       Settings is visible to the next call and to nothing that cached one. */
    const i18n = getEffectiveLocales();
    if (i18n === null || i18n.locales.length < 2) {
      return "a project that declares more than one locale — see Project Settings › Locales";
    }
    /* A PATH, because a translation is a FILE (§13.3) rather than a rendering: an unsaved document
       has nowhere for its sibling to be, and `translationPathFor` would answer null for it one
       frame later with a sentence about locales instead of about saving. */
    if (source.documentPath === null) {
      return "a document that has been saved";
    }
    return locale !== null && i18n.locales.includes(locale)
      ? null
      : "a locale this project declares";
  }
  return null;
}

/**
 * Why `paneId` cannot derive, or null when it can. **A pure function OF THE PANE.**
 *
 * `pane.derive`'s `enablement` opened with `activePane()` and the menu asked the registry
 * `disabledReason("pane.derive")` for a pane it had been handed by name — so the same pane got two
 * answers depending on where the keyboard was, and every row in the SECONDARY pane's menu was
 * permanently disabled the moment the author clicked into the lens beside it.
 *
 * **The structural point, stated once here.** A command's `enablement(ctx)` receives no pane, and
 * it cannot: a command's subject IS the focused pane, which is what makes `⌘\` mean "split the
 * thing I am looking at". A per-pane MENU is a different question with a different subject, so it
 * must not be routed through a predicate that resolves one. The answer therefore lives in a pure
 * predicate the menu calls with its own pane, and the command record reuses it for the focused one
 * — one rule, two subjects, no second definition site.
 *
 * `scripts/check-pane-singletons.ts` rule 4 charges a pane-scoped function for reading the focus
 * one hop in, and it could not see this one: the hop was a METHOD CALL on a registry value,
 * dispatched by a string id to a closure built in another module. Following THAT needs a type
 * checker. What the rule can decide is that the question was asked, so `disabledReason` and
 * `isEnabled` are focus reads now — see that file's {@link FOCUS_NAMES}. The closure is still
 * invisible and is not pretended otherwise.
 *
 * @param {string} paneId
 * @returns {string | null}
 */
export function deriveRefusal(paneId: string): string | null {
  const pane = paneById(paneId);
  return pane && pane.activeTabId !== null && pane.derived === null ? null : DERIVE_REQUIRES;
}

/** The one sentence `pane.derive` refuses with — its `requires`, and the menu's disabled reason. */
const DERIVE_REQUIRES = "an open document in a pane that is not itself derived";

/** The derivation record a preset builds, given the pane it derives from. */
function derivationFor(
  preset: DerivePreset,
  sourcePaneId: string,
  media: string | null,
  locale: string | null = null,
): PaneDerivation {
  /* A COMPANION, because the French copy of this page is a different FILE — §13.3 has no message
     catalogue, so there is no rendering of this document that is the French one. A lens here would
     be a second copy of the same page under a chip naming another language, which is the defect
     this module's own header warns about: a projection that changes only the chip. */
  if (preset === "locale") {
    return {
      kind: "companion",
      locale,
      preset,
      reason: "",
      resolved: null,
      sourcePaneId,
      status: "loading",
    };
  }
  if (preset === "layout" || preset === "component") {
    return {
      kind: "companion",
      preset,
      reason: "",
      resolved: null,
      sourcePaneId,
      status: "loading",
    };
  }
  const mode = preset === "code" ? "source" : preset === "diff" ? "git-diff" : "design";
  return {
    /* NO COMPARISON, whatever the Git panel happens to be holding. This seeded itself from
       `shell.git.diffState` — an app-level slot carrying the file the author last clicked in the
       Git panel — so a brand-new Diff lens's FIRST PAINT was somebody else's document, under a
       chip naming this one, until the follow's frame corrected it. The lens loads its own. */
    diff: null,
    kind: "lens",
    media: preset === "breakpoint" ? media : null,
    mode,
    preset,
    reason: "",
    sourcePaneId,
    status: "loading",
    zoom: 1,
  };
}

/**
 * Whether `pane` can be pinned — a companion can, a lens cannot.
 *
 * A companion names a different FILE, so promoting its preview tab and dropping the derivation
 * leaves an ordinary tab, exactly as §18.4 says. A lens has no document of its own: pinning it
 * would have to mint a second tab for a path that already has one, which is the §14.1 violation the
 * whole design exists to avoid. Its exit is `pane.unsplit`.
 */
function pinnablePane(): Pane | null {
  return workspace.panes.find((pane) => pinRefusal(pane.id) === null) ?? null;
}

/**
 * Why `paneId` cannot be pinned, or null when it can. Pure, like {@link deriveRefusal}.
 *
 * **Unlike `pane.derive`, the COMMAND's subject is the grid rather than the focused pane**, and
 * that is deliberate: the author reaches "Keep This Document" from the palette while the keyboard
 * is in the page they are editing, and a grid holds at most one derived pane — `pane.derive` puts
 * the projection in `sidePane()`, and `workspace.ts`'s `MAX_PANES` is 2. {@link pinnablePane} finds
 * it by scanning, which reads no focus and is therefore the same answer from anywhere — so the
 * preset menu can ask it about its own pane and get an answer about its own pane.
 *
 * @param {string} paneId
 * @returns {string | null}
 */
export function pinRefusal(paneId: string): string | null {
  const pane = paneById(paneId);
  return pane?.derived?.kind === "companion" && pane.activeTabId ? null : PIN_REQUIRES;
}

/** `pane.pin`'s `requires`, and the menu's disabled reason. One sentence, one home. */
const PIN_REQUIRES =
  "a derived pane showing a document of its own — Code, Diff and breakpoint views project " +
  "the document already open beside them";

/**
 * The derivation commands: `pane.derive` and `pane.pin`.
 *
 * They live here rather than in `paneCommands()` because a capability's record belongs beside its
 * implementation — the same rule the tab and pane commands follow. `pane.compareWith` deliberately
 * stays in `workspace.ts`: it is a transport verb over the pane model and needs none of this.
 *
 * @param {DerivationDeps} deps
 * @returns {AnyCommand[]}
 */
export function derivationCommands(deps: DerivationDeps): AnyCommand[] {
  return [
    {
      args: argsSchema(
        {
          locale: stringProperty('BCP 47 tag for preset "locale". Ignored by every other preset.'),
          media: stringProperty(
            'Breakpoint name for preset "breakpoint" — omit or leave empty for the base size. ' +
              "Ignored by every other preset.",
          ),
          preset: enumProperty(
            DERIVE_PRESETS,
            "Which projection of this pane's document to show beside it.",
          ),
        },
        ["preset"],
      ),
      id: "pane.derive",
      title: "Show Beside This…",
      category: "View",
      level: "document",
      /* NOT in the palette, and that is a fact about the palette rather than a judgement about
         this verb: `panels/quick-search.ts`'s `paletteArgs` can prompt for exactly ONE closed value
         space, so a command with two properties is dropped from command mode entirely. Declaring
         `"palette"` here would declare a surface that never renders the row — the same
         "declared and never drawn" defect `context/pane` itself spent two phases being. The preset
         menu on the pane's context bar is this command's surface, and every row there IS the
         command with its arguments (§13.5), which is also how the screenshot manifest addresses
         it. */
      menus: ["context/pane"],
      group: "5_pane",
      when: (ctx) => ctx.document.open,
      /* One sentence, because `enablement` only has one. What each preset needs is decided at run
         time by {@link presetRefusal}, which the menu also reads to disable a row with its own
         reason.
         The FOCUS is read HERE and only here — a command's subject is the pane the keyboard is in,
         and that read belongs at the record where a reviewer can see it. {@link deriveRefusal} is
         the pane-scoped predicate underneath, which is what the per-pane menu calls instead. */
      enablement: () => deriveRefusal(activePane().id) === null,
      requires: DERIVE_REQUIRES,
      undo: "none",
      aiTool: {
        description: "Show a projection of the current document in the pane beside it.",
        name: "show_beside",
      },
      run: (_ctx, args) => {
        const preset = enumArg("pane.derive", args, "preset", DERIVE_PRESETS);
        /* `??`, not `||`. `optionalStringArg` answers `undefined` or a non-empty string — it is
           `stringArg` underneath, which REFUSES `""` — so the two operators cannot disagree here,
           and the `||` implied a blank the caller can never deliver. */
        const media = optionalStringArg("pane.derive", args, "media") ?? null;
        const locale = optionalStringArg("pane.derive", args, "locale") ?? null;
        const source = activePane();
        const refusal = presetRefusal(preset, source.id, media, locale);
        if (refusal) {
          throw new RangeError(
            `command "pane.derive" argument "preset": "${preset}" requires ${refusal}`,
          );
        }
        const target = sidePane();
        /* The DERIVATION IS PUBLISHED FIRST, and the order is not cosmetic.
           §18.1 rule 3 removes a pane with no subject, and `detachTab` applies it as each tab
           leaves — so handing the side pane's tabs back before it had a derivation collapsed the
           very pane about to become the lens, and `setPaneDerivation` then wrote onto a pane that
           was no longer in the grid. `paneIsEmpty` counts a derivation as a subject; giving the
           pane one first is what makes the hand-back safe. Nothing renders between these two
           statements — `run` is synchronous to the end — so no frame observes a lens with tabs. */
        setPaneDerivation(target.id, derivationFor(preset, source.id, media, locale));
        /* NOTHING IS CLOSED. Whatever the side pane was holding goes back to the pane the author
           is in — the same promise `closePane` makes — so a derivation is a layout action rather
           than a destructive one. */
        /* `detachTab` reassigns `activeTabId` to `tabOrder.at(-1) ?? null` as each tab leaves, so
           the pane's own field is already `null` when the last one has gone: a trailing
           `target.activeTabId = null` here wrote the value it already held, and inverting it
           changed nothing any state could reach. `applyDerivation` still owns the D2 repair for a
           tab that arrives afterwards. */
        const displaced = [...target.tabOrder];
        for (const tabId of displaced) {
          detachTab(tabId);
          insertIntoPane(source, tabId);
        }
        applyDerivation(target.id, deps);
        // The focus does NOT move. An assistant pane does not take the keyboard: the author asked
        // To SEE something beside what they are doing, not to go and work on it.
      },
    },
    {
      id: "pane.pin",
      title: "Keep This Document",
      category: "View",
      level: "document",
      menus: ["context/pane", "palette"],
      group: "5_pane",
      /* Enabled for a COMPANION only, and the sentence says which — §18.4's "until it is pinned, at
         which point it becomes an ordinary tab" is true for `layout` and `component` and impossible
         for `code`, `diff` and `breakpoint`. */
      enablement: () => pinnablePane() !== null,
      requires: PIN_REQUIRES,
      undo: "none",
      run: () => {
        const pane = pinnablePane();
        if (!pane?.activeTabId) {
          return;
        }
        promoteTab(pane.activeTabId);
        clearPaneDerivation(pane.id);
      },
    },
  ];
}
