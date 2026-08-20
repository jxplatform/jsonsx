/// <reference lib="dom" />
/**
 * The Palette — one omnibox, several modes (UX-REDESIGN-PLAN §5.4).
 *
 * This file used to be a filename-substring finder with one hidden domain swap in it: with no
 * project open the same trigger, the same chrome and the same placeholder silently listed recent
 * PROJECTS instead. It is now the surface the whole shell shrinks into — the place a capability
 * goes when it is retired from the chrome (§2 principle 9), which only works if everything is
 * reachable here by name, with its chord printed beside it.
 *
 * Four properties earn that:
 *
 * 1. **Modes are named, prefixed and enumerable.** `>` commands, `@` document nodes, plain text files,
 *    and `?` lists them. The mode is echoed as a REMOVABLE CHIP, so the no-project case is a stated
 *    `Recent Projects` mode rather than a swap you have to infer. `PALETTE_MODES` is the namespace:
 *    P4's Problems and P7's content search are new members, not a new widget.
 * 2. **Files are matched by fuzzy subsequence over the FULL PATH.** `pgblog` finds
 *    `pages/blog/index.md`. The backend glob (`**\/*q*.{json,md}`) can only do a basename
 *    substring, so the palette asks it once for the document set and ranks locally — which is also
 *    what lets the ranking prefer a basename hit, a word boundary and a consecutive run, in that
 *    order.
 * 3. **Every row prints its binding.** That is how a large surface stays discoverable without adding
 *    chrome, and it is the mechanism by which the palette teaches the keyboard it replaced.
 * 4. **An unavailable command is GREYED, not hidden**, with its `requires` sentence as the subtitle
 *    (§2 principle 4). "Why can't I" is the question a palette is uniquely good at answering, and a
 *    row that vanishes answers it with silence.
 *
 * The exported names still read `…QuickSearch` because `src/studio.ts` and `src/panels/empty-state.
 * ts` import them and neither is this workstream's file. They are the palette's; the rename is one
 * find-replace in those two call sites.
 */

import { html, render as litRender, nothing } from "lit-html";
import { classMap } from "lit-html/directives/class-map.js";
import { live } from "lit-html/directives/live.js";
import { ref } from "lit-html/directives/ref.js";
import { getPlatform } from "../platform";
import { flattenTree, nodeLabel, projectState } from "../store";
import { documentExtensions, formatByExtension, loadFormats } from "../format/format-host";
import { openFileInTab } from "../files/files";
import { getRecentFiles, getRecentProjects, trackRecentFile } from "../recent-projects";
import { getLayerSlot } from "../ui/layers";
import { activeTab } from "../workspace/workspace";
import { activeRegistry } from "../commands/active-registry";
import type { PaletteMode } from "../commands/defaults";
import type { AnyCommand, CommandRegistry } from "../commands/registry";
import type { JxMutableNode } from "@jxsuite/schema/types";
import type { JxPath } from "../state";

export type { PaletteMode } from "../commands/defaults";

// ─── The mode namespace ───────────────────────────────────────────────────────

/** One palette mode: its prefix, the chip it echoes, and what it says when it is empty. */
export interface PaletteModeSpec {
  mode: PaletteMode;
  /** The one character that switches into this mode from any other. `""` = the plain mode. */
  prefix: string;
  /** The removable chip's text, and the row label in `?`. */
  chip: string;
  placeholder: string;
  /** What `?` prints under the mode's name. One sentence, no noun phrases (§2 principle 6). */
  description: string;
}

/**
 * Every mode, in the order `?` lists them.
 *
 * Declared as data rather than as a switch because three consumers read it: the prefix parser, the
 * chip, and the `?` listing itself — which is what makes the palette able to teach its own
 * namespace instead of hiding it in a docs page.
 */
export const PALETTE_MODES: readonly PaletteModeSpec[] = [
  {
    mode: "files",
    prefix: "",
    chip: "Files",
    placeholder: "Go to a file…",
    description: "Open a file by any part of its path — pgblog finds pages/blog/index.md.",
  },
  {
    mode: "commands",
    prefix: ">",
    chip: "Commands",
    placeholder: "Run a command…",
    description: "Run anything Studio can do, with its keyboard shortcut printed beside it.",
  },
  {
    mode: "nodes",
    prefix: "@",
    chip: "Symbols",
    placeholder: "Go to an element in this document…",
    description: "Select an element in the open document by its Outline name.",
  },
  {
    mode: "projects",
    prefix: "",
    chip: "Recent Projects",
    placeholder: "Open a recent project…",
    description: "Reopen a project you have had open before.",
  },
  {
    mode: "picker",
    prefix: "?",
    chip: "Modes",
    placeholder: "Type ? for modes, > for commands, @ for elements…",
    description: "List these modes.",
  },
];

