/**
 * Check-shot-contract.ts — Lane 1 of the screenshot gate (UX-REDESIGN-PLAN §13.5).
 *
 * `docs:verify` does not verify screenshots. `scripts/docs/check-doc-refs.ts:209-231` asserts only
 * that a referenced image resolves into `docs/images/`, that its basename is a name the manifest
 * COULD produce, and `existsSync`. No CI job runs `bun run screenshots`. So a panel rename ships
 * wrong pictures under green CI, which is exactly how two shots stayed red on main for weeks.
 *
 * This check closes that half in seconds, with no browser: it reads `scripts/screenshots/
 * manifest.json` and the command projection, and fails NAMING BOTH SIDES OF THE BREAK —
 *
 *     manifest shot "properties-bar" step 3 names command "view.setActivity" with tab "head";
 *     the panel registry declares "page"
 *
 * — in the PR that caused it, so the renamer sees it rather than an archaeologist three weeks
 * later. It enforces the two rules §13 establishes:
 *
 * R1. A shot may name inputs the app accepts, never values the app derives. R2. The pipeline may
 * only ask the app to do sooner what the plan already commits to.
 *
 * Rules, in the order they fire:
 *
 * 1. Every command step names a declared, scriptable command, and every seed step names a declared
 *    seed. The projection is the app's registry ∪
 *    {@link import("../packages/studio/src/services/automation").seedIds} ∪ the shrinking
 *    `AUTOMATION_COMMANDS` gap list.
 * 2. No command id matches `/\.toggle[A-Z]/` — §13.3 clause 3. A toggle is a delta against unstated
 *    state, which is what silently inverted 18 steps when the assistant's default flipped.
 *    {@link TOGGLE_DEBT} is **empty**, so any toggle id is a hard error the first time it appears.
 * 3. `args` validate against the command's own `args` JSON Schema, where one is declared.
 * 4. No CSS or XPath selector anywhere in the manifest, and no hand-stamped (non-derived) region id
 *    beyond the committed count — the `ALLOWED_ORPHANS` idiom from
 *    `packages/studio/scripts/check-styles.ts`. The selector counters are all at **zero**.
 * 5. The `input`-step and `unstable` counts §13.3 caps, same shape.
 * 6. `manifest.contract` matches {@link CONTRACT_VERSION}.
 *
 * **Quarantined shots are read past.** A shot carrying `status: {state: "quarantined"}` is one the
 * repo admits is broken; the runner skips it too, `docs:check` fails if a page still illustrates
 * itself with it, and its ids are checked again the moment the quarantine is lifted — which is the
 * moment someone is looking. Holding a disabled shot to the contract only means fixing it twice.
 *
 * The manifest is read in BOTH shapes: contract 0 (`actions`/`waitFor`/`regions`/`variants`, which
 * only the fixtures under `scripts/screenshots/fixtures/contract/` still use) and contract 1
 * (`steps`/`expect`/`capture`), so the fixtures that prove each rule need not be rewritten with
 * it.
 *
 * Run in the CI `checks` job: `bun scripts/check-shot-contract.ts` Against fixtures: `bun
 * scripts/check-shot-contract.ts --manifest <m.json> --commands <mod.ts>`
 */

import { isAbsolute, resolve } from "node:path";

/**
 * Paths in this file are repo-relative, resolved against the repo root rather than `cwd`.
 *
 * CI runs the check from the root; a test runs it from `packages/studio`. A path that means two
 * different things depending on where you stand is exactly the class of bug this file exists to
 * catch, so it does not have one.
 */
const REPO_ROOT = resolve(import.meta.dir, "..");

function fromRoot(path: string): string {
  return isAbsolute(path) ? path : resolve(REPO_ROOT, path);
}

// ─── The command projection ───────────────────────────────────────────────────
// §13.3 makes `__jxAutomation.run` a projection of the command registry. It is not one yet: the
// Registry (`commands/defaults.ts`) holds the records written in the new form, and the 39-entry
// `AUTOMATION_COMMANDS` table holds the ids the manifest actually addresses. The projection is
// Their union, registry first, so a record's `args` schema wins over the shim's. When S3 deletes
// `AUTOMATION_COMMANDS`, one entry leaves DEFAULT_COMMAND_SOURCES and nothing else here changes.

