/// <reference lib="dom" />
/**
 * Shell — the reactive record of Jx Studio's UI _inputs_.
 *
 * Companion to `view.ts`, and the other half of the split that `view.ts` used to straddle:
 *
 * - `view` holds render **outputs** — Monaco instances, the panzoom wrap, observers, DOM refs and the
 *   per-render cleanup arrays. It stays a plain object, because wrapping a live editor instance and
 *   detached DOM nodes in a reactive proxy is an active hazard.
 * - `shell` (here) holds UI **inputs** — which panel each dock shows, whether each dock is open and
 *   how wide, the focused region, the layout preset, and the project-level state (source control,
 *   the stylebook selection, the settings tab) that a _document_ must not own.
 *
 * Because this record is reactive, a surface tracks it by reading it: the rail, the left panel and
 * the toolbar all repaint from the effects they already run. The stand-in that preceded this —
 * `onPanelCollapse(fn)` plus an explicit `render()` in every toggle handler — is deleted.
 *
 * **Project-level state does not live on the focused tab.** Git status is a property of the
 * project, not of whichever document happens to be open: sourcing it from `activeTab` meant the
 * rail's Source Control badge vanished when the last tab closed, and two tabs could disagree about
 * the branch. See specs/studio.md and the level × placement matrix.
 */

import { effect, effectScope, reactive } from "./reactivity";
import { applyStartupProfile } from "./services/profile";
import { stampShellRegions } from "./ui/regions";
import { workspace } from "./workspace/workspace";
import {
  argsSchema,
  booleanArg,
  booleanProperty,
  enumArg,
  enumProperty,
  stringArg,
  stringProperty,
} from "./commands/command-args";
import type { EffectScope } from "@vue/reactivity";
import type { LayoutHit } from "./canvas/iframe-protocol";
import type { GitBranchesResult, GitDiffState, GitStatusResult } from "./types";
import type { AnyCommand, CommandRegistry } from "./commands/registry";

/**
 * The canvas selection when the author clicked LAYOUT chrome rather than page content — a header, a
 * footer, anything contributed by the layout file. It is deliberately NOT a document selection: the
 * node is not in the open page at all, so the properties panel shows the read-only layout panel
 * (with "Open Layout →") instead of the element inspector. See {@link setLayoutSelection}.
 */
export type LayoutSelection = LayoutHit;

/**
 * The three resizable docks around the pane grid: two flanking it, one under it.
 *
 * `"chat"` is not among them: the assistant is the Inspector's fourth TAB, not a dock, so it has no
 * column, no size, no collapse flag and no resize handle of its own — which is the whole claim of
 * plan §3.2 ⑨, that folding it in costs zero additional width. What selects it is
 * {@link INSPECTOR_TAB_IDS}, the same mechanism that selects Content, Style and Logic.
 *
 * `"bottom"` is the one that arrives with P4.2. It is a dock like the other two — a collapse flag,
 * a remembered size, a resize handle, a place in every {@link LayoutPreset} — and the reason
 * `view.toggleBottomDock` had no idempotent setter for two phases is that it was not on this
 * record. It sits under the PANE GRID rather than under the window (plan §3.2 ⑪), so opening it
 * never narrows the Navigator or the Inspector.
 */
export type DockId = "left" | "right" | "bottom";

/**
 * The ids of the panels the NAVIGATOR DOCK draws, in rail order, then the two with no rail button.
 *
 * This is the DECLARATION `view.setActivity`'s `args` enum is built from, and it is the reason a
 * panel rename fails `scripts/check-shot-contract.ts` in the renaming PR naming both ids instead of
 * silently photographing the wrong panel (plan §13.5). `shell.leftTab` stays a `string` because it
 * is also read from persisted state written by an older build — the COMMAND is what refuses an
 * undeclared id, at the one door a caller comes through, and {@link migratePanelId} is what turns a
 * stale stored id into a current one before it gets there.
 *
 * **`"problems"` is not here, and it has no rail button either.** It is hosted in the Bottom dock,
 * so `view.setBottomTab { tab: "problems" }` is the verb that shows it and this enum would be a
 * second, wrong door. That verb is now the ONLY door: the status bar's warning count runs it, and
 * `panel.focus.problems` no longer exists, because the roster it was generated from follows the
 * rail and Problems is off the rail.
 *
 * The records themselves live in `panels/navigator-panels.ts`, one per owning module. This list is
 * the same set written down in a module that imports no DOM, because `commands/app-commands.ts`
 * must load the enum in a bare Bun process; `tests/navigator-panels.test.ts` asserts the two agree,
 * so the duplicate cannot drift.
 */
export const NAVIGATOR_PANEL_IDS = [
  "files",
  "search",
  "git",
  "layers",
  "page",
  "data",
  "packages",
  "insert",
  "state",
] as const;

export type NavigatorPanelId = (typeof NAVIGATOR_PANEL_IDS)[number];

/**
 * Panel ids a previous build persisted, and what they are called now.
 *
 * Three renames, each fixing a name that described a mechanism rather than a task: `blocks` was an
 * insert palette, `head` was an HTML element, `imports` was the verb and not the thing. A stored
 * value is the one place those old strings can still arrive from, so they are translated once, on
 * read, and then never again — there is no alias in the registry and no branch in the rail.
 */
const RENAMED_PANEL_IDS: Readonly<Record<string, NavigatorPanelId>> = {
  blocks: "insert",
  head: "page",
  imports: "packages",
};

/** The panel the Navigator wakes up on when nothing usable is stored. */
export const DEFAULT_PANEL_ID: NavigatorPanelId = "layers";

/** Whether a string is a declared panel id. */
export function isNavigatorPanelId(value: unknown): value is NavigatorPanelId {
  return typeof value === "string" && (NAVIGATOR_PANEL_IDS as readonly string[]).includes(value);
}

/**
 * Translate a stored panel id into a current one, or `null` when it names nothing.
 *
 * `null` rather than a default, so the caller decides: the boot path falls back to
 * {@link DEFAULT_PANEL_ID}, and a test can tell "I stored junk" from "I stored `layers`".
 *
 * `"problems"` is the one id that returns `null` because it MOVED rather than because it was junk:
 * a build before §7.2's correction could persist `leftTab: "problems"`, and the Navigator can no
 * longer show it. There is no alias to add — Problems is not a Navigator panel under any name — so
 * the shell boots into {@link DEFAULT_PANEL_ID} and the Bottom dock keeps its own `bottomTab`,
 * which already defaults to Problems. This is exactly the wedge this function exists to prevent.
 */
