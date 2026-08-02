/**
 * Lane 1 of the screenshot gate: `bun scripts/check-shot-contract.ts` (UX-REDESIGN-PLAN §13.5).
 *
 * Two halves, deliberately:
 *
 * - The pure rules are imported and tested against hand-built inputs, because a test asserting "the
 *   repo has exactly 58 run steps" would go red on every unrelated PR that adds a shot.
 * - The CLI is SPAWNED against the fixtures in `scripts/screenshots/fixtures/contract/`, because the
 *   exit code and the exact error string ARE the contract — a check that reports a violation and
 *   exits 0 is worse than no check, and a check whose message does not name both sides of the break
 *   sends the renamer digging instead of editing.
 *
 * The one assertion made against the live tree is that the shipped manifest passes; the numbers
 * live in `CONTRACT_BUDGET`, so this file never has to be edited when a shot is added.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  CONTRACT_BUDGET,
  CONTRACT_VERSION,
  DEFAULT_COMMAND_SOURCES,
  TOGGLE_DEBT,
  checkShotContract,
  editDistance,
  formatSummary,
  isDerivedRegionId,
  isToggleId,
  loadCommandTable,
  looksLikeSelector,
  main,
  nearestId,
  readManifest,
  setterFor,
  suggestFor,
  validateArgs,
} from "../../../scripts/check-shot-contract";
import type { CommandTable, ContractCounts } from "../../../scripts/check-shot-contract";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const FIXTURES = "scripts/screenshots/fixtures/contract";

async function runCheck(args: string[]) {
  const proc = Bun.spawn([process.execPath, join("scripts", "check-shot-contract.ts"), ...args], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stderr, stdout };
}

/** A projection built by hand, so the pure rules are tested without importing the studio. */
function table(entries: { id: string; args?: object; scriptable?: boolean }[] = []): CommandTable {
  return new Map(
    entries.map((entry) => [
      entry.id,
      {
        id: entry.id,
        scriptable: entry.scriptable !== false,
        source: "fixture",
        ...(entry.args ? { args: entry.args } : {}),
      },
    ]),
  );
}

const ZERO_BUDGET: ContractCounts = {
  argSelectors: 0,
  clipSelectors: 0,
  inputSteps: 0,
  nonDerivedRegions: 0,
  regionSelectors: 0,
  selectorActions: 0,
  unstable: 0,
  waitForSelectors: 0,
};

describe("the toggle rule (§13.3 clause 3)", () => {
  test("matches a delta id and not an idempotent one", () => {
    expect(isToggleId("view.toggleAssistant")).toBe(true);
    expect(isToggleId("canvas.togglePreview")).toBe(true);
    expect(isToggleId("view.setAssistant")).toBe(false);
    // Lowercase after `toggle` is a word, not a verb+Noun — `toggler.setX` must not trip.
    expect(isToggleId("toggler.setX")).toBe(false);
  });

  test("names the setter the registry should have declared instead", () => {
    expect(setterFor("view.toggleAssistant")).toBe("view.setAssistant");
    expect(setterFor("canvas.togglePreview")).toBe("canvas.setPreview");
  });

  test("an unlisted toggle id is a hard error even when the registry declares it", () => {
    const result = checkShotContract({
      commands: table([{ id: "view.toggleZen" }]),
      manifest: { shots: [{ name: "s", actions: [{ do: "run", id: "view.toggleZen" }] }] },
    });
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain('declare "view.setZen"');
  });

  test("a listed toggle id passes at its committed count and fails above it", () => {
    const manifest = (count: number) => ({
      shots: [
        {
          name: "s",
          actions: Array.from({ length: count }, () => ({
            do: "run",
            id: "canvas.togglePreview",
          })),
        },
      ],
    });
    const commands = table([{ id: "canvas.togglePreview" }]);
    const debt = { "canvas.togglePreview": 2 };
    expect(
      checkShotContract({ commands, manifest: manifest(2), toggleDebt: debt }).violations,
    ).toEqual([]);
    const over = checkShotContract({ commands, manifest: manifest(3), toggleDebt: debt });
    expect(over.violations[0]).toBe(
      'manifest names "canvas.togglePreview" in 3 step(s); the committed toggle debt is 2 and ' +
        'may only shrink — replace it with "canvas.setPreview"',
    );
  });

  test("a debt entry that has fallen reports a ratchet rather than a violation", () => {
    const result = checkShotContract({
      commands: table([{ id: "canvas.togglePreview" }]),
      manifest: { shots: [] },
      toggleDebt: { "canvas.togglePreview": 2 },
    });
    expect(result.violations).toEqual([]);
    expect(result.ratchets).toContain(
      'toggle debt "canvas.togglePreview" is now 0 (committed 2) — lower it',
    );
  });
});

