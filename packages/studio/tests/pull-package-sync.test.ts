/** Tests for src/packages/pull-package-sync.ts — pull orchestration with package-conflict recovery. */
import { flush, installMockPlatform } from "./harness";
import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { initLayers } from "../src/ui/layers";
import type { GitStatusResult, StudioPlatform } from "../src/types";

const applyCalls: unknown[][] = [];
let checkResult: {
  target: string;
  outdated: { name: string; current: string; dev: boolean }[];
} | null = null;

void mock.module("../src/packages/jxsuite-update", () => ({
  applyJxsuiteUpdate: async (...args: unknown[]) => {
    applyCalls.push(args);
  },
  checkJxsuiteUpdate: async () => checkResult,
  maybePromptJxsuiteUpdate: async () => {},
}));

const statusMessages: string[] = [];
void mock.module("../src/panels/statusbar", () => ({
  mountStatusbar: () => {},
  renderStatusbar: () => {},
  setStatusbarRenderer: () => {},
  statusMessage: (msg: string) => {
    statusMessages.push(msg);
  },
  unmountStatusbar: () => {},
}));

const { autoSyncProjectOnOpen, isAutomatedPackageDiff, planPackageDiscard, pullWithPackageSync } =
  await import("../src/packages/pull-package-sync");

beforeAll(() => {
  for (const id of ["layer-popover", "layer-modal", "layer-dialog"]) {
    if (!document.querySelector(`#${id}`)) {
      const el = document.createElement("div");
      el.id = id;
      document.body.append(el);
    }
  }
  initLayers();
});

beforeEach(() => {
  applyCalls.length = 0;
  statusMessages.length = 0;
  checkResult = null;
});

afterEach(() => {
  (document.querySelector("#layer-dialog") as HTMLElement).innerHTML = "";
  (document.querySelector("#layer-modal") as HTMLElement).innerHTML = "";
});

function dialog(): HTMLElement | null {
  return document.querySelector("#layer-dialog sp-dialog-wrapper");
}

function progressCard(): Element | null {
  return (document.querySelector("#layer-modal") as HTMLElement).querySelector(".progress-modal");
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const PKG_HEAD = JSON.stringify({
  dependencies: { "@jxsuite/runtime": "^0.19.0", hono: "^4.0.0" },
  name: "site",
});
const PKG_AUTOMATED = JSON.stringify({
  dependencies: { "@jxsuite/runtime": "^0.30.1", hono: "^4.0.0" },
  name: "site",
});
const PKG_MANUAL = JSON.stringify({
  dependencies: { "@jxsuite/runtime": "^0.30.1", hono: "^4.0.0", "left-pad": "^1.0.0" },
  name: "site",
});

function gitStatusOf(over: Partial<GitStatusResult> = {}): GitStatusResult {
  return {
    ahead: 0,
    behind: 0,
    branch: "main",
    files: [],
    isRepo: true,
    remotes: ["origin"],
    ...over,
  };
}

/** GitShow backed by a `ref:path` map; missing entries throw like a real `git show`. */
function showFrom(db: Record<string, string>): StudioPlatform["gitShow"] {
  return async ({ path, ref }) => {
    const content = db[`${ref ?? "HEAD"}:${path}`];
    if (content === undefined) {
      throw new Error(`fatal: path '${path}' does not exist in '${ref}'`);
    }
    return content;
  };
}

const dirtyPkgFiles = [
  { path: "package.json", status: "M" },
  { path: "bun.lock", status: "M" },
];

const conflictShowDb = {
  "@{u}:bun.lock": "lock-upstream",
  "@{u}:package.json": PKG_AUTOMATED,
  "HEAD:bun.lock": "lock-old",
  "HEAD:package.json": PKG_HEAD,
};

function callNames(state: { calls: unknown[][] }): string[] {
  return state.calls.map((c) => c[0] as string);
}

/** Await a promise that must reject; returns the rejection error. */
async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected promise to reject");
}

// ─── isAutomatedPackageDiff ──────────────────────────────────────────────────

