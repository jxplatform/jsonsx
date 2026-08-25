/// <reference lib="dom" />
/**
 * Preferences-keymap.ts — the user's keyboard layer: where it is kept, and what it refuses.
 *
 * `specs/studio.md` §15 rule 2 says the Keyboard sheet is a PROJECTION of the command registry —
 * the same `shortcutReference()` that generates `docs/studio/interface/shortcuts.md` — so it cannot
 * drift from the app. Rebinding must not break that, which is why nothing here writes to a command
 * record. A rebinding is one entry in an override map that `keymap.setOverrides` lays over the
 * declared chords; `keymap.declaredFor(id)` keeps answering what the app ships with, and a reset is
 * the removal of an entry rather than the restoration of a value this module remembered.
 *
 * Three refusals, in the order they are checked, because each one is a different mistake:
 *
 * 1. **Not a chord.** Modifier-only, or a string no keyboard produces.
 * 2. **A bare printable key.** `s` bound globally fires while you are typing your name into a field:
 *    the dispatcher is one `document` keydown listener, and only some scopes are narrow enough to
 *    hold the key back. So a letter, digit or punctuation needs a modifier; ↑, Esc, F5 and their
 *    kind do not, because nothing types them.
 * 3. **Already taken.** The chord is claimed by another command in a scope that can be live at the
 *    same instant as this one — `keymap.overlappingScopes`. In the SAME scope that is exactly the
 *    condition `keymap.add` throws on at registration (the check that caught ⌘W); across scopes it
 *    is the quieter version of the same loss, because every dispatch stack is `[engine, "global"]`
 *    and a narrow binding silently shadows a global one for as long as that engine has focus. Two
 *    engine scopes (`caret` and `grid`, say) never share a stack and may hold one chord each for
 *    ever, so that is allowed — refusing it would forbid the shadowing ladder its whole purpose.
 *    Here it must not throw and must not silently win: the result NAMES the command holding the
 *    chord AND where that command is live, so the sheet can say who has it and offer to show that
 *    row.
 *
 * Storage is `localStorage`, the same place the chrome theme lives, and it is read defensively at
 * every layer: unavailable storage, invalid JSON, a non-array value and an unparseable chord all
 * degrade to "this author has no override for that command" rather than to a keyboard that throws
 * during boot.
 */

import { normalizeChord, overlappingScopes, parseChord } from "../commands/keymap";
import { SETTINGS } from "../services/settings/definitions";
import { clearSettings, readStoredSetting, setSetting } from "../services/settings/kernel";
import type { KeybindingOverrides } from "../commands/keymap";
import type { KeyScope } from "../commands/levels";
import type { AnyCommand, CommandRegistry } from "../commands/registry";

/** Where the user's layer is kept. One key, one JSON object of `id → chords`. */
export const KEYBINDINGS_STORAGE_KEY = SETTINGS.keybindings.key;

/** Keys that type nothing, and so may be bound without a modifier. */
const UNMODIFIED_KEYS = new Set([
  "escape",
  "enter",
  "tab",
  "backspace",
  "delete",
  "arrowup",
  "arrowdown",
  "arrowleft",
  "arrowright",
  "home",
  "end",
  "pageup",
  "pagedown",
  "insert",
]);

const FUNCTION_KEY = /^f([1-9]|1\d|2[0-4])$/;

/**
 * Where each scope's chords are live, in words a refusal can end with.
 *
 * A cross-scope conflict is otherwise unreadable: "⌘S is already Save" is baffling when the sheet
 * is showing you a canvas command and Save is a global one. The scope is the missing half of the
 * sentence, and it is also the half that tells the author whether they care.
 */
const SCOPE_WHERE: Readonly<Record<KeyScope, string>> = {
  global: "everywhere",
  canvas: "on the canvas",
  caret: "while text is being edited",
  grid: "in the data grid",
  code: "in the code editor",
  dock: "in the panels",
  palette: "in the command palette",
};

/** The command that already holds a chord — everything the refusal needs to name it. */
export interface RebindConflict {
  /** Canonical chord, as the user just pressed it. */
  chord: string;
  scope: KeyScope;
  /** The holder. */
  commandId: string;
  /** The holder's title, so the refusal names an action rather than an id. */
  title: string;
}

/**
 * What a rebind did.
 *
 * A refusal always carries a `reason` fit to show a person, and carries `conflict` when the reason
 * is another command — the case the sheet turns into "show me that one".
 */
export type RebindResult = { ok: true } | { ok: false; reason: string; conflict?: RebindConflict };

/** Whether a canonical chord may be bound at all. Modifier-less printable keys may not. */
export function isBindableChord(chord: string): boolean {
  let parsed;
  try {
    parsed = parseChord(chord);
  } catch {
    // Modifier-only, or empty: `parseChord` is the one place that decides what a chord is.
    return false;
  }
  if (parsed.mod || parsed.ctrl || parsed.alt) {
    return true;
  }
  // Shift alone is not enough: ⇧A is how a capital A is typed.
  return UNMODIFIED_KEYS.has(parsed.key) || FUNCTION_KEY.test(parsed.key);
}