describe("unknown ids", () => {
  test("names the nearest declared id, preferring the same namespace", () => {
    const known = ["view.setActivity", "view.setAssistant", "file.setActivity"];
    expect(nearestId("view.setActivty", known)).toBe("view.setActivity");
    expect(nearestId("view.setAsistant", known)).toBe("view.setAssistant");
    // Nothing within the distance budget: better silent than misleading.
    expect(nearestId("library.open", known)).toBeUndefined();
    expect(nearestId("anything", [])).toBeUndefined();
  });

  test("editDistance is symmetric and zero on equal strings", () => {
    expect(editDistance("abc", "abc")).toBe(0);
    expect(editDistance("kitten", "sitting")).toBe(3);
    expect(editDistance("", "abc")).toBe(3);
    expect(editDistance("abc", "")).toBe(3);
  });

  test("suggestFor names the nearest id, else what the namespace does declare", () => {
    const known = ["view.showPanel", "view.setStatus", "view.setTheme", "file.save"];
    expect(suggestFor("view.setStatu", known)).toBe(' — nearest declared id is "view.setStatus"');
    // A rename is not a typo — `view.setActivity` → `view.showPanel` is nine edits apart, so the
    // Namespace listing is the only thing that names the other side of the break.
    expect(suggestFor("view.setActivity", known)).toBe(
      ' — "view." declares "view.setStatus" | "view.setTheme" | "view.showPanel"',
    );
    expect(suggestFor("library.open", known)).toBe("");
    expect(suggestFor("bare", known)).toBe("");
  });

  test("suggestFor reads a Map iterator once — reading it twice reads it empty", () => {
    const keys = new Map([
      ["view.showPanel", 1],
      ["view.setStatus", 1],
    ]).keys();
    expect(suggestFor("view.setActivity", keys)).toContain("view.showPanel");
  });

  test("a long namespace is truncated rather than printed as a wall", () => {
    const known = Array.from({ length: 11 }, (_unused, index) => `view.command${index}`);
    const suggestion = suggestFor("view.gone", known);
    expect(suggestion).toContain("+3 more");
    expect(suggestion.split(" | ")).toHaveLength(8);
  });

  test("an id the projection refuses fails separately from an id it does not know", () => {
    const result = checkShotContract({
      commands: table([{ id: "view.setStatus", scriptable: false }]),
      manifest: { shots: [{ name: "s", actions: [{ do: "run", id: "view.setStatus" }] }] },
    });
    expect(result.violations[0]).toBe(
      'manifest shot "s" step 1 names command "view.setStatus"; fixture declares it unscriptable',
    );
  });
});