describe("isAutomatedPackageDiff", () => {
  test("true when only @jxsuite versions changed", () => {
    expect(isAutomatedPackageDiff(PKG_HEAD, PKG_AUTOMATED)).toBe(true);
  });

  test("true for formatting/key-order-only differences", () => {
    const reordered = JSON.stringify(
      { name: "site", dependencies: { hono: "^4.0.0", "@jxsuite/runtime": "^0.19.0" } },
      null,
      2,
    );
    expect(isAutomatedPackageDiff(PKG_HEAD, reordered)).toBe(true);
  });

  test("false when a non-jxsuite version changed", () => {
    const working = JSON.stringify({
      dependencies: { "@jxsuite/runtime": "^0.30.1", hono: "^5.0.0" },
      name: "site",
    });
    expect(isAutomatedPackageDiff(PKG_HEAD, working)).toBe(false);
  });

  test("false when a dependency was added or removed", () => {
    expect(isAutomatedPackageDiff(PKG_HEAD, PKG_MANUAL)).toBe(false);
    const removed = JSON.stringify({ dependencies: { hono: "^4.0.0" }, name: "site" });
    expect(isAutomatedPackageDiff(PKG_HEAD, removed)).toBe(false);
  });

  test("false on parse failure or non-object content", () => {
    expect(isAutomatedPackageDiff("not json", PKG_AUTOMATED)).toBe(false);
    expect(isAutomatedPackageDiff(PKG_HEAD, "not json")).toBe(false);
    expect(isAutomatedPackageDiff(null, PKG_AUTOMATED)).toBe(false);
    expect(isAutomatedPackageDiff(PKG_HEAD, null)).toBe(false);
    expect(isAutomatedPackageDiff('"str"', '"str"')).toBe(false);
  });

  test("true when devDependencies differ only in @jxsuite versions", () => {
    const head = JSON.stringify({ devDependencies: { "@jxsuite/compiler": "^0.19.0" } });
    const working = JSON.stringify({ devDependencies: { "@jxsuite/compiler": "^0.30.1" } });
    expect(isAutomatedPackageDiff(head, working)).toBe(true);
  });
});

// ─── Preemptive path ─────────────────────────────────────────────────────────

describe("pullWithPackageSync — preemptive", () => {
  test("discards automated package edits before pulling and re-applies the update", async () => {
    const { state } = installMockPlatform(
      {
        gitShow: showFrom(conflictShowDb),
        gitStatus: async () => gitStatusOf({ behind: 1, files: dirtyPkgFiles }),
        setPackageVersions: async () => ({ ok: true }),
      },
      { "bun.lock": "lock-local", "package.json": PKG_AUTOMATED },
    );
    checkResult = {
      outdated: [{ current: "^0.19.0", dev: false, name: "@jxsuite/runtime" }],
      target: "0.30.1",
    };

    await pullWithPackageSync();

    // Overridden mock methods (gitStatus/gitShow) bypass the harness call log; assert on defaults.
    const names = callNames(state);
    expect(names.indexOf("gitFetch")).toBeLessThan(names.indexOf("gitUnstage"));
    expect(names.indexOf("gitUnstage")).toBeLessThan(names.indexOf("gitDiscard"));
    expect(names.indexOf("gitDiscard")).toBeLessThan(names.indexOf("gitPull"));
    const discard = state.calls.find((c) => c[0] === "gitDiscard");
    expect(discard?.[1]).toEqual(["package.json", "bun.lock"]);
    expect(applyCalls).toHaveLength(1);
    expect(dialog()).toBeNull();
    expect(statusMessages).toContain("Local package updates were superseded by pulled changes");
  });

  test("leaves files alone when upstream content matches HEAD", async () => {
    const { state } = installMockPlatform(
      {
        gitShow: showFrom({
          "@{u}:bun.lock": "lock-old",
          "@{u}:package.json": PKG_HEAD,
          "HEAD:bun.lock": "lock-old",
          "HEAD:package.json": PKG_HEAD,
        }),
        gitStatus: async () => gitStatusOf({ behind: 1, files: dirtyPkgFiles }),
      },
      { "bun.lock": "lock-local", "package.json": PKG_AUTOMATED },
    );

    await pullWithPackageSync();

    const names = callNames(state);
    expect(names).not.toContain("gitDiscard");
    expect(names.filter((n) => n === "gitPull")).toHaveLength(1);
  });

  test("plain pull when not behind — no upstream inspection", async () => {
    const { state } = installMockPlatform({
      gitStatus: async () => gitStatusOf({ files: dirtyPkgFiles }),
    });

    await pullWithPackageSync();

    const names = callNames(state);
    expect(names).not.toContain("gitShow");
    expect(names).not.toContain("gitDiscard");
    expect(names.filter((n) => n === "gitPull")).toHaveLength(1);
    expect(applyCalls).toHaveLength(0);
  });

  test("deletes an untracked lockfile that exists upstream instead of discarding", async () => {
    let installed = false;
    const { state } = installMockPlatform(
      {
        gitShow: showFrom({ "@{u}:bun.lock": "lock-upstream" }),
        gitStatus: async () =>
          gitStatusOf({ behind: 1, files: [{ path: "bun.lock", status: "??" }] }),
        installDependencies: async () => {
          installed = true;
          return { ok: true };
        },
      },
      { "bun.lock": "lock-local", "package.json": PKG_HEAD },
    );

    await pullWithPackageSync();
    await flush();

    const names = callNames(state);
    expect(names).not.toContain("gitDiscard");
    const del = state.calls.find((c) => c[0] === "deleteFile");
    expect(del?.[1]).toBe("bun.lock");
    expect(installed).toBe(true);
  });

  test("re-syncs packages even when the pull after a discard fails", async () => {
    installMockPlatform(
      {
        gitPull: async () => {
          throw new Error("network died mid-pull");
        },
        gitShow: showFrom(conflictShowDb),
        gitStatus: async () => gitStatusOf({ behind: 1, files: dirtyPkgFiles }),
        setPackageVersions: async () => ({ ok: true }),
      },
      { "bun.lock": "lock-local", "package.json": PKG_AUTOMATED },
    );
    checkResult = {
      outdated: [{ current: "^0.19.0", dev: false, name: "@jxsuite/runtime" }],
      target: "0.30.1",
    };

    const error = await rejectionOf(pullWithPackageSync());
    expect(error.message).toBe("network died mid-pull");
    expect(applyCalls).toHaveLength(1);
  });
});