/** One command as this check sees it — the three fields a manifest step can break against. */
export interface CommandRecord {
  id: string;
  /** JSON Schema for `run`'s args, when the record declares one. */
  args?: object;
  /** `false` once a record opts out of the `run()` projection. */
  scriptable: boolean;
  /** Module that declared it, so a failure says where to look. */
  source: string;
}

export type CommandTable = ReadonlyMap<string, CommandRecord>;

export const DEFAULT_COMMAND_SOURCES = [
  "packages/studio/src/commands/app-commands.ts",
  "packages/studio/src/services/automation.ts",
] as const;

export const DEFAULT_MANIFEST = "scripts/screenshots/manifest.json";

/** The manifest shape this file implements. A bump is for surface SHAPE, never for content drift. */
export const CONTRACT_VERSION = 1;

// ─── Committed budgets ────────────────────────────────────────────────────────

/**
 * The counts §13.3 caps, committed at what the CONVERTED manifest holds.
 *
 * The check fails when a count goes UP — that is the whole contract. When a count goes down the run
 * prints a ratchet line naming the new value; lowering the committed number is then a one-line
 * edit, and raising one needs the same written justification as lowering a coverage threshold
 * (CLAUDE.md).
 *
 * - `selectorActions` `click`/`hover`/`type`/`canvasClick`/`dispatchDragOver` with a selector. **0**
 *   — the contract has no verb that takes one.
 * - `waitForSelectors` `waitFor: {type: "selector"}` steps. **0** — all 43 became `expect`.
 * - `regionSelectors` region captures addressed by CSS instead of a region id. **0**.
 * - `clipSelectors` `clip: {selector}`. **0** — `of: "viewport"` names the camera's own frame.
 * - `argSelectors` a puppeteer handler prefix (`xpath/`, `pierce/`) inside a step's `args`. Always
 *   zero, and landing it at zero is what keeps it zero.
 * - `inputSteps` raw input: keystrokes, typing, caret placement, synthetic drags. §13.6 wanted ≤6. It
 *   lands at **19**, and the gap is almost entirely the three ids that have no command record yet
 *   (`settings.selectEntry` ×5, `element.insertData`, `media.browse`) plus `tab-strip-shot`, which
 *   types into a real editor because the dirty flag is EARNED, not asserted. Each falls out as its
 *   record lands.
 * - `nonDerivedRegions` DISTINCT region ids no registry stamps for free — the hand-stamped leaves
 *   §13.3 budgets for (`navigator/panel:git/commit`, `navigator/statements`, the settings entry
 *   rows, the media-picker's browse button…). Contract 0 counted 17 CSS selectors here.
 * - `unstable` `{reason, until}` escape hatches. **7**, and every one is a step that would otherwise
 *   be a `cmd` naming an id no registry declares. See {@link REMEDY}.
 */
export const CONTRACT_BUDGET = {
  selectorActions: 0,
  waitForSelectors: 0,
  regionSelectors: 0,
  clipSelectors: 0,
  argSelectors: 0,
  inputSteps: 18,
  nonDerivedRegions: 12,
  unstable: 7,
} as const;

export type BudgetKey = keyof typeof CONTRACT_BUDGET;
export type ContractCounts = Record<BudgetKey, number>;

/**
 * The toggle ids the manifest still names, and how many steps name each. **Empty, and staying so.**
 *
 * §13.3 clause 3 requires zero: `canvas.togglePreview` cannot say which state it ends in, so six
 * screenshots taken through it photographed whichever way the default happened to point that week.
 * S2 replaced all ten steps with the state each was reaching for — `canvas.setMode {mode:
 * "preview"}` ×6, `inspector.setSection {section: "__element", open: true}` ×3, and the one
 * `view.toggleActivity {tab: "layers"}` in `block-action-bar-shot`, which was not switching panel
 * at all: it was COLLAPSING the dock, and now says `view.setNavigator {open: false}`.
 *
 * With the list empty, any toggle id is a hard error the first time it appears. Re-opening it is a
 * deliberate act in a PR that argues for it, the same bar as raising a budget.
 */
export const TOGGLE_DEBT: Readonly<Record<string, number>> = {};