describe("args schemas", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["tab"],
    properties: {
      tab: { type: "string", enum: ["page", "layers"], declaredBy: "the panel registry" },
      zoom: { type: "number" },
      mode: { const: "design" },
      open: { type: "boolean" },
    },
  };

  test("accepts a conforming record", () => {
    expect(validateArgs(schema, { tab: "page", zoom: 1, mode: "design", open: true })).toEqual([]);
  });

  test("names the declaring registry on an enum miss", () => {
    expect(validateArgs(schema, { tab: "head" })).toEqual([
      'with tab "head"; the panel registry declares "page" | "layers"',
    ]);
  });

  test("reports a missing required property, a wrong type, a bad const and an unknown key", () => {
    expect(validateArgs(schema, {})).toEqual(['with no "tab"; its args schema requires one']);
    expect(validateArgs(schema, { tab: "page", zoom: "1.5" })).toEqual([
      'with zoom "1.5" (string); its args schema declares number',
    ]);
    expect(validateArgs(schema, { tab: "page", mode: "preview" })).toEqual([
      'with mode "preview"; its args schema declares "design"',
    ]);
    expect(validateArgs(schema, { tab: "page", dock: "right" })).toEqual([
      'with unknown argument "dock"; its args schema declares "tab" | "zoom" | "mode" | "open"',
    ]);
  });

  test("an open schema ignores extra keys, and a property with no schema is unchecked", () => {
    expect(validateArgs({ type: "object", properties: {} }, { anything: 1 })).toEqual([]);
    expect(validateArgs({ properties: { path: {} } }, { path: null })).toEqual([]);
  });

  test("reports types the way JSON names them", () => {
    const typed = { properties: { v: { type: "array" } } };
    expect(validateArgs(typed, { v: [] })).toEqual([]);
    expect(validateArgs(typed, { v: null })).toEqual([
      "with v null (null); its args schema declares array",
    ]);
    expect(validateArgs({ properties: { v: { type: "integer" } } }, { v: 1.5 })).toEqual([
      "with v 1.5 (number); its args schema declares integer",
    ]);
    expect(validateArgs({ properties: { v: { type: "integer" } } }, { v: 2 })).toEqual([]);
    expect(validateArgs({ additionalProperties: false, properties: {} }, { v: 1 })[0]).toContain(
      "declares none",
    );
  });
});

describe("region ids", () => {
  test("the §13.2 grammar is derived; a selector never is", () => {
    for (const id of [
      "rail",
      "pane",
      "pane.secondary",
      "dock.bottom",
      "overlay.palette",
      "navigator/panel:git",
      "inspector/tab:style",
      "inspector/field:href",
      "statusbar/selection",
      "pane.primary/tabs",
      "overlay.menu:layer-context",
    ]) {
      expect(isDerivedRegionId(id)).toBe(true);
    }
    for (const id of [
      "#tab-strip",
      ".settings-modal",
      "sp-popover[open]",
      "navigator/panel:git/commit",
      "inspector/target",
      "navigator/statements",
    ]) {
      expect(isDerivedRegionId(id)).toBe(false);
    }
  });

  test("only DISTINCT hand-stamped addresses count, so a reused crop is not double-charged", () => {
    const facts = readManifest({
      shots: [
        {
          name: "s",
          regions: [
            { name: "a", selector: ".git-panel" },
            { name: "b", selector: ".git-panel" },
            { name: "c", selector: "#chat-panel" },
          ],
          capture: [{ image: "d", of: "navigator/panel:git" }],
        },
      ],
    });
    expect(facts.counts.regionSelectors).toBe(3);
    expect(facts.counts.nonDerivedRegions).toBe(2);
  });

  test("a capture with no region address is ignored rather than counted as an empty id", () => {
    const facts = readManifest({
      shots: [
        { name: "s", capture: [{ image: "a" }, { image: "b", of: "" }, { image: "c", of: 3 }] },
      ],
    });
    expect(facts.regionIds).toEqual([]);
    expect(facts.counts.nonDerivedRegions).toBe(0);
  });
});

