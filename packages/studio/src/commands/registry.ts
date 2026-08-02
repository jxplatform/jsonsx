/**
 * Registry.ts — one definition site per action.
 *
 * A {@link Command} is the whole record of a capability: its name, its containment level, the
 * predicate that decides whether it is available, the one sentence that says why it is not, its
 * default chord, and the surfaces it belongs in. Every surface — Command Bar, palette, rail,
 * context menus, the block action bar, the keymap, `__jxAutomation` and the assistant's tools —
 * becomes a RENDERING of these records. A surface may choose whether to show a command; it may
 * never decide what it is called, when it is available, or what it does (plan §2, principle 1).
 *
 * Three things fail loudly at registration rather than degrading into a surface disagreement:
 *
 * - A duplicate id — the second definition site the whole design exists to prevent;
 * - A chord already claimed in the same `keyScope` (see `keymap.ts`) — this is exactly how ⌘W came to
 *   disagree with the tab strip's × button;
 * - A `menus` placement the level × placement matrix does not admit (see `levels.ts`), so a
 *   selection-level verb cannot appear in the Command Bar even in a hand-written test app.
 *
 * `when` / `enablement` are `(ctx) => boolean` closures, modelled on the shipped
 * `services/gated-registry.ts` `ToolAvailability`, and `requires` is ONE string with three
 * consumers: the disabled control's tooltip, the palette row's grey subtitle and the agent's
 * refusal message. Plan §13 rejects a serialisable string DSL; do not add one.
 *
 * The registry takes its context by injection (`getContext`), so nothing here imports a state
 * module. That is what lets the CI checks import the command set in a bare Bun process and lets
 * every test build the exact state it wants to assert against.
 */

import { createKeymap } from "./keymap";
import type { KeyChordEvent, Keymap } from "./keymap";
import { checkRecordPlacements } from "./levels";
import type { Category, KeyScope, Level, Placement } from "./levels";
import type { CommandContext } from "./context";

/** Arguments as they arrive from a palette prompt, an automation manifest step or an AI tool call. */
export type CommandArgs = Record<string, unknown>;

/** How an action's effect is undone — surfaced to the user before an agent runs it. */
export type UndoScope = "document" | "project" | "none";

/**
 * One capability, defined once.
 *
 * @template A The argument record `run` receives. Defaults to `void` for the (common) case of a
 *   command that takes none.
 */
export interface Command<A = void> {
  /** `"<category>.<verb>"` — the same namespace `scripts/screenshots/manifest.json` addresses. */
  id: string;
  /** Imperative human name. The ONLY place this action is named. */
  title: string;
  category: Category;
  /** REQUIRED containment level, checked against every declared placement. */
  level: Level;
  /** Keyboard dispatch scope. Deliberately separate from {@link Command.level}. */
  keyScope?: KeyScope;
  /** Icon key, resolved through the activity bar's existing icon map. */
  icon?: string;
  /** Hide entirely. Default: always visible. */
  when?: (ctx: CommandContext) => boolean;
  /** Show but disable. Defaults to {@link Command.when}. */
  enablement?: (ctx: CommandContext) => boolean;
  /** The human reason, e.g. "an element selection". Tooltip, palette subtitle, agent refusal. */
  requires?: string;
  /** Default chord(s), e.g. `"mod+shift+p"`. User overrides layer on top. */
  keybinding?: string | readonly string[];
  /** JSON Schema for {@link Command.run}'s args — the palette's prompt AND the AI tool's params. */
  args?: object;
  /** Surfaces this command renders in. Defaults to `["palette"]`. */
  menus?: readonly Placement[];
  /** Menu ordering key: "1_clipboard", "3_structure", "9_danger". */
  group?: string;
  undo?: UndoScope;
  destructive?: boolean;
  /** Opt-in projection to the assistant. The human's gate and the agent's gate stay one predicate. */
  aiTool?: { name: string; description: string };
  run: (ctx: CommandContext, args: A) => void | Promise<void>;
}

