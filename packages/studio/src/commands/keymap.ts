/**
 * Keymap.ts — chords in, command ids out.
 *
 * Three jobs, deliberately in one file because they must agree on one canonical chord string:
 *
 * 1. **Normalisation.** `"Cmd+Shift+P"`, `"meta+shift+p"` and `"mod+shift+P"` are the same chord.
 *    Everything is stored as `"mod+shift+p"` — modifiers in a fixed order, key lowercase.
 * 2. **Formatting.** ONE function turns a chord into what the user reads: `⌘⇧P` on mac, `Ctrl+Shift+P`
 *    everywhere else. Today `toolbar.ts:301` and `:555` hardcode `⌘P` and show it to Windows and
 *    Linux users; `formatChord` is what kills that everywhere at once.
 * 3. **Resolution through a scope stack.** `caret > grid/code engine > focused dock > global`. A chord
 *    bound in a narrower scope shadows the same chord in a wider one — that is the mechanism, not
 *    an accident, and it is why `keyScope` exists as a field separate from `level`.
 *
 * Conflicts fail loudly at registration: two commands claiming one chord in ONE scope throws. That
 * is the class of bug that let ⌘W (`editor/shortcuts.ts:192`, refuses to close the last tab) and
 * the tab strip's × (`panels/tab-strip.ts:182`, closes it happily) disagree for a year.
 */

import type { KeyScope } from "./levels";

/** Canonical modifier order. `mod` is ⌘ on mac and Ctrl elsewhere — one token, one meaning. */
const MODIFIER_ORDER = ["mod", "ctrl", "alt", "shift"] as const;

type Modifier = (typeof MODIFIER_ORDER)[number];

/** Spellings people actually write, mapped onto the canonical four. */
const MODIFIER_ALIASES: Readonly<Record<string, Modifier>> = {
  mod: "mod",
  cmd: "mod",
  command: "mod",
  meta: "mod",
  super: "mod",
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  opt: "alt",
  option: "alt",
  shift: "shift",
};

/** Key aliases — arrow/space spellings and the `KeyboardEvent.key` values that differ. */
const KEY_ALIASES: Readonly<Record<string, string>> = {
  up: "arrowup",
  down: "arrowdown",
  left: "arrowleft",
  right: "arrowright",
  esc: "escape",
  space: " ",
  spacebar: " ",
  del: "delete",
  plus: "=",
  return: "enter",
};

/** How each modifier prints, per platform. */
const MAC_GLYPHS: Readonly<Record<Modifier, string>> = {
  mod: "⌘",
  ctrl: "⌃",
  alt: "⌥",
  shift: "⇧",
};

const PC_LABELS: Readonly<Record<Modifier, string>> = {
  mod: "Ctrl",
  ctrl: "Ctrl",
  alt: "Alt",
  shift: "Shift",
};

/** Keys whose printed name is not just the uppercased token. */
const KEY_LABELS: Readonly<Record<string, string>> = {
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  " ": "Space",
  escape: "Esc",
  enter: "Enter",
  tab: "Tab",
  delete: "Delete",
  backspace: "Backspace",
};

/**
 * The five fields the keymap reads off a keyboard event.
 *
 * Declared structurally rather than as `KeyboardEvent` so this module — and the registry that
 * imports it — type without the DOM lib. That is what lets `scripts/check-command-levels.ts` load
 * the command set in a bare Bun process, and it costs nothing: a real `KeyboardEvent` satisfies
 * it.
 */
export interface KeyChordEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** Enough of `navigator` to tell a mac from everything else. */
export interface PlatformInfo {
  platform?: string;
  userAgent?: string;
}

/** A chord broken into its parts. */
export interface ParsedChord {
  mod: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** Lowercased key token, e.g. "p", "arrowup", "," or a lone space for Space. */
  key: string;
}

/** The subset of a command record the keymap indexes. */
export interface BindableRecord {
  id: string;
  keybinding?: string | readonly string[] | undefined;
  keyScope?: KeyScope | undefined;
}