/**
 * Region ids the app stamps for free, per the §13.2 grammar `<surface>[.<instance>][/<part>]`.
 *
 * Anything else is hand-stamped and counts against `nonDerivedRegions`. A CSS selector never
 * matches any of these, which is what makes the contract-1 manifest count 16/16 non-derived today
 * and what makes S2's conversion visible as the number falling.
 */
export const DERIVED_REGION_PATTERNS: readonly RegExp[] = [
  // Bare surfaces and instances.
  /^(?:rail|navigator|inspector|commandbar|statusbar|overlay|dock\.bottom)$/,
  /^pane(?:\.(?:primary|secondary))?$/,
  /^overlay\.(?:palette|dialog|menu|toasts)$/,
  // Stamped by the panel host from `registerPanel()`.
  /^navigator\/panel:[a-z][\w-]*$/,
  // Stamped by the inspector's tab record and by `ui/field-row.ts:50`'s `data-prop`.
  /^inspector\/tab:[a-z][\w-]*$/,
  /^inspector\/field:[\w$.-]+$/,
  // Already in `PLACEMENTS`.
  /^statusbar\/(?:project|document|selection)$/,
  // The pane's own tab strip — names the pane, not `#tab-strip`.
  /^pane(?:\.(?:primary|secondary))?\/tabs$/,
  // `ui/layers.ts:550` already keys `_namedSlots` as `${layer}:${id}`.
  /^overlay\.[a-z][a-z\d]*:[\w-]+$/,
];

/** Puppeteer selector-handler prefixes — unambiguous evidence of a selector in a value. */
const HANDLER_PREFIXES = ["xpath/", "pierce/", "aria/", "text/"];

/** Contract-1 action kinds that are raw input rather than a named state transition. */
const INPUT_ACTIONS = new Set([
  "canvasClick",
  "canvasKey",
  "canvasType",
  "click",
  "dispatchDragOver",
  "hover",
  "type",
]);

/**
 * Contract-1 bespoke verbs, read as the command step each one already is.
 *
 * This is §13.6's own conversion table, applied at READ time rather than waiting for S2 to apply it
 * at edit time — and it is what makes §13.7's promise true today: a P3 panel rename fails Lane 1 on
 * exactly the four `setActivity` steps that name `blocks`, `imports` and `head`, in the renaming
 * PR, naming both ids. Without it the check would see 58 of the manifest's 400 actions and the 46
 * `setActivity` steps would rename silently.
 *
 * `valueAs` names the argument the verb's single `value` field carries; verbs without it pass their
 * own named fields through (`openSettings {section}`, `editFunction {path, eventKey}`). When S2
 * rewrites the manifest into `cmd:` steps, this table is deleted and nothing else moves.
 */
const LEGACY_ACTIONS: Readonly<Record<string, { id: string; valueAs?: string }>> = {
  editDef: { id: "formula.editDef" },
  editFunction: { id: "formula.editEvent" },
  openBrowse: { id: "project.browse" },
  openDataGrid: { id: "data.openGrid" },
  openNewProject: { id: "project.new" },
  openQuickSearch: { id: "search.openPalette" },
  openSettings: { id: "settings.open" },
  seedAssistant: { id: "seed.assistant" },
  seedCollab: { id: "seed.collab" },
  seedPublish: { id: "seed.publish" },
  select: { id: "selection.set" },
  setActivity: { id: "view.setActivity", valueAs: "tab" },
  setCanvasMode: { id: "canvas.setMode", valueAs: "mode" },
  setRightTab: { id: "view.setRightTab", valueAs: "tab" },
  setStatus: { id: "view.setStatus", valueAs: "text" },
  setTheme: { id: "view.setTheme", valueAs: "color" },
  setZoom: { id: "canvas.setZoom", valueAs: "zoom" },
  showWelcome: { id: "project.showWelcome" },
};

// ─── Pure rules ───────────────────────────────────────────────────────────────

/** §13.3 clause 3: `view.toggleAssistant` names a delta; `view.setAssistant` names a state. */
export function isToggleId(id: string): boolean {
  return /\.toggle[A-Z]/.test(id);
}

/** The idempotent id a toggle should have become — printed so the fix is in the error. */
export function setterFor(id: string): string {
  return id.replace(/\.toggle([A-Z])/, (_match, initial: string) => `.set${initial}`);
}

/** True when a registry stamps this region id without anyone authoring it. */
export function isDerivedRegionId(id: string): boolean {
  return DERIVED_REGION_PATTERNS.some((pattern) => pattern.test(id));
}

