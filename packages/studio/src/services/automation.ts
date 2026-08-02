/// <reference lib="dom" />
/**
 * Automation.ts — the scripting surface, as a PROJECTION of the app.
 *
 * Installed as `window.__jxAutomation` only when the page URL carries `?automation=1`. It exposes
 * exactly three members (spec studio.md §13.5):
 *
 * - `run(id, args)` — **is** `registry.run(id, args)`, behind {@link isScriptable}. There is no
 *   second action table. A hand-maintained parallel list of what the app can do is what plan §2
 *   principle 1 defines as a defect, and this module used to be 39 entries of exactly that, 16 of
 *   them holding raw XPath into the shell and three of them matching RENDERED TEXT.
 * - `seed(id, args)` — the {@link SEEDS} registry, under the **Remote Rule**: a seed may only write
 *   state whose real writer is a network or IPC boundary. It stands in for a remote, never for a
 *   user. {@link REFUSED_SEEDS} names what that excludes and why.
 * - `probe` — read-only. {@link AutomationProbe.idle} (the predicate that replaced 115 sleeps),
 *   `state()` (the full `CommandContext`), `commands()`, `seeds()`, and `pointAt`/`revealPath`,
 *   which compose the app's own transforms and answer in top-document coordinates.
 *
 * **What is deliberately absent**, each a normative refusal in spec §13.5:
 *
 * 1. No method that takes a selector. If a script cannot say it in command ids and `JxPath`s, it
 *    cannot say it here.
 * 2. No `setStatus`. Staging the word "Ready" over the status bar is lying to the reader; if a capture
 *    needs a calm status bar, the app has to BE calm.
 * 3. No `toggle*`. A delta against unstated state is what silently inverted 23 manifest steps when the
 *    assistant's default flipped, and an agent calling `view.toggleAssistant` is guessing at state
 *    it cannot observe. {@link TOGGLE_ID} refuses them at runtime.
 * 4. No compatibility shim. The predecessor carried `setRightTab`'s `if (tab === "assistant")`
 *    redirect, whose own comment said it existed "to keep the Screenshot-manifest verb working" — a
 *    pipeline artefact living in production code.
 * 5. No presentation-state pokes. Automation mutates documents by running the commands a user runs, so
 *    every write goes through the transaction log.
 */

import { render } from "../store";
import { seedProjectList } from "../project-list";
import { activeTab } from "../workspace/workspace";
import { shell } from "../shell";
import { collabState } from "../collab/collab-state";
import { canvasPointAt, revealCanvasPath } from "../canvas/iframe-host";
import { probeIdle } from "./idle";
import type { CanvasPoint } from "../canvas/iframe-host";
import type { IdleOptions } from "./idle";
import type { CommandContext } from "../commands/context";
import type { AnyCommand, CommandRegistry } from "../commands/registry";
import type { PeerPresence } from "../collab/collab-state";
import type { SeededAssistantMessage } from "../panels/ai-panel";
import type { PagesDeploymentInfo } from "../publish/pages-service";
import type { GitBranchesResult, GitStatusResult, ProjectListEntry } from "../types";
import type { GitLogEntry } from "../shell";
import type { JxPath } from "../state";

/** Loosely-typed arguments, as they arrive from a manifest step, a palette prompt or a tool call. */
export type AutomationArgs = Record<string, unknown>;

/**
 * What the hook needs that it cannot import.
 *
 * Three entries, and the shape is the point: everything the predecessor took by injection —
 * `getCanvasMode`, `openBrowseModal`, `openSettingsModal`, `render`, `setCanvasMode`,
 * `statusMessage` — was a capability being re-implemented here instead of being a command.
 */
export interface AutomationDeps {
  /** The registry `run()` projects. One per window, exactly as the bootstrap builds it. */
  registry: CommandRegistry;
  /** The assistant's transcript sink — stands in for the model stream. */
  seedAssistantMessages: (messages: SeededAssistantMessage[]) => void;
  /** The publish panel's connected state — stands in for the Cloudflare Pages API. */
  seedPublishConnected: (options: { accountId?: string; deployment: PagesDeploymentInfo }) => void;
}

// ─── The idempotence rule ─────────────────────────────────────────────────────

/** `view.toggleAssistant` names a delta; `view.setAssistant` names a state. Only one is runnable. */
export const TOGGLE_ID = /\.toggle[A-Z]/;

/** The idempotent id a toggle should have become — printed so the fix is inside the refusal. */
export function setterFor(id: string): string {
  return id.replace(/\.toggle([A-Z])/, (_match, initial: string) => `.set${initial}`);
}

/**
 * Whether a command projects into `run()`.
 *
 * Derived, not declared: everything the registry holds is a capability with an id, a gate and a
 * `run`, which is exactly what a script needs. The one exclusion is the idempotence rule, so the
 * projection cannot drift from the registry the way a hand-kept allow-list would.
 */