/** Parse `"Cmd+Shift+P"` into its parts. Throws on an empty or modifier-only chord. */
export function parseChord(chord: string): ParsedChord {
  const parsed: ParsedChord = { mod: false, ctrl: false, alt: false, shift: false, key: "" };
  const tokens = chord.split("+");
  for (const [index, token] of tokens.entries()) {
    if (token === "") {
      // "mod++".split("+") is ["mod", "", ""] — a pair of empty tokens is a literal "+" key, and
      // A lone empty token is just the slack in "mod + s".
      if (index > 0 && tokens[index - 1] === "") {
        parsed.key = "+";
      }
      continue;
    }
    // A whitespace-only token is the Space key; everything else is trimmed so "Cmd + Shift + P"
    // Parses the same as "Cmd+Shift+P".
    const trimmed = token.trim();
    const lower = trimmed === "" ? " " : trimmed.toLowerCase();
    const modifier = MODIFIER_ALIASES[lower];
    if (modifier) {
      parsed[modifier] = true;
      continue;
    }
    parsed.key = KEY_ALIASES[lower] ?? lower;
  }
  if (!parsed.key) {
    throw new Error(`keybinding "${chord}" has no key — a chord needs more than modifiers`);
  }
  return parsed;
}

/** Render a parsed chord back to its canonical string. */
export function serializeChord(parsed: ParsedChord): string {
  const parts = MODIFIER_ORDER.filter((modifier) => parsed[modifier]);
  return [...parts, parsed.key].join("+");
}

/** `"Cmd+Shift+P"` → `"mod+shift+p"`. Idempotent; the storage form for every binding. */
export function normalizeChord(chord: string): string {
  return serializeChord(parseChord(chord));
}

/** Whether the current platform is a mac. `navigator` is injectable so tests never touch globals. */
export function isMacPlatform(
  nav: PlatformInfo = (globalThis as { navigator?: PlatformInfo }).navigator ?? {},
): boolean {
  return /mac/i.test(nav.platform ?? nav.userAgent ?? "");
}

/**
 * The chord a keyboard event represents, in canonical form.
 *
 * `mod` is the platform's primary modifier: ⌘ on mac (where a separate ⌃ can still be held and
 * reads as `ctrl`), Ctrl elsewhere (where Ctrl is `mod` and never also `ctrl`).
 */
export function chordFromEvent(event: KeyChordEvent, mac: boolean): string {
  const key = event.key.toLowerCase();
  const parsed: ParsedChord = {
    mod: mac ? event.metaKey : event.ctrlKey,
    ctrl: mac ? event.ctrlKey : false,
    alt: event.altKey,
    // Shift is implied by an uppercase letter but a chord table cannot rely on that: with ⇧ held
    // `e.key` is "Z" for ⌘⇧Z and "?" for ⇧/, so the flag is the only stable signal.
    shift: event.shiftKey,
    key: KEY_ALIASES[key] ?? key,
  };
  return serializeChord(parsed);
}

/** `"mod+shift+p"` → `⌘⇧P` on mac, `Ctrl+Shift+P` elsewhere. The only place a chord is styled. */
export function formatChord(chord: string, mac: boolean): string {
  const parsed = parseChord(chord);
  const held = MODIFIER_ORDER.filter((modifier) => parsed[modifier]);
  const key =
    KEY_LABELS[parsed.key] ??
    (parsed.key.length === 1
      ? parsed.key.toUpperCase()
      : parsed.key.charAt(0).toUpperCase() + parsed.key.slice(1));
  return mac
    ? held.map((modifier) => MAC_GLYPHS[modifier]).join("") + key
    : [...held.map((modifier) => PC_LABELS[modifier]), key].join("+");
}

/** Raised when two commands claim one chord in one scope. Carries both ids for the message. */
export class KeybindingConflictError extends Error {
  readonly chord: string;
  readonly scope: KeyScope;
  readonly existingId: string;
  readonly incomingId: string;

  constructor(chord: string, scope: KeyScope, existingId: string, incomingId: string) {
    super(
      `keybinding conflict: "${chord}" in scope "${scope}" is already bound to "${existingId}"; ` +
        `"${incomingId}" cannot claim it. Rebind one, or move one to a narrower keyScope.`,
    );
    this.name = "KeybindingConflictError";
    this.chord = chord;
    this.scope = scope;
    this.existingId = existingId;
    this.incomingId = incomingId;
  }
}

