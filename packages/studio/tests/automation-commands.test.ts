/**
 * The seed registry under the **Remote Rule**, the probe, and the manifest's side of the contract.
 *
 * > A seed may only write state whose real writer is a network or IPC boundary. It stands in for a
 * > remote, never for a user.
 *
 * That rule is what deletes `setStatus`, `setActivity`, `setRightTab`, `setZoom`, `select` and
 * `openSettings` from this surface: a user does all six, so a COMMAND does all six.
 */
import { resetWorkspaceWithTab } from "./harness";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { resolve } from "node:path";
import { createCommandRegistry } from "../src/commands/registry";
import { makeContext } from "../src/commands/context";
import type { AutomationDeps } from "../src/services/automation";

void mock.module("../src/panels/stylebook-panel", () => ({
  renderComponentPreview: async () => document.createElement("div"),
  renderStylebookMode: () => {},
  selectStylebookTag: () => {},
}));

const { AUTOMATION_COMMANDS, AutomationRefusedError, REFUSED_SEEDS, createAutomationApi, seedIds } =
  await import("../src/services/automation");
// The WHOLE app's set, not `commands/defaults`' sixteen: the manifest addresses records that live
// Beside the state they write, and checking against the smaller set is what let a shot name an id
// No registry declared and still pass here.
const { defaultCommandSet } = await import("../src/commands/app-commands");
const { shell } = await import("../src/shell");
const { closeAllTabs } = await import("../src/workspace/workspace");
const { getProjectList } = await import("../src/project-list");

function makeDeps(): AutomationDeps & {
  seedAssistantMessages: ReturnType<typeof mock>;
  seedPublishConnected: ReturnType<typeof mock>;
} {
  const registry = createCommandRegistry({ getContext: () => makeContext() });
  return {
    registry,
    seedAssistantMessages: mock(() => {}),
    seedPublishConnected: mock(() => {}),
  };
}