/** True when a string is a CSS or XPath selector rather than a region id or a document path. */
export function looksLikeSelector(value: string): boolean {
  return HANDLER_PREFIXES.some((prefix) => value.startsWith(prefix));
}

/** Classic Levenshtein — small, and only ever run over ~40 ids on the failure path. */
export function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_unused, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(current[j - 1]! + 1, previous[j]! + 1, substitution);
    }
    previous = current;
  }
  return previous[b.length]!;
}

/**
 * The declared id a stale one most plausibly renamed into, or `undefined`.
 *
 * Same-namespace candidates are preferred, because `project.browse → library.open` is a rename
 * nobody can spell-check and `view.setActivty → view.setActivity` is one nobody should have to.
 */
export function nearestId(id: string, known: Iterable<string>): string | undefined {
  const namespace = id.slice(0, Math.max(0, id.indexOf(".") + 1));
  let best: string | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const candidate of known) {
    const distance = editDistance(id, candidate);
    const score = candidate.startsWith(namespace) ? distance - 0.5 : distance;
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best !== undefined && bestScore <= Math.max(3, id.length / 3) ? best : undefined;
}

/** How many sibling ids a failure lists before it stops being help and starts being a wall. */
const MAX_SIBLINGS = 8;

/**
 * The other side of the break, for an id nothing declares.
 *
 * A typo has a near neighbour and gets named one. A RENAME usually does not — `view.setActivity →
 * view.showPanel` is 9 edits apart — so the fallback lists what the namespace does declare, which
 * is where the new name is. Naming neither side is what sends people digging through git log.
 */
export function suggestFor(id: string, known: Iterable<string>): string {
  // Materialised once: `known` is usually `Map.keys()`, and reading it twice reads it empty.
  const ids = [...known];
  const nearest = nearestId(id, ids);
  if (nearest !== undefined) {
    return ` — nearest declared id is "${nearest}"`;
  }
  const namespace = id.slice(0, Math.max(0, id.indexOf(".") + 1));
  const siblings = namespace
    ? ids.filter((candidate) => candidate.startsWith(namespace)).toSorted()
    : [];
  if (siblings.length === 0) {
    return "";
  }
  const shown = siblings
    .slice(0, MAX_SIBLINGS)
    .map((sibling) => `"${sibling}"`)
    .join(" | ");
  const more = siblings.length > MAX_SIBLINGS ? `, +${siblings.length - MAX_SIBLINGS} more` : "";
  return ` — "${namespace}" declares ${shown}${more}`;
}

/** A JSON Schema keyword subset — everything a command's `args` schema realistically declares. */
interface ArgsSchema {
  type?: string;
  properties?: Record<string, ArgsSchema>;
  required?: readonly string[];
  additionalProperties?: boolean;
  enum?: readonly unknown[];
  const?: unknown;
  items?: ArgsSchema;
  /**
   * Non-standard, and the reason the §13.5 error string reads the way it does: the registry that
   * owns the value space, so the failure says "the panel registry declares" rather than "the schema
   * declares". JSON Schema ignores unknown keywords, so this costs nothing at runtime.
   */
  declaredBy?: string;
}

const JSON_TYPE_OF: Record<string, string> = {
  boolean: "boolean",
  number: "number",
  object: "object",
  string: "string",
};

function jsonTypeOf(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return JSON_TYPE_OF[typeof value] ?? typeof value;
}

function show(value: unknown): string {
  return typeof value === "string" ? `"${value}"` : JSON.stringify(value);
}

function typeMatches(expected: string, value: unknown): boolean {
  if (expected === "integer") {
    return typeof value === "number" && Number.isInteger(value);
  }
  return jsonTypeOf(value) === expected;
}

/**
 * Validate one step's `args` against a command's schema, returning message FRAGMENTS.
 *
 * Fragments, not sentences: the caller prefixes `manifest shot "x" step n names command "id" `, so
 * every failure in this file reads as one sentence naming both sides of the break.
 */
