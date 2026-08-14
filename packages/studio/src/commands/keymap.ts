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
 *    {@link overlappingScopes} is the same fact read the other way round: which scopes can be live
 *    at one instant, and therefore which pairs cannot both answer one chord.
 *
 * Conflicts fail loudly at registration: two commands claiming one chord in ONE scope throws. That
 * is the class of bug that let ⌘W (`editor/shortcuts.ts:192`, refuses to close the last tab) and
 * the tab strip's × (`panels/tab-strip.ts:182`, closes it happily) disagree for a year.
 *
 * 4. **The user's layer.** A rebinding is an OVERRIDE (`setOverrides`), never an edit to a record:
 *    `declaredFor(id)` keeps answering what the registry declared, which is what a reset restores
 *    and what `specs/studio.md` §15 rule 2 means by the Keyboard sheet being a projection. The two
 *    layers meet by one rule — **an override outranks a default, and a default never evicts an
 *    override** — so the outcome does not depend on registration order, and a stored override that
 *    a later release's new default happens to collide with cannot throw the bootstrap. Two defaults
 *    colliding still throws, because that one is a bug in the app and nobody's preference.
 */

import { KEY_SCOPES } from "./levels";
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
  /**
   * The physical key, when the event carries one.
   *
   * Optional, and read for exactly one purpose: with ⇧ held, `key` is the SHIFTED glyph, so ⌘⇧2
   * arrives as `"@"` on a US layout, `"\""` on a UK one and `"é"` on a French one. A chord table
   * that spelled `mod+shift+2` would then never fire — which is precisely the run of chords ⌘⇧1–4
   * (the Inspector tabs) needs. `code` is `"Digit2"` on all three, so the digit row resolves by
   * position, the way a user counting tabs means it.
   */
  code?: string;
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
 * The chord a keyboard event represents, in canonical form — or `""` for a bare modifier press.
 *
 * `mod` is the platform's primary modifier: ⌘ on mac (where a separate ⌃ can still be held and
 * reads as `ctrl`), Ctrl elsewhere (where Ctrl is `mod` and never also `ctrl`).
 */
/** `"Digit4"` → `"4"`; anything else → `undefined`. See {@link KeyChordEvent.code}. */
function digitFromCode(code: string | undefined): string | undefined {
  const match = /^Digit(\d)$/.exec(code ?? "");
  return match?.[1];
}