/**
 * A command of unknown argument type, as stored.
 *
 * `never` (not `unknown`) is what makes an arbitrary `Command<A>` assignable: `run` is
 * contravariant in its argument, so a handler taking `{ path }` satisfies one taking `never`.
 */
export type AnyCommand = Command<never>;

/** `<namespace>.<verb>`, lowercase namespace, at least two dot-separated segments. */
const ID_PATTERN = /^[a-z][a-z\d]*(\.[a-zA-Z\d]+)+$/;

/** Thrown when a command is invoked while its own predicate refuses it. */
export class CommandUnavailableError extends Error {
  readonly commandId: string;
  /** The `requires` sentence, or a generic fallback when the record did not supply one. */
  readonly requires: string;

  constructor(commandId: string, requires: string) {
    super(refusalSentence(commandId, requires));
    this.name = "CommandUnavailableError";
    this.commandId = commandId;
    this.requires = requires;
  }
}

/** Wording shared by the disabled tooltip, the palette subtitle and the agent's refusal. */
const GENERIC_REQUIREMENT = "a different studio state";

/** The one refusal sentence. `CommandUnavailableError` and `refusalMessage` must not diverge. */
function refusalSentence(commandId: string, requires: string): string {
  return `Command "${commandId}" is not available right now — it requires ${requires}.`;
}

export interface CommandRegistry {
  /** Define a command. Throws on a duplicate id, a chord conflict or a misplacement. */
  register: <A>(command: Command<A>) => void;
  /** Define many, in order. Not transactional: the throwing record is the one that failed. */
  registerAll: (commands: readonly AnyCommand[]) => void;
  get: (id: string) => AnyCommand | undefined;
  /** Every command, in registration order. */
  list: () => readonly AnyCommand[];
  /** Commands whose `when` holds right now — what a surface iterates. */
  visible: () => readonly AnyCommand[];
  /** Commands declaring `placement`, visible right now, sorted by `group` then title. */
  forPlacement: (placement: Placement) => readonly AnyCommand[];
  isVisible: (id: string) => boolean;
  isEnabled: (id: string) => boolean;
  /** The `requires` sentence when a visible command is disabled; `undefined` when it is usable. */
  disabledReason: (id: string) => string | undefined;
  /** The full refusal sentence, for an agent or a tooltip. `undefined` when the command is usable. */
  refusalMessage: (id: string) => string | undefined;
  /** Run a command. Throws on an unknown id, or {@link CommandUnavailableError} when refused. */
  run: (id: string, args?: CommandArgs) => void | Promise<void>;
  /** The chord index, conflict-checked at registration. */
  keymap: Keymap;
  /** Resolve a keyboard event through a scope stack and run what it hits. */
  handleKeyEvent: (event: KeyChordEvent, scopeStack: readonly KeyScope[]) => string | undefined;
  /** The context the predicates are currently reading — exposed for surfaces that need a snapshot. */
  context: () => CommandContext;
}

export interface CommandRegistryOptions {
  /** The live context. Called per predicate evaluation; a reactive record makes this free. */
  getContext: () => CommandContext;
  /** Format chords with mac glyphs. Defaults to platform detection inside the keymap. */
  mac?: boolean;
}

/**
 * Build an empty registry.
 *
 * There is deliberately no module-level singleton here: the app creates one in its bootstrap and
 * passes it down, so tests, the CI checks and a future second window each get their own.
 */