describe("selectors", () => {
  test("a puppeteer handler prefix is unambiguous evidence", () => {
    expect(looksLikeSelector("xpath///sp-menu-item")).toBe(true);
    expect(looksLikeSelector("pierce/.quick-search-input")).toBe(true);
    expect(looksLikeSelector("pages/index.md")).toBe(false);
  });

  test("selectors are counted wherever the schema still admits them", () => {
    const facts = readManifest({
      defaults: {
        clip: { selector: "#app" },
        waitFor: [{ type: "selector", selector: ".x" }, { type: "fonts" }],
      },
      shots: [
        {
          name: "s",
          clip: { selector: "#left-panel" },
          actions: [
            { do: "type", selector: ".quick-search-input", text: "menu" },
            { do: "run", id: "layers.contextMenu", args: { label: "xpath///div" } },
            { do: "canvasKey", key: "Enter" },
          ],
          waitFor: [{ type: "selector", selector: ".y" }],
          regions: [{ name: "r", selector: ".tab-strip-dirty" }],
          variants: [
            {
              suffix: "v",
              actions: [{ do: "hover", selector: ".z" }],
              waitFor: [{ type: "selector", selector: ".w" }],
            },
          ],
        },
      ],
    });
    expect(facts.counts).toMatchObject({
      argSelectors: 1,
      clipSelectors: 2,
      inputSteps: 3,
      regionSelectors: 1,
      selectorActions: 2,
      waitForSelectors: 3,
    });
  });

  test("a budget that is exceeded fails, and one that is undershot only advises", () => {
    const manifest = {
      shots: [{ name: "s", actions: [{ do: "click", selector: ".a" }] }],
    };
    const over = checkShotContract({ budget: ZERO_BUDGET, commands: table(), manifest });
    // Canonical CONTRACT_BUDGET order, not the caller's key order.
    expect(over.violations).toEqual([
      "manifest holds 1 selectorActions (committed budget 0); the budget is a ratchet and may " +
        "only fall — see CONTRACT_BUDGET in scripts/check-shot-contract.ts",
      "manifest holds 1 inputSteps (committed budget 0); the budget is a ratchet and may " +
        "only fall — see CONTRACT_BUDGET in scripts/check-shot-contract.ts",
    ]);
    const under = checkShotContract({
      budget: { ...ZERO_BUDGET, inputSteps: 4, selectorActions: 2 },
      commands: table(),
      manifest,
      toggleDebt: {},
    });
    expect(under.violations).toEqual([]);
    expect(under.ratchets).toEqual([
      "selectorActions is now 1 (committed 2) — lower it",
      "inputSteps is now 1 (committed 4) — lower it",
    ]);
  });
});

describe("the contract-1 bespoke verbs (§13.6's codemod, applied at read time)", () => {
  test("a `value` verb is read as the command and argument the codemod will write", () => {
    const facts = readManifest({
      shots: [
        {
          name: "s",
          actions: [
            { do: "setActivity", value: "head" },
            { do: "setCanvasMode", value: "design" },
            { do: "setZoom", value: 1.5 },
            { do: "setRightTab", value: "style" },
            { do: "setStatus", value: "Ready" },
            { do: "setTheme", value: "dark" },
            // No `value` at all: the step is still addressed, with empty args.
            { do: "setActivity" },
          ],
        },
      ],
    });
    expect(facts.commandSteps.map((step) => [step.id, step.args])).toEqual([
      ["view.setActivity", { tab: "head" }],
      ["canvas.setMode", { mode: "design" }],
      ["canvas.setZoom", { zoom: 1.5 }],
      ["view.setRightTab", { tab: "style" }],
      ["view.setStatus", { text: "Ready" }],
      ["view.setTheme", { color: "dark" }],
      ["view.setActivity", {}],
    ]);
  });

  test("a verb with named fields passes them through, minus `do`", () => {
    const facts = readManifest({
      shots: [
        {
          name: "s",
          actions: [
            { do: "openSettings", section: "contexts" },
            { do: "editFunction", path: ["children", 3], eventKey: "onClick" },
            { do: "select", path: null },
            { do: "openBrowse" },
            // Not a command verb: raw input and sleeps stay out of the command list.
            { do: "wait", ms: 400 },
            { do: "canvasKey", key: "Enter" },
          ],
        },
      ],
    });
    expect(facts.commandSteps.map((step) => [step.id, step.args])).toEqual([
      ["settings.open", { section: "contexts" }],
      ["formula.editEvent", { path: ["children", 3], eventKey: "onClick" }],
      ["selection.set", { path: null }],
      ["project.browse", {}],
    ]);
  });

  test("§13.7's claim holds: a panel rename fails on the `setActivity` steps that name it", () => {
    const result = checkShotContract({
      commands: table([
        {
          id: "view.setActivity",
          args: {
            properties: {
              tab: { enum: ["page", "layers"], declaredBy: "the panel registry" },
            },
          },
        },
      ]),
      manifest: {
        shots: [
          { name: "properties-bar", actions: [{ do: "setActivity", value: "head" }] },
          { name: "layers-panel-shot", actions: [{ do: "setActivity", value: "layers" }] },
        ],
      },
    });
    expect(result.violations).toEqual([
      'manifest shot "properties-bar" step 1 names command "view.setActivity" with tab "head"; ' +
        'the panel registry declares "page" | "layers"',
    ]);
  });
});

