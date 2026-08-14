/**
 * Deploy checklist tests — the ordered prerequisite chain, its three states, the status-bar item
 * whose label IS the next blocking step, and the Activity-tab rendering.
 *
 * The assertion that matters most is the `unknown` one: "Cloudflare reports no deployments" and
 * "nobody has asked Cloudflare" are different sentences, and collapsing them is how a checklist
 * tells a user to redo a deploy that already succeeded.
 */
import { flush, installMockPlatform, renderInto, resetStudioState } from "./harness";
import { beforeEach, describe, expect, test } from "bun:test";
import type { GitStatusResult } from "@jxsuite/protocol";

const { shell } = await import("../src/shell");
const { setProjectState } = await import("../src/store");
const { createCommandRegistry } = await import("../src/commands/registry");
const { emptyContext } = await import("../src/commands/context");
const { setActiveRegistry } = await import("../src/commands/active-registry");
const {
  deployChecklist,
  deployStatusItem,
  forgetDeployment,
  nextDeployStep,
  noteDeployment,
  observedDeployment,
  renderDeployChecklist,
} = await import("../src/publish/deploy-checklist");

function gitStatus(over: Partial<GitStatusResult> = {}): GitStatusResult {
  return { ahead: 0, behind: 0, branch: "main", files: [], isRepo: true, remotes: [], ...over };
}

/** One step by id, so an assertion never depends on the array's index. */
function step(id: string) {
  return deployChecklist().find((candidate) => candidate.id === id)!;
}

const DEPLOY = {
  provider: "cloudflare-pages" as const,
  accountId: "a".repeat(32),
  projectName: "my-site",
  productionUrl: "https://my-site.pages.dev",
};

beforeEach(() => {
  forgetDeployment();
  shell.git.status = null;
  resetStudioState({ projectConfig: { name: "My Site" } });
  installMockPlatform();
  setActiveRegistry(null);
});

describe("deployChecklist — the repository links", () => {
  test("a project source control has not reported on is unknown, not untracked", () => {
    // The distinction the whole module exists for: at cold start `shell.git.status` is null, and
    // Saying "this project is not tracked by git" then would be a guess presented as a fact.
    expect(step("repo").state).toBe("unknown");
    expect(step("remote").state).toBe("unknown");
  });

  test("no repository blocks at the first link", () => {
    shell.git.status = gitStatus({ branch: "", isRepo: false });
    expect(step("repo").state).toBe("todo");
    expect(nextDeployStep()?.id).toBe("repo");
    expect(nextDeployStep()?.command).toBe("git.init");
  });

  test("a tracked repository names its branch and moves the block to the remote", () => {
    shell.git.status = gitStatus();
    expect(step("repo").state).toBe("done");
    expect(step("repo").detail).toContain("main");
    expect(nextDeployStep()?.id).toBe("remote");
    expect(nextDeployStep()?.command).toBe("git.createGithubRepository");
  });

  test("a remote with unpushed commits blocks on a push, and says how many", () => {
    shell.git.status = gitStatus({ ahead: 3, remotes: ["origin"] });
    expect(step("remote").state).toBe("todo");
    expect(step("remote").command).toBe("git.push");
    expect(step("remote").detail).toContain("3 commit(s)");
    expect(step("remote").detail).toContain("origin");
  });

  test("a current remote is done", () => {
    shell.git.status = gitStatus({ remotes: ["origin"] });
    expect(step("remote").state).toBe("done");
    expect(step("remote").detail).toContain("Up to date with origin");
  });
});

describe("deployChecklist — the provider links", () => {
  beforeEach(() => {
    shell.git.status = gitStatus({ remotes: ["origin"] });
  });

  test("a platform that cannot reach Cloudflare says so instead of pretending", () => {
    // `installMockPlatform()` supplies no `cfApi`. The step is not `todo`, because "connect a
    // Provider" is not an action available here — it is the host's job, and the detail says so.
    expect(step("provider").state).toBe("unknown");
    expect(step("provider").detail).toContain("cannot reach the Cloudflare API");
  });

  test("a reachable platform with no connection is a plain todo", () => {
    installMockPlatform({ cfApi: async () => ({}) });
    expect(step("provider").state).toBe("todo");
    expect(nextDeployStep()?.command).toBe("publish.setUp");
  });

  test("a connected provider is done and names the Pages project", () => {
    setProjectState({
      expanded: new Set(),
      projectConfig: { build: { deploy: DEPLOY }, name: "My Site" },
    } as never);
    expect(step("provider").state).toBe("done");
    expect(step("provider").detail).toContain("my-site");
  });
});