function readRaw(): string {
  return readStoredSetting(SETTINGS.keybindings);
}

/** Every chord in one stored entry, canonicalised — or `null` if any of them is not a chord. */
function canonicalise(chords: unknown): string[] | null {
  if (!Array.isArray(chords)) {
    return null;
  }
  const canonical: string[] = [];
  for (const chord of chords as unknown[]) {
    if (typeof chord !== "string") {
      return null;
    }
    try {
      canonical.push(normalizeChord(chord));
    } catch {
      // A stored string that is not a chord: drop the whole entry rather than half of it.
      return null;
    }
  }
  return canonical;
}

/**
 * The stored layer, validated.
 *
 * Nothing here trusts the store: it is a JSON blob a user can hand-edit and an older release can
 * have written. An entry that does not survive validation is dropped, and the command keeps its
 * declared chord — which is the only failure mode that leaves the app usable.
 */
export function loadKeybindingOverrides(): Map<string, string[]> {
  const layer = new Map<string, string[]>();
  const raw = readRaw();
  if (!raw) {
    return layer;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt store: the defaults are the whole keymap.
    return layer;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return layer;
  }
  for (const [id, chords] of Object.entries(parsed as Record<string, unknown>)) {
    const canonical = canonicalise(chords);
    if (canonical) {
      layer.set(id, canonical);
    }
  }
  return layer;
}

function store(layer: KeybindingOverrides): void {
  if (layer.size === 0) {
    clearSettings([SETTINGS.keybindings]);
    return;
  }
  setSetting(SETTINGS.keybindings, JSON.stringify(Object.fromEntries(layer)));
}

/**
 * Lay the stored overrides over a registry's keymap.
 *
 * Called from `registerPreferencesCommands`, which is the bootstrap's one contact point with
 * Preferences. Because the layer lives INSIDE the keymap, applying it before the rest of the
 * bootstrap has finished registering is safe: a record registered afterwards is indexed against the
 * layer that is already there.
 */
export function applyKeybindingOverrides(registry: CommandRegistry): void {
  registry.keymap.setOverrides(loadKeybindingOverrides());
}

/**
 * Bind `command` to `chord`, or say why not.
 *
 * Rebinding a command back to the chord it declared REMOVES the override rather than pinning the
 * current default: the point of a layer is that a command whose default moves in a later release
 * moves with it unless the author asked for something else.
 */
export function rebindCommand(
  registry: CommandRegistry,
  command: AnyCommand,
  chord: string,
): RebindResult {
  let canonical: string;
  try {
    canonical = normalizeChord(chord);
  } catch {
    return { ok: false, reason: "That is not a shortcut — hold a key as well as the modifiers." };
  }
  if (!isBindableChord(canonical)) {
    return {
      ok: false,
      reason:
        `${registry.keymap.format(canonical)} would fire while you type. ` +
        "Add ⌘, Ctrl or Alt, or use a key that types nothing.",
    };
  }
  const scope: KeyScope = command.keyScope ?? "global";
  // Every scope this one can share a dispatch stack with, not just its own: a chord claimed in an
  // Overlapping scope is one of the two commands going quiet, and which one it is depends only on
  // Which is narrower. `resolveChord` walks the list in order, so the same scope is named first.
  const held = registry.keymap.resolveChord(canonical, overlappingScopes(scope));
  if (held && held.commandId !== command.id) {
    const holder = registry.get(held.commandId);
    const title = holder?.title ?? held.commandId;
    const where = held.scope === scope ? "" : `, which is live ${SCOPE_WHERE[held.scope]}`;
    return {
      ok: false,
      reason: `${registry.keymap.format(canonical)} is already ${title}${where}.`,
      conflict: { chord: canonical, commandId: held.commandId, scope: held.scope, title },
    };
  }
  const next = new Map(registry.keymap.overrides());
  const declared = registry.keymap.declaredFor(command.id);
  if (declared.length === 1 && declared[0] === canonical) {
    next.delete(command.id);
  } else {
    next.set(command.id, [canonical]);
  }
  registry.keymap.setOverrides(next);
  store(next);
  return { ok: true };
}

/**
 * Drop the override on `commandId`, restoring what the registry declares.
 *
 * @returns Whether there was one to drop, so a caller does not repaint over nothing.
 */
export function resetKeybinding(registry: CommandRegistry, commandId: string): boolean {
  const next = new Map(registry.keymap.overrides());
  if (!next.delete(commandId)) {
    return false;
  }
  registry.keymap.setOverrides(next);
  store(next);
  return true;
}