export function isScriptable(command: AnyCommand): boolean {
  return !TOGGLE_ID.test(command.id);
}

// ─── The registry-gap declaration ─────────────────────────────────────────────

/**
 * How a manifest id the registry does not declare is going to stop existing.
 *
 * - `command` — a thing a user does, so it becomes a registry record. The value names who lands it.
 * - `seed` — a remote's state, addressed through {@link AutomationApi.seed}.
 * - `refused` — §13.3 says the app will never provide it; the manifest step is deleted.
 */
export type GapDisposition = "command" | "seed" | "refused";

export interface ManifestId {
  disposition: GapDisposition;
  /** The phase that lands the record, or the sentence that refuses it. One line, for the error. */
  note: string;
}

/**
 * Ids the screenshot manifest still depends on and no registry declares. **No handlers, no
 * behaviour.**
 *
 * The export name is the contract `scripts/check-shot-contract.ts` reads (`loadCommandTable` looks
 * for `defaultCommandSet()`, `seedIds()` or `AUTOMATION_COMMANDS`), and it is all that is left of
 * the 39-entry action table this module used to be: every `press`, every XPath, every rendered-text
 * matcher and both label mirrors are gone, and `run()` never consults this map to decide what to DO
 * — only to explain, when the registry refuses an id, which of the three fates that id has.
 *
 * This is a countdown, in the idiom of the checker's own `TOGGLE_DEBT`: it may only shrink. It went
 * 39 → 8 when the manifest converted (S2). What left: every `seed` entry, now read off
 * {@link seedIds} and answered from the live registry rather than from a hand-kept list; every
 * `toggle*` entry, which {@link TOGGLE_ID} refuses before this map is ever consulted; and every
 * `command` entry whose record has since landed.
 *
 * What is left is two kinds. Three `command` entries are the manifest's real registry gaps — each
 * reached today by an `input` step clicking a hand-stamped region, and each of those steps carries
 * an `unstable` hatch naming the phase that lands the record, so this map and that hatch count are
 * the same debt. Five `refused` entries are NOT a countdown: they are §13.3's normative refusals,
 * and they stay so that a caller reaching for one gets the reason instead of "unknown command".
 */
export const AUTOMATION_COMMANDS: Readonly<Record<string, ManifestId>> = {
  "element.insertData": { disposition: "command", note: "P5 — insert.data" },
  "file.contextMenu": {
    disposition: "refused",
    note: "opening a menu to press an item names a control; the ITEM is the command",
  },
  "layers.contextMenu": {
    disposition: "refused",
    note: "matched RENDERED TEXT, which §13's R1 forbids; P5.5 stamps data-jx-path on rows",
  },
  "media.browse": { disposition: "command", note: "P7.5 — media.browse" },
  "project.showWelcome": {
    disposition: "refused",
    note: "cold start is a startup profile (?profile=fresh), not an action",
  },
  "settings.selectEntry": { disposition: "command", note: "P6.2 — settings.selectEntry" },
  "settings.setSection": {
    disposition: "refused",
    note: 'mirrored the section registry\'s LABELS; say settings.open { section: "cssVars" }',
  },
  "view.setStatus": {
    disposition: "refused",
    note: "the status bar is not staged — if a capture needs a calm shell, the app must BE calm",
  },
};

// ─── The seed registry, under the Remote Rule ─────────────────────────────────

/** One staged fixture, and the boundary whose job it is doing. */
export interface SeedDefinition {
  id: string;
  /** The network or IPC boundary this seed stands in for. The Remote Rule, written down per seed. */
  boundary: string;
  run: (args: AutomationArgs) => void | Promise<void>;
}

/**
 * Writes a seed will not do, and the reason, quoted back at the caller.
 *
 * Every one of these was a method on the old surface. Each writes state a USER writes, so each is a
 * COMMAND — and a fixture that stages it photographs a state no session could have reached.
 */
export const REFUSED_SEEDS: Readonly<Record<string, string>> = {
  openSettings: 'a user opens Settings — run("settings.open")',
  select: 'a user selects a node — run("selection.set", { path })',
  setActivity: 'a user picks a Navigator panel — run("navigator.showPanel", { panel })',
  setRightTab: 'a user picks an Inspector tab — run("inspector.setTab", { tab })',
  setStatus:
    "the status bar reports what the app just did; staging it is the one lie §13.3 names outright",
  setZoom: 'a user zooms — run("canvas.setZoom", { zoom })',
};

function arrayArg<T>(args: AutomationArgs, key: string): T[] {
  const value = args[key];
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new TypeError(`seed argument "${key}" must be an array`);
  }
  return value as T[];
}