// ─── Plain pull + post-pull sync ─────────────────────────────────────────────

describe("pullWithPackageSync — post-pull sync", () => {
  test("runs bun install when the pull changed package files and nothing is outdated", async () => {
    let installed = false;
    const { state } = installMockPlatform(
      {
        gitPull: async () => {
          state.files.set("package.json", PKG_AUTOMATED);
          state.files.set("bun.lock", "lock-upstream");
        },
        gitStatus: async () => gitStatusOf(),
        installDependencies: async () => {
          installed = true;
          return { ok: true };
        },
      },
      { "bun.lock": "lock-old", "package.json": PKG_HEAD },
    );

    await pullWithPackageSync();
    await flush();

    expect(installed).toBe(true);
    expect(progressCard()).toBeNull();
  });

  test("shows the install log in the progress modal when bun install fails", async () => {
    const { state } = installMockPlatform(
      {
        gitPull: async () => {
          state.files.set("bun.lock", "lock-upstream");
        },
        gitStatus: async () => gitStatusOf(),
        installDependencies: async () => ({ log: "lockfile corrupt", ok: false }),
      },
      { "bun.lock": "lock-old", "package.json": PKG_HEAD },
    );

    await pullWithPackageSync();
    await flush();

    expect(progressCard()?.textContent).toContain("lockfile corrupt");
  });
});

// ─── Reactive fallback ───────────────────────────────────────────────────────