export function migratePanelId(stored: unknown): NavigatorPanelId | null {
  if (typeof stored !== "string") {
    return null;
  }
  const renamed = RENAMED_PANEL_IDS[stored];
  if (renamed) {
    return renamed;
  }
  return isNavigatorPanelId(stored) ? stored : null;
}

/**
 * The Inspector's tab ids, in strip order — the `value`s `panels/right-panel.ts` renders.
 *
 * Four now, and `"assistant"` is one of them: the chat is a tab of this dock, so the id space that
 * addresses Content, Style and Logic addresses it too. The old arrangement needed a fourth verb
 * (`view.setAssistant`) precisely because the assistant was somewhere else; it survives as the
 * dock-toggle spelling of "show me the assistant", but it now writes the same field as the others.
 *
 * The ORDER is §3.2 ⑨'s — Content · Style · Logic · Assistant — which is the order ⌘⇧1–4 follow.
 * The human titles live in `commands/defaults.ts`'s `INSPECTOR_TABS` (a module with no state and no
 * DOM, so the CI checks can load it); `tests/right-panel.test.ts` asserts the two agree, the same
 * way `tests/navigator-panels.test.ts` does for the rail.
 */
export const INSPECTOR_TAB_IDS = ["properties", "style", "events", "assistant"] as const;

export type InspectorTabId = (typeof INSPECTOR_TAB_IDS)[number];

/** The tab the Inspector falls back to — the leftmost, Content. */
export const DEFAULT_INSPECTOR_TAB: InspectorTabId = "properties";

/** Whether a string is a declared Inspector tab id. */
export function isInspectorTabId(value: unknown): value is InspectorTabId {
  return typeof value === "string" && (INSPECTOR_TAB_IDS as readonly string[]).includes(value);
}

/**
 * The Bottom dock's tab ids, in strip order — plan §3.2 ⑪, at the documented cap of four.
 *
 * **Four, not five.** `scripts/check-chrome-budget.ts` caps a dock at four tabs, and §12's P4 entry
 * resolves the fifth candidate explicitly: **Deploy folds into Activity**, because a deploy IS a
 * long operation with a log, and giving it its own tab would have bought a fifth strip item to say
 * what the fourth already says.
 *
 * Declared here, beside {@link NAVIGATOR_PANEL_IDS} and {@link INSPECTOR_TAB_IDS} and for the same
 * reason: `view.setBottomTab`'s `args` enum is built from it, and `commands/app-commands.ts` must
 * load that enum in a bare Bun process, which it could not do from a module that renders lit
 * templates. `panels/bottom-dock.ts` builds its strip from this list and
 * `tests/bottom-dock.test.ts` asserts the two agree, exactly as the rail's do.
 */
export const BOTTOM_TAB_IDS = ["problems", "logic", "activity"] as const;

export type BottomTabId = (typeof BOTTOM_TAB_IDS)[number];

/** The tab the Bottom dock opens on. Problems, because that is the one it opens itself for. */
export const DEFAULT_BOTTOM_TAB: BottomTabId = "problems";

/** Whether a string is a declared Bottom dock tab id. */
export function isBottomTabId(value: unknown): value is BottomTabId {
  return typeof value === "string" && (BOTTOM_TAB_IDS as readonly string[]).includes(value);
}

/** The Studio chrome's Spectrum theme — the `color` attribute on `<sp-theme>`. */
export const CHROME_THEMES = ["light", "dark"] as const;

export type ChromeTheme = (typeof CHROME_THEMES)[number];

/** Which shell region currently owns keyboard focus (`focus.region` in the command context). */
export type FocusRegion = "rail" | "navigator" | "pane" | "inspector" | "dock" | "status";

/**
 * Open/closed plus size, per dock. Persisted together under one storage key.
 *
 * `size` and not `width`: the Bottom dock resizes on the other axis, so the field is measured along
 * whichever axis its dock's handle drags — px across for the two side docks, px tall for the bottom
 * one. {@link DOCK_CSS_VAR} names the custom property each one is projected onto, and that is where
 * the axis is stated in a place CSS can read.
 */
export interface DockState {
  collapsed: boolean;
  size: number;
}

/** One row of `git log`, as the Source Control panel's History tab renders it. */
export interface GitLogEntry {
  hash: string;
  message: string;
  author: string;
  date: string;
}

/** Source control — project level, one copy, independent of which document is focused. */
export interface ShellGit {
  status: GitStatusResult | null;
  branches: GitBranchesResult | null;
  commitMessage: string;
  loading: boolean;
  error: string | null;
  diffState: GitDiffState | null;
  logEntries: GitLogEntry[] | null;
  /** "changes" | "history" — the panel's sub-tab. */
  subTab: string;
  /** Epoch ms of the last successful refresh, or null when never refreshed. */
  lastUpdated: number | null;
}

/** The stylebook catalogue's selection and filters — project level, like the styles they edit. */
export interface ShellStylebook {
  selection: string | null;
  /** "elements" | "variables" */
  tab: string;
  filter: string;
  customizedOnly: boolean;
}

/**
 * A named arrangement of the shell — plan §3.2 ①b.
 *
 * A layout is a TUPLE, not a mode: which Navigator panel is showing, whether each dock is open and
 * how wide, and which Inspector tab is selected. Picking one reconfigures; it never removes. Every
 * panel stays reachable by rail, chord and palette afterwards, because §13 rejects workspaces that
 * gate features — telling a copy editor the Style panel "is in ⌘K" hands the non-technical user the
 * one affordance they are least likely to reach for.
 *
 * The field this replaces (`shell.layout`, a string with a declared default and NO writer) was the
 * exact failure `layoutSelection` had already been through: a record nothing sets, read by chrome
 * that therefore cannot change. Wiring it was the alternative to deleting it, and these are the
 * writers.
 *
 * **Editor kind is deliberately not in the tuple.** §3.2 ①b names it, but nothing in the shell can
 * apply it: switching a pane's editor is `studio.ts`'s `setCanvasMode`, which this module does not
 * have and cannot be handed without changing a bootstrap it does not own. A fourth field no writer
 * could honour would recreate the defect this type exists to close, so the tuple is three fields
 * and the fourth arrives with the pane record that can carry it.
 */
export interface LayoutPreset {
  /** Stable key. Built-ins use their own lowercase name; a saved layout gets a slug of its. */
  id: string;
  /** What the Command Bar tab reads. Renamed by double-clicking it. */
  name: string;
  /** Which Navigator panel this arrangement shows. */
  navigatorPanel: NavigatorPanelId;
  /** Which Inspector tab this arrangement selects. */
  inspectorTab: InspectorTabId;
  /** Which Bottom dock tab this arrangement selects — read whether or not the dock is open. */
  bottomTab: BottomTabId;
  /** Dock visibility and sizes, all three of them. */
  docks: Record<DockId, DockState>;
}