const MODE_SPEC = new Map(PALETTE_MODES.map((spec) => [spec.mode, spec]));

/** The modes a prefix character switches into. `files` and `projects` have no prefix. */
const PREFIXED_MODES = PALETTE_MODES.filter((spec) => spec.prefix !== "");

/** The spec for a mode. Total: every {@link PaletteMode} is declared above. */
export function modeSpec(mode: PaletteMode): PaletteModeSpec {
  return MODE_SPEC.get(mode) ?? PALETTE_MODES[0]!;
}

/**
 * The mode a raw input actually addresses.
 *
 * Three rules, in order:
 *
 * - A leading prefix character wins, whatever the palette was opened as — that is what `>` and `@`
 *   are FOR, and it is why the prefix is stripped out of the query and into the chip.
 * - `picker` with an empty query lists the modes; `picker` with anything typed means files, because
 *   ⌘K then typing a filename is the gesture every omnibox has trained people to expect.
 * - Files with no project open is `Recent Projects`. This is the one substitution the old widget made
 *   silently; here the chip says so, and `Project: Open Recent…` names it from the outside.
 */
export function resolvePaletteMode(
  requested: PaletteMode,
  raw: string,
  projectOpen: boolean,
): { mode: PaletteMode; query: string } {
  const prefixed = PREFIXED_MODES.find((spec) => raw.startsWith(spec.prefix));
  if (prefixed) {
    return resolvePaletteMode(prefixed.mode, raw.slice(1), projectOpen);
  }
  let mode = requested;
  if (mode === "picker" && raw.trim() !== "") {
    mode = "files";
  }
  if (mode === "files" && !projectOpen) {
    mode = "projects";
  }
  return { mode, query: raw };
}

// ─── Fuzzy subsequence ranking ────────────────────────────────────────────────

/** Characters after which a match counts as starting a word — the boundaries a path has. */
const BOUNDARY = new Set(["/", "-", "_", ".", " "]);

/**
 * Score `text` against `query` as a subsequence, or `null` when it is not one.
 *
 * Higher is better. The weights encode what a person means when they type six characters at a file
 * tree: a consecutive run is worth much more than scattered letters, a match that starts a path
 * segment is worth more than one mid-word, and — decisively — a match inside the BASENAME beats one
 * in a directory, so typing `index` does not bury `index.md` under `pages/index-partials/x.md`.
 *
 * An empty query scores 0 and matches everything, which is what makes "show me the recents" and
 * "show me every file" the same code path.
 */
export function fuzzyScore(text: string, query: string): number | null {
  if (query === "") {
    return 0;
  }
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  const basenameStart = haystack.lastIndexOf("/") + 1;
  let score = 0;
  let cursor = 0;
  let previousIndex = -2;
  for (const char of needle) {
    const index = haystack.indexOf(char, cursor);
    if (index === -1) {
      return null;
    }
    if (index === previousIndex + 1) {
      score += 8;
    }
    if (index === 0 || BOUNDARY.has(haystack[index - 1] ?? "")) {
      score += 6;
    }
    if (index >= basenameStart) {
      score += 4;
    }
    previousIndex = index;
    cursor = index + 1;
  }
  // Two tie-breaks, both small enough never to outrank a real structural signal: an earlier first
  // Match, and a shorter path — `pages/index.md` over `pages/blog/drafts/index.md`.
  return score - previousIndex * 0.01 - haystack.length * 0.001;
}