/** The rejection reason, as a value. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  return (await promise.catch((error: unknown) => error)) as Error;
}

const DEPLOYMENT = {
  createdOn: "2026-07-01T00:00:00Z",
  environment: "production",
  id: "d1",
  stage: "deploy",
  status: "success",
  url: "https://demo.pages.dev",
};

beforeEach(() => {
  closeAllTabs();
  resetWorkspaceWithTab();
});

describe("the seed registry", () => {
  test("declares exactly the five boundaries §13.5 admits", () => {
    const seeds = createAutomationApi(makeDeps()).probe.seeds();
    expect(seeds.map((seed) => seed.id)).toEqual([
      "seed.assistant",
      "seed.collab",
      "seed.publish",
      "seed.git",
      "seed.projectList",
    ]);
    // Each names the remote it stands in for — that IS the rule, written per seed.
    for (const seed of seeds) {
      expect(seed.boundary.length, seed.id).toBeGreaterThan(0);
    }
  });

  test("seedIds() is the same list, without an app to build it against", () => {
    // Lane 1 runs in a bare Bun process and has to answer "is `seed.projectList` real?". Reading
    // The definitions themselves is why it can: the hand-kept shim table never listed `seed.git`
    // Or `seed.projectList`, and a manifest naming either failed against a stale map.
    expect(seedIds()).toEqual(
      createAutomationApi(makeDeps())
        .probe.seeds()
        .map((s) => s.id),
    );
  });

  test("seed.assistant hands the canned transcript to the model-stream sink", async () => {
    const deps = makeDeps();
    const messages = [{ content: "hello", role: "user" }];
    await createAutomationApi(deps).seed("seed.assistant", { messages });
    expect(deps.seedAssistantMessages).toHaveBeenCalledWith(messages);
    // A seed with no argument stages the empty remote, not `undefined`.
    await createAutomationApi(deps).seed("seed.assistant");
    expect(deps.seedAssistantMessages).toHaveBeenLastCalledWith([]);
  });

  test("seed.collab stages a synced session, defaulting each peer's focused document", async () => {
    const { collabState } = await import("../src/collab/collab-state");
    const tab = resetWorkspaceWithTab(undefined, { documentPath: "pages/index.md" });
    await createAutomationApi(makeDeps()).seed("seed.collab", {
      peers: [
        {
          clientId: 7,
          state: {
            focusedPath: null,
            structuralSelection: ["children", 0],
            user: { color: "#30a46c", login: "maya" },
          },
        },
        {
          clientId: 8,
          state: { focusedPath: "pages/about.md", user: { color: "#f5a524", login: "jon" } },
        },
      ],
    });
    const state = collabState(tab);
    expect(state.status).toBe("synced");
    expect(state.active).toBe(true);
    expect(state.peers[0]!.state.focusedPath).toBe("pages/index.md");
    expect(state.peers[1]!.state.focusedPath).toBe("pages/about.md");
  });

  test("seed.collab with no tab is a no-op rather than a crash", async () => {
    closeAllTabs();
    await createAutomationApi(makeDeps()).seed("seed.collab", { peers: [] });
  });

  test("seed.publish hands the canned deployment to the Pages sink", async () => {
    const deps = makeDeps();
    await createAutomationApi(deps).seed("seed.publish", {
      accountId: "acct-1",
      deployment: DEPLOYMENT,
    });
    expect(deps.seedPublishConnected).toHaveBeenCalledWith({
      accountId: "acct-1",
      deployment: DEPLOYMENT,
    });
    await createAutomationApi(deps).seed("seed.publish", { deployment: DEPLOYMENT });
    expect(deps.seedPublishConnected).toHaveBeenLastCalledWith({ deployment: DEPLOYMENT });
  });

  test("seed.git replaces the working tree the git panel reads", async () => {
    // The git-panel shot photographs whatever the author had dirty, because its project lives
    // Inside this repository. The working tree really is a remote here.
    const status = { ahead: 0, behind: 0, branch: "main", files: [], isRepo: true };
    const branches = { current: "main", list: ["main"] };
    shell.git.error = "stale";
    shell.git.loading = true;
    await createAutomationApi(makeDeps()).seed("seed.git", {
      branches,
      log: [{ author: "Ada", date: "2026-01-01", hash: "abc1234", message: "Init" }],
      status,
    });
    expect(shell.git.status?.branch).toBe("main");
    expect(shell.git.status?.isRepo).toBe(true);
    expect(shell.git.branches?.current).toBe("main");
    expect(shell.git.logEntries).toHaveLength(1);
    expect(shell.git.logEntries?.[0]?.hash).toBe("abc1234");
    expect(shell.git.loading).toBe(false);
    expect(shell.git.error).toBeNull();
  });

  test("seed.git with no arguments clears the tree rather than half-writing it", async () => {
    await createAutomationApi(makeDeps()).seed("seed.git", {});
    expect(shell.git.status).toBeNull();
    expect(shell.git.branches).toBeNull();
    expect(shell.git.logEntries).toBeNull();
  });

  test("seed.projectList replaces the catalogue, so no capture leaks a local path", async () => {
    await createAutomationApi(makeDeps()).seed("seed.projectList", {
      projects: [{ name: "demo", root: "/tmp/demo" }],
    });
    expect(getProjectList().map((entry) => entry.name)).toEqual(["demo"]);
  });

  test("a bare id resolves to its `seed.` form", async () => {
    const deps = makeDeps();
    await createAutomationApi(deps).seed("assistant", { messages: [] });
    expect(deps.seedAssistantMessages).toHaveBeenCalledTimes(1);
  });

  test("an unknown seed names the declared ones instead of no-opping", async () => {
    const error = await rejection(createAutomationApi(makeDeps()).seed("seed.nope"));
    expect(error.message).toContain('unknown seed "seed.nope"');
    expect(error.message).toContain("seed.assistant");
  });

  test("a mistyped argument fails the caller loudly", async () => {
    const api = createAutomationApi(makeDeps());
    const badMessages = await rejection(api.seed("seed.assistant", { messages: "hi" }));
    expect(badMessages.message).toContain('"messages" must be an array');
    const badDeployment = await rejection(api.seed("seed.publish", { deployment: 7 }));
    expect(badDeployment.message).toContain('"deployment" must be an object');
    const badAccount = await rejection(
      api.seed("seed.publish", { accountId: 7, deployment: DEPLOYMENT }),
    );
    expect(badAccount.message).toContain('"accountId" must be a string');
  });
});

describe("the Remote Rule's refusals", () => {
  test("every write a USER makes is refused, and the command is named in the refusal", async () => {
    const api = createAutomationApi(makeDeps());
    expect(Object.keys(REFUSED_SEEDS).toSorted()).toEqual([
      "openSettings",
      "select",
      "setActivity",
      "setRightTab",
      "setStatus",
      "setZoom",
    ]);
    for (const id of Object.keys(REFUSED_SEEDS)) {
      const error = await rejection(api.seed(id));
      expect(error, id).toBeInstanceOf(AutomationRefusedError);
      expect(error.message, id).toContain("stands in for a remote, never for a user");
    }
  });

  test("prefixing the refused id with `seed.` does not get around it", async () => {
    const error = await rejection(createAutomationApi(makeDeps()).seed("seed.setStatus"));
    expect(error).toBeInstanceOf(AutomationRefusedError);
    expect(error.message).toContain("the one lie");
  });
});

describe("probe", () => {
  test("idle resolves against a quiet, canvas-less page", async () => {
    await createAutomationApi(makeDeps()).probe.idle({ timeoutMs: 2000 });
  });

  test("pointAt and revealPath answer null when no canvas can measure the path", async () => {
    const { probe } = createAutomationApi(makeDeps());
    const point = await probe.pointAt({ path: ["children", 0] });
    expect(point).toBeNull();
    const revealed = await probe.revealPath(["children", 0]);
    expect(revealed).toBeNull();
  });
});

describe("the screenshot manifest", () => {
  const manifestPath = resolve(import.meta.dir, "../../../scripts/screenshots/manifest.json");

  interface Step {
    cmd?: string;
    seed?: string;
    input?: string;
    region?: string;
    selector?: string;
  }

  /**
   * Every step of every LIVE shot.
   *
   * Quarantined shots are read past, exactly as Lane 1 and the runner do: a quarantined shot is one
   * the repo admits is broken, and `repeat-dialog` names `selection.repeat` on purpose — the record
   * P5 has to land. Checking it here would only mean the fix has to be made twice.
   */
  async function steps(): Promise<Step[]> {
    const manifest = (await Bun.file(manifestPath).json()) as {
      shots: {
        status?: { state?: string };
        steps?: Step[];
        then?: { steps?: Step[] }[];
      }[];
    };
    const all: Step[] = [];
    for (const shot of manifest.shots) {
      if (shot.status?.state === "quarantined") {
        continue;
      }
      all.push(...(shot.steps ?? []));
      for (const segment of shot.then ?? []) {
        all.push(...(segment.steps ?? []));
      }
    }
    return all;
  }

  test("addresses the shell by command id and region id, never by selector", async () => {
    const all = await steps();
    expect(all.filter((step) => step.selector !== undefined)).toEqual([]);
  });

  test("every command id it names is one the registry declares", async () => {
    // Lane 1 (`scripts/check-shot-contract.ts`) enforces the same union in CI; this is the same
    // Assertion in the workspace's own suite, so a rename fails here first.
    const declared = new Set(defaultCommandSet().map((command) => command.id));
    const all = await steps();
    const commands = all.filter((step) => step.cmd !== undefined);
    expect(commands.length).toBeGreaterThan(0);
    for (const step of commands) {
      expect(declared.has(step.cmd!), `manifest names undeclared id "${step.cmd}"`).toBe(true);
    }
  });

  test("every seed it names is one createSeeds() declares", async () => {
    const declared = new Set(seedIds());
    const all = await steps();
    const seeds = all.filter((step) => step.seed !== undefined);
    expect(seeds.length).toBeGreaterThan(0);
    for (const step of seeds) {
      expect(declared.has(step.seed!), `manifest names undeclared seed "${step.seed}"`).toBe(true);
    }
  });

  test("the gap countdown holds only ids no registry declares, and may only shrink", async () => {
    // The idiom is the checker's own `TOGGLE_DEBT`: a named debt with a number that goes one way.
    // S2 took it from 39 to 8 — the seeds moved to `seedIds()`, the `toggle*` entries are refused
    // By `TOGGLE_ID` before this map is read, and every id whose record landed left.
    expect(Object.keys(AUTOMATION_COMMANDS).length).toBeLessThanOrEqual(8);
    // An entry that the registry HAS declared is a countdown that failed to count down.
    const declared = new Set(defaultCommandSet().map((command) => command.id));
    expect(Object.keys(AUTOMATION_COMMANDS).filter((id) => declared.has(id))).toEqual([]);
    // And no `command` gap is a mystery: the manifest reaches each through an `unstable` step whose
    // `reason` names the id, which is what makes the hatch count and this map the same debt.
    const manifestText = await Bun.file(manifestPath).text();
    for (const [id, entry] of Object.entries(AUTOMATION_COMMANDS)) {
      if (entry.disposition === "command") {
        expect(manifestText, `nothing in the manifest still needs "${id}"`).toContain(id);
      }
    }
  });
});