export interface ShellState {
  /** Which panel the Navigator dock shows. One of {@link NAVIGATOR_PANEL_IDS}. */
  leftTab: string;
  /**
   * Which tab the Bottom dock shows. One of {@link BOTTOM_TAB_IDS}.
   *
   * A `string` for the same reason `leftTab` is: it is also read back from persisted state, and the
   * COMMAND (`view.setBottomTab`) is what refuses an undeclared id, at the one door callers use.
   */
  bottomTab: string;
  /** The Studio chrome's Spectrum theme. One of {@link CHROME_THEMES}. */
  theme: ChromeTheme;
  docks: Record<DockId, DockState>;
  /**
   * Where the splitter sits between two panes, as the primary's share of the grid — [0.2, 0.8].
   *
   * On `shell` rather than on `workspace` because it is pure LAYOUT: it names no tab, no document
   * and no pane identity, and it is remembered with the dock widths because it is the same kind of
   * thing. Read only when `workspace.panes.length > 1`, so a value restored with no split open is
   * inert rather than wrong.
   */
  paneSplit: number;
  focusRegion: FocusRegion;
  /** The active {@link LayoutPreset}'s id — the Command Bar tab drawn as selected. */
  layout: string;
  /** Every layout this project has, built-ins included. Persisted per project root. */
  layouts: LayoutPreset[];
  layoutSelection: LayoutSelection | null;
  /** Which section Project Settings opens on. */
  settingsTab: string;
  stylebook: ShellStylebook;
  git: ShellGit;
}

const DOCK_STORAGE_KEY = "jx-studio-panel-widths";

const THEME_STORAGE_KEY = "jx-studio-theme";

/**
 * The per-project record's key prefix — one namespaced record per project root (§4.4).
 *
 * Namespaced because a layout is an arrangement of THIS project's panels: "Ship" over a repo with
 * no git remote is not the same tuple as "Ship" over one that has one, and two projects sharing a
 * key means opening the second silently rewrites the first.
 *
 * Dock geometry stays in {@link DOCK_STORAGE_KEY}, which is read at module scope, before any
 * project root exists. It is workspace state — `resetProjectShell()` has always kept it across a
 * project switch for that reason — and moving it here would mean the shell could not lay itself out
 * until a project opened.
 */
const PROJECT_STORAGE_PREFIX = "jx-studio-project::";

/**
 * The chrome theme Studio wakes up in.
 *
 * `index.html` hard-codes `color="dark"` on `<sp-theme>` so the first paint has a theme before this
 * module evaluates; the default here has to agree with it or the shell flashes.
 */
const DEFAULT_THEME: ChromeTheme = "dark";

/** Whether a string is one of the declared {@link CHROME_THEMES}. */
function isChromeTheme(value: unknown): value is ChromeTheme {
  return typeof value === "string" && (CHROME_THEMES as readonly string[]).includes(value);
}