export function chordFromEvent(event: KeyChordEvent, mac: boolean): string {
  const key = digitFromCode(event.code) ?? event.key.toLowerCase();
  /* A modifier ALONE is not a chord, and holding one is how every chord starts. Serializing the
     keydown for a lone Ctrl produced "mod+control", which `parseChord` refuses by contract ("a
     chord needs more than modifiers") — so every bare modifier press threw out of `resolveEvent`,
     into the keydown listener, and onto the console. `""` is the honest answer, and
     {@link Keymap.resolveEvent} reads it as "no chord yet". */
  if (MODIFIER_ALIASES[key]) {
    return "";
  }
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

/** The overlay's stack, and the only one `palette` appears in. */
const PALETTE_SCOPES: readonly KeyScope[] = ["palette"];

/** Every scope a dispatch stack can reach outside an overlay, `global` last-resort but named first. */
const DISPATCHABLE_SCOPES: readonly KeyScope[] = [
  "global",
  ...KEY_SCOPES.filter((scope) => scope !== "global" && scope !== "palette"),
];

/**
 * Every scope that can be live at the same instant as `scope` — including `scope` itself.
 *
 * Scopes are NOT independent namespaces, and treating them as one is how a rebinding steals a
 * chord. Dispatch walks a stack (`commands/context.ts` `keyScopeStack`), and every stack Studio can
 * be in is either the overlay's `["palette"]` or `[<one engine scope>, "global"]`. So:
 *
 * - **`global` overlaps every engine scope.** Binding a canvas command to ⌘S does not "also" bind ⌘S
 *   — it SHADOWS Save for as long as the canvas has focus, and Save stops responding with no trace.
 *   Whichever of the two is the newcomer, the pair cannot both answer that chord.
 * - **Two engine scopes never overlap.** `caret` and `grid` are never on one stack, so one chord may
 *   mean two things there for ever; refusing that would forbid the shadowing ladder's whole point.
 * - **`palette` overlaps nothing but itself.** An overlay owns the keyboard outright: nothing else
 *   resolves while one is up, and a palette binding resolves nowhere else.
 *
 * Ordered so that {@link Keymap.resolveChord} over the result names the most direct holder first:
 * the same scope, then the wider one.
 */
export function overlappingScopes(scope: KeyScope): readonly KeyScope[] {
  if (scope === "palette") {
    return PALETTE_SCOPES;
  }
  if (scope === "global") {
    return DISPATCHABLE_SCOPES;
  }
  return [scope, "global"];
}

/** One resolved chord. */
export interface KeymapMatch {
  commandId: string;
  chord: string;
  scope: KeyScope;
}

/**
 * The user's keybinding layer: command id → the chords it holds INSTEAD of the ones it declared.
 *
 * An entry with an empty list is a command the user unbound. An id with no entry is a command that
 * still has whatever the registry declared — absence is what makes a default a default.
 */
export type KeybindingOverrides = ReadonlyMap<string, readonly string[]>;

export interface Keymap {
  /**
   * Whether chords print with mac glyphs.
   *
   * Exposed because the platform decision is made ONCE, here, and every surface that prints a chord
   * reads it rather than re-detecting: the hardcoded `⌘P` that `toolbar.ts` showed Windows and
   * Linux users existed because there was nowhere else to ask.
   */
  readonly mac: boolean;
  /** Format an arbitrary chord for this platform. {@link formatBinding} is this over a command's. */
  format: (chord: string) => string;
  /** Index a record's bindings. Throws {@link KeybindingConflictError} on a same-scope clash. */
  add: (record: BindableRecord) => void;
  /** Drop a record's bindings — used when a registry is rebuilt, not in normal operation. */
  remove: (id: string) => void;
  /** Canonical chords LIVE for `id` — the user's, when they have overridden it. */
  bindingsFor: (id: string) => readonly string[];
  /**
   * Canonical chords `id` DECLARED, whatever the user layer says.
   *
   * This is what a reset restores, and it is why a rebinding is a layer rather than an edit: the
   * registry stays the one place a default chord is written down.
   */
  declaredFor: (id: string) => readonly string[];
  /** Replace the user's layer and re-index every record against it. */
  setOverrides: (overrides: KeybindingOverrides) => void;
  /** The user's layer, as applied. A copy: the layer is replaced, never mutated in place. */
  overrides: () => KeybindingOverrides;
  /** The first binding of `id`, formatted for this platform, or `undefined` if unbound. */
  formatBinding: (id: string) => string | undefined;
  /** Walk `scopeStack` narrowest-first and return the first scope that binds `chord`. */
  resolveChord: (chord: string, scopeStack: readonly KeyScope[]) => KeymapMatch | undefined;
  /** {@link resolveChord} over a live keyboard event. */
  resolveEvent: (event: KeyChordEvent, scopeStack: readonly KeyScope[]) => KeymapMatch | undefined;
  /** Every (scope, chord, id) triple — the generated shortcut sheet reads this. */
  entries: () => readonly KeymapMatch[];
  /**
   * Subscribe to "the live bindings changed". Returns an unsubscribe.
   *
   * One listener exists today and it is the reason this hook does: the canvas iframe holds a COPY
   * of the chord table (`canvas/iframe-keys.ts`), and a copy with no invalidation is a second
   * authority that drifts the moment someone rebinds a key. Fired by {@link setOverrides}, which is
   * the only operation that changes what is live after boot.
   */
  onChange: (listener: () => void) => () => void;
}

/**
 * Build an empty keymap.
 *
 * @param options.mac Whether to format chords with mac glyphs. Defaults to platform detection.
 */
/** Which layer a live claim came from — the whole of the precedence rule is this one field. */
interface Claim {
  id: string;
  source: "default" | "override";
}

export function createKeymap(options: { mac?: boolean } = {}): Keymap {
  const mac = options.mac ?? isMacPlatform();
  /** Scope → chord → who holds it. */
  const byScope = new Map<KeyScope, Map<string, Claim>>();
  /** Command id → the chords it holds LIVE, in declaration order. */
  const byId = new Map<string, string[]>();
  /** Command id → what it declared. Never written by a rebinding. */
  const declared = new Map<string, { chords: string[]; scope: KeyScope }>();
  /** The user's layer. Replaced wholesale by `setOverrides`; empty until one is applied. */
  let userLayer = new Map<string, readonly string[]>();
  /** Who to tell when the live bindings change. */
  const listeners = new Set<() => void>();

  function chordsOf(record: BindableRecord): string[] {
    const raw = record.keybinding;
    if (!raw) {
      return [];
    }
    return (typeof raw === "string" ? [raw] : [...raw]).map((chord) => normalizeChord(chord));
  }

  function tableFor(scope: KeyScope): Map<string, Claim> {
    let table = byScope.get(scope);
    if (!table) {
      table = new Map<string, Claim>();
      byScope.set(scope, table);
    }
    return table;
  }

  /**
   * Index one record's LIVE chords.
   *
   * `strict` is registration: two defaults colliding is an app bug and throws, and the throw
   * happens before anything is written so a rejected record leaves nothing behind. A rebuild is not
   * strict — by then every collision involves the user's layer, which has an answer.
   */
  function claim(id: string, strict: boolean): void {
    const record = declared.get(id);
    if (!record) {
      return;
    }
    const override = userLayer.get(id);
    const source: Claim["source"] = override === undefined ? "default" : "override";
    const chords = override ?? record.chords;
    const table = tableFor(record.scope);
    if (strict) {
      for (const chord of chords) {
        const held = table.get(chord);
        if (held && held.id !== id && held.source === "default" && source === "default") {
          throw new KeybindingConflictError(chord, record.scope, held.id, id);
        }
      }
    }
    const taken: string[] = [];
    for (const chord of chords) {
      const held = table.get(chord);
      if (held && held.id !== id) {
        if (source === "default") {
          // A default never evicts an override: the user asked for this chord by name, and a
          // Command that ships with it later is the one that goes unbound.
          continue;
        }
        // An override always evicts. (Two overrides on one chord can only come from a hand-edited
        // Store — `rebindCommand` refuses it — and then the later record wins, deterministically.)
        byId.set(
          held.id,
          (byId.get(held.id) ?? []).filter((bound) => bound !== chord),
        );
      }
      table.set(chord, { id, source });
      taken.push(chord);
    }
    byId.set(id, taken);
  }

  /** Re-index everything: overridden records first, so their claims are the ones that survive. */
  function rebuild(): void {
    byScope.clear();
    byId.clear();
    for (const id of declared.keys()) {
      if (userLayer.has(id)) {
        claim(id, false);
      }
    }
    for (const id of declared.keys()) {
      if (!userLayer.has(id)) {
        claim(id, false);
      }
    }
  }

  return {
    mac,
    format(chord) {
      return formatChord(chord, mac);
    },
    add(record) {
      const scope: KeyScope = record.keyScope ?? "global";
      declared.set(record.id, { chords: chordsOf(record), scope });
      try {
        claim(record.id, true);
      } catch (error) {
        declared.delete(record.id);
        throw error;
      }
    },
    remove(id) {
      declared.delete(id);
      // A rebuild rather than a targeted delete, so anything this record was displacing gets its
      // Chord back — the same reason `setOverrides` rebuilds.
      rebuild();
    },
    bindingsFor(id) {
      return byId.get(id) ?? [];
    },
    declaredFor(id) {
      return declared.get(id)?.chords ?? [];
    },
    setOverrides(overrides) {
      userLayer = new Map(
        [...overrides].map(([id, chords]) => [id, chords.map((chord) => normalizeChord(chord))]),
      );
      rebuild();
      for (const listener of listeners) {
        listener();
      }
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    overrides() {
      return new Map(userLayer);
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
      const held = scope === undefined ? undefined : byScope.get(scope)?.get(normalized);
      return scope === undefined || held === undefined
        ? undefined
        : { chord: normalized, commandId: held.id, scope };
    },
    resolveEvent(event, scopeStack) {
      const chord = chordFromEvent(event, mac);
      // A bare modifier press resolves to nothing rather than throwing on a keyless chord.
      return chord === "" ? undefined : this.resolveChord(chord, scopeStack);
    },
    entries() {
      const all: KeymapMatch[] = [];
      for (const [scope, table] of byScope) {
        for (const [chord, held] of table) {
          all.push({ chord, commandId: held.id, scope });
        }
      }
      return all;
    },
  };
}

/**
 * Every live (chord, scope) pair in `scopes`, deduplicated — the table a second realm can resolve
 * against.
 *
 * Written for the canvas iframe, which cannot see the registry at all: it is handed this and
 * forwards a keystroke iff some scope on its own stack claims the chord (`canvas/iframe-keys.ts`).
 * The command id is deliberately dropped — the frame decides whether to forward, never what runs —
 * and the projection is a pure function of the keymap so the host can recompute and repost it
 * whenever a rebinding lands.
 */
export function chordsInScopes<S extends KeyScope>(
  keymap: Keymap,
  scopes: readonly S[],
): { chord: string; scope: S }[] {
  const seen = new Set<string>();
  const out: { chord: string; scope: S }[] = [];
  for (const entry of keymap.entries()) {
    /* `find` rather than a `Set.has` test: the narrowed member is what makes the result carry the
       CALLER's scope union. The canvas frame's table is three scopes wide (`FRAME_KEY_SCOPES`) and
       has to stay that way across the bridge, where `SyncedChord` declares exactly those three —
       widening back to every `KeyScope` here would push a `grid` chord into a message that cannot
       hold one. */
    const scope = scopes.find((candidate) => candidate === entry.scope);
    if (scope === undefined) {
      continue;
    }
    const key = `${scope} ${entry.chord}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push({ chord: entry.chord, scope });
  }
  return out;
}