export function createCommandRegistry(options: CommandRegistryOptions): CommandRegistry {
  const commands = new Map<string, AnyCommand>();
  const keymap = createKeymap(options.mac === undefined ? {} : { mac: options.mac });

  function mustGet(id: string): AnyCommand {
    const command = commands.get(id);
    if (!command) {
      throw new Error(`unknown command "${id}"`);
    }
    return command;
  }

  function visibleWith(command: AnyCommand, ctx: CommandContext): boolean {
    return command.when?.(ctx) ?? true;
  }

  function enabledWith(command: AnyCommand, ctx: CommandContext): boolean {
    if (!visibleWith(command, ctx)) {
      return false;
    }
    // `enablement` defaults to `when`: a command that only declared `when` is enabled exactly when
    // It is shown, which is the behaviour every existing hand-wired control already has.
    return command.enablement?.(ctx) ?? true;
  }

  const registry: CommandRegistry = {
    register(command) {
      if (!ID_PATTERN.test(command.id)) {
        throw new Error(
          `invalid command id "${command.id}" — ids are "<category>.<verb>", ` +
            `e.g. "selection.duplicate" or "view.toggleDock.right"`,
        );
      }
      if (commands.has(command.id)) {
        throw new Error(
          `duplicate command id "${command.id}" — a capability has exactly one definition site`,
        );
      }
      if (!command.title) {
        throw new Error(
          `command "${command.id}" has no title — the record is where actions are named`,
        );
      }
      const violations = checkRecordPlacements(command);
      if (violations.length > 0) {
        throw new Error(`command "${command.id}" ${violations[0]!.message}`);
      }
      // Chord conflicts throw from the keymap; do this LAST so a rejected record leaves the
      // Registry untouched in every failure mode.
      keymap.add(command);
      commands.set(command.id, command as AnyCommand);
    },
    registerAll(list) {
      for (const command of list) {
        registry.register(command);
      }
    },
    get(id) {
      return commands.get(id);
    },
    list() {
      return [...commands.values()];
    },
    visible() {
      const ctx = options.getContext();
      return [...commands.values()].filter((command) => visibleWith(command, ctx));
    },
    forPlacement(placement) {
      const ctx = options.getContext();
      return [...commands.values()]
        .filter(
          (command) =>
            (command.menus ?? ["palette"]).includes(placement) && visibleWith(command, ctx),
        )
        .toSorted(
          (a, b) => (a.group ?? "").localeCompare(b.group ?? "") || a.title.localeCompare(b.title),
        );
    },
    isVisible(id) {
      return visibleWith(mustGet(id), options.getContext());
    },
    isEnabled(id) {
      return enabledWith(mustGet(id), options.getContext());
    },
    disabledReason(id) {
      const command = mustGet(id);
      const ctx = options.getContext();
      return enabledWith(command, ctx) ? undefined : (command.requires ?? GENERIC_REQUIREMENT);
    },
    refusalMessage(id) {
      const reason = registry.disabledReason(id);
      return reason === undefined ? undefined : refusalSentence(id, reason);
    },
    run(id, args = {}) {
      const command = mustGet(id);
      const ctx = options.getContext();
      if (!enabledWith(command, ctx)) {
        throw new CommandUnavailableError(id, command.requires ?? GENERIC_REQUIREMENT);
      }
      return command.run(ctx, args as never);
    },
    keymap,
    handleKeyEvent(event, scopeStack) {
      const match = keymap.resolveEvent(event, scopeStack);
      // A chord bound to a command whose `when` is false is not a hit: the key falls through to
      // The browser rather than being swallowed by an action that is not there.
      const hit = match && registry.isVisible(match.commandId) ? match : undefined;
      if (!hit) {
        return;
      }
      // Visible but disabled — ⌘Z with no history, Delete on the root. The chord IS claimed (the
      // Action exists here, it just cannot act right now, and letting the browser have it would be
      // Worse), but running it would throw CommandUnavailableError straight out of the keydown
      // Listener. Claim it silently instead of making every caller wrap dispatch in a try/catch.
      if (!registry.isEnabled(hit.commandId)) {
        return hit.commandId;
      }
      void registry.run(hit.commandId);
      return hit.commandId;
    },
    context: options.getContext,
  };
  return registry;
}
