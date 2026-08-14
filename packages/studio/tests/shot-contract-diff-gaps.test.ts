/**
 * The parts of `scripts/check-shot-contract.ts` that `shot-contract-check.test.ts` only ever
 * reaches through a SPAWNED CLI, plus the two facts no shipped input holds.
 *
 * A spawned child proves the exit code and the error string, which is what that file is for — but
 * it runs in another process, so `main()`'s three early returns and its ratchet tail are executed
 * by nothing this process can see. They are called directly here, with `console` sunk, and asserted
 * on the exact line the operator reads.
 *
 * The two facts:
 *
 * - A **union `type`** in an args schema (`canvas.setBreakpoint`'s `media` is `["string", "null"]`).
 *   No shot names one of those commands, so the union branch is unreachable from any manifest in
 *   the tree and has to be addressed through `validateArgs` directly.
 * - A **quarantined shot**. The committed manifest has none — it is the state a broken shot passes
 *   through, not one it rests in — so `readManifest`'s read-past and the summary line that admits
 *   it are exercised against hand-built manifests.
 */
import { afterEach, beforeAll, afterAll, describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";

import {
  CONTRACT_BUDGET,
  DEFAULT_MANIFEST,
  checkShotContract,
  formatSummary,
  main,
  readManifest,
  validateArgs,
} from "../../../scripts/check-shot-contract";
import type { CommandTable, ContractCounts } from "../../../scripts/check-shot-contract";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const FIXTURES = "scripts/screenshots/fixtures/contract";

/** Same hand-built projection the sibling file uses, so the pure rules never import the studio. */
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

describe("a union `type` in an args schema", () => {
  test("a value matching EITHER member passes; one matching neither names both", () => {
    // `canvas.setBreakpoint`'s `media`, verbatim.
    const schema = { properties: { media: { type: ["string", "null"] } } };
    expect(validateArgs(schema, { media: "print" })).toEqual([]);
    expect(validateArgs(schema, { media: null })).toEqual([]);
    expect(validateArgs(schema, { media: 42 })).toEqual([
      "with media 42 (number); its args schema declares string,null",
    ]);
  });

  test("a union member is read with its own rule, so `integer` still rejects a fraction", () => {
    const schema = { properties: { value: { type: ["integer", "boolean"] } } };
    expect(validateArgs(schema, { value: 3 })).toEqual([]);
    expect(validateArgs(schema, { value: true })).toEqual([]);
    expect(validateArgs(schema, { value: 3.5 })).toEqual([
      "with value 3.5 (number); its args schema declares integer,boolean",
    ]);
  });

  test("the declaring registry still names itself on a union miss", () => {
    const schema = {
      properties: { tab: { type: ["string", "null"], declaredBy: "the panel registry" } },
    };
    expect(validateArgs(schema, { tab: ["page"] })).toEqual([
      'with tab ["page"] (array); the panel registry declares string,null',
    ]);
  });
});

describe("a quarantined shot (§13.5)", () => {
  test("is counted and named, and every id under it is read past", () => {
    const facts = readManifest({
      shots: [
        {
          name: "broken-shot",
          status: { state: "quarantined" },
          unstable: { reason: "r", until: "P7" },
          steps: [
            { cmd: "no.such.command", args: { label: "xpath///sp-menu-item" } },
            { input: { hover: "#hand-stamped" }, region: "#hand-stamped" },
          ],
          capture: [{ image: "x", of: ".broken-crop" }],
        },
        { name: "live-shot", steps: [{ cmd: "view.setStatus", args: { text: "Ready" } }] },
      ],
    });
    expect(facts.quarantined).toEqual(["broken-shot"]);
    // Still a shot: it is admitted, not hidden. Only its CONTENTS are read past.
    expect(facts.shots).toBe(2);
    expect(facts.commandSteps.map((step) => step.id)).toEqual(["view.setStatus"]);
    expect(facts.regionIds).toEqual([]);
    expect(facts.counts).toMatchObject({
      argSelectors: 0,
      inputSteps: 0,
      nonDerivedRegions: 0,
      unstable: 0,
    });
  });

  test("its stale ids cost nothing, while the live shot beside it still fails", () => {
    const result = checkShotContract({
      commands: table([{ id: "file.save" }]),
      manifest: {
        shots: [
          { name: "shelved", status: { state: "quarantined" }, steps: [{ cmd: "view.gone" }] },
          { name: "live", steps: [{ cmd: "view.gone" }] },
        ],
      },
    });
    expect(result.quarantined).toEqual(["shelved"]);
    expect(result.violations).toEqual([
      'manifest shot "live" step 1 names command "view.gone"; no command registry declares it',
    ]);
  });

  test("a status that is not `quarantined` leaves the shot under the contract", () => {
    const result = checkShotContract({
      commands: table([{ id: "file.save" }]),
      manifest: {
        shots: [{ name: "flaky", status: { state: "flaky" }, steps: [{ cmd: "view.gone" }] }],
      },
    });
    expect(result.quarantined).toEqual([]);
    expect(result.violations).toEqual([
      'manifest shot "flaky" step 1 names command "view.gone"; no command registry declares it',
    ]);
  });

  test("the summary admits what it read past, and stays silent when it read past nothing", () => {
    const shelved = checkShotContract({
      commands: table(),
      manifest: {
        shots: [
          { name: "media-shot", status: { state: "quarantined" } },
          { name: "publish-shot", status: { state: "quarantined" } },
        ],
      },
    });
    expect(formatSummary(shelved)).toContain(
      "  quarantined (not checked, not captured): media-shot, publish-shot",
    );
    const clean = checkShotContract({ commands: table(), manifest: { shots: [{ name: "s" }] } });
    expect(formatSummary(clean)).not.toContain("quarantined");
  });
});

describe("main() in-process", () => {
  const out: string[] = [];
  const errors: string[] = [];
  let spies: ReturnType<typeof spyOn>[] = [];

  beforeAll(() => {
    spies = [
      spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        out.push(args.join(" "));
      }),
      spyOn(console, "error").mockImplementation((...args: unknown[]) => {
        errors.push(args.join(" "));
      }),
    ];
  });

  afterEach(() => {
    out.length = 0;
    errors.length = 0;
  });

  afterAll(() => {
    for (const spy of spies) {
      spy.mockRestore();
    }
  });

  const USAGE =
    "Usage: bun scripts/check-shot-contract.ts [--manifest <manifest.json>] " +
    "[--commands <module.ts>]…";

  test("an unknown flag prints the usage line and exits 2", async () => {
    expect(await main(["--budget", "0"])).toBe(2);
    expect(errors).toEqual([USAGE]);
    expect(out).toEqual([]);
  });

  test("a recognised flag with no value is the same usage error", async () => {
    expect(await main([`${FIXTURES}/clean.json`])).toBe(2);
    expect(errors).toEqual([USAGE]);
    expect(await main(["--commands"])).toBe(2);
    expect(errors).toEqual([USAGE, USAGE]);
  });

  test("an unloadable command module exits 2 naming the module, before the manifest is read", async () => {
    // Both arguments are bad. The message names the MODULE, which is the fact that fixes the run —
    // Reading the manifest first would report a missing file and bury it.
    const code = await main([
      "--commands",
      "packages/studio/src/commands/budget.ts",
      "--manifest",
      `${FIXTURES}/nope.json`,
    ]);
    expect(code).toBe(2);
    expect(errors).toEqual([
      "packages/studio/src/commands/budget.ts exports none of defaultCommandSet(), seedIds() or " +
        "AUTOMATION_COMMANDS",
    ]);
  });

  test("an unreadable manifest exits 2 naming the path as it was GIVEN", async () => {
    const code = await main([
      "--manifest",
      `${FIXTURES}/nope.json`,
      "--commands",
      `${FIXTURES}/commands.ts`,
    ]);
    expect(code).toBe(2);
    expect(errors).toHaveLength(1);
    // Repo-relative, not the absolute path it resolved to: the operator retypes what they read.
    expect(errors[0]).toStartWith(`Cannot read ${FIXTURES}/nope.json: `);
    expect(out).toEqual([]);
  });
});