/** Read the persisted theme, falling back to {@link DEFAULT_THEME} on absent/corrupt storage. */
function readPersistedTheme(): ChromeTheme {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return isChromeTheme(stored) ? stored : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export const DOCK_IDS: DockId[] = ["left", "right", "bottom"];

/**
 * First-run docks.
 *
 * The two side docks open, because the shell's whole point is that it says where you are. The
 * Bottom dock CLOSED, because it is the one dock whose contents are usually empty: a Problems list
 * with nothing in it and an Activity log with nothing running would spend 220px of the canvas — the
 * one region §3.2 says must never disappear — to say "nothing has gone wrong". ⌘J opens it, the
 * rail badge and the status bar say when it has something to show, and nothing opens it for you.
 */
const DOCK_DEFAULTS: Record<DockId, DockState> = {
  bottom: { collapsed: true, size: 220 },
  left: { collapsed: false, size: 240 },
  right: { collapsed: false, size: 280 },
};

/** The size a dock returns to when its handle is double-clicked. */
export const DOCK_DEFAULT_SIZES: Record<DockId, number> = {
  bottom: DOCK_DEFAULTS.bottom.size,
  left: DOCK_DEFAULTS.left.size,
  right: DOCK_DEFAULTS.right.size,
};

/**
 * The custom property each dock's size is projected onto — and where its axis is written down.
 *
 * `--panel-w-*` feeds `grid-template-columns`, `--dock-h-bottom` feeds `grid-template-rows`. Both
 * carry a declared fallback in `styles/tokens.css`, because an unset custom property inside a
 * `grid-template-*` shorthand invalidates the WHOLE declaration at computed-value time and the
 * shell would paint with no grid at all for the frame before the effect first runs.
 */
const DOCK_CSS_VAR: Record<DockId, string> = {
  bottom: "--dock-h-bottom",
  left: "--panel-w-left",
  right: "--panel-w-right",
};

const DOCK_CLASS: Record<DockId, string> = {
  bottom: "bottom-collapsed",
  left: "left-collapsed",
  right: "right-collapsed",
};

/**
 * The persisted shell record. Absent keys keep the declared default.
 *
 * `leftTab` rides in the same record as the dock geometry because it is remembered for the same
 * reason and by the same writer — one key, one shape, one `JSON.stringify`. P3.7 replaces the whole
 * thing with a per-project session record; until then, adding a second localStorage key would
 * recreate the two-writer bug this record was consolidated to fix.
 */
interface PersistedDocks {
  left?: number;
  right?: number;
  bottom?: number;
  leftCollapsed?: boolean;
  rightCollapsed?: boolean;
  bottomCollapsed?: boolean;
  /** The Navigator panel last shown. Migrated through {@link migratePanelId} on read. */
  leftTab?: string;
  /** The Bottom dock tab last shown. Checked by {@link isBottomTabId} on read. */
  bottomTab?: string;
  /** The pane splitter's position. Clamped on READ — see {@link clampPaneSplit}. */
  paneSplit?: number;
}

/** An even split — what the grid opens on, and what a double-click on the splitter restores. */
export const DEFAULT_PANE_SPLIT = 0.5;

/**
 * Coerce a stored split into the supported range.
 *
 * Clamped here, at the READ, rather than at the drag site: the drag already refuses to leave the
 * range, so the only way a bad value arrives is a corrupt or hand-edited record — and that is the
 * one caller that has to be defended.
 */
function clampPaneSplit(value: unknown): number {
  return typeof value === "number" && value >= 0.2 && value <= 0.8 ? value : DEFAULT_PANE_SPLIT;
}

/** Move the splitter. Clamped, and the one writer every control routes through. */
export function setPaneSplit(value: number): void {
  shell.paneSplit = Math.min(0.8, Math.max(0.2, value));
}

/** Read the persisted dock record, tolerating absent/corrupt storage. */
function readPersistedDocks(): PersistedDocks {
  try {
    return JSON.parse(localStorage.getItem(DOCK_STORAGE_KEY) || "{}") as PersistedDocks;
  } catch {
    return {};
  }
}

function freshGit(): ShellGit {
  return {
    branches: null,
    commitMessage: "",
    diffState: null,
    error: null,
    lastUpdated: null,
    loading: false,
    logEntries: null,
    status: null,
    subTab: "changes",
  };
}

function freshStylebook(): ShellStylebook {
  return { customizedOnly: false, filter: "", selection: null, tab: "elements" };
}

/**
 * The four layouts every project starts with — §3.2 ①b's `Write · Design · Build · Ship`.
 *
 * Each is a real arrangement of surfaces that already exist, not a mode: Write puts the file set
 * beside the prose and the Inspector on Content; Design opens the Outline against the Style tab;
 * Build pairs Data with Logic; Ship opens Source Control and gives the whole width to the diff by
 * collapsing the Inspector — which stays one ⌘B away, because a layout never removes.
 *
 * Written as a factory so every project gets its own objects: they are mutable records (a saved
 * layout overwrites the one with its name) and a shared array literal would leak one project's
 * edits into the next.
 */
function builtInLayouts(): LayoutPreset[] {
  return [
    {
      bottomTab: "problems",
      docks: {
        bottom: { collapsed: true, size: 220 },
        left: { collapsed: false, size: 240 },
        right: { collapsed: false, size: 280 },
      },
      id: "write",
      inspectorTab: "properties",
      name: "Write",
      navigatorPanel: "files",
    },
    {
      bottomTab: "problems",
      docks: {
        bottom: { collapsed: true, size: 220 },
        left: { collapsed: false, size: 240 },
        right: { collapsed: false, size: 320 },
      },
      id: "design",
      inspectorTab: "style",
      name: "Design",
      navigatorPanel: "layers",
    },
    {
      bottomTab: "logic",
      docks: {
        bottom: { collapsed: true, size: 260 },
        left: { collapsed: false, size: 280 },
        right: { collapsed: false, size: 300 },
      },
      id: "build",
      inspectorTab: "events",
      name: "Build",
      navigatorPanel: "data",
    },
    {
      // The one built-in that OPENS the Bottom dock, on Activity: shipping is a long operation
      // With a log, which is exactly what that tab is (§12 P4 — Deploy folds into Activity).
      bottomTab: "activity",
      docks: {
        bottom: { collapsed: false, size: 240 },
        left: { collapsed: false, size: 300 },
        right: { collapsed: true, size: 280 },
      },
      id: "ship",
      inspectorTab: "properties",
      name: "Ship",
      navigatorPanel: "git",
    },
  ];
}

/** The layout a project wakes up on, and the fallback when a stored id names nothing. */
export const DEFAULT_LAYOUT_ID = "design";

/**
 * Build the whole record — nested collections complete — before it is handed to `reactive()`.
 *
 * Assembling it this way is not style: writing into a nested plain object AFTER the proxy exists
 * goes through the raw target and skips every effect depending on it.
 */
function createShellState(): ShellState {
  const saved = readPersistedDocks();
  const docks = {} as Record<DockId, DockState>;
  for (const id of DOCK_IDS) {
    const width = saved[id];
    const collapsed = saved[`${id}Collapsed` as const];
    docks[id] = {
      // A stored `false` has to REOPEN a dock, so this cannot be the usual
      // `if (saved.x) { collapse() }` shape — that silently pins a dock shut forever for
      // Everyone who ever closed it once.
      collapsed: typeof collapsed === "boolean" ? collapsed : DOCK_DEFAULTS[id].collapsed,
      size: typeof width === "number" && width > 0 ? width : DOCK_DEFAULTS[id].size,
    };
  }
  return {
    bottomTab: isBottomTabId(saved.bottomTab) ? saved.bottomTab : DEFAULT_BOTTOM_TAB,
    docks,
    focusRegion: "pane",
    paneSplit: clampPaneSplit(saved.paneSplit),
    git: freshGit(),
    layout: DEFAULT_LAYOUT_ID,
    layoutSelection: null,
    layouts: builtInLayouts(),
    leftTab: migratePanelId(saved.leftTab) ?? DEFAULT_PANEL_ID,
    settingsTab: "stylebook",
    stylebook: freshStylebook(),
    theme: readPersistedTheme(),
  };
}

/*
 * The startup profile is applied HERE, above the first read of persisted state.
 *
 * `?profile=fresh` has to mean "the app woke up with nothing", and this module's `createShellState()`
 * is the earliest `localStorage.getItem` in the import graph — every other read is inside a function
 * and therefore runs after module evaluation. Clearing storage a statement later would restore the
 * dock widths from a profile that claims not to have any.
 */
applyStartupProfile();

/*
 * The input is widened before `reactive()` sees it: `UnwrapNestedRefs<ShellState>` recurses through
 * `LayoutHit` and the git result shapes deeply enough for tsc to give up (TS2589). The proxy is
 * deep either way — only the type computation is short-circuited — and the declared annotation is
 * what every consumer sees. Same reason `tabs/tab.ts` casts its own reactive tree.
 */
export const shell: ShellState = reactive(
  createShellState() as unknown as Record<string, unknown>,
) as unknown as ShellState;

/**
 * Write the whole dock record in one shot.
 *
 * One writer, one shape. The predecessor had two: `persistWidths()` wrote a fresh `{left,right,…}`
 * to this key while `applyPanelCollapse()` read-merge-wrote the collapse booleans into it, so
 * dragging any handle wiped all of them.
 */
export function persistDocks(): void {
  try {
    localStorage.setItem(
      DOCK_STORAGE_KEY,
      JSON.stringify({
        bottom: shell.docks.bottom.size,
        bottomCollapsed: shell.docks.bottom.collapsed,
        bottomTab: shell.bottomTab,
        left: shell.docks.left.size,
        leftCollapsed: shell.docks.left.collapsed,
        leftTab: shell.leftTab,
        paneSplit: shell.paneSplit,
        right: shell.docks.right.size,
        rightCollapsed: shell.docks.right.collapsed,
      } satisfies PersistedDocks),
    );
  } catch {
    // Storage full or unavailable — the layout is still applied, just not remembered.
  }
}

// ─── Named layouts (§3.2 ①b) ──────────────────────────────────────────────────

/** What a project's namespaced record holds today. Session state (§4.4) grows into this shape. */
interface PersistedProject {
  layouts?: unknown;
  activeLayout?: unknown;
}

/** The project whose layouts are loaded, or `undefined` before the first sync. */
let _layoutRoot: string | null | undefined;

/** Whether a parsed value is a usable {@link LayoutPreset} — a stored record is untrusted input. */
function isLayoutPreset(value: unknown): value is LayoutPreset {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const preset = value as Partial<LayoutPreset>;
  return (
    typeof preset.id === "string" &&
    preset.id !== "" &&
    typeof preset.name === "string" &&
    isNavigatorPanelId(preset.navigatorPanel) &&
    isInspectorTabId(preset.inspectorTab) &&
    isBottomTabId(preset.bottomTab) &&
    DOCK_IDS.every((dock) => typeof preset.docks?.[dock]?.size === "number")
  );
}

/** Read a project's namespaced record, tolerating absent, corrupt and hand-edited storage. */
function readPersistedProject(root: string | null): {
  layouts: LayoutPreset[];
  activeLayout: string | null;
} {
  const fresh = { activeLayout: null, layouts: builtInLayouts() };
  if (!root) {
    return fresh;
  }
  let parsed: PersistedProject;
  try {
    parsed = JSON.parse(
      localStorage.getItem(`${PROJECT_STORAGE_PREFIX}${root}`) || "{}",
    ) as PersistedProject;
  } catch {
    return fresh;
  }
  const layouts = Array.isArray(parsed.layouts) ? parsed.layouts.filter(isLayoutPreset) : [];
  if (layouts.length === 0) {
    return fresh;
  }
  return {
    activeLayout: typeof parsed.activeLayout === "string" ? parsed.activeLayout : null,
    layouts,
  };
}

/**
 * Write the project's namespaced record. One key, one writer, one shape.
 *
 * The dock record's two-writer bug (`persistWidths` vs `applyPanelCollapse`, both on
 * {@link DOCK_STORAGE_KEY}) is the reason this is a single function that serialises the whole
 * record rather than a merge at each call site.
 */
export function persistProjectShell(): void {
  const root = workspace.projectRoot;
  if (!root) {
    return;
  }
  try {
    localStorage.setItem(
      `${PROJECT_STORAGE_PREFIX}${root}`,
      JSON.stringify({
        activeLayout: shell.layout,
        layouts: shell.layouts,
      } satisfies PersistedProject),
    );
  } catch {
    // Storage full or unavailable — the arrangement is applied, just not remembered.
  }
}

/**
 * Load the layouts belonging to `root`. Idempotent per root, so the effect can call it freely.
 *
 * Loading does NOT apply the active layout: a boot that re-applied it would overwrite the dock
 * widths the user dragged since, which are persisted separately and are the more recent statement.
 * The stored id says which tab is drawn as selected; clicking it is what re-applies the tuple.
 */
export function syncProjectLayouts(root: string | null): void {
  if (root === _layoutRoot) {
    return;
  }
  _layoutRoot = root;
  const { activeLayout, layouts } = readPersistedProject(root);
  shell.layouts = layouts;
  const has = (id: string | null) => id !== null && layouts.some((preset) => preset.id === id);
  // The stored active layout wins, then the one already selected, then the default, then whatever
  // The project actually has — a bar drawn with nothing selected says the app has lost your place.
  shell.layout = has(activeLayout)
    ? activeLayout!
    : has(shell.layout)
      ? shell.layout
      : has(DEFAULT_LAYOUT_ID)
        ? DEFAULT_LAYOUT_ID
        : (layouts[0]?.id ?? DEFAULT_LAYOUT_ID);
}

/** The layout with this id, or `undefined`. */
export function layoutById(id: string): LayoutPreset | undefined {
  return shell.layouts.find((preset) => preset.id === id);
}

/** A stable id for a saved layout's name: `My Layout` → `my-layout`. */
export function layoutIdFor(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "");
  return slug || "layout";
}