describe("the contract-2 shape (§13.2)", () => {
  test("`steps`/`expect`/`capture`/`seed`/`unstable` read without a rewrite", () => {
    const facts = readManifest({
      contract: 1,
      shots: [
        {
          name: "git-panel",
          steps: [
            { cmd: "view.showPanel", args: { panel: "git" } },
            { seed: "git.status", args: { fixture: "dirty-3" } },
            { input: { hover: "navigator/panel:git" }, unstable: { reason: "r", until: "P7" } },
          ],
          expect: [{ region: "navigator/panel:git" }],
          capture: [{ image: "git-commit", of: "navigator/panel:git/commit" }],
        },
      ],
    });
    expect(facts.commandSteps).toHaveLength(1);
    expect(facts.seedSteps[0]).toMatchObject({
      at: 'manifest shot "git-panel" step 2',
      id: "git.status",
    });
    expect(facts.counts.inputSteps).toBe(1);
    expect(facts.counts.unstable).toBe(1);
    expect(facts.counts.nonDerivedRegions).toBe(1);
  });

  test("an unknown seed id names the registry entry it wanted", () => {
    const result = checkShotContract({
      commands: table([{ id: "seed.git" }]),
      manifest: { shots: [{ name: "s", steps: [{ seed: "publish" }, { seed: "seed.git" }] }] },
    });
    expect(result.violations).toEqual([
      'manifest shot "s" step 1 seeds "publish"; no seed registry declares "seed.publish"',
    ]);
  });

  test("a contract bump fails until this file implements it", () => {
    const result = checkShotContract({ commands: table(), manifest: { contract: 2, shots: [] } });
    expect(result.violations[0]).toBe(
      `manifest declares contract 2; scripts/check-shot-contract.ts implements ${CONTRACT_VERSION}`,
    );
  });

  test("a malformed manifest degrades to zero facts rather than throwing", () => {
    const facts = readManifest("not a manifest");
    expect(facts.shots).toBe(0);
    expect(readManifest({ shots: [{}, "x", { name: 1, actions: "no" }] }).shots).toBe(2);
    // An unnamed shot is still addressable in the error string.
    expect(
      checkShotContract({
        commands: table(),
        manifest: { shots: [{ actions: [{ do: "run", id: "x.y" }] }] },
      }).violations[0],
    ).toContain('manifest shot "#1" step 1');
  });
});

