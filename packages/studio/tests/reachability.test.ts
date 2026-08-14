/**
 * Nothing in `packages/studio/src` may be unreachable from the app's entry points.
 *
 * P7 shipped ELEVEN features that were built, unit-tested, and reachable from nothing — four
 * command factories neither composed nor registered, two composed but never registered, and four
 * functions (`applyDraftFilter`, `loadMediaUsages`, `peekMediaUsages`, `mediaUsageHeadline`) with
 * no caller at all. Every gate was green, because a unit test imports the module under test
 * directly and so cannot tell whether anything else does. `tests/app-commands-composition.test.ts`
 * closed the command-factory half of that by pattern; this closes the rest by construction.
 *
 * The analysis is in `./reachability.ts` — a call graph over the TypeScript checker's own symbol
 * resolution, walked from the bundle entrypoints, the package's published exports, and the repo
 * scripts that import studio source. Tests are not roots, which is the entire point.
 *
 * Two lists, and they are different things:
 *
 * - {@link DYNAMIC_ENTRY} — genuinely reached, through a channel no static analysis can see. These
 *   are NOT debt; deleting one turns a green CI lane red. Each says who reaches it and how.
 * - {@link KNOWN_UNREACHABLE} — the functions the running app still cannot get to. A debt ledger, not
 *   a set of exemptions: it only ever shrinks, and **every entry carries a reason**. It landed
 *   holding 143 bare names across 91 files, which is how nine `deploy-checklist.ts` lines hid a
 *   FINISHED feature nobody had plugged in — a bare name cannot be told apart from an oversight.
 *   Triaging those 143 resolved 29 of them (two whole modules and the legacy flat-state layer
 *   deleted; six caches, accessors and a delegation wired) and gave the remaining 114 a stated
 *   decision. Delete the code with its tests, or give it an entry point, and delete the line.
 *
 * All three gates below are staleness-tested, so none can rot into a suppression: a name that no
 * longer exists fails, a name that became reachable fails, and an entry with no reason fails.
 *
 * Runtime is about 5s: one type-check of the monorepo, then batched symbol resolution.
 */

import { describe, expect, test } from "bun:test";
import { analyzeReachability } from "./reachability";

/**
 * Reached at runtime through a dynamic `import()` on a string path, then read off the module
 * object. The compiler cannot see it, and neither can this check — but CI does.
 */
const DYNAMIC_ENTRY = new Map<string, string>([
  [
    "commands/defaults.ts:defaultCommandSet",
    "scripts/check-command-levels.ts imports its `--source` module by path and calls " +
      "`source.defaultCommandSet()` off a cast",
  ],
  [
    "services/automation.ts:seedIds",
    "scripts/check-shot-contract.ts imports each DEFAULT_COMMAND_SOURCES module by path and " +
      "calls `module_.seedIds()` off a cast",
  ],
]);

/**
 * Module-private state, reset so the next test starts cold.
 *
 * There is no app path and there should not be one: Studio boots each of these modules once per
 * window and never unwinds them, so a caller would be a caller with nothing to say. Deleting them
 * does not shed dead weight, it makes every suite inherit the previous suite's state.
 */
const TEST_RESET = "test-only state reset — the app never unwinds this module";

/**
 * A panel's `unmount`, mirroring its `mount` exactly.
 *
 * "Nothing calls it yet" and "nothing should ever call it" are different things, and this is the
 * first. `shell.ts` already declares the contract these fit — `ShellSurface` is `{ mount, unmount
 * }` — and `unmountShell()` already loops it. But only `bottom-dock` registers, and
 * `unmountShell()` is itself unreachable, so registering the other nine would move the deadness up
 * a level rather than resolve it. What is missing underneath is a reason for the shell to ever tear
 * down: a second window, or a project switch that rebuilds the chrome instead of resetting it in
 * place.
 *
 * Each one is meanwhile load-bearing for its own suite — every panel test calls it in teardown, to
 * stop an effect scope and drop a host — so these are the least deletable lines in the ledger.
 */
const PANEL_TEARDOWN = "panel teardown, symmetric with mount() — the shell has no tear-down path";

/** A seam for handing a module its data directly, instead of the async load the app takes. */
const TEST_SEAM = "test/host seam — the app takes the async path beside it";