/** What applying or capturing a layout needs from the Inspector, which lives on the active tab. */
export interface LayoutDeps {
  setInspectorTab: (tab: InspectorTabId) => void;
  inspectorTab: () => InspectorTabId;
}

/**
 * Adopt a layout: its panel, its docks, its Inspector tab — and remember that it is the active one.
 *
 * Throws on an unknown id rather than silently doing nothing, because the id space is the user's
 * own (their saved layouts) and a typo in a command argument has to be reportable.
 */
export function applyLayout(id: string, deps: LayoutDeps): void {
  const preset = layoutById(id);
  if (!preset) {
    throw new RangeError(
      `no layout named "${id}" — this project has: ${shell.layouts.map((p) => p.id).join(", ")}`,
    );
  }
  shell.layout = preset.id;
  shell.leftTab = preset.navigatorPanel;
  shell.bottomTab = preset.bottomTab;
  for (const dock of DOCK_IDS) {
    shell.docks[dock].collapsed = preset.docks[dock].collapsed;
    shell.docks[dock].size = preset.docks[dock].size;
  }
  deps.setInspectorTab(preset.inspectorTab);
  persistDocks();
  persistProjectShell();
}

/**
 * Save the current arrangement under `name`, and make it the active layout.
 *
 * Saving over an existing name overwrites it — that is what `+` on a layout you have just adjusted
 * means, and it keeps the operation idempotent for a caller that cannot see the list.
 */
export function saveLayout(name: string, deps: LayoutDeps): LayoutPreset {
  const trimmed = name.trim();
  const id = layoutIdFor(trimmed);
  const docks = {} as Record<DockId, DockState>;
  for (const dock of DOCK_IDS) {
    docks[dock] = { collapsed: shell.docks[dock].collapsed, size: shell.docks[dock].size };
  }
  const preset: LayoutPreset = {
    bottomTab: isBottomTabId(shell.bottomTab) ? shell.bottomTab : DEFAULT_BOTTOM_TAB,
    docks,
    id,
    inspectorTab: deps.inspectorTab(),
    name: trimmed || id,
    navigatorPanel: migratePanelId(shell.leftTab) ?? DEFAULT_PANEL_ID,
  };
  const existing = shell.layouts.findIndex((entry) => entry.id === id);
  if (existing === -1) {
    shell.layouts.push(preset);
  } else {
    shell.layouts.splice(existing, 1, preset);
  }
  shell.layout = id;
  persistProjectShell();
  return preset;
}