describe("pullWithPackageSync — reactive fallback", () => {
  function reactivePlatform(opts: {
    workingPkg: string;
    postFiles?: { path: string; status: string }[];
    showDb?: Record<string, string>;
  }) {
    let statusCalls = 0;
    let pullCalls = 0;
    const result = installMockPlatform(
      {
        gitPull: async () => {
          pullCalls += 1;
          if (pullCalls === 1) {
            throw new Error("merge blocked by local changes");
          }
        },
        gitShow: showFrom(opts.showDb ?? conflictShowDb),
        gitStatus: async () => {
          statusCalls += 1;
          return statusCalls === 1
            ? gitStatusOf() // Stale pre-pull view: not behind
            : gitStatusOf({ behind: 1, files: opts.postFiles ?? dirtyPkgFiles });
        },
      },
      { "bun.lock": "lock-local", "package.json": opts.workingPkg },
    );
    return { pulls: () => pullCalls, ...result };
  }

  test("recovers silently when the conflicting edits are automated", async () => {
    const { state, pulls } = reactivePlatform({ workingPkg: PKG_AUTOMATED });

    await pullWithPackageSync();

    expect(callNames(state)).toContain("gitDiscard");
    expect(pulls()).toBe(2);
    expect(dialog()).toBeNull();
  });

  test("asks before discarding manual package.json edits — confirm recovers", async () => {
    const { state, pulls } = reactivePlatform({ workingPkg: PKG_MANUAL });

    const run = pullWithPackageSync();
    await flush();
    const d = dialog();
    expect(d).not.toBeNull();
    d?.dispatchEvent(new Event("confirm"));
    await run;

    expect(callNames(state)).toContain("gitDiscard");
    expect(pulls()).toBe(2);
  });

  test("cancel keeps local edits and surfaces the original error", async () => {
    const { state } = reactivePlatform({ workingPkg: PKG_MANUAL });

    const pending = rejectionOf(pullWithPackageSync());
    await flush();
    dialog()?.dispatchEvent(new Event("cancel"));
    const error = await pending;

    expect(error.message).toBe("merge blocked by local changes");
    expect(callNames(state)).not.toContain("gitDiscard");
  });

  test("rethrows the original error when no package files are dirty", async () => {
    const { state } = reactivePlatform({
      postFiles: [{ path: "src/app.ts", status: "M" }],
      showDb: {},
      workingPkg: PKG_HEAD,
    });

    const error = await rejectionOf(pullWithPackageSync());
    expect(error.message).toBe("merge blocked by local changes");
    expect(callNames(state)).not.toContain("gitDiscard");
  });

  test("rethrows when another dirty file also conflicts upstream", async () => {
    const { state } = reactivePlatform({
      postFiles: [...dirtyPkgFiles, { path: "src/app.ts", status: "M" }],
      showDb: {
        ...conflictShowDb,
        "@{u}:src/app.ts": "upstream code",
        "HEAD:src/app.ts": "old code",
      },
      workingPkg: PKG_AUTOMATED,
    });

    const error = await rejectionOf(pullWithPackageSync());
    expect(error.message).toBe("merge blocked by local changes");
    expect(callNames(state)).not.toContain("gitDiscard");
    expect(dialog()).toBeNull();
  });

  test("rethrows when the post-failure status check itself fails", async () => {
    let statusCalls = 0;
    installMockPlatform({
      gitPull: async () => {
        throw new Error("merge blocked by local changes");
      },
      gitStatus: async () => {
        statusCalls += 1;
        if (statusCalls > 1) {
          throw new Error("status broke");
        }
        return gitStatusOf();
      },
    });

    const error = await rejectionOf(pullWithPackageSync());
    expect(error.message).toBe("merge blocked by local changes");
  });
});

// ─── planPackageDiscard ──────────────────────────────────────────────────────

describe("planPackageDiscard", () => {
  test("marks manual package.json edits as not automated", async () => {
    installMockPlatform({ gitShow: showFrom(conflictShowDb) }, { "package.json": PKG_MANUAL });
    const plan = await planPackageDiscard(
      gitStatusOf({ behind: 1, files: [{ path: "package.json", status: "M" }] }),
    );
    expect(plan.discard).toEqual(["package.json"]);
    expect(plan.automated).toBe(false);
  });

  test("skips untracked package files that do not exist upstream", async () => {
    installMockPlatform({ gitShow: showFrom({}) }, { "bun.lock": "lock-local" });
    const plan = await planPackageDiscard(
      gitStatusOf({ behind: 1, files: [{ path: "bun.lock", status: "U" }] }),
    );
    expect(plan.discard).toEqual([]);
    expect(plan.removeUntracked).toEqual([]);
  });
});

// ─── autoSyncProjectOnOpen ───────────────────────────────────────────────────

describe("autoSyncProjectOnOpen", () => {
  test("skips when git status fails or reports no repo", async () => {
    const failing = installMockPlatform({
      gitStatus: async () => {
        throw new Error("no project open");
      },
    });
    await autoSyncProjectOnOpen();
    expect(callNames(failing.state)).not.toContain("gitPull");

    // Harness default status has no isRepo flag — treated as "not a repo".
    const bare = installMockPlatform();
    await autoSyncProjectOnOpen();
    expect(callNames(bare.state)).not.toContain("gitPull");
  });

  test("skips when the repo has no remotes", async () => {
    const { state } = installMockPlatform({
      gitStatus: async () => gitStatusOf({ remotes: [] }),
    });
    await autoSyncProjectOnOpen();
    expect(callNames(state)).not.toContain("gitPull");
  });

  test("pulls when a remote-backed repo is open", async () => {
    const { state } = installMockPlatform(
      { gitStatus: async () => gitStatusOf() },
      { "package.json": PKG_HEAD },
    );
    await autoSyncProjectOnOpen();
    expect(callNames(state)).toContain("gitPull");
    expect(statusMessages).toContain("Syncing project…");
  });

  test("swallows pull failures and reports them as a status message", async () => {
    installMockPlatform({
      gitPull: async () => {
        throw new Error("no tracking information");
      },
      gitStatus: async () => gitStatusOf(),
    });
    await autoSyncProjectOnOpen();
    expect(statusMessages.some((m) => m.startsWith("Sync skipped:"))).toBe(true);
  });
});
