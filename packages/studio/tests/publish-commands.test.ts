/**
 * `Publish:` family tests — the three records' gates, and `runDeploy` as an Activity.
 *
 * Two things are asserted that are easy to get wrong and invisible when they are:
 *
 * - A deploy failure raises exactly ONE report, from `activity.fail`, and the caller does not also
 *   notify (§16 — a Problem and a toast for one failure is the double-reporting the tier system
 *   exists to prevent);
 * - The activity ENDS in every branch, including the one where Cloudflare answers nothing. A running
 *   activity is an idle blocker (`services/idle.ts`), so an operation that forgets to finish hangs
 *   `probe.idle()` and every screenshot after it.
 */
import { flush, installMockPlatform, resetStudioState } from "./harness";
import { beforeEach, describe, expect, test } from "bun:test";

const { activities, resetActivities } = await import("../src/panels/activity-panel");
const { problems, resetNotifications, toasts } = await import("../src/services/notify");
const { forgetDeployment, observedDeployment } = await import("../src/publish/deploy-checklist");
const { setProjectState } = await import("../src/store");
const { dashboardUrl, publishCommands, registerPublishCommands, runDeploy } =
  await import("../src/publish/publish-commands");
const { createCommandRegistry } = await import("../src/commands/registry");
const { emptyContext, makeContext } = await import("../src/commands/context");

const DEPLOY = {
  provider: "cloudflare-pages" as const,
  accountId: "a".repeat(32),
  projectName: "my-site",
  productionUrl: "https://my-site.pages.dev",
};

const DEPLOYMENT_WIRE = {
  id: "d1",
  url: "https://abc.my-site.pages.dev",
  environment: "production",
  latest_stage: { name: "deploy", status: "success" },
  created_on: "2026-07-06T00:00:00Z",
};

function command(id: string) {
  return publishCommands().find((candidate) => candidate.id === id)!;
}

function connect() {
  setProjectState({
    expanded: new Set(),
    projectConfig: { build: { deploy: DEPLOY }, name: "My Site" },
  } as never);
}

beforeEach(() => {
  resetActivities();
  resetNotifications();
  forgetDeployment();
  resetStudioState({ projectConfig: { name: "My Site" } });
  installMockPlatform();
});

describe("the records", () => {
  test("three of them, all Publish, all project-level", () => {
    const records = publishCommands();
    expect(records.map((record) => record.id)).toEqual([
      "publish.setUp",
      "publish.deploy",
      "publish.openDashboard",
    ]);
    expect(records.every((record) => record.category === "Publish")).toBe(true);
    expect(records.every((record) => record.level === "project")).toBe(true);
    // Always REACHABLE, never silently absent: the palette shows them and states the requirement.
    expect(records.every((record) => (record.menus ?? []).includes("palette"))).toBe(true);
    expect(records.every((record) => typeof record.requires === "string")).toBe(true);
  });

  test("registering them passes the registry's own placement and id checks", () => {
    const registry = createCommandRegistry({ getContext: emptyContext });
    registerPublishCommands(registry);
    expect([...registry.list()].map((record) => record.id).toSorted()).toEqual([
      "publish.deploy",
      "publish.openDashboard",
      "publish.setUp",
    ]);
  });

  test("all three are hidden with no project, and all three appear with one", () => {
    // §9.5's "always reachable": with a project open the family is VISIBLE even when it cannot
    // Run, so the palette states the requirement instead of the row silently not existing.
    const open = makeContext({ project: { open: true } });
    for (const record of publishCommands()) {
      expect(record.when!(emptyContext())).toBe(false);
      expect(record.when!(open)).toBe(true);
    }
  });

  test("no record is a toggle — there is no delta against unstated state here", () => {
    expect(publishCommands().some((record) => /\.toggle[A-Z]/.test(record.id))).toBe(false);
  });

  test("Set Up is hidden without a project and refused without a reachable provider", () => {
    const setUp = command("publish.setUp");
    expect(setUp.when!(emptyContext())).toBe(false);
    const open = makeContext({ project: { open: true } });
    expect(setUp.when!(open)).toBe(true);
    // No `cfApi` on the mock platform → enabled is false, and `requires` says why.
    expect(setUp.enablement!(open)).toBe(false);
    installMockPlatform({ cfApi: async () => ({}) });
    expect(setUp.enablement!(open)).toBe(true);
  });

  test("Deploy needs a repository AND a connected provider", () => {
    const deploy = command("publish.deploy");
    const repo = makeContext({ project: { isRepo: true, open: true } });
    expect(deploy.enablement!(repo)).toBe(false);
    connect();
    expect(deploy.enablement!(repo)).toBe(true);
    expect(deploy.enablement!(makeContext({ project: { open: true } }))).toBe(false);
  });

  test("Open Dashboard needs only the connection, and builds Cloudflare's own URL", () => {
    const dashboard = command("publish.openDashboard");
    expect(dashboard.enablement!(makeContext({ project: { open: true } }))).toBe(false);
    connect();
    expect(dashboard.enablement!(makeContext({ project: { open: true } }))).toBe(true);
    expect(dashboardUrl("acct", "site")).toBe("https://dash.cloudflare.com/acct/pages/view/site");
  });

  test("Open Dashboard opens the connected project in a new tab", () => {
    connect();
    const opened: unknown[][] = [];
    const original = window.open;
    window.open = (...args: unknown[]) => {
      opened.push(args);
      return null;
    };
    void command("publish.openDashboard").run(emptyContext(), undefined as never);
    window.open = original;
    expect(opened).toEqual([
      [`https://dash.cloudflare.com/${DEPLOY.accountId}/pages/view/my-site`, "_blank", "noopener"],
    ]);
  });

  test("Set Up opens the panel, and does not import it until it is run", async () => {
    // The lazy import is load-bearing: `commands/app-commands.ts` is read by three CI checks in a
    // Bare Bun process, and a module that opens a modal at import time would break all three.
    const { openModal } = await import("../src/ui/layers");
    expect(typeof openModal).toBe("function");
    resetStudioState({ projectConfig: { name: "My Site" } });
    document.body.innerHTML = `
      <div id="layer-popover"></div>
      <div id="layer-modal"></div>
      <div id="layer-dialog"></div>
    `;
    const { initLayers } = await import("../src/ui/layers");
    initLayers();
    await command("publish.setUp").run(emptyContext(), undefined as never);
    await flush();
    expect(document.querySelector("#layer-modal .publish-modal")).toBeTruthy();
  });

  test("Deploy's run wrapper drives the same activity the direct call does", async () => {
    connect();
    installMockPlatform({
      cfApi: async (path: string) =>
        path.includes("/deployments") ? [DEPLOYMENT_WIRE] : ({} as unknown),
    });
    await command("publish.deploy").run(emptyContext(), undefined as never);
    expect(activities).toHaveLength(1);
    expect(activities[0]!.state).toBe("done");
  });

  test("Open Dashboard with no connection does nothing rather than opening about:blank", () => {
    const opened: unknown[][] = [];
    const original = window.open;
    window.open = (...args: unknown[]) => {
      opened.push(args);
      return null;
    };
    void command("publish.openDashboard").run(emptyContext(), undefined as never);
    window.open = original;
    expect(opened).toEqual([]);
  });
});