/** Rename a layout in place. The id — and therefore every reference to it — is unchanged. */
export function renameLayout(id: string, name: string): void {
  const preset = layoutById(id);
  const trimmed = name.trim();
  if (!preset || !trimmed) {
    return;
  }
  preset.name = trimmed;
  persistProjectShell();
}

/**
 * Forget a layout. The last one cannot be deleted: an empty Command Bar with a `+` and no way to
 * know what it does is worse than a layout you do not use.
 */
export function deleteLayout(id: string): void {
  if (shell.layouts.length < 2) {
    return;
  }
  const index = shell.layouts.findIndex((preset) => preset.id === id);
  if (index === -1) {
    return;
  }
  shell.layouts.splice(index, 1);
  if (shell.layout === id) {
    shell.layout = shell.layouts[0]!.id;
  }
  persistProjectShell();
}

/**
 * Re-apply the active layout as declared — `View: Reset Layout`, always one action away (§3.2 ①b).
 *
 * This is the escape hatch that makes a layout safe to drift from: drag a dock, collapse the
 * Inspector, open a different panel, and one command puts the arrangement back.
 */
export function resetLayout(deps: LayoutDeps): void {
  applyLayout(shell.layout, deps);
}

/**
 * Project the theme record onto `<sp-theme>`.
 *
 * The predecessor was a raw `document.querySelector("sp-theme")?.setAttribute(...)` inside the
 * automation hook — a presentation poke no user could make and no surface could read back. It is a
 * shell input like the docks, so it lives on the record and is applied by the same effect.
 */
export function applyChromeTheme(): void {
  document.querySelector("sp-theme")?.setAttribute("color", shell.theme);
}

/** Project the dock record onto the shell grid: collapse classes on #app, sizes as CSS vars. */
export function applyDockLayout(): void {
  const root = document.documentElement;
  for (const id of DOCK_IDS) {
    root.style.setProperty(DOCK_CSS_VAR[id], `${shell.docks[id].size}px`);
  }
  const app = document.querySelector("#app");
  if (!app) {
    return;
  }
  for (const id of DOCK_IDS) {
    app.classList.toggle(DOCK_CLASS[id], shell.docks[id].collapsed);
  }
}

let _scope: EffectScope | null = null;

/**
 * A surface that lives and dies with the shell but is drawn somewhere else.
 *
 * The Bottom dock is the first: it is a DOCK — projected onto the grid by this module's own record
 * and effect — but it renders lit templates over the panel registry, and a direct import here would
 * be a cycle (`shell → bottom-dock → shell`) that `oxlint`'s `import/no-cycle` refuses and that
 * would drag the panel registry into every bare-Bun process that reads the command enums.
 *
 * So the dependency points one way: the surface's own module registers itself, and this module
 * knows only that something wants to be mounted when the shell is.
 */
export interface ShellSurface {
  mount: () => void;
  unmount: () => void;
}

const _surfaces: ShellSurface[] = [];

/**
 * Attach a surface to the shell's lifecycle. Idempotent per object.
 *
 * Called at module scope by the surface itself, so importing it is enough — the same bargain
 * `ui/panel-resize.ts` makes, minus its unguarded `document` read at import time.
 */
export function registerShellSurface(surface: ShellSurface): void {
  if (!_surfaces.includes(surface)) {
    _surfaces.push(surface);
  }
}

/** Forget every registered surface. Tests only. */
export function resetShellSurfaces(): void {
  _surfaces.length = 0;
}

/**
 * Start the one effect that keeps the DOM in step with the dock record. Idempotent.
 *
 * Nothing else applies the grid: a caller flips `shell.docks.right.collapsed` and the layout
 * follows, whether the flip came from a click, the automation runner or the boot-time restore.
 */
export function mountShell(): void {
  if (_scope) {
    return;
  }
  // The six shell hosts are bare `<div id>`s in index.html, so they cannot stamp their own region
  // The way a panel or an overlay slot does. One table, applied once the tree exists.
  stampShellRegions();
  // The Bottom dock mounts from here rather than from the bootstrap because it is a DOCK: it is
  // Projected onto the grid by the same record and the same effect as the other two, and a second
  // Mounting site would be a second place the shell's own layout is decided. Every surface's own
  // Mount is idempotent and inert when its host is absent — the desktop shell and the tests both
  // Boot partial trees.
  for (const surface of _surfaces) {
    surface.mount();
  }
  _scope = effectScope();
  _scope.run(() => {
    effect(() => {
      applyDockLayout();
    });
    effect(() => {
      applyChromeTheme();
    });
    // Layouts belong to a project, and the project root is reactive: opening one loads its record
    // With no boot-order hook to forget. `resetProjectShell()` runs while the OLD root is still
    // Set — it is the closing half of a switch — which is why the load cannot live there.
    effect(() => {
      syncProjectLayouts(workspace.projectRoot);
    });
  });
}

export function unmountShell(): void {
  _scope?.stop();
  _scope = null;
  for (const surface of _surfaces) {
    surface.unmount();
  }
}

/**
 * Open or close a dock, and remember it.
 *
 * There is no cross-dock coupling left to write here. The predecessor had to keep "assistant open,
 * inspector collapsed" unreachable by hand, because the assistant was a fifth column sharing the
 * inspector's cell; a TAB cannot be in that state by construction — collapsing the Inspector dock
 * hides whichever of its four tabs was selected, assistant included.
 */
export function setDockCollapsed(dock: DockId, collapsed: boolean): void {
  if (shell.docks[dock].collapsed === collapsed) {
    persistDocks();
    return;
  }
  shell.docks[dock].collapsed = collapsed;
  persistDocks();
}

/** Flip a dock's open state, and remember it. */
export function toggleDock(dock: DockId): void {
  setDockCollapsed(dock, !shell.docks[dock].collapsed);
}

/** Resize a dock. Persisting is the caller's call — a drag persists once, on release. */
export function setDockSize(dock: DockId, size: number): void {
  shell.docks[dock].size = size;
}

/**
 * Reveal a Navigator panel: select it, make sure the dock is open, and remember both.
 *
 * `persistDocks()` is called unconditionally rather than relying on `setDockCollapsed` — that only
 * writes when the collapse flag actually changed, so re-picking a panel in an already-open dock
 * would have been forgotten.
 */
export function setActivityTab(tab: string): void {
  shell.leftTab = tab;
  setDockCollapsed("left", false);
  persistDocks();
}

/**
 * Reveal a Bottom dock tab: select it, make sure the dock is open, and remember both.
 *
 * The Navigator's {@link setActivityTab} shape, for the same reason — "show me the Activity log"
 * means the log is on screen when it returns, not that a tab is selected inside a closed dock.
 */