describe("the ratchet tail", () => {
  const out: string[] = [];
  let log: ReturnType<typeof spyOn> | undefined;

  beforeAll(() => {
    log = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      out.push(...args.join(" ").split("\n"));
    });
  });

  afterEach(() => {
    out.length = 0;
  });

  afterAll(() => {
    log?.mockRestore();
  });

  /** Every counter §13.3 still budgets above zero, in CONTRACT_BUDGET's canonical order. */
  const budgeted = (Object.keys(CONTRACT_BUDGET) as (keyof ContractCounts)[]).filter(
    (key) => CONTRACT_BUDGET[key] > 0,
  );

  test("a COMMITTED manifest under budget prints one ratchet line per counter", async () => {
    // The shipped manifest sits exactly ON every budget, so the advice it would print is empty by
    // Construction. Reading an under-budget document from the committed path is the only way to see
    // The line an author is meant to act on — the counters themselves are read from the budget, so
    // This stays true the next time one of them is lowered.
    const onDisk = join(REPO_ROOT, DEFAULT_MANIFEST);
    const realFile = Bun.file;
    const file = spyOn(Bun, "file").mockImplementation(((path: unknown, options?: unknown) =>
      path === onDisk
        ? { json: () => Promise.resolve({ contract: 1, shots: [] }) }
        : (realFile as (a: unknown, b?: unknown) => unknown)(
            path,
            options,
          )) as unknown as typeof Bun.file);
    let code: number;
    try {
      code = await main(["--manifest", DEFAULT_MANIFEST, "--commands", `${FIXTURES}/commands.ts`]);
    } finally {
      file.mockRestore();
    }
    expect(code).toBe(0);
    expect(out.filter((line) => line.startsWith("  ratchet: "))).toEqual(
      budgeted.map(
        (key) => `  ratchet: ${key} is now 0 (committed ${CONTRACT_BUDGET[key]}) — lower it`,
      ),
    );
  });

  test("a fixture run is under every budget by construction and stays quiet", async () => {
    const code = await main([
      "--manifest",
      `${FIXTURES}/clean.json`,
      "--commands",
      `${FIXTURES}/commands.ts`,
    ]);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("shot-contract OK:");
    expect(budgeted.length).toBeGreaterThan(0);
    expect(out.filter((line) => line.startsWith("  ratchet: "))).toEqual([]);
  });
});