function requiredArg<T>(args: AutomationArgs, key: string): T {
  const value = args[key];
  if (value === null || typeof value !== "object") {
    throw new TypeError(`seed argument "${key}" must be an object`);
  }
  return value as T;
}

function optionalString(args: AutomationArgs, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new TypeError(`seed argument "${key}" must be a string`);
  }
  return value;
}

/**
 * The declared seeds.
 *
 * Each one writes exactly what its named boundary would have written, and nothing else — the git
 * seed does not also open the Source Control panel, because a user does that.
 */
export function createSeeds(deps: AutomationDeps): SeedDefinition[] {
  return [
    {
      boundary: "the assistant's model stream",
      id: "seed.assistant",
      run: (args) => {
        deps.seedAssistantMessages(arrayArg<SeededAssistantMessage>(args, "messages"));
      },
    },
    {
      boundary: "the collaboration websocket (awareness + sync)",
      id: "seed.collab",
      run: (args) => {
        const tab = activeTab.value;
        if (!tab) {
          return;
        }
        const state = collabState(tab);
        state.status = "synced";
        state.active = true;
        const peers: PeerPresence[] = [];
        for (const peer of arrayArg<PeerPresence>(args, "peers")) {
          const peerState = { ...peer.state };
          // A peer with no focused document is focused on THIS one — the presence overlay keys on it.
          peerState.focusedPath ??= tab.documentPath;
          peers.push({ ...peer, state: peerState });
        }
        state.peers = peers;
        render();
      },
    },
    {
      boundary: "the Cloudflare Pages API",
      id: "seed.publish",
      run: (args) => {
        const accountId = optionalString(args, "accountId");
        deps.seedPublishConnected({
          deployment: requiredArg<PagesDeploymentInfo>(args, "deployment"),
          ...(accountId ? { accountId } : {}),
        });
      },
    },
    {
      boundary: "the platform's git routes (`gitStatus` / `gitBranches` / `gitLog`)",
      id: "seed.git",
      run: (args) => {
        // The working tree really is a remote here: the git-panel shot photographs whatever the
        // Author happened to have dirty, because its project lives inside this repository.
        shell.git.status = (args.status as GitStatusResult | undefined) ?? null;
        shell.git.branches = (args.branches as GitBranchesResult | undefined) ?? null;
        shell.git.logEntries = (args.log as GitLogEntry[] | undefined) ?? null;
        shell.git.loading = false;
        shell.git.error = null;
        render();
      },
    },
    {
      boundary: "the platform's recent-projects store (desktop IPC / cloud API)",
      id: "seed.projectList",
      run: (args) => {
        seedProjectList(arrayArg<ProjectListEntry>(args, "projects"));
        render();
      },
    },
  ];
}

/**
 * Every declared seed id, read off {@link createSeeds} itself.
 *
 * `scripts/check-shot-contract.ts` needs to answer "is `seed.projectList` a real seed?" in a bare
 * Bun process with no app. It could have read a hand-kept list — and a hand-kept list is precisely
 * how `seed.git` and `seed.projectList` came to be missing from {@link AUTOMATION_COMMANDS} while
 * both were shipping. Constructing the definitions is free: every seed's dependency is used inside
 * its `run`, never while building it, so the no-op deps below can never be called.
 */
export function seedIds(): string[] {
  const inert = {
    registry: undefined as unknown as CommandRegistry,
    seedAssistantMessages: () => {},
    seedPublishConnected: () => {},
  } satisfies AutomationDeps;
  return createSeeds(inert).map((seed) => seed.id);
}

// ─── The API ──────────────────────────────────────────────────────────────────

/** One command as a script sees it — the projection, not a second declaration. */
export interface ScriptableCommand {
  id: string;
  title: string;
  /** Whether its own `enablement` predicate would let it run right now. */
  enabled: boolean;
  /** The `requires` sentence when it would not. */
  requires?: string;
  /** The command's own JSON Schema — the palette's prompt and the AI tool's parameters. */
  args?: object;
}

/** What `pointAt` can address. Region ids join `path` when P3.8's region registry lands. */
export interface AutomationTarget {
  path: JxPath;
}

/** Read-only questions. Nothing here writes document or presentation state. */
export interface AutomationProbe {
  /**
   * Resolve when Studio has settled; reject with `NotIdleError.blockedBy` naming what it is waiting
   * on. See `services/idle.ts` — the rejection is the reason this exists.
   */
  idle: (options?: Pick<IdleOptions, "frames" | "timeoutMs">) => Promise<void>;
  /** The full `CommandContext` — the same record every `when` predicate and AI tool gate reads. */
  state: () => CommandContext;
  /** Every command a script may run right now, with its gate already evaluated. */
  commands: () => ScriptableCommand[];
  /** The declared seed ids, with the boundary each stands in for. */
  seeds: () => { id: string; boundary: string }[];
  /** Where a node is on screen, in TOP-DOCUMENT coordinates. Measures; moves nothing. */
  pointAt: (target: AutomationTarget) => Promise<CanvasPoint | null>;
  /** Bring a node into view and answer where it landed — the app's own jump-to-node. */
  revealPath: (path: JxPath) => Promise<CanvasPoint | null>;
}