export function setBottomTab(tab: string): void {
  shell.bottomTab = tab;
  setDockCollapsed("bottom", false);
  persistDocks();
}

/** Set the chrome theme, apply it, and remember it. */
export function setChromeTheme(theme: ChromeTheme): void {
  if (shell.theme === theme) {
    return;
  }
  shell.theme = theme;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage full or unavailable — the theme is still applied, just not remembered.
  }
}

/**
 * Toggle-focus semantics for the rail: re-picking the panel that is already showing closes the dock
 * instead of reselecting it.
 */
export function toggleActivityTab(tab: string): void {
  if (tab === shell.leftTab && !shell.docks.left.collapsed) {
    setDockCollapsed("left", true);
    return;
  }
  setActivityTab(tab);
}

/**
 * Adopt (or clear) a layout-chrome selection reported by the canvas.
 *
 * The canvas host calls this on a `layoutHit`, and clears it (`null`) whenever an ordinary document
 * node is selected — the two are mutually exclusive, and only one panel can be right at a time. It
 * exists as a function rather than a bare assignment so the one writer has a name: the field spent
 * a long release cycle with a reader (the properties panel's layout panel) and no writer at all,
 * which is why clicking a header did nothing.
 */
export function setLayoutSelection(selection: LayoutSelection | null): void {
  shell.layoutSelection = selection;
}

/**
 * Drop everything scoped to the project being closed.
 *
 * Source control, the stylebook selection and the settings tab all describe _a_ project; carrying
 * them into the next one showed the previous repository's branch, file count and "last updated"
 * time under the new project's name. Docks, the layout preset and the active rail panel are
 * deliberately kept — they describe the workspace, not the project.
 */
export function resetProjectShell(): void {
  Object.assign(shell.git, freshGit());
  Object.assign(shell.stylebook, freshStylebook());
  shell.settingsTab = "stylebook";
  shell.layoutSelection = null;
  // Forget which project's layouts are loaded, so the next `syncProjectLayouts()` reloads even if
  // The same root is opened again. The docks and the active rail panel stay: they describe the
  // Workspace, and re-applying a layout on project open would discard the widths you just dragged.
  _layoutRoot = undefined;
}

// ─── Commands ─────────────────────────────────────────────────────────────────

/** What the shell's view verbs need that this module does not own. */
export interface ShellCommandDeps {
  /**
   * Show an Inspector tab. Writes the ACTIVE TAB's `session.ui.rightTab`, which is per-document
   * session state this module deliberately does not reach into (`shell` is workspace state, and the
   * split is the whole point of the file).
   */
  setInspectorTab: (tab: InspectorTabId) => void;
  /**
   * Which Inspector tab is showing right now.
   *
   * Only `view.setAssistant { open: false }` needs it, and it needs it to stay idempotent: "the
   * assistant is not showing" is a state, not a delta, so the verb steps off the Assistant tab and
   * leaves any OTHER tab exactly where it was. Without the read it would have to guess, and a
   * screenshot that closed the assistant would silently also lose your Style tab.
   */
  inspectorTab: () => InspectorTabId;
}

/** The Navigator dock hosts a panel — the precondition its own verbs share. */
const projectOpen = (ctx: { project: { open: boolean } }) => ctx.project.open;

/**
 * The shell's view verbs: idempotent SETTERS, never toggles.
 *
 * Plan §13.3 clause 3 is the whole shape of this list. `view.toggleAssistant` names a _delta_
 * against state the caller cannot observe, so flipping the assistant's default silently inverted 18
 * screenshots and an agent calling it is guessing; `view.setAssistant { open: false }` means the
 * same thing whichever way the default points. The rail's own click handler keeps its
 * toggle-to-collapse behaviour ({@link toggleActivityTab}) because a human CAN see which panel is
 * open — that is a gesture, not an API.
 *
 * The `args` enums are the highest-value declaration here: `view.setActivity`'s `tab` is exactly
 * {@link NAVIGATOR_PANEL_IDS}, so renaming a panel turns every stale manifest step red naming both
 * ids, in the PR that renamed it (plan §13.5).
 *
 * @param {ShellCommandDeps} deps
 * @returns {AnyCommand[]}
 */