describe("formatSummary", () => {
  test("prints the budget line, and the toggle debt only while it exists", () => {
    const withDebt = checkShotContract({
      commands: table([{ id: "canvas.togglePreview" }]),
      manifest: { shots: [{ name: "s", actions: [{ do: "run", id: "canvas.togglePreview" }] }] },
    });
    const printed = formatSummary(withDebt);
    expect(printed).toContain("shot-contract OK: 1 shot(s), 1 command step(s) over 1 id(s).");
    expect(printed).toContain(`nonDerivedRegions 0/${CONTRACT_BUDGET.nonDerivedRegions}`);
    expect(printed).toContain("toggle debt: 1 step(s)");
    const clean = checkShotContract({ commands: table(), manifest: { shots: [] } });
    expect(formatSummary(clean)).not.toContain("toggle debt");
  });
});

describe("loadCommandTable", () => {
  test("folds the fixture module into a table with its schemas", async () => {
    const loaded = await loadCommandTable([`${FIXTURES}/commands.ts`]);
    expect(loaded.get("view.setActivity")?.args).toBeDefined();
    expect(loaded.get("view.setStatus")?.scriptable).toBe(false);
    expect(loaded.get("seed.git")?.source).toBe(`${FIXTURES}/commands.ts`);
  });

  test("the shipped projection is the registry, the seeds and the AUTOMATION_COMMANDS shim", async () => {
    const loaded = await loadCommandTable(DEFAULT_COMMAND_SOURCES);
    // The registry composes every module's records, so `view.setActivity` comes from the FIRST
    // Source with its `args` schema — the shim's bare id no longer shadows a schema-carrying record.
    expect(loaded.get("file.save")?.source).toBe(DEFAULT_COMMAND_SOURCES[0]);
    expect(loaded.get("view.setActivity")?.source).toBe(DEFAULT_COMMAND_SOURCES[0]);
    expect(loaded.get("view.setActivity")?.args).toBeDefined();
    // Seeds are read off `createSeeds()` itself, which is how `seed.git` and `seed.projectList`
    // Resolve at all: neither was ever listed in the hand-kept shim table.
    expect(loaded.get("seed.projectList")?.source).toBe(DEFAULT_COMMAND_SOURCES[1]);
    expect(loaded.get("seed.git")?.source).toBe(DEFAULT_COMMAND_SOURCES[1]);
    // … and the shim still contributes the ids no registry declares yet.
    expect(loaded.get("element.insertData")?.source).toBe(DEFAULT_COMMAND_SOURCES[1]);
  });

  test("a module declaring none of the three exports is an error, not an empty projection", async () => {
    let thrown: unknown;
    try {
      await loadCommandTable(["packages/studio/src/commands/budget.ts"]);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error | undefined)?.message).toBe(
      "packages/studio/src/commands/budget.ts exports none of defaultCommandSet(), seedIds() or " +
        "AUTOMATION_COMMANDS",
    );
  });
});