describe("runDeploy", () => {
  test("pushes, reads the deployment back, and records it for the checklist", async () => {
    connect();
    const { state } = installMockPlatform({
      cfApi: async (path: string) =>
        path.includes("/deployments") ? [DEPLOYMENT_WIRE] : ({} as unknown),
    });
    expect(await runDeploy({ attempts: 1, delayMs: 0 })).toBe(true);
    expect(state.calls.some((call) => call[0] === "gitPush")).toBe(true);
    expect(observedDeployment()?.status).toBe("success");
    expect(activities).toHaveLength(1);
    expect(activities[0]!.state).toBe("done");
    expect(activities[0]!.status).toBe("deploy: success");
    expect(activities[0]!.steps.every((step) => step.state === "done")).toBe(true);
    expect(problems).toHaveLength(0);
  });

  test("a failed push is one Problem carrying the log, and no toast beside it", async () => {
    connect();
    installMockPlatform({
      gitPush: () => Promise.reject(new Error("remote rejected")),
    });
    expect(await runDeploy({ attempts: 1, delayMs: 0 })).toBe(false);
    expect(activities[0]!.state).toBe("failed");
    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toBe("Could not push to the remote.");
    expect(problems[0]!.detail).toContain("remote rejected");
    expect(problems[0]!.action).toBe("git.push");
    expect(toasts).toHaveLength(0);
  });

  test("a Cloudflare that will not answer fails once, not on every attempt", async () => {
    connect();
    let calls = 0;
    installMockPlatform({
      cfApi: () => {
        calls += 1;
        return Promise.reject(new Error("502 Bad Gateway"));
      },
    });
    expect(await runDeploy({ attempts: 3, delayMs: 0 })).toBe(false);
    expect(calls).toBe(1);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toBe("Cloudflare did not answer.");
    expect(problems[0]!.detail).toContain("502 Bad Gateway");
  });

  test("no deployment yet ends honestly rather than claiming one or hanging", async () => {
    connect();
    installMockPlatform({ cfApi: async () => [] });
    expect(await runDeploy({ attempts: 2, delayMs: 0 })).toBe(true);
    expect(activities[0]!.state).toBe("done");
    expect(activities[0]!.status).toContain("has not reported a deployment yet");
    // Asked, and the answer was none — which is a fact the checklist may now state.
    expect(observedDeployment()).toBeNull();
    expect(problems).toHaveLength(0);
  });

  test("a push with no provider connected is still a completed push", async () => {
    installMockPlatform();
    expect(await runDeploy({ attempts: 1, delayMs: 0 })).toBe(true);
    expect(activities[0]!.state).toBe("done");
    expect(activities[0]!.status).toContain("No provider is connected");
  });

  test("cancelling during the last wait still returns without claiming a deploy", async () => {
    // The post-loop guard: the cancel lands while the FINAL delay is pending, so the loop exits
    // Normally and the "no deployment yet" line would otherwise be written over a cancellation.
    connect();
    const { cancelActivity } = await import("../src/panels/activity-panel");
    installMockPlatform({
      cfApi: async () => {
        cancelActivity(activities[0]!.id);
        return [];
      },
    });
    expect(await runDeploy({ attempts: 1, delayMs: 0 })).toBe(false);
    expect(activities[0]!.state).toBe("cancelled");
    expect(observedDeployment()).toBeNull();
  });

  test("cancelling stops the poll and leaves the entry cancelled, not running", async () => {
    connect();
    installMockPlatform({ cfApi: async () => [] });
    const { cancelActivity } = await import("../src/panels/activity-panel");
    const promise = runDeploy({ attempts: 5, delayMs: 1 });
    await flush(1);
    expect(cancelActivity(activities[0]!.id)).toBe(true);
    expect(await promise).toBe(false);
    expect(activities[0]!.state).toBe("cancelled");
  });
});