export function shellViewCommands(deps: ShellCommandDeps): AnyCommand[] {
  return [
    {
      args: argsSchema({
        tab: enumProperty(NAVIGATOR_PANEL_IDS, "Which Navigator panel to show."),
      }),
      category: "View",
      id: "view.setActivity",
      level: "application",
      menus: ["commandbar/overflow", "palette"],
      group: "4_docks",
      requires: "an open project",
      when: projectOpen,
      aiTool: {
        description:
          "Show one of the Navigator panels (Files, Search, Source Control, Outline, Page, Data, " +
          "Packages, Insert, State) and open the Navigator dock if it is closed. Problems is a " +
          "Bottom dock tab — use show_bottom_tab for it.",
        name: "show_navigator_panel",
      },
      run: (_ctx, args) => {
        setActivityTab(enumArg("view.setActivity", args, "tab", NAVIGATOR_PANEL_IDS));
      },
      title: "Show Navigator Panel",
    },
    {
      args: argsSchema({
        tab: enumProperty(INSPECTOR_TAB_IDS, "Which Inspector tab to show."),
      }),
      category: "View",
      id: "view.setRightTab",
      level: "document",
      menus: ["palette"],
      group: "4_docks",
      requires: "an open document",
      when: (ctx) => ctx.document.open,
      run: (_ctx, args) => {
        deps.setInspectorTab(enumArg("view.setRightTab", args, "tab", INSPECTOR_TAB_IDS));
      },
      title: "Show Inspector Tab",
    },
    {
      args: argsSchema({
        open: booleanProperty("True to show the Navigator dock, false to collapse it."),
      }),
      category: "View",
      // The idempotent half of `toggleActivityTab`. A shot that wants the Navigator CLOSED used to
      // Say `view.toggleActivity { tab: "layers" }` — re-pick the open panel and the dock
      // Collapses — which only means "closed" if you already know it was open.
      id: "view.setNavigator",
      level: "application",
      menus: ["palette"],
      group: "4_docks",
      run: (_ctx, args) => {
        setDockCollapsed("left", !booleanArg("view.setNavigator", args, "open"));
      },
      title: "Show Navigator Dock",
    },
    {
      args: argsSchema({
        open: booleanProperty("True to show the Inspector dock, false to collapse it."),
      }),
      category: "View",
      id: "view.setRightPanel",
      level: "application",
      menus: ["palette"],
      group: "4_docks",
      run: (_ctx, args) => {
        setDockCollapsed("right", !booleanArg("view.setRightPanel", args, "open"));
      },
      title: "Show Inspector Dock",
    },
    {
      args: argsSchema({
        open: booleanProperty("True to show the Bottom dock, false to collapse it."),
      }),
      category: "View",
      // The idempotent half of `view.toggleBottomDock`, and the reason the toggle can exist at all:
      // `tests/app-commands.test.ts` fails any `toggle*` id with no `set*` beside it, and this one
      // Has been listed as HANDOFF debt since P2 because the dock was not on the `shell` record.
      // It is now, so this is a two-line `run` rather than the special case ⌘J used to need.
      id: "view.setBottomDock",
      level: "application",
      menus: ["palette"],
      group: "4_docks",
      run: (_ctx, args) => {
        setDockCollapsed("bottom", !booleanArg("view.setBottomDock", args, "open"));
      },
      title: "Show Bottom Dock",
    },
    {
      // ⌘J. A gesture, not an API: a human presses it while looking at the dock, which is the
      // Exemption §13.3 clause 3 grants a toggle whose state the presser can SEE. A script says
      // `view.setBottomDock { open }` instead, and the test beside the registry enforces the pair.
      category: "View",
      id: "view.toggleBottomDock",
      keybinding: "mod+j",
      level: "application",
      menus: ["commandbar/overflow", "palette"],
      group: "4_docks",
      run: () => {
        toggleDock("bottom");
      },
      title: "Toggle Bottom Dock",
    },
    {
      args: argsSchema({
        tab: enumProperty(BOTTOM_TAB_IDS, "Which Bottom dock tab to show."),
      }),
      category: "View",
      id: "view.setBottomTab",
      level: "application",
      menus: ["palette"],
      group: "4_docks",
      aiTool: {
        description:
          "Show one of the Bottom dock's tabs (Problems, Diff, Logic, Activity) and open the " +
          "Bottom dock if it is closed.",
        name: "show_bottom_tab",
      },
      run: (_ctx, args) => {
        setBottomTab(enumArg("view.setBottomTab", args, "tab", BOTTOM_TAB_IDS));
      },
      title: "Show Bottom Dock Tab",
    },
    {
      args: argsSchema({
        open: booleanProperty("True to show the Assistant tab, false to step off it."),
      }),
      category: "View",
      // Kept as a verb of its own even though the assistant is now an ordinary Inspector tab: it
      // Is the one tab with a dock toggle's meaning ("show me the assistant, wherever it lives"),
      // Three screenshot shots address it by this name, and `open` reads as a STATE where
      // `view.setRightTab { tab: "assistant" }` can only ever select.
      id: "view.setAssistant",
      level: "application",
      menus: ["palette"],
      group: "4_docks",
      run: (_ctx, args) => {
        if (booleanArg("view.setAssistant", args, "open")) {
          setDockCollapsed("right", false);
          deps.setInspectorTab("assistant");
          return;
        }
        if (deps.inspectorTab() === "assistant") {
          deps.setInspectorTab(DEFAULT_INSPECTOR_TAB);
        }
      },
      title: "Show Assistant",
    },
    // ── Named layouts ────────────────────────────────────────────────────────
    // Five verbs, because a named arrangement you can create but not rename, delete or restore is
    // A trap. All five are SETTERS: `view.setLayout { layout: "ship" }` means the same thing twice
    // In a row, and `view.resetLayout` is the one action that puts a drifted arrangement back.
    {
      args: argsSchema({
        layout: stringProperty("The layout's id — one of this project's saved layouts."),
      }),
      category: "View",
      id: "view.setLayout",
      level: "application",
      menus: ["palette"],
      group: "4_layouts",
      requires: "an open project",
      when: projectOpen,
      aiTool: {
        description:
          "Adopt one of the project's named layouts (Write, Design, Build, Ship, or one the user " +
          "saved): its Navigator panel, its dock widths and visibility, and its Inspector tab.",
        name: "set_layout",
      },
      run: (_ctx, args) => {
        applyLayout(stringArg("view.setLayout", args, "layout"), deps);
      },
      title: "Switch Layout",
    },
    {
      args: argsSchema({
        name: stringProperty("What to call this arrangement. An existing name is overwritten."),
      }),
      category: "View",
      id: "view.saveLayout",
      level: "application",
      menus: ["palette"],
      group: "4_layouts",
      requires: "an open project",
      when: projectOpen,
      run: (_ctx, args) => {
        saveLayout(stringArg("view.saveLayout", args, "name"), deps);
      },
      title: "Save Layout",
    },
    {
      args: argsSchema({
        layout: stringProperty("The layout's id."),
        name: stringProperty("Its new name. The id, and every reference to it, is unchanged."),
      }),
      category: "View",
      id: "view.renameLayout",
      level: "application",
      menus: ["palette"],
      group: "4_layouts",
      requires: "an open project",
      when: projectOpen,
      run: (_ctx, args) => {
        renameLayout(
          stringArg("view.renameLayout", args, "layout"),
          stringArg("view.renameLayout", args, "name"),
        );
      },
      title: "Rename Layout",
    },
    {
      args: argsSchema({
        layout: stringProperty("The layout's id. The last remaining layout is kept."),
      }),
      category: "View",
      id: "view.deleteLayout",
      level: "application",
      menus: ["palette"],
      group: "4_layouts",
      requires: "an open project",
      when: projectOpen,
      run: (_ctx, args) => {
        deleteLayout(stringArg("view.deleteLayout", args, "layout"));
      },
      title: "Delete Layout",
    },
    {
      // No `args`: this verb takes none. An empty schema would be a promise of parameters the
      // Palette would then prompt for and the record would ignore.
      category: "View",
      id: "view.resetLayout",
      level: "application",
      menus: ["palette"],
      group: "4_layouts",
      requires: "an open project",
      when: projectOpen,
      run: () => {
        resetLayout(deps);
      },
      title: "Reset Layout",
    },
    {
      args: argsSchema({
        color: enumProperty(CHROME_THEMES, "The Studio chrome's theme."),
      }),
      category: "View",
      id: "view.setTheme",
      level: "application",
      menus: ["palette"],
      group: "6_appearance",
      run: (_ctx, args) => {
        setChromeTheme(enumArg("view.setTheme", args, "color", CHROME_THEMES));
      },
      title: "Set Theme",
    },
  ];
}

/**
 * Register the shell's view verbs. Called from the bootstrap, beside the state they write.
 *
 * @param {CommandRegistry} registry
 * @param {ShellCommandDeps} deps
 */
export function registerShellViewCommands(registry: CommandRegistry, deps: ShellCommandDeps): void {
  registry.registerAll(shellViewCommands(deps));
}