/** Module-private state read back through an accessor that only its own tests call. */
const TEST_OBS = "observability accessor — only its own tests read the private state through it";

/**
 * Functions the app cannot reach, by file — and WHY each one is still here.
 *
 * The list only ratchets down: a new entry is a new defect, and the gate below says so by name. The
 * REASON is mandatory, and `every ledger entry states a reason` enforces it. 143 entries
 * accumulated here as bare names, and a bare name is indistinguishable from an oversight — nine
 * `deploy-checklist.ts` lines sat in that pile while the feature they belonged to was finished and
 * simply not plugged in.
 *
 * Four reasons are shared, because they are genuinely one decision made many times. The rest say
 * their own piece, and several of them name a defect somebody still has to choose about.
 */
const KNOWN_UNREACHABLE: Record<string, Record<string, string>> = {
  "account-status.ts": { resetAccountStatus: TEST_RESET },
  "browse/library-layouts.ts": {
    cellTextOf:
      "row-shaped access for a caller holding grid cells rather than the typed record. The " +
      "Library renders from the record, so that caller does not exist",
  },
  "browse/library-model.ts": {
    isLibraryLayout:
      "the type guard behind `library.setLayout`'s argument. The command validates through its " +
      "JSON-Schema `args` enum instead, so the guard is a second spelling of the same rule",
  },
  "canvas/canvas-perf.ts": { resetCanvasPerf: TEST_RESET },
  "canvas/canvas-utils.ts": {
    hasDeclaredFit:
      "asks whether the active document declared a fit of its own. Every caller today wants the " +
      "fit itself; the distinction is real but has no reader while zoom-to-fit is still moving",
    resetFits: TEST_RESET,
  },
  "canvas/iframe-channel.ts": {
    fakeChannelPair:
      "the deterministic in-memory channel pair every cross-frame suite drives postMessage " +
      "ordering with. It exists so tests need no live iframe, which is why the app never calls it",
  },
  "canvas/iframe-host.ts": {
    adoptDragSession:
      "the parent half of DnD flow 3 (grab-anywhere), and the only half there is. " +
      "`iframe-protocol.ts` carries the flow-3 comment but declares no message variant to START " +
      "one, and `iframe-entry.ts`'s `updateAutoScroll` takes a `flow3` argument that neither of " +
      "its two call sites passes. Flow 3 does not exist end to end — finishing it or deleting all " +
      "three halves is a DnD decision, not a wiring",
  },
  "canvas/iframe-position.ts": {
    isAtBlockEnd:
      "a SECOND SPELLING of a predicate that ships. Delete-at-a-block's-end joining the next block " +
      "is built — `canvas/editable-actions.ts` returns `mergeForward` from it — but the caller " +
      "computes the same fact inline (`resolved.to.offset >= blockTextLength(resolved.endEl)` in " +
      "`iframe-editable-root.ts`), so this export has no reader. An audit found this reason " +
      "claiming the behaviour was unbuilt; either the caller adopts this or it goes",
  },
  "canvas/iframe-protocol.ts": {
    isCanvasMode:
      "the runtime guard for a `CanvasMode` arriving over the wire. Both sides of the protocol are " +
      "typed and built together, so nothing narrows at the boundary yet",
  },
  "collab/collab-session.ts": { resetCollabForTests: TEST_RESET },
  "collab/collab-state.ts": {
    isCollabActive:
      "per-tab collab predicate. The live readers hold the state record itself " +
      "(`states.get(tab)`) rather than asking, so this accessor has no consumer",
  },
  "commands/levels.ts": {
    checkPanelPlacements:
      "the whole-set wrapper over `checkPanelPlacement`. `scripts/check-command-levels.ts` reaches " +
      "the singular one directly, so the plural is an unused convenience",
    placementAdmits:
      "the placement matrix as a predicate. The checker reads the matrix through " +
      "`checkPanelPlacement`, so nothing asks the question in this shape",
  },
  "editor/context-menu.ts": {
    copyStyles:
      "A REAL DIVERGENCE, and a product call. `edit.copyStyles`/`edit.pasteStyles` are registered " +
      "and live with their own inline bodies, which address `deps.target()` — the ONE " +
      "right-clicked node. These two address `session.selection` — all of it, in one transaction. " +
      'UX-REDESIGN-PLAN §6.5 says the batch is the intent ("structural commands iterating inside ' +
      'one transaction, so a batch is one undo step"), which makes the LIVE command the wrong one ' +
      "and this the right one. Wiring it changes what a paste does to a multi-selection, so " +
      "somebody has to choose it rather than a refactor sliding it in",
    pasteStyles: "see `copyStyles` — the same divergence, and the half that carries the §6.5 batch",
  },
  "editor/slash-menu.ts": {
    isSlashMenuOpen:
      "the concrete menu's open flag. Callers go through the injected `slash.isOpen()` seam, which " +
      "is what makes the menu swappable",
  },
  "files/file-ops.ts": {
    openFile:
      "the File System Access API open path. Every shipped host opens through the platform " +
      "adapter and the tree, so the browser file picker has no entry point — it is the fallback " +
      "for a host with no adapter, and no such host exists",
  },
  "files/media-meta.ts": {
    loadMediaMeta:
      "one file's size and dimensions, request-coalesced. The media surfaces render from the " +
      "directory listing they already hold; nothing yet shows per-file metadata",
  },
  "files/media-paths.ts": {
    dirName:
      "the directory half of the media path helpers. Its caller would be the media MOVE the media " +
      "panel does not offer",
  },
  "files/media-usage.ts": {
    mediaUsageHeadline:
      'the RENDERING half of media reference counting — "Counting references…", a count, or ' +
      '**unknown**, which is deliberately a different fact from "unused". `loadMediaUsages` is ' +
      "wired (`file-ops.ts` reads it before a delete); the surface that would DISPLAY a count is " +
      "not built. Named in this file's own P7 list at the top and still unresolved",
    peekMediaUsages:
      "see `mediaUsageHeadline` — the synchronous read that surface would paint from",
    retryMediaUsages: "see `mediaUsageHeadline` — the Retry behind the failed count it would show",
  },
  "format/constraints.ts": {
    createNestingValidator:
      "builds a nesting validator from a format's `$studio.elements`. Drop and insert both reject " +
      "invalid nesting inside the iframe's own drop math, so no parent-side validator is built",
  },
  "format/format-host.ts": { setExtensions: TEST_SEAM, setFormats: TEST_SEAM },
  "grid/grid-layout.ts": {
    clearGridLayout:
      'drops a grid\'s stored layout AND its named views. Nothing offers "reset this grid" — the ' +
      "grid's commands all write layouts, none discards one. A missing command, not a question",
  },
  "new-project/location-fields.ts": {
    locationError:
      "reads back the inline validation message from the last `collectDestination`. The dialog " +
      "renders the message from the value that call returned, so it never re-reads it",
  },
  "panels/activity-bar.ts": { unmount: PANEL_TEARDOWN },
  "panels/activity-panel.ts": { resetActivities: TEST_RESET },
  "panels/block-action-bar.ts": {
    isLinkPopoverOpen:
      "guards a toolbar refresh from re-rendering the open link popover out from under the caret. " +
      "The refresh path consults the edit snapshot instead — worth re-checking the day a refresh " +
      "is seen closing that popover",
    useCommandRegistry:
      "injects the app-wide registry into the selection surfaces in place of their own. The " +
      "bootstrap lets them keep their own, so the injection point is unused; its contract " +
      "(register the selection commands AND honour `commandTargetPath`) is why it is a seam",
  },
  "panels/chat-panel.ts": { unmount: PANEL_TEARDOWN },
  "panels/data-explorer.ts": { resetDataRowExpansion: TEST_RESET },
  "panels/data-grid.ts": {
    isDataGridAvailable:
      "a one-line re-export of `dataSurfaceAvailable()`; callers ask the underlying predicate",
    resetDataGridState: TEST_RESET,
  },
  "panels/frontmatter-panel.ts": { unmount: PANEL_TEARDOWN },
  "panels/layers-panel.ts": {
    outlineRowPath:
      "reads a row's unambiguous `JxPath` back off `data-jx-path`. Its docstring names five " +
      "readers that need exactly this — shift-range select, drag-reorder, canvas-to-Outline sync, " +
      "a collaborator's cursor, a Problems jump — and every one of them uses the LOSSY `data-path` " +
      'key beside it, which collides `["children", 0]` with `["children", "0"]` and cannot ' +
      "represent a segment containing a slash. The correct reader is written and waiting; " +
      "migrating five call sites onto it is a real change with real risk",
  },
  "panels/left-panel.ts": { unmount: PANEL_TEARDOWN },
  "panels/navigator-panels.ts": { resetNavigatorPanels: TEST_RESET },
  "panels/overlays.ts": { unmount: PANEL_TEARDOWN },
  "panels/pane-context.ts": {
    resetResolvingOpen: TEST_RESET,
    unmount: PANEL_TEARDOWN,
  },
  "panels/panel-registry.ts": {
    resetPanels: TEST_RESET,
    unregisterPanel:
      'removes one panel. Named for "the contributed-extension path", and that path only ever ' +
      "adds — an extension disabled at runtime leaves its panel registered. Wiring it needs " +
      "extension teardown, which does not exist",
  },
  "panels/quick-search.ts": {
    isQuickSearchOpen:
      "\"the fact the Command Bar's ⌘K affordance reflects\" — and it does not: the pill's ⌘K " +
      "segment renders identically whether the palette is up or not. A small, real gap in ①a",
  },
  "panels/right-panel.ts": { unmount: PANEL_TEARDOWN },
  "panels/signals-panel.ts": {
    resolveDefaultForCanvas:
      "renders a `$ref` as its signal's default so the canvas shows a value rather than a raw " +
      "ref. The canvas resolves refs through the live iframe scope now " +
      "(`services/live-preview.ts`), which cannot disagree with the render; this is the " +
      "parent-side fallback nothing falls back to",
  },
  "panels/statusbar.ts": { forgetSavedTimes: TEST_RESET },
  "panels/style-panel.ts": {
    resetAffectedDisclosure:
      "test reset, with a caveat worth keeping: `_showAffected` is deliberately module-global " +
      "rather than per-tab, so it also survives a PROJECT switch — and the warning band it folds " +
      "open belongs to a project. `resetProjectShell()` is where that would be answered, and " +
      "`shell.ts` may not import a panel",
    resetSelectorMenu: "test reset; delegates to `target-line.ts`'s `resetSelectorTrigger`",
  },
  "panels/tab-strip.ts": { unmount: PANEL_TEARDOWN },
  "panels/target-line.ts": { resetSelectorTrigger: TEST_RESET },
  "panels/toolbar.ts": { setMacPlatformForTests: TEST_SEAM, unmount: PANEL_TEARDOWN },
  "project-list.ts": { resetProjectList: TEST_RESET },
  "publish/deploy-checklist.ts": {
    forgetDeployment: "test reset, and the project-close half of the memory below",
    observedDeployment:
      "the READ half of the deployment memory: `noteDeployment` writes and nothing reads back, so " +
      "the checklist recomputes its `unknown` branch instead of remembering the deployment it " +
      "already observed. Nine of this file's eleven entries were the P7 shape and are wired; " +
      "these two are the remainder, and what a remembered deployment entitles the checklist to " +
      "skip is a Publish decision",
  },
  "services/ai-models.ts": {
    getProxyDefaultModel:
      "the proxy's preferred model id. The picker offers the full list and defaults to the first, " +
      "so the proxy's own preference is fetched, stored, and never consulted",
  },
  "services/ai-writes.ts": { resetAiWrites: TEST_RESET },
  "services/cem-export.ts": {
    exportCemManifest:
      "downloads a CEM 2.1.0 manifest for the open document, and still takes the DELETED flat " +
      "state shape (`{ document }` plus three injected helpers) rather than a `Tab`. No menu " +
      "offers it. Port it onto a command or delete the module — it is the last caller-shaped " +
      "remnant of the old state model",
  },
  "services/clock.ts": {
    isClockPinned:
      '"Read by `probe.state()`" — and it is not. `services/automation.ts` builds `state()` from ' +
      "the CommandContext, which has no clock field, so a capture taken with the clock pinned " +
      "looks identical to one taken live and the manifest cannot tell",
    unpinClock:
      "releases the pin. Only the screenshot runner pins, and it pins for the life of a capture " +
      "process, so nothing ever releases",
  },
  "services/code-services.ts": {
    locateDocument:
      "asks the server to find a document by filename. Every jump the app makes — Problems, " +
      "references, the palette — already carries a full path, so nothing searches by name",
  },
  "services/data-service.ts": {
    listSecretNames:
      "the secrets seam, and it is being ROUTED AROUND: `settings/contributed-section.ts` calls " +
      "`platform.setSecrets` directly rather than through this module. Either these three " +
      "wrappers are the seam and that call site is the defect, or they are surplus — one decision " +
      "covers all three",
    saveSecrets: "see `listSecretNames` — the same routed-around seam",
    secretsAvailable: "see `listSecretNames` — the same routed-around seam",
  },
  "services/jx-validate.ts": { resetProjectSchemas: TEST_RESET },
  "services/live-preview.ts": {
    requestLivePreview:
      "evaluates a node against the live canvas scope, falling back to the parent snapshot. The " +
      "value surfaces read the snapshot path directly; this is the async upgrade nothing has taken",
  },
  "services/monaco-lazy.ts": { isMonacoLoaded: TEST_OBS, resetMonacoLazy: TEST_RESET },
  "services/monaco-setup.ts": { resetProjectSchemas: TEST_RESET },
  "services/notify.ts": { resetNotifications: TEST_RESET },
  "services/profile.ts": {
    resetStartupProfile: TEST_RESET,
    startupState: "what the app started as. Nothing prints the startup profile, so nothing asks",
  },
  "settings/contexts-section.ts": {
    contextsError:
      "reads back the per-container failure message. The section renders the message at the point " +
      "it is set, so the WeakMap is written and never read — which also means a re-render drops " +
      "the message it was keyed to survive",
  },
  "settings/contributed-section.ts": {
    resetContributedDiagnostics: TEST_RESET,
    resetContributedSectionState: TEST_RESET,
  },
  "settings/extension-sections.ts": {
    extensionSectionKeys: "diagnostics accessor; nothing reports the registered section keys",
    extensionSectionsReady:
      "awaits the in-flight contribution sync. Its one caller is " +
      "`settings-document.ts`'s `settingsSectionsReady`, which is itself unreachable — see there",
    resetExtensionSettingsSections: TEST_RESET,
  },
  "settings/preferences-accounts.ts": { resetCredentialListeners: TEST_RESET },
  "settings/preferences-dialog.ts": {
    closePreferences:
      '"Tests, and the shell teardown" — and the shell has no teardown (see PANEL_TEARDOWN). ' +
      "Escape and the dialog's own cancel close it through the layer stack, so the programmatic " +
      "close has no app caller",
    isPreferencesOpen: TEST_OBS,
    preferencesSection:
      'the section showing, for "the `app.preferences` round-trip". The command sets a section ' +
      "and never reads one back, so the round-trip is half-built: it can open a section but " +
      "cannot report which is open",
  },
  "settings/schema-field-ui.ts": {
    yamlDefault:
      "a YAML frontmatter default per schema type. Fields are seeded from the schema's own " +
      "`default` now; this type-based guess is the fallback for schemas declaring none, and " +
      "nothing asks for it",
  },
  "settings/section-registry.ts": { resetSettingsDocumentState: TEST_RESET },
  "settings/settings-document.ts": {
    activeSettingsSection:
      "which section the settings editor shows, or null when it is not the active editor. " +
      "Composed from two live functions and read by nobody",
    settingsDocumentOpen:
      "internal-only now: `activeSettingsSection` is its one caller and is itself unreachable",
    settingsSectionsReady:
      '"the readiness `probe.idle()` and the command both need" — and `services/idle.ts` does ' +
      "not list it. Contributed settings sections can still be syncing when a capture is taken " +
      "and no idle source says so. The fix is a seventh idle source, but `settings` importing " +
      "`idle` would cycle, so it needs the same injected shape the derived-cache drop uses",
  },
  "shell.ts": {
    resetShellSurfaces: TEST_RESET,
    unmountShell:
      "the shell's own teardown, and the loop that would drive every PANEL_TEARDOWN above. " +
      "Nothing tears the shell down: Studio mounts once per window and lives until the window " +
      "closes. This is the ROOT of the nine `unmount` entries — give the shell a reason to tear " +
      "down and ten lines leave the ledger together",
  },
  "style/project-styles.ts": {
    tokenOverrides:
      "every context in which a token already carries an override. The Stylebook's token rows " +
      "show the ACTIVE context's value; this cross-context summary is drawn nowhere",
  },
  "tabs/patch-ops.ts": {
    markNonInvertible:
      "marks the open transaction non-invertible, so history stores a checkpoint rather than an " +
      "inverse. Every mutation currently produces an invertible patch, so nothing has had to say " +
      "otherwise — the day one cannot, undo does the wrong thing silently without this call",
  },
  "tabs/project-config.ts": { resetProjectConfigDocument: TEST_RESET },
  "tabs/selection.ts": {
    selectionsEqual:
      "order-sensitive selection equality. The reactive selection is replaced wholesale and " +
      "effects compare by identity, so no site diffs two selections",
  },
  "tabs/transact.ts": {
    getHistoryDelegate:
      "reads a tab's history delegate back. `setHistoryDelegate` writes and the transaction path " +
      "uses the map directly, so the getter has no caller",
    mutateUpdateMedia:
      "renames or re-queries one `$media` entry. Breakpoints are defined in Project Settings › " +
      "Contexts, which writes the whole `$media` block rather than editing an entry — this is the " +
      "surgical edit that surface does not make",
  },
  "ui/dynamic-slot.ts": { resetSlotModeMemory: TEST_RESET },
  "ui/field-input.ts": {
    clearDraft:
      "discards a field's in-flight draft and cancels its debounced commit. Nothing discards — " +
      "drafts resolve by committing. The caller would be Escape-in-a-field, which today commits " +
      "like any other blur",
    hasDraft: "the predicate beside `clearDraft`, unread for the same reason",
  },
  "ui/form-controls.ts": { resetFormControlUiState: TEST_RESET },
  "ui/layers.ts": {
    clearLayerSlot:
      "removes a named layer slot from the DOM and the map. Slots are reused rather than cleared " +
      "— the same popover id is re-rendered — so nothing removes one, and a slot for a surface " +
      "that is gone for good leaves an empty div behind",
  },
  "ui/value-source.ts": { resetCapsCache: TEST_RESET },
  "utils/canvas-media.ts": {
    activeBreakpointsForWidth:
      "which named breakpoints a canvas width activates. The iframe answers this from its own " +
      "`matchMedia` now, where it cannot disagree with the rendered document; this is the " +
      "parent-side arithmetic that used to",
  },
  "utils/geometry.ts": {
    elementsAtPoint:
      "the full front-to-back hit stack at a point. Every hit test the parent still runs wants " +
      "the topmost element; the stack served the parent-side layout hit-testing that moved into " +
      "the iframe",
  },
  "utils/inherited-style.ts": {
    computeInheritedStyle:
      "the values a breakpoint inherits from narrower ones. The Style tab shows provenance per " +
      "field through `provenance.ts`, which answers WHERE a value came from rather than only " +
      "WHAT — a strictly larger answer, computed separately. One of the two should go, and " +
      "provenance is the one that ships",
  },
  "workspace/workspace.ts": {
    endTabCycle:
      "the modifier-release end of a ⌃Tab cycle. The comment above `_cycleList` states the " +
      'contract — the cycle ends "at endTabCycle (the modifier release) or at the next ordinary ' +
      'activation" — and only the second half happens, so the tab you settle on is never promoted ' +
      "to most-recent and the NEXT cycle starts from a stale MRU order. Wiring it needs a keyup " +
      "listener for a modifier that is rebindable through `commands/keymap.ts`, so WHICH key to " +
      "watch is a keymap decision",
    focusOtherPane:
      "focuses the pane that is not focused. The side pane is reached by clicking it or through " +
      "`view.focusPane { id }`, and a bare toggle would be exactly the delta-shaped verb §13.3 " +
      "clause 3 forbids — so this may be wrong to wire at all",
  },
};

