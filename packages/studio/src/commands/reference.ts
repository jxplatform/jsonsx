/**
 * Reference.ts — the registry, projected into the two generated documentation pages.
 *
 * Plan §12 P3 lists `docs/studio/interface/shortcuts.md` and a new
 * `docs/studio/interface/commands.md` as **generated from the registry and CI-diffed**, which is
 * the last of §5.5's seven derivations: with the chrome, the keymap, the palette, the menus and the
 * automation surface all rendering the same records, a hand-maintained shortcut sheet is the only
 * place left for the app's keyboard and its documentation to disagree.
 *
 * This module is the projection, not the generator. It takes a command set — `appCommandSet()`, the
 * one bare-Bun-importable export the three CI checks already load — and returns ROWS plus the
 * markdown table each page's body is made of. `scripts/docs/generate-reference.ts` supplies the
 * frontmatter, the prose and the file write; keeping the two apart is what lets the projection be
 * tested in this package, next to the records it reads, without a docs harness.
 *
 * Everything here is pure and sorted deterministically: a generated page that reorders itself
 * between runs is a CI diff nobody can review.
 */

import { formatChord, normalizeChord } from "./keymap";
import { CATEGORIES } from "./levels";
import type { Category, KeyScope, Level, Placement } from "./levels";
import type { AnyCommand } from "./registry";

/** One command, as `docs/studio/interface/commands.md` prints it. */
export interface CommandRow {
  id: string;
  title: string;
  category: Category;
  level: Level;
  /** Canonical chords, in declaration order. Empty when the command is palette-only. */
  chords: readonly string[];
  /** Chords as a mac reader sees them. */
  mac: readonly string[];
  /** Chords as a Windows/Linux reader sees them. */
  pc: readonly string[];
  /** The `requires` sentence — the same string the disabled tooltip and the agent's refusal print. */
  requires: string;
  /** Declared placements, sorted. `["palette"]` when the record declares none. */
  menus: readonly Placement[];
  /** The assistant tool name this record projects to, or `""` when it does not. */
  aiTool: string;
  destructive: boolean;
}

/** One binding, as `docs/studio/interface/shortcuts.md` prints it. */
export interface ShortcutRow {
  /** Canonical chord — `"mod+shift+p"`. The sort key, so the sheet is stable across platforms. */
  chord: string;
  mac: string;
  pc: string;
  commandId: string;
  title: string;
  category: Category;
  /** Where the chord is live. The column that explains why ⌘D does nothing while you are typing. */
  scope: KeyScope;
}

/** Human wording for each {@link KeyScope}, so the sheet does not print an enum at a reader. */
export const SCOPE_LABELS: Readonly<Record<KeyScope, string>> = {
  global: "Anywhere",
  canvas: "Canvas selection",
  caret: "Text caret",
  grid: "Data grid",
  code: "Code editor",
  dock: "Focused dock",
  palette: "Palette",
};

/** Category order — declaration order in `levels.ts`, which is task order, not alphabetical. */
const CATEGORY_RANK = new Map(CATEGORIES.map((category, index) => [category, index]));

function categoryRank(category: Category): number {
  return CATEGORY_RANK.get(category) ?? CATEGORIES.length;
}

/** A record's chords in canonical form, in declaration order. */
function chordsOf(command: AnyCommand): string[] {
  const raw = command.keybinding;
  if (!raw) {
    return [];
  }
  return (typeof raw === "string" ? [raw] : [...raw]).map((chord) => normalizeChord(chord));
}

/**
 * Every command, as documentation rows.
 *
 * Sorted by category then title — the palette's own grouping, so a reader who learned the app
 * through the palette finds the page laid out the way they already think.
 */
export function commandReference(commands: readonly AnyCommand[]): CommandRow[] {
  return commands
    .map((command) => {
      const chords = chordsOf(command);
      const row: CommandRow = {
        id: command.id,
        title: command.title,
        category: command.category,
        level: command.level,
        chords,
        mac: chords.map((chord) => formatChord(chord, true)),
        pc: chords.map((chord) => formatChord(chord, false)),
        requires: command.requires ?? "",
        menus: [...(command.menus ?? ["palette"])].toSorted(),
        aiTool: command.aiTool?.name ?? "",
        destructive: command.destructive === true,
      };
      return row;
    })
    .toSorted(
      (a, b) =>
        categoryRank(a.category) - categoryRank(b.category) || a.title.localeCompare(b.title),
    );
}

/**
 * Every BINDING, as documentation rows — one row per chord, not per command.
 *
 * `edit.redo` declares two chords and appears twice, because a reader looking up ⌘Y needs to find
 * it. Sorted by scope then chord so the sheet reads as "here is what this key does, and here is
 * where it is live".
 */
export function shortcutReference(commands: readonly AnyCommand[]): ShortcutRow[] {
  const rows: ShortcutRow[] = [];
  for (const command of commands) {
    const scope: KeyScope = command.keyScope ?? "global";
    for (const chord of chordsOf(command)) {
      rows.push({
        chord,
        mac: formatChord(chord, true),
        pc: formatChord(chord, false),
        commandId: command.id,
        title: command.title,
        category: command.category,
        scope,
      });
    }
  }
  return rows.toSorted((a, b) => a.scope.localeCompare(b.scope) || a.chord.localeCompare(b.chord));
}

/** Escape the one character that would break out of a markdown table cell. */
function cell(value: string): string {
  return value.replaceAll("|", String.raw`\|`);
}

function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const lines = [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map((value) => cell(value)).join(" | ")} |`),
  ];
  return lines.join("\n");
}

/** A chord list as one cell: `` `⌘⇧Z` or `⌘Y` ``, or an em dash when the command has none. */
function chordCell(chords: readonly string[]): string {
  return chords.length === 0 ? "—" : chords.map((chord) => `\`${chord}\``).join(" or ");
}

/**
 * The body of `docs/studio/interface/shortcuts.md` — one `##` section per scope.
 *
 * Both platforms print, side by side, because the alternative is the page telling half its readers
 * a chord they do not have — which is the documentation version of the bug `formatChord` fixed in
 * the toolbar.
 */
export function shortcutsMarkdown(rows: readonly ShortcutRow[]): string {
  const sections: string[] = [];
  const scopes = [...new Set(rows.map((row) => row.scope))];
  for (const scope of scopes) {
    const inScope = rows.filter((row) => row.scope === scope);
    sections.push(
      `## ${SCOPE_LABELS[scope]}\n`,
      table(
        ["macOS", "Windows / Linux", "Command", "Id"],
        inScope.map((row) => [
          `\`${row.mac}\``,
          `\`${row.pc}\``,
          row.title,
          `\`${row.commandId}\``,
        ]),
      ),
    );
  }
  return sections.join("\n\n");
}

/** The body of `docs/studio/interface/commands.md` — one `##` section per category. */
export function commandsMarkdown(rows: readonly CommandRow[]): string {
  const sections: string[] = [];
  const categories = [...new Set(rows.map((row) => row.category))];
  for (const category of categories) {
    const inCategory = rows.filter((row) => row.category === category);
    sections.push(
      `## ${category}\n`,
      table(
        ["Command", "Id", "Shortcut", "Level", "Requires"],
        inCategory.map((row) => [
          row.destructive ? `${row.title} (destructive)` : row.title,
          `\`${row.id}\``,
          chordCell(row.mac),
          row.level,
          row.requires || "—",
        ]),
      ),
    );
  }
  return sections.join("\n\n");
}