export function validateArgs(schema: object, args: Record<string, unknown>): string[] {
  const spec = schema as ArgsSchema;
  const properties = spec.properties ?? {};
  const issues: string[] = [];
  for (const key of spec.required ?? []) {
    if (!(key in args)) {
      issues.push(`with no "${key}"; its args schema requires one`);
    }
  }
  for (const [key, value] of Object.entries(args)) {
    const property = properties[key];
    if (!property) {
      if (spec.additionalProperties === false) {
        const declared = Object.keys(properties)
          .map((name) => `"${name}"`)
          .join(" | ");
        issues.push(
          `with unknown argument "${key}"; its args schema declares ${declared || "none"}`,
        );
      }
      continue;
    }
    const source = property.declaredBy ?? "its args schema";
    if (property.type !== undefined && !typeMatches(property.type, value)) {
      issues.push(
        `with ${key} ${show(value)} (${jsonTypeOf(value)}); ${source} declares ${property.type}`,
      );
      continue;
    }
    if (property.const !== undefined && value !== property.const) {
      issues.push(`with ${key} ${show(value)}; ${source} declares ${show(property.const)}`);
      continue;
    }
    if (property.enum && !property.enum.includes(value)) {
      const allowed = property.enum.map((option) => show(option)).join(" | ");
      issues.push(`with ${key} ${show(value)}; ${source} declares ${allowed}`);
    }
  }
  return issues;
}

// ─── Manifest traversal ───────────────────────────────────────────────────────
// Deliberately shape-tolerant: it reads contract 1 (`actions`/`waitFor`/`regions`/`variants`) and
// Contract 2 (`steps`/`expect`/`capture`) in one pass, so S2's conversion shows up as the budgets
// Falling rather than as a rewrite of this file.

interface CommandStep {
  /** `manifest shot "tab-strip-shot" step 12`, or `… variant "cleanup" step 3`. */
  at: string;
  id: string;
  args: Record<string, unknown>;
}

interface Sighting {
  at: string;
  value: string;
}

interface ManifestFacts {
  shots: number;
  /** Shots carrying `status: {state: "quarantined"}` — read past, and reported rather than hidden. */
  quarantined: string[];
  commandSteps: CommandStep[];
  seedSteps: CommandStep[];
  regionIds: Sighting[];
  counts: ContractCounts;
  contract: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((entry) => isRecord(entry)) : [];
}