/** One resolved chord. */
export interface KeymapMatch {
  commandId: string;
  chord: string;
  scope: KeyScope;
}

export interface Keymap {
  /** Index a record's bindings. Throws {@link KeybindingConflictError} on a same-scope clash. */
  add: (record: BindableRecord) => void;
  /** Drop a record's bindings — used when a registry is rebuilt, not in normal operation. */
  remove: (id: string) => void;
  /** Canonical chords bound to `id`, in declaration order. */
  bindingsFor: (id: string) => readonly string[];
  /** The first binding of `id`, formatted for this platform, or `undefined` if unbound. */
  formatBinding: (id: string) => string | undefined;
  /** Walk `scopeStack` narrowest-first and return the first scope that binds `chord`. */
  resolveChord: (chord: string, scopeStack: readonly KeyScope[]) => KeymapMatch | undefined;
  /** {@link resolveChord} over a live keyboard event. */
  resolveEvent: (event: KeyChordEvent, scopeStack: readonly KeyScope[]) => KeymapMatch | undefined;
  /** Every (scope, chord, id) triple — the generated shortcut sheet reads this. */
  entries: () => readonly KeymapMatch[];
}

/**
 * Build an empty keymap.
 *
 * @param options.mac Whether to format chords with mac glyphs. Defaults to platform detection.
 */
export function createKeymap(options: { mac?: boolean } = {}): Keymap {
  const mac = options.mac ?? isMacPlatform();
  /** Scope → chord → command id. */
  const byScope = new Map<KeyScope, Map<string, string>>();
  /** Command id → its canonical chords, in declaration order. */
  const byId = new Map<string, string[]>();

  function chordsOf(record: BindableRecord): string[] {
    const raw = record.keybinding;
    if (!raw) {
      return [];
    }
    return (typeof raw === "string" ? [raw] : [...raw]).map((chord) => normalizeChord(chord));
  }

  return {
    add(record) {
      const scope: KeyScope = record.keyScope ?? "global";
      const chords = chordsOf(record);
      if (chords.length === 0) {
        return;
      }
      let table = byScope.get(scope);
      if (!table) {
        table = new Map<string, string>();
        byScope.set(scope, table);
      }
      for (const chord of chords) {
        const existing = table.get(chord);
        if (existing !== undefined && existing !== record.id) {
          throw new KeybindingConflictError(chord, scope, existing, record.id);
        }
      }
      // Only mutate once every chord has cleared, so a rejected record leaves nothing behind.
      for (const chord of chords) {
        table.set(chord, record.id);
      }
      byId.set(record.id, chords);
    },
    remove(id) {
      for (const table of byScope.values()) {
        for (const [chord, boundId] of table) {
          if (boundId === id) {
            table.delete(chord);
          }
        }
      }
      byId.delete(id);
    },
    bindingsFor(id) {
      return byId.get(id) ?? [];
    },
    formatBinding(id) {
      const first = byId.get(id)?.[0];
      return first === undefined ? undefined : formatChord(first, mac);
    },
    resolveChord(chord, scopeStack) {
      const normalized = normalizeChord(chord);
      // Narrowest scope first: the stack IS the precedence order, so the first hit wins and a
      // Caret binding shadows the same chord bound globally.
      const scope = scopeStack.find((candidate) => byScope.get(candidate)?.has(normalized));
      const commandId = scope === undefined ? undefined : byScope.get(scope)?.get(normalized);
      return scope === undefined || commandId === undefined
        ? undefined
        : { chord: normalized, commandId, scope };
    },
    resolveEvent(event, scopeStack) {
      return this.resolveChord(chordFromEvent(event, mac), scopeStack);
    },
    entries() {
      const all: KeymapMatch[] = [];
      for (const [scope, table] of byScope) {
        for (const [chord, commandId] of table) {
          all.push({ chord, commandId, scope });
        }
      }
      return all;
    },
  };
}