/**
 * Modules under `src/` that nothing imports at all — dead in the same way, one level up.
 *
 * Empty, and it must stay that way: a module nothing imports is not debt to schedule, it is a file
 * to delete. `canvas/canvas-diff.ts` (a document-tree visual diff — the shipped Diff is the
 * `git-diff` editor kind, a text diff) and `canvas/nested-site-style.ts` (a nested-style-object CSS
 * builder with no producer of nested style objects) were the two, and both are gone.
 */
const KNOWN_UNREACHABLE_MODULES = new Set<string>();

const LEDGER = new Map<string, string>(
  Object.entries(KNOWN_UNREACHABLE).flatMap(([file, entries]) =>
    Object.entries(entries).map(([name, reason]): [string, string] => [`${file}:${name}`, reason]),
  ),
);

const report = await analyzeReachability();
const deadKeys = new Set(report.dead.map((d) => d.key));

describe("reachability", () => {
  test("the analysis actually saw the studio", () => {
    // A run that resolves nothing reports nothing dead, which would pass every assertion below.
    expect(report.moduleCount).toBeGreaterThan(250);
    expect(report.functionCount).toBeGreaterThan(2000);
    expect(deadKeys.size).toBeLessThan(report.functionCount / 4);
  });

  test("no function in src/ is unreachable from an entry point", () => {
    const news = report.dead
      .filter((d) => !LEDGER.has(d.key) && !DYNAMIC_ENTRY.has(d.key))
      .map(
        (d) =>
          `${d.name}() — src/${d.file}:${d.line}\n` +
          "      Nothing the running app reaches calls it. Give it an entry point (compose it " +
          "into appCommandSet(), register it at boot, or call it from a live path), or delete it " +
          "with its tests. If a repo script reaches it through a dynamic import, add it to " +
          "DYNAMIC_ENTRY with the script that does.",
      );
    expect(news, "built, tested, and reachable from nothing — the P7 failure, again").toEqual([]);
  });

  test("no module under src/ is unimported", () => {
    const news = report.deadModules.filter((m) => !KNOWN_UNREACHABLE_MODULES.has(m));
    expect(news, "nothing imports these files, so none of their code can run").toEqual([]);
  });

  test("the ledger holds nothing stale", () => {
    const keys = [...LEDGER.keys()];
    const gone = keys.filter((key) => !report.allFunctions.has(key));
    expect(
      gone,
      "KNOWN_UNREACHABLE names a function that no longer exists — delete the entry",
    ).toEqual([]);
    const revived = keys.filter((key) => report.allFunctions.has(key) && !deadKeys.has(key));
    expect(
      revived,
      "this is now reachable, so the ledger has ratcheted down — delete the entry",
    ).toEqual([]);
    for (const module_ of KNOWN_UNREACHABLE_MODULES) {
      expect(
        report.deadModules,
        `${module_} is imported again — delete it from KNOWN_UNREACHABLE_MODULES`,
      ).toContain(module_);
    }
  });

  test("every ledger entry states a reason", () => {
    // The whole point of the reason. 143 entries accumulated as bare names because nothing made
    // Anyone write one down, and a bare name reads exactly like a line somebody skipped — which is
    // How a finished feature (`publish/deploy-checklist.ts`) sat here for a phase looking like debt.
    // A reason short enough to be a shrug is not a decision, so there is a floor on it.
    const unexplained = [...LEDGER]
      .filter(([, reason]) => reason.trim().length < 40)
      .map(([key, reason]) => `${key} — ${reason.trim() === "" ? "(no reason)" : reason}`);
    expect(
      unexplained,
      "every KNOWN_UNREACHABLE entry needs a reason saying why it is still here: wire it, " +
        "delete it, or say what decision is outstanding and who owns it",
    ).toEqual([]);
  });

  test("every DYNAMIC_ENTRY exemption is still invisible to the analysis", () => {
    for (const [key, reason] of DYNAMIC_ENTRY) {
      expect(report.allFunctions.has(key), `${key} no longer exists — delete the entry`).toBe(true);
      expect(
        deadKeys.has(key),
        `${key} has a static caller now (${reason}) — delete the exemption`,
      ).toBe(true);
    }
  });
});