describe("deployChecklist — the deployment link", () => {
  beforeEach(() => {
    shell.git.status = gitStatus({ remotes: ["origin"] });
    setProjectState({
      expanded: new Set(),
      projectConfig: { build: { deploy: DEPLOY }, name: "My Site" },
    } as never);
  });

  test("with no provider connected, nothing is deployed and it says why", () => {
    resetStudioState({ projectConfig: { name: "My Site" } });
    expect(step("deployed").state).toBe("todo");
    expect(step("deployed").detail).toContain("no provider is connected");
  });

  test("unasked is unknown, and says it is not a claim", () => {
    expect(step("deployed").state).toBe("unknown");
    expect(step("deployed").detail).toContain("not been asked");
  });

  test("asked-and-none is a todo — the difference from unasked is the whole point", () => {
    noteDeployment(null);
    expect(observedDeployment()).toBeNull();
    expect(step("deployed").state).toBe("todo");
    expect(step("deployed").detail).toContain("no deployments");
  });

  test("a successful deployment completes the chain", () => {
    noteDeployment({
      createdOn: "2026-07-06T00:00:00Z",
      environment: "production",
      id: "d1",
      stage: "deploy",
      status: "success",
      url: "https://abc.my-site.pages.dev",
    });
    expect(step("deployed").state).toBe("done");
    expect(nextDeployStep()).toBeNull();
  });

  test("a failed deployment blocks, and quotes the stage that failed", () => {
    noteDeployment({
      createdOn: "2026-07-06T00:00:00Z",
      environment: "production",
      id: "d1",
      stage: "build",
      status: "failure",
      url: "https://abc.my-site.pages.dev",
    });
    expect(step("deployed").state).toBe("todo");
    expect(step("deployed").detail).toContain("build: failure");
  });
});

describe("deployStatusItem — the status bar's project field", () => {
  test("no project, no item", () => {
    setProjectState(null as never);
    expect(deployStatusItem()).toBeNull();
  });

  test("its label IS the next blocking prerequisite", () => {
    shell.git.status = gitStatus({ branch: "", isRepo: false });
    expect(deployStatusItem()).toEqual({
      command: "git.init",
      label: "Track this project with git",
      title: "A deploy ships what the repository holds, so the repository comes first.",
    });
  });

  test("a whole chain reads as ambient state, pointing at the dashboard", () => {
    shell.git.status = gitStatus({ remotes: ["origin"] });
    setProjectState({
      expanded: new Set(),
      projectConfig: { build: { deploy: DEPLOY }, name: "My Site" },
    } as never);
    noteDeployment({
      createdOn: "2026-07-06T00:00:00Z",
      environment: "production",
      id: "d1",
      stage: "deploy",
      status: "success",
      url: "https://abc.my-site.pages.dev",
    });
    expect(deployStatusItem()).toEqual({
      command: "publish.openDashboard",
      label: "Deployed",
      title: "https://my-site.pages.dev",
    });
  });
});

describe("renderDeployChecklist", () => {
  test("renders nothing at all when no project is open", async () => {
    setProjectState(null as never);
    const host = await renderInto(renderDeployChecklist() as never);
    expect(host.textContent?.trim()).toBe("");
  });

  test("draws every step in the Activity tab's own vocabulary", async () => {
    shell.git.status = gitStatus({ branch: "", isRepo: false });
    const host = await renderInto(renderDeployChecklist() as never);
    // Reused classes, not new ones: the checklist is a list of stages that finish, which is what
    // The Activity row already draws — and `scripts/check-styles.ts` has rules for all of them.
    expect(host.querySelectorAll(".activity-step")).toHaveLength(4);
    expect(host.querySelector(".activity-row--running")).toBeTruthy();
    expect(host.textContent).toContain("Track this project with git");
    expect(host.textContent).toContain("Connect a deploy provider");
  });

  test("a step the registry cannot run draws no button, rather than a dead one", async () => {
    shell.git.status = gitStatus({ branch: "", isRepo: false });
    const host = await renderInto(renderDeployChecklist() as never);
    expect(host.querySelector("sp-action-button")).toBeNull();
  });

  test("the next action carries the command's own title and runs it", async () => {
    shell.git.status = gitStatus({ branch: "", isRepo: false });
    const runs: string[] = [];
    const registry = createCommandRegistry({ getContext: emptyContext });
    registry.register({
      category: "Source Control",
      id: "git.init",
      level: "project",
      run: () => {
        runs.push("git.init");
      },
      title: "Initialize Repository",
    });
    setActiveRegistry(registry);
    const host = await renderInto(renderDeployChecklist() as never);
    const action = host.querySelector("sp-action-button")!;
    expect(action.textContent).toContain("Initialize Repository");
    action.dispatchEvent(new Event("click", { bubbles: true }));
    await flush();
    expect(runs).toEqual(["git.init"]);
  });

  test("a disabled command keeps its row and states the requirement", async () => {
    shell.git.status = gitStatus({ branch: "", isRepo: false });
    const registry = createCommandRegistry({ getContext: emptyContext });
    registry.register({
      category: "Source Control",
      id: "git.init",
      level: "project",
      requires: "an open project",
      enablement: () => false,
      run: () => {},
      title: "Initialize Repository",
    });
    setActiveRegistry(registry);
    const host = await renderInto(renderDeployChecklist() as never);
    const action = host.querySelector("sp-action-button")!;
    expect(action.hasAttribute("disabled")).toBe(true);
    expect(action.getAttribute("title")).toContain("requires an open project");
  });

  test("a whole chain says so and offers no next action", async () => {
    shell.git.status = gitStatus({ remotes: ["origin"] });
    setProjectState({
      expanded: new Set(),
      projectConfig: { build: { deploy: DEPLOY }, name: "My Site" },
    } as never);
    noteDeployment({
      createdOn: "2026-07-06T00:00:00Z",
      environment: "production",
      id: "d1",
      stage: "deploy",
      status: "success",
      url: "https://abc.my-site.pages.dev",
    });
    const host = await renderInto(renderDeployChecklist() as never);
    expect(host.querySelector(".activity-row--done")).toBeTruthy();
    expect(host.textContent).toContain("Everything this project needs to ship is in place.");
    expect(host.querySelectorAll(".activity-step--done")).toHaveLength(4);
  });
});