function asArgs(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/** A contract-1 action's own fields, read as the command args §13.6's codemod will write. */
function legacyArgs(
  verb: { id: string; valueAs?: string },
  action: Record<string, unknown>,
): Record<string, unknown> {
  if (verb.valueAs) {
    return "value" in action ? { [verb.valueAs]: action.value } : {};
  }
  const { do: _verb, ...rest } = action;
  return rest;
}

/** Read every fact the rules need out of a parsed manifest, in one traversal. */
export function readManifest(raw: unknown): ManifestFacts {
  const root = isRecord(raw) ? raw : {};
  const counts: ContractCounts = {
    selectorActions: 0,
    waitForSelectors: 0,
    regionSelectors: 0,
    clipSelectors: 0,
    argSelectors: 0,
    inputSteps: 0,
    nonDerivedRegions: 0,
    unstable: 0,
  };
  const facts: ManifestFacts = {
    shots: 0,
    quarantined: [],
    commandSteps: [],
    seedSteps: [],
    regionIds: [],
    counts,
    contract: typeof root.contract === "number" ? root.contract : 1,
  };
  const distinctRegions = new Set<string>();

  const countArgSelectors = (args: Record<string, unknown>) => {
    for (const value of Object.values(args)) {
      if (typeof value === "string" && looksLikeSelector(value)) {
        counts.argSelectors += 1;
      }
    }
  };
  const countUnstable = (entry: Record<string, unknown>) => {
    if (entry.unstable !== undefined) {
      counts.unstable += 1;
    }
  };
  const takeRegion = (at: string, id: unknown) => {
    if (typeof id !== "string" || !id) {
      return;
    }
    facts.regionIds.push({ at, value: id });
    if (!distinctRegions.has(id)) {
      distinctRegions.add(id);
      if (!isDerivedRegionId(id)) {
        counts.nonDerivedRegions += 1;
      }
    }
  };
  const takeClip = (at: string, clip: unknown) => {
    if (isRecord(clip) && typeof clip.selector === "string") {
      counts.clipSelectors += 1;
      takeRegion(at, clip.selector);
    }
  };
  // `waitFor` selectors are counted, not addressed: S2 turns all 43 into `expect` entries, so
  // Nothing here ever needs to name the step that held one.
  const takeWaits = (waits: unknown) => {
    for (const wait of records(waits)) {
      if (wait.type === "selector") {
        counts.waitForSelectors += 1;
      }
    }
  };
  const takeSteps = (label: string, steps: unknown) => {
    for (const [index, step] of records(steps).entries()) {
      const at = `${label} step ${index + 1}`;
      countUnstable(step);
      const args = asArgs(step.args);
      countArgSelectors(args);
      const kind = typeof step.do === "string" ? step.do : "";
      if (typeof step.selector === "string") {
        counts.selectorActions += 1;
      }
      if (INPUT_ACTIONS.has(kind) || step.input !== undefined) {
        counts.inputSteps += 1;
        // An `input` step addresses its target by region id, so it is exactly as much of a
        // Hand-stamped-region commitment as a capture is — and the three ids that only ever appear
        // On a gesture (`pane.primary/prop:count`, `…/insertData`, `inspector/field:src/browse`)
        // Would otherwise be invisible to the budget that exists to hold that number down.
        takeRegion(at, step.region);
      }
      const commandId = kind === "run" ? step.id : step.cmd;
      const legacy = LEGACY_ACTIONS[kind];
      if (typeof commandId === "string") {
        facts.commandSteps.push({ at, args, id: commandId });
      } else if (legacy) {
        facts.commandSteps.push({ at, args: legacyArgs(legacy, step), id: legacy.id });
      }
      if (typeof step.seed === "string") {
        facts.seedSteps.push({ at, args, id: step.seed });
      }
    }
  };

  takeWaits(isRecord(root.defaults) ? root.defaults.waitFor : undefined);
  takeClip("manifest defaults", isRecord(root.defaults) ? root.defaults.clip : undefined);

  for (const [index, shot] of records(root.shots).entries()) {
    facts.shots += 1;
    const name = typeof shot.name === "string" ? shot.name : `#${index + 1}`;
    const label = `manifest shot "${name}"`;
    // A quarantined shot is one the repo ADMITS is broken (§13.5). The runner skips it, `docs:check`
    // Fails if a page still illustrates itself with it, and holding a disabled shot to the contract
    // Would only mean the fix has to be made twice. Its ids are checked again the moment the
    // Quarantine is lifted, which is the point at which someone is looking.
    if (isRecord(shot.status) && shot.status.state === "quarantined") {
      facts.quarantined.push(name);
      continue;
    }
    countUnstable(shot);
    takeSteps(label, shot.actions);
    takeSteps(label, shot.steps);
    takeWaits(shot.waitFor);
    takeClip(label, shot.clip);
    for (const region of records(shot.regions)) {
      if (typeof region.selector === "string") {
        counts.regionSelectors += 1;
        takeRegion(label, region.selector);
      }
    }
    for (const capture of records(shot.capture)) {
      countUnstable(capture);
      takeRegion(label, capture.of);
    }
    for (const assertion of records(shot.expect)) {
      takeRegion(label, assertion.region);
    }
    for (const variant of records(shot.variants)) {
      const suffix = typeof variant.suffix === "string" ? variant.suffix : "?";
      const variantLabel = `${label} variant "${suffix}"`;
      takeSteps(variantLabel, variant.actions);
      takeWaits(variant.waitFor);
    }
  }
  return facts;
}

// ─── The check ────────────────────────────────────────────────────────────────

export interface ContractResult {
  violations: string[];
  /** Names of the shots read past because they are quarantined. */
  quarantined: string[];
  /** `budget` lines for counters now BELOW their committed value — the ratchet, spelled out. */
  ratchets: string[];
  counts: ContractCounts;
  shots: number;
  commandSteps: number;
  commandIds: number;
  toggleSteps: number;
}

export interface ContractInput {
  manifest: unknown;
  commands: CommandTable;
  budget?: Readonly<ContractCounts>;
  toggleDebt?: Readonly<Record<string, number>>;
}

export function checkShotContract(input: ContractInput): ContractResult {
  const { commands, manifest } = input;
  const budget = input.budget ?? CONTRACT_BUDGET;
  const toggleDebt = input.toggleDebt ?? TOGGLE_DEBT;
  const facts = readManifest(manifest);
  const violations: string[] = [];
  const seenIds = new Set<string>();
  const toggleSeen = new Map<string, number>();

  if (facts.contract !== CONTRACT_VERSION) {
    violations.push(
      `manifest declares contract ${facts.contract}; ` +
        `scripts/check-shot-contract.ts implements ${CONTRACT_VERSION}`,
    );
  }

  for (const step of facts.commandSteps) {
    seenIds.add(step.id);
    const head = `${step.at} names command "${step.id}"`;
    if (isToggleId(step.id)) {
      toggleSeen.set(step.id, (toggleSeen.get(step.id) ?? 0) + 1);
      if (!(step.id in toggleDebt)) {
        violations.push(
          `${head}; a toggle names a delta against unstated state (§13.3 clause 3) — ` +
            `declare "${setterFor(step.id)}" and name the value the step ends in`,
        );
        // A new toggle is usually also an unknown id. Reporting both buries the actionable one.
        continue;
      }
    }
    const record = commands.get(step.id);
    if (!record) {
      violations.push(
        `${head}; no command registry declares it${suggestFor(step.id, commands.keys())}`,
      );
      continue;
    }
    if (!record.scriptable) {
      violations.push(`${head}; ${record.source} declares it unscriptable`);
      continue;
    }
    if (record.args) {
      for (const issue of validateArgs(record.args, step.args)) {
        violations.push(`${head} ${issue}`);
      }
    }
  }

  for (const step of facts.seedSteps) {
    const id = step.id.startsWith("seed.") ? step.id : `seed.${step.id}`;
    if (!commands.has(id)) {
      violations.push(`${step.at} seeds "${step.id}"; no seed registry declares "${id}"`);
    }
  }

  for (const [id, allowed] of Object.entries(toggleDebt)) {
    const actual = toggleSeen.get(id) ?? 0;
    if (actual > allowed) {
      violations.push(
        `manifest names "${id}" in ${actual} step(s); the committed toggle debt is ${allowed} ` +
          `and may only shrink — replace it with "${setterFor(id)}"`,
      );
    }
  }

  const ratchets: string[] = [];
  // Canonical order, so a violation list reads the same whoever supplied the budget.
  for (const key of Object.keys(CONTRACT_BUDGET) as BudgetKey[]) {
    const actual = facts.counts[key];
    const allowed = budget[key];
    if (actual > allowed) {
      violations.push(
        `manifest holds ${actual} ${key} (committed budget ${allowed}); the budget is a ratchet ` +
          `and may only fall — see CONTRACT_BUDGET in scripts/check-shot-contract.ts`,
      );
    } else if (actual < allowed) {
      ratchets.push(`${key} is now ${actual} (committed ${allowed}) — lower it`);
    }
  }
  const toggleSteps = [...toggleSeen.values()].reduce((sum, n) => sum + n, 0);
  for (const [id, allowed] of Object.entries(toggleDebt)) {
    const actual = toggleSeen.get(id) ?? 0;
    if (actual < allowed) {
      ratchets.push(`toggle debt "${id}" is now ${actual} (committed ${allowed}) — lower it`);
    }
  }

  return {
    commandIds: seenIds.size,
    commandSteps: facts.commandSteps.length,
    counts: facts.counts,
    quarantined: facts.quarantined,
    ratchets,
    shots: facts.shots,
    toggleSteps,
    violations,
  };
}

/** The paragraph printed under a failure — what to do, not just what broke. */
export const REMEDY =
  "A manifest step names an INPUT the app accepts; it may never name a value the app derives " +
  "(UX-REDESIGN-PLAN §13, R1). Fix the step, not the check: rename the id, correct the args, or " +
  "delete the shot. Raising a number in CONTRACT_BUDGET or TOGGLE_DEBT needs the same written " +
  "justification as lowering a coverage threshold — those counts are the migration's scoreboard.";

export function formatSummary(result: ContractResult): string {
  const budgetLine = (Object.keys(CONTRACT_BUDGET) as BudgetKey[])
    .map((key) => `${key} ${result.counts[key]}/${CONTRACT_BUDGET[key]}`)
    .join(" · ");
  const lines = [
    `shot-contract OK: ${result.shots} shot(s), ${result.commandSteps} command step(s) over ` +
      `${result.commandIds} id(s).`,
    `  budget: ${budgetLine}`,
  ];
  if (result.quarantined.length > 0) {
    lines.push(`  quarantined (not checked, not captured): ${result.quarantined.join(", ")}`);
  }
  if (result.toggleSteps > 0) {
    lines.push(
      `  toggle debt: ${result.toggleSteps} step(s) over ${Object.keys(TOGGLE_DEBT).length} id(s) ` +
        `— §13.3 clause 3 requires zero; S2 converts them.`,
    );
  }
  return lines.join("\n");
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

interface CommandModule {
  defaultCommandSet?: () => { id: string; args?: object; isScriptable?: boolean }[];
  seedIds?: () => string[];
  AUTOMATION_COMMANDS?: Record<string, unknown>;
}

/**
 * Import each module and fold its declarations into one table, first declaration winning.
 *
 * A module may export `defaultCommandSet()` (the registry), `seedIds()` (the seed registry),
 * `AUTOMATION_COMMANDS` (the shim table S3 deletes), or any combination. Exporting NONE of them is
 * a usage error, not a silent empty projection.
 *
 * `seedIds()` is read rather than the shim's three `disposition: "seed"` entries because those
 * three were a hand-kept list, and `seed.git` and `seed.projectList` were both shipping while
 * absent from it — a manifest naming either failed against a check that was simply out of date.
 */
export async function loadCommandTable(modulePaths: readonly string[]): Promise<CommandTable> {
  const table = new Map<string, CommandRecord>();
  const add = (id: string, source: string, args?: object, scriptable = true) => {
    if (!table.has(id)) {
      table.set(id, { id, scriptable, source, ...(args ? { args } : {}) });
    }
  };
  for (const path of modulePaths) {
    const module_ = (await import(Bun.pathToFileURL(fromRoot(path)).href)) as CommandModule;
    let declared = false;
    if (typeof module_.defaultCommandSet === "function") {
      declared = true;
      for (const command of module_.defaultCommandSet()) {
        add(command.id, path, command.args, command.isScriptable !== false);
      }
    }
    if (typeof module_.seedIds === "function") {
      declared = true;
      for (const id of module_.seedIds()) {
        add(id, path);
      }
    }
    if (module_.AUTOMATION_COMMANDS && typeof module_.AUTOMATION_COMMANDS === "object") {
      declared = true;
      for (const id of Object.keys(module_.AUTOMATION_COMMANDS)) {
        add(id, path);
      }
    }
    if (!declared) {
      throw new Error(
        `${path} exports none of defaultCommandSet(), seedIds() or AUTOMATION_COMMANDS`,
      );
    }
  }
  return table;
}

const USAGE =
  "Usage: bun scripts/check-shot-contract.ts [--manifest <manifest.json>] " +
  "[--commands <module.ts>]…";

export async function main(argv: readonly string[]): Promise<number> {
  let manifestPath = DEFAULT_MANIFEST;
  const sources: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if ((flag === "--manifest" || flag === "--commands") && value !== undefined) {
      i += 1;
      if (flag === "--manifest") {
        manifestPath = value;
      } else {
        sources.push(value);
      }
      continue;
    }
    console.error(USAGE);
    return 2;
  }

  let commands: CommandTable;
  try {
    commands = await loadCommandTable(sources.length > 0 ? sources : DEFAULT_COMMAND_SOURCES);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  let manifest: unknown;
  try {
    manifest = (await Bun.file(fromRoot(manifestPath)).json()) as unknown;
  } catch (error) {
    console.error(`Cannot read ${manifestPath}: ${error instanceof Error ? error.message : error}`);
    return 2;
  }

  const result = checkShotContract({ commands, manifest });
  if (result.violations.length > 0) {
    console.error("Shot contract violations (UX-REDESIGN-PLAN §13.2–§13.5):\n");
    for (const violation of result.violations) {
      console.error(`  ✗ ${violation}`);
    }
    console.error(`\n${REMEDY}`);
    return 1;
  }
  console.log(formatSummary(result));
  // Ratchet advice is about the COMMITTED manifest; a fixture run is under every budget by
  // Construction and would print eight meaningless lines.
  if (manifestPath === DEFAULT_MANIFEST) {
    for (const ratchet of result.ratchets) {
      console.log(`  ratchet: ${ratchet}`);
    }
  }
  return 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