export interface AutomationApi {
  run: (id: string, args?: AutomationArgs) => Promise<void>;
  seed: (id: string, args?: AutomationArgs) => Promise<void>;
  probe: AutomationProbe;
}

/** Thrown when the surface refuses an id on principle rather than because it is unknown. */
export class AutomationRefusedError extends Error {
  readonly id: string;

  constructor(id: string, reason: string) {
    super(`automation refuses "${id}" — ${reason}`);
    this.name = "AutomationRefusedError";
    this.id = id;
  }
}

/** The projection: every visible, scriptable command with its gate already evaluated. */
export function scriptableCommands(registry: CommandRegistry): ScriptableCommand[] {
  const projected: ScriptableCommand[] = [];
  for (const command of registry.visible()) {
    if (!isScriptable(command)) {
      continue;
    }
    const requires = registry.disabledReason(command.id);
    const entry: ScriptableCommand = {
      enabled: requires === undefined,
      id: command.id,
      title: command.title,
    };
    if (command.args) {
      entry.args = command.args;
    }
    if (requires !== undefined) {
      entry.requires = requires;
    }
    projected.push(entry);
  }
  return projected;
}

/** Why an id the registry does not declare is not runnable — the countdown, said out loud. */
function unknownCommandMessage(
  id: string,
  registry: CommandRegistry,
  seeds: ReadonlySet<string>,
): string {
  // Derived from the live seed registry, not from a hand-kept `disposition: "seed"` list: a seed
  // Added next week answers this question without anyone remembering to write it down twice.
  if (seeds.has(id)) {
    return `"${id}" is a seed, not a command — call seed("${id}", …)`;
  }
  const gap = AUTOMATION_COMMANDS[id];
  if (gap?.disposition === "refused") {
    return `"${id}" is refused by spec §13.5: ${gap.note}`;
  }
  if (gap) {
    return `"${id}" has no command record yet (${gap.note}) — __jxAutomation.run projects the registry and nothing else`;
  }
  const known = registry
    .list()
    .filter((command) => isScriptable(command))
    .map((command) => command.id);
  return `unknown command "${id}" — the registry declares ${known.length} scriptable id(s)`;
}

export function createAutomationApi(deps: AutomationDeps): AutomationApi {
  const seeds = new Map(createSeeds(deps).map((seed) => [seed.id, seed]));
  const seedIdSet = new Set(seeds.keys());

  return {
    probe: {
      commands: () => scriptableCommands(deps.registry),
      idle: (options = {}) => probeIdle(options),
      pointAt: (target) => canvasPointAt(target.path),
      revealPath: (path) => revealCanvasPath(path),
      seeds: () => [...seeds.values()].map((seed) => ({ boundary: seed.boundary, id: seed.id })),
      state: () => deps.registry.context(),
    },
    async run(id, args = {}) {
      if (TOGGLE_ID.test(id)) {
        throw new AutomationRefusedError(
          id,
          `it names a delta against state the caller cannot observe; call "${setterFor(id)}"`,
        );
      }
      const { registry } = deps;
      if (!registry.get(id)) {
        throw new Error(unknownCommandMessage(id, registry, seedIdSet));
      }
      // Refusal propagates as `CommandUnavailableError`: a step asking for a state the app refuses
      // Must FAIL, because that step is lying about what the app can be.
      await registry.run(id, args);
    },
    async seed(id, args = {}) {
      const bare = id.startsWith("seed.") ? id.slice(5) : id;
      const refusal = REFUSED_SEEDS[bare];
      if (refusal) {
        throw new AutomationRefusedError(
          id,
          `a seed stands in for a remote, never for a user: ${refusal}`,
        );
      }
      const seed = seeds.get(id.startsWith("seed.") ? id : `seed.${id}`);
      if (!seed) {
        throw new Error(
          `unknown seed "${id}" — declared seeds are ${[...seeds.keys()].join(", ")}`,
        );
      }
      await seed.run(args);
    },
  };
}

/** The hook is opt-in per page load: only `?automation=1` installs it. */
export function shouldInstallAutomation(search: string): boolean {
  return new URLSearchParams(search).get("automation") === "1";
}

/**
 * Install the hook on globalThis when the current URL opts in. Returns whether it installed, so
 * callers (and tests) can assert the gate.
 */
export function installAutomationHook(deps: AutomationDeps): boolean {
  if (!shouldInstallAutomation(location.search)) {
    return false;
  }
  (globalThis as Record<string, unknown>).__jxAutomation = createAutomationApi(deps);
  return true;
}