/** Rank candidates by {@link fuzzyScore}, dropping non-matches. Stable within equal scores. */
export function rankBy<T>(items: readonly T[], query: string, key: (item: T) => string): T[] {
  const scored: { item: T; score: number; index: number }[] = [];
  for (const [index, item] of items.entries()) {
    const score = fuzzyScore(key(item), query);
    if (score !== null) {
      scored.push({ index, item, score });
    }
  }
  return scored
    .toSorted((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.item);
}

// ─── Argument prompts ─────────────────────────────────────────────────────────

/** One offered value for a command's single argument. */
export interface PaletteArgChoice {
  value: unknown;
  label: string;
}

/** What the palette can do with a command's `args` schema. */
export type PaletteArgs =
  | { kind: "none" }
  | { kind: "choice"; name: string; choices: PaletteArgChoice[] }
  | { kind: "unsupported" };

interface ArgsSchemaShape {
  properties?: Record<string, { type?: string; enum?: readonly unknown[]; description?: string }>;
  required?: readonly string[];
}

/**
 * How a command's arguments are asked for.
 *
 * The palette can prompt for exactly one closed value space — an `enum` or a boolean — because that
 * is a LIST, and a list is the one thing this widget is. `canvas.setZoom { zoom: number }` and
 * `selection.set { path }` are `"unsupported"`, so command mode does not render them: a row that
 * cannot be completed is worse than an absent one, and both are reachable from the surface that
 * owns them (the zoom cluster, the canvas). This is a property of the SCHEMA, not a list of ids, so
 * a command that gains an enum argument becomes promptable without anyone editing this file.
 */
export function paletteArgs(command: AnyCommand): PaletteArgs {
  const schema = command.args as ArgsSchemaShape | undefined;
  const properties = schema?.properties;
  if (!schema || !properties) {
    return { kind: "none" };
  }
  const names = Object.keys(properties);
  if (names.length !== 1) {
    return { kind: "unsupported" };
  }
  const name = names[0]!;
  const property = properties[name]!;
  if (property.enum) {
    return {
      kind: "choice",
      name,
      choices: property.enum.map((value) => ({ label: String(value), value })),
    };
  }
  if (property.type === "boolean") {
    return {
      kind: "choice",
      name,
      choices: [
        { label: "on", value: true },
        { label: "off", value: false },
      ],
    };
  }
  return { kind: "unsupported" };
}

// ─── Recently-used commands ───────────────────────────────────────────────────

/**
 * The ids the combobox relationship is built from (WAI-ARIA APG, combobox with listbox popup).
 *
 * The input already said `role="combobox"`, but nothing connected it to the list beneath: no
 * `aria-controls`, so a screen reader could not find the popup, and no `aria-activedescendant`, so
 * arrowing through the results moved a visual highlight and announced nothing. `aria-expanded` was
 * the literal string `"true"`, which claims a popup is showing even when the query matched
 * nothing.
 */
const QUICK_SEARCH_LISTBOX_ID = "quick-search-listbox";

/** A stable per-row id, so `aria-activedescendant` has something to point at. */
function optionId(index: number): string {
  return `quick-search-option-${index}`;
}

const RECENT_COMMANDS_KEY = "jx-studio-recent-commands";
const RECENT_COMMANDS_MAX = 6;

/** The ids most recently run FROM THE PALETTE, newest first. Pinned above the rest of the list. */
export function getRecentCommands(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(RECENT_COMMANDS_KEY) || "[]");
    return Array.isArray(raw) ? raw.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function trackRecentCommand(id: string): void {
  const next = [id, ...getRecentCommands().filter((known) => known !== id)].slice(
    0,
    RECENT_COMMANDS_MAX,
  );
  try {
    localStorage.setItem(RECENT_COMMANDS_KEY, JSON.stringify(next));
  } catch {
    // Storage full or unavailable — the command still ran, it is just not remembered.
  }
}

// ─── Rows ─────────────────────────────────────────────────────────────────────

interface FileRow {
  kind: "file";
  path: string;
  name: string;
  /** Directory part, shown as the subtitle. */
  detail: string;
  recent: boolean;
}
interface ProjectRow {
  kind: "project";
  root: string;
  name: string;
  detail: string;
}
interface CommandRow {
  kind: "command";
  id: string;
  /** `"View: Zen Mode"` — the palette's own naming convention (§5.1). */
  name: string;
  /** The `requires` sentence when disabled; otherwise empty. */
  detail: string;
  chord: string;
  enabled: boolean;
  recent: boolean;
}
interface NodeRow {
  kind: "node";
  path: JxPath;
  name: string;
  detail: string;
}
interface ModeRow {
  kind: "mode";
  mode: PaletteMode;
  name: string;
  detail: string;
  chord: string;
}
interface ArgRow {
  kind: "arg";
  commandId: string;
  argName: string;
  value: unknown;
  name: string;
  detail: string;
}

type PaletteRow = FileRow | ProjectRow | CommandRow | NodeRow | ModeRow | ArgRow;

// ─── State ────────────────────────────────────────────────────────────────────

interface QuickCtx {
  openRecentProject: (root: string) => void | Promise<void>;
}

let _ctx: QuickCtx | null = null;
let _open = false;
/** The mode the palette was OPENED as; the effective one is derived with the query. */
let _requested: PaletteMode = "picker";
let _query = "";
let _selectedIndex = 0;
/** The project's document set, fetched once per open. `null` while it has never been asked for. */
let _files: FileRow[] | null = null;
let _loading = false;
/** The command awaiting its one argument, or `null`. */
let _pending: { command: AnyCommand; name: string; choices: PaletteArgChoice[] } | null = null;

function getContainer() {
  return getLayerSlot("popover", "quick-search");
}

export function initQuickSearch(ctx?: QuickCtx) {
  _ctx = ctx ?? null;
}

/**
 * Open the palette in `mode`.
 *
 * The default is `"files"`, not the picker: every caller that names a mode names one (⌘K passes
 * `"picker"`, the pill's segments pass theirs), so the bare call is the "open a page…" gesture an
 * empty state offers — and that has to land on files rather than on a list of modes.
 *
 * @param mode Which mode to open in. `"picker"` (⌘K) lists the modes until something is typed.
 */
export function openQuickSearch(mode: PaletteMode = "files") {
  _open = true;
  _requested = mode;
  _query = "";
  _selectedIndex = 0;
  _pending = null;
  _files = null;
  renderOverlay();
  void ensureFiles();
}

export function closeQuickSearch() {
  _open = false;
  _pending = null;
  renderOverlay();
}

/** Whether the palette is on screen — the fact the Command Bar's ⌘K affordance reflects. */
export function isQuickSearchOpen(): boolean {
  return _open;
}

/** The project root scoping the palette, or null when no project is open. */
function scopeRoot(): string | null {
  return projectState ? (projectState.projectRoot ?? null) : null;
}

function hasProject(): boolean {
  return projectState != null;
}

/** The mode and query the current input resolves to. */
function current(): { mode: PaletteMode; query: string } {
  return resolvePaletteMode(_requested, _query, hasProject());
}

// ─── Row sources ──────────────────────────────────────────────────────────────

function dirPart(path: string) {
  const parts = path.split("/");
  parts.pop();
  return parts.length > 0 ? parts.join("/") : "";
}

/** Collapse a home-prefixed absolute path for compact display. */
function shortenPath(path: string) {
  if (path.startsWith("/home/")) {
    return `~/${path.split("/").slice(3).join("/")}`;
  }
  return path;
}

/**
 * Fetch the project's document set once per open.
 *
 * The empty query is deliberate: `searchFiles`'s glob is `**\/*<query>*.{json,md,…}`, so an empty
 * one IS "every document", and asking for it once buys a client-side fuzzy match over full paths
 * that the glob could never express.
 */
async function ensureFiles(): Promise<void> {
  if (!_open || _files !== null || _loading || !hasProject()) {
    return;
  }
  _loading = true;
  renderOverlay();
  try {
    await loadFormats();
    const hits = await getPlatform().searchFiles("", documentExtensions());
    _files = hits.map((hit) => ({
      kind: "file" as const,
      path: hit.path,
      name: hit.name ?? hit.path.split("/").pop() ?? "",
      detail: dirPart(hit.path),
      recent: false,
    }));
  } catch {
    // A search backend that is down leaves the palette usable in every other mode; the files mode
    // Says "No results" rather than pretending the project is empty.
    _files = [];
  }
  _loading = false;
  renderOverlay();
}

function fileRows(query: string): FileRow[] {
  if (query.trim() === "") {
    return getRecentFiles(scopeRoot() ?? undefined).map((file) => ({
      kind: "file" as const,
      path: file.path,
      name: file.name,
      detail: dirPart(file.path),
      recent: true,
    }));
  }
  return rankBy(_files ?? [], query.trim(), (row) => row.path);
}

function projectRows(query: string): ProjectRow[] {
  const rows = getRecentProjects().map((project) => ({
    kind: "project" as const,
    root: project.root,
    name: project.name,
    detail: shortenPath(project.root),
  }));
  return rankBy(rows, query.trim(), (row) => `${row.name}/${row.root}`);
}

/**
 * Every command the registry holds, ranked — including the ones that cannot run right now.
 *
 * Visibility (`when`) still hides; enablement does not. That split is the whole of §2 principle 4:
 * a command that does not apply to this app at all is absent, and one that does not apply to this
 * MOMENT is greyed and says why.
 */
function commandRows(registry: CommandRegistry, query: string): CommandRow[] {
  const recents = getRecentCommands();
  const rows: CommandRow[] = [];
  for (const command of registry.visible()) {
    if (paletteArgs(command).kind === "unsupported") {
      continue;
    }
    if (!(command.menus ?? ["palette"]).includes("palette")) {
      continue;
    }
    rows.push({
      kind: "command",
      id: command.id,
      name: `${command.category}: ${command.title}`,
      detail: registry.disabledReason(command.id) ?? "",
      chord: registry.keymap.formatBinding(command.id) ?? "",
      enabled: registry.isEnabled(command.id),
      recent: recents.includes(command.id),
    });
  }
  const ranked = rankBy(rows, query.trim(), (row) => row.name);
  if (query.trim() !== "") {
    return ranked;
  }
  // Recents pin above the rest, newest first — the one ordering a palette owes a returning user.
  const pinned = recents
    .map((id) => ranked.find((row) => row.id === id))
    .filter((row): row is CommandRow => row !== undefined);
  return [...pinned, ...ranked.filter((row) => !pinned.includes(row))];
}

function nodeRows(query: string): NodeRow[] {
  const tab = activeTab.value;
  if (!tab) {
    return [];
  }
  const rows: NodeRow[] = flattenTree(tab.doc.document).map((row) => ({
    kind: "node" as const,
    path: row.path,
    name:
      row.nodeType === "text"
        ? String(row.node).slice(0, 60)
        : nodeLabel(row.node as JxMutableNode),
    detail: row.nodeType,
  }));
  return rankBy(rows, query.trim(), (row) => row.name);
}

function modeRows(): ModeRow[] {
  return PALETTE_MODES.filter((spec) => spec.mode !== "picker").map((spec) => ({
    kind: "mode" as const,
    mode: spec.mode,
    name: spec.chip,
    detail: spec.description,
    chord: spec.prefix,
  }));
}

function argRows(query: string): ArgRow[] {
  const pending = _pending!;
  const rows: ArgRow[] = pending.choices.map((choice) => ({
    kind: "arg" as const,
    commandId: pending.command.id,
    argName: pending.name,
    value: choice.value,
    name: choice.label,
    detail: `${pending.command.title} → ${pending.name}`,
  }));
  return rankBy(rows, query.trim(), (row) => row.name);
}

/** The rows for the current input, and whether they are a "recent" listing rather than a search. */
function currentRows(): { rows: PaletteRow[]; showingRecent: boolean } {
  const { mode, query } = current();
  if (_pending) {
    return { rows: argRows(query), showingRecent: false };
  }
  switch (mode) {
    case "commands": {
      const registry = activeRegistry();
      return {
        rows: registry ? commandRows(registry, query) : [],
        showingRecent: query.trim() === "",
      };
    }
    case "nodes": {
      return { rows: nodeRows(query), showingRecent: false };
    }
    case "projects": {
      return { rows: projectRows(query), showingRecent: query.trim() === "" };
    }
    case "picker": {
      return { rows: modeRows(), showingRecent: false };
    }
    default: {
      return { rows: fileRows(query), showingRecent: query.trim() === "" };
    }
  }
}

// ─── Interaction ──────────────────────────────────────────────────────────────

function onInput(e: Event) {
  const raw = (e.target as HTMLInputElement).value;
  const prefixed = PREFIXED_MODES.find((spec) => raw.startsWith(spec.prefix));
  if (prefixed) {
    // The prefix moves OUT of the input and into the chip, so the query the user reads back is the
    // Text they are searching for and Backspace has one obvious meaning at position zero.
    _requested = prefixed.mode;
    _query = raw.slice(1);
  } else {
    _query = raw;
  }
  _selectedIndex = 0;
  renderOverlay();
  void ensureFiles();
}

/** Drop the mode chip: back to the neutral picker, keeping what was typed. */
function clearMode() {
  _requested = "picker";
  _pending = null;
  _selectedIndex = 0;
  renderOverlay();
}

function onKeydown(e: KeyboardEvent) {
  const { rows } = currentRows();
  switch (e.key) {
    case "ArrowDown": {
      e.preventDefault();
      _selectedIndex = Math.min(_selectedIndex + 1, rows.length - 1);
      renderOverlay();
      break;
    }
    case "ArrowUp": {
      e.preventDefault();
      _selectedIndex = Math.max(_selectedIndex - 1, 0);
      renderOverlay();
      break;
    }
    case "Enter": {
      e.preventDefault();
      if (rows[_selectedIndex]) {
        selectRow(rows[_selectedIndex]!);
      }
      break;
    }
    case "Backspace": {
      // At position zero the chip is the thing to the left of the caret, so this is the same
      // Gesture as deleting a character — and it is why the chip is removable at all.
      if (_query === "" && (_pending || _requested !== "picker")) {
        e.preventDefault();
        clearMode();
      }
      break;
    }
    case "Escape": {
      e.preventDefault();
      closeQuickSearch();
      break;
    }
    default: {
      break;
    }
  }
}

function enterMode(mode: PaletteMode) {
  _requested = mode;
  _query = "";
  _selectedIndex = 0;
  renderOverlay();
  void ensureFiles();
}

function runCommand(command: AnyCommand, args?: Record<string, unknown>) {
  const registry = activeRegistry();
  if (!registry) {
    return;
  }
  trackRecentCommand(command.id);
  closeQuickSearch();
  const report = (error: unknown) => {
    console.error(`palette: command "${command.id}" failed`, error);
  };
  // Both shapes, deliberately: `run` may throw synchronously (a coercion refusal from
  // `command-args.ts` does) or reject later. A palette that let either escape would take the
  // Keydown listener down with it, and the overlay is already closed by then.
  try {
    void Promise.resolve(registry.run(command.id, args)).catch(report);
  } catch (error) {
    report(error);
  }
}

function selectRow(row: PaletteRow) {
  switch (row.kind) {
    case "project": {
      closeQuickSearch();
      void _ctx?.openRecentProject(row.root);
      return;
    }
    case "file": {
      closeQuickSearch();
      trackRecentFile({ name: row.name, path: row.path, root: scopeRoot() ?? "" });
      void openFileInTab(row.path);
      return;
    }
    case "mode": {
      enterMode(row.mode);
      return;
    }
    case "node": {
      const registry = activeRegistry();
      closeQuickSearch();
      void registry?.run("selection.set", { path: row.path });
      return;
    }
    case "arg": {
      runCommand(_pending!.command, { [row.argName]: row.value });
      return;
    }
    default: {
      selectCommandRow(row);
    }
  }
}

function selectCommandRow(row: CommandRow) {
  const registry = activeRegistry();
  const command = registry?.get(row.id);
  if (!registry || !command || !row.enabled) {
    // A greyed row is not a dead one: it stays on screen with its reason, and pressing Enter on it
    // Does nothing rather than closing the palette on a refusal the user never asked to see.
    return;
  }
  const args = paletteArgs(command);
  if (args.kind === "choice") {
    _pending = { choices: args.choices, command, name: args.name };
    _query = "";
    _selectedIndex = 0;
    renderOverlay();
    return;
  }
  runCommand(command);
}

// ─── Rendering ────────────────────────────────────────────────────────────────

function fileIcon(name: string) {
  const ext = name.split(".").pop()?.toLowerCase();
  if (ext === "json") {
    return html`<sp-icon-file-code size="s"></sp-icon-file-code>`;
  }
  if (ext && formatByExtension(ext)) {
    return html`<sp-icon-file-txt size="s"></sp-icon-file-txt>`;
  }
  return html`<sp-icon-document size="s"></sp-icon-document>`;
}

function rowIcon(row: PaletteRow) {
  switch (row.kind) {
    case "project": {
      return html`<sp-icon-folder-open size="s"></sp-icon-folder-open>`;
    }
    case "file": {
      return fileIcon(row.name);
    }
    case "command": {
      return html`<sp-icon-play size="s"></sp-icon-play>`;
    }
    case "node": {
      return html`<sp-icon-layers size="s"></sp-icon-layers>`;
    }
    default: {
      return html`<sp-icon-chevron-right size="s"></sp-icon-chevron-right>`;
    }
  }
}

/** The right-aligned cell: a chord, a prefix, or the recent badge. */
function rowTrailing(row: PaletteRow, showingRecent: boolean) {
  if (row.kind === "command" && row.chord) {
    return html`<kbd class="palette-chord">${row.chord}</kbd>`;
  }
  if (row.kind === "mode" && row.chord) {
    return html`<kbd class="palette-chord">${row.chord}</kbd>`;
  }
  if (row.kind === "command" && row.recent) {
    return html`<span class="quick-search-badge">recent</span>`;
  }
  return showingRecent ? html`<span class="quick-search-badge">recent</span>` : nothing;
}

/** The chip echoing the active mode (or the command awaiting an argument), with its remove button. */
function chipTemplate(mode: PaletteMode) {
  const label = _pending ? _pending.command.title : modeSpec(mode).chip;
  if (!_pending && mode === "picker") {
    return nothing;
  }
  return html`
    <span class="palette-chip">
      ${label}
      <button
        class="palette-chip-remove"
        type="button"
        title="Clear mode (Backspace)"
        aria-label="Clear mode"
        @click=${clearMode}
      >
        ×
      </button>
    </span>
  `;
}

/** The sentence an empty result set shows. Never a noun phrase (§2 principle 6). */
function emptyHint(mode: PaletteMode, query: string): string {
  if (_loading) {
    return "Reading the project's files…";
  }
  if (query.trim() !== "") {
    return "No results";
  }
  switch (mode) {
    case "projects": {
      return "No recent projects — open one to get started";
    }
    case "nodes": {
      return "Open a document to jump to its elements";
    }
    case "commands": {
      return "Type to find any command in Studio";
    }
    default: {
      return modeSpec(mode).placeholder;
    }
  }
}

function renderOverlay() {
  const container = getContainer();
  if (!_open) {
    litRender(nothing, container);
    return;
  }

  const { mode, query } = current();
  const { rows, showingRecent } = currentRows();
  const spec = modeSpec(mode);
  const placeholder = _pending ? `Choose a ${_pending.name}…` : spec.placeholder;
  const sectionLabel = _pending
    ? `${_pending.command.title} — ${_pending.name}`
    : mode === "projects"
      ? "Recent projects"
      : mode === "commands"
        ? "Recently used"
        : "Recently opened";

  const tpl = html`
    <div class="quick-search-overlay" @click=${closeQuickSearch}>
      <div class="quick-search-panel" @click=${(e: Event) => e.stopPropagation()}>
        <div class="palette-input-row">
          ${chipTemplate(mode)}
          <input
            class="quick-search-input"
            type="text"
            role="combobox"
            aria-controls=${QUICK_SEARCH_LISTBOX_ID}
            aria-expanded=${rows.length > 0}
            aria-activedescendant=${rows.length > 0 ? optionId(_selectedIndex) : nothing}
            aria-autocomplete="list"
            aria-label=${placeholder}
            placeholder=${placeholder}
            .value=${live(_query)}
            @input=${onInput}
            @keydown=${onKeydown}
            ${ref((el) => {
              if (el) {
                requestAnimationFrame(() => (el as HTMLInputElement).focus());
              }
            })}
          />
        </div>
        <div class="quick-search-results" role="listbox" id=${QUICK_SEARCH_LISTBOX_ID}>
          ${
            rows.length === 0
              ? html`<div class="quick-search-empty">${emptyHint(mode, query)}</div>`
              : nothing
          }
          ${
            showingRecent && rows.length > 0
              ? html`<div class="quick-search-section-label">${sectionLabel}</div>`
              : nothing
          }
          ${rows.map(
            (row, i) => html`
              <div
                class=${classMap({
                  "quick-search-item": true,
                  disabled: row.kind === "command" && !row.enabled,
                  selected: i === _selectedIndex,
                })}
                role="option"
                id=${optionId(i)}
                aria-selected=${i === _selectedIndex}
                aria-disabled=${row.kind === "command" && !row.enabled}
                @click=${() => selectRow(row)}
                @mouseenter=${() => {
                  _selectedIndex = i;
                  renderOverlay();
                }}
              >
                <span class="quick-search-icon">${rowIcon(row)}</span>
                <span class="quick-search-name">${row.name}</span>
                <span class="quick-search-path">${row.detail}</span>
                ${rowTrailing(row, showingRecent)}
              </div>
            `,
          )}
        </div>
        <div class="palette-hint">
          <kbd>↑↓</kbd> move · <kbd>↵</kbd> run · <kbd>?</kbd> modes · <kbd>&gt;</kbd> commands ·
          <kbd>@</kbd> elements
        </div>
      </div>
    </div>
  `;

  litRender(tpl, container);
}