describe("the CLI", () => {
  test("passes on the shipped manifest and prints every committed budget", async () => {
    const result = await runCheck([]);
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("shot-contract OK:");
    for (const key of Object.keys(CONTRACT_BUDGET)) {
      expect(result.stdout).toContain(key);
    }
  });

  test("the shipped manifest names no toggle at all, and TOGGLE_DEBT is empty", async () => {
    expect(Object.keys(TOGGLE_DEBT)).toEqual([]);
    const result = await runCheck([]);
    // The debt line is printed only when a toggle survives. Its ABSENCE is the assertion: with the
    // List empty, the next `canvas.togglePreview` to appear is a hard failure rather than a tally.
    expect(result.stdout).not.toContain("toggle debt:");
  });

  test("passes on a clean fixture, and does not print ratchets for a fixture run", async () => {
    const result = await runCheck([
      "--manifest",
      `${FIXTURES}/clean.json`,
      "--commands",
      `${FIXTURES}/commands.ts`,
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("2 shot(s), 5 command step(s) over 5 id(s)");
    expect(result.stdout).not.toContain("ratchet:");
  });

  test("a renamed panel exits 1 with the message §13.5 specifies, verbatim", async () => {
    const result = await runCheck([
      "--manifest",
      `${FIXTURES}/renamed-panel.json`,
      "--commands",
      `${FIXTURES}/commands.ts`,
    ]);
    expect(result.exitCode).toBe(1);
    // Step 3 is a bespoke `setActivity` verb (46 of them in the shipped manifest) and step 4 the
    // `run` form; both must read as the same sentence, because a renamer should not have to know
    // Which spelling a shot happened to use.
    expect(result.stderr).toContain(
      'manifest shot "properties-bar" step 3 names command "view.setActivity" with tab "head"; ' +
        'the panel registry declares "page"',
    );
    expect(result.stderr).toContain(
      'manifest shot "properties-bar" step 4 names command "view.setActivity" with tab "blocks"; ' +
        'the panel registry declares "page"',
    );
    expect(result.stderr).toContain("Fix the step, not the check");
  });

  test("stale ids, a new toggle, a refused id and bad args all fail in one run", async () => {
    const result = await runCheck([
      "--manifest",
      `${FIXTURES}/stale-ids.json`,
      "--commands",
      `${FIXTURES}/commands.ts`,
    ]);
    expect(result.exitCode).toBe(1);
    const lines = result.stderr
      .split("\n")
      .filter((line) => line.startsWith("  ✗ "))
      .map((line) => line.slice(4));
    expect(lines).toEqual([
      'manifest shot "quick-access" step 1 names command "view.setActivty"; no command registry ' +
        'declares it — nearest declared id is "view.setActivity"',
      'manifest shot "quick-access" step 2 names command "view.toggleAssistant"; a toggle names ' +
        'a delta against unstated state (§13.3 clause 3) — declare "view.setAssistant" and ' +
        "name the value the step ends in",
      'manifest shot "quick-access" step 3 names command "view.setStatus"; ' +
        `${FIXTURES}/commands.ts declares it unscriptable`,
      'manifest shot "quick-access" step 4 names command "canvas.setZoom" with zoom "1.5" ' +
        "(string); its args schema declares number",
      'manifest shot "quick-access" step 5 names command "view.setAssistant" with unknown ' +
        'argument "dock"; its args schema declares "open"',
      'manifest shot "quick-access" step 6 names command "file.open" with no "path"; its args ' +
        "schema requires one",
      'manifest shot "quick-access" variant "cleanup" step 1 names command "project.browse"; no ' +
        "command registry declares it",
      'manifest shot "quick-access" variant "cleanup" step 2 seeds "publish"; no seed registry ' +
        'declares "seed.publish"',
    ]);
  });

  test("an unreadable manifest and an unloadable command module are usage errors", async () => {
    const missing = await runCheck(["--manifest", `${FIXTURES}/nope.json`]);
    expect(missing.exitCode).toBe(2);
    expect(missing.stderr).toContain("Cannot read");
    const bad = await runCheck(["--commands", "packages/studio/src/commands/budget.ts"]);
    expect(bad.exitCode).toBe(2);
    expect(bad.stderr).toContain("exports none of defaultCommandSet(), seedIds() or");
  });

  test("an unknown flag, or a flag with no value, is a usage error", async () => {
    for (const args of [["--manifest"], ["--commands"], ["--budget", "0"], ["oops"]]) {
      const result = await runCheck(args);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("Usage: bun scripts/check-shot-contract.ts");
    }
  });

  test("main() returns an exit code and resolves paths against the repo root, not cwd", async () => {
    // This test's cwd is packages/studio; the same repo-relative arguments must still resolve.
    expect(process.cwd()).not.toBe(REPO_ROOT);
    const args = ["--manifest", `${FIXTURES}/clean.json`, "--commands", `${FIXTURES}/commands.ts`];
    expect(await main(args)).toBe(0);
    expect(await main([...args.slice(0, 2), "--commands", `${FIXTURES}/commands.ts`])).toBe(0);
    expect(
      await main([
        "--manifest",
        `${FIXTURES}/renamed-panel.json`,
        "--commands",
        `${FIXTURES}/commands.ts`,
      ]),
    ).toBe(1);
  });
});
