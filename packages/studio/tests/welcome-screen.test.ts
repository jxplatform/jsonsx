/**
 * Welcome-screen tests (E9). Renders the start screen into a detached host with a mock platform and
 * seeded recent projects, then asserts the actions, clone visibility, and recent list behavior.
 */
import { installMockPlatform, pointer } from "./harness";
import { beforeEach, describe, expect, mock, test } from "bun:test";

const { initWelcome, renderWelcome } = await import("../src/panels/welcome-screen");
const { hydrateProjectList, resetProjectList } = await import("../src/project-list");
const { hydrateAccountStatus, resetAccountStatus } = await import("../src/account-status");

const RECENT_KEY = "jx-studio-recent-projects";

interface Ctx {
  openProject: ReturnType<typeof mock>;
  openRecentProject: ReturnType<typeof mock>;
  openNewProject: ReturnType<typeof mock>;
  cloneRepository: ReturnType<typeof mock>;
  addExistingRepo: ReturnType<typeof mock>;
}

function makeCtx(): Ctx {
  return {
    addExistingRepo: mock(() => {}),
    cloneRepository: mock(() => {}),
    openNewProject: mock(() => {}),
    openProject: mock(() => {}),
    openRecentProject: mock((_root: string) => {}),
  };
}

function renderScreen(ctx: Ctx): HTMLElement {
  initWelcome(ctx as never);
  const host = document.createElement("div");
  renderWelcome(host);
  return host;
}

function actions(host: HTMLElement): HTMLButtonElement[] {
  return [...host.querySelectorAll("button.welcome-action")] as HTMLButtonElement[];
}

beforeEach(() => {
  localStorage.removeItem(RECENT_KEY);
  resetProjectList();
  resetAccountStatus();
  installMockPlatform();
});

describe("renderWelcome — start actions", () => {
  test("renders title, subtitle, and New/Open actions without clone by default", () => {
    const host = renderScreen(makeCtx());
    expect(host.querySelector(".welcome-title")?.textContent).toBe("Jx Studio");
    expect(host.querySelector(".welcome-subtitle")?.textContent).toBe("Visual component builder");

    const btns = actions(host);
    expect(btns).toHaveLength(3);
    expect(btns[0]!.textContent).toContain("New Project...");
    expect(btns[1]!.textContent).toContain("Start from an Example...");
    expect(btns[2]!.textContent).toContain("Open Project...");
    // Mock platform has no gitClone, so the clone action is hidden
    expect(host.textContent).not.toContain("Clone Git Repository");
  });

  test("New Project, Example, and Open Project buttons invoke the ctx callbacks", () => {
    const ctx = makeCtx();
    const host = renderScreen(ctx);
    const [newBtn, exampleBtn, openBtn] = actions(host);
    pointer(newBtn!, "click");
    expect(ctx.openNewProject).toHaveBeenCalledTimes(1);
    expect(ctx.openNewProject).toHaveBeenLastCalledWith();
    // The example action opens the same modal preselected to the Starter Site tab.
    pointer(exampleBtn!, "click");
    expect(ctx.openNewProject).toHaveBeenCalledTimes(2);
    expect(ctx.openNewProject).toHaveBeenLastCalledWith({ tab: "starter" });
    pointer(openBtn!, "click");
    expect(ctx.openProject).toHaveBeenCalledTimes(1);
    expect(ctx.cloneRepository).not.toHaveBeenCalled();
  });

  test("shows Add Existing Repository when the platform can browse + import repos", () => {
    installMockPlatform({
      importProject: (() => Promise.resolve({ root: "octocat/site@main" })) as never,
      listRepos: (() => Promise.resolve([])) as never,
    });
    const ctx = makeCtx();
    const host = renderScreen(ctx);
    const btns = actions(host);
    expect(btns).toHaveLength(4);
    expect(btns[3]!.textContent).toContain("Add Existing Repository...");
    pointer(btns[3]!, "click");
    expect(ctx.addExistingRepo).toHaveBeenCalledTimes(1);
  });

  test("shows the clone action when the platform supports gitClone", () => {
    installMockPlatform({
      gitClone: (async () => ({ ok: true, root: "/cloned" })) as never,
    });
    const ctx = makeCtx();
    const host = renderScreen(ctx);
    const btns = actions(host);
    expect(btns).toHaveLength(4);
    expect(btns[3]!.textContent).toContain("Clone Git Repository...");
    pointer(btns[3]!, "click");
    expect(ctx.cloneRepository).toHaveBeenCalledTimes(1);
  });
});

describe("renderWelcome — recent projects", () => {
  test("omits the Recent section when there are no recent projects", () => {
    const host = renderScreen(makeCtx());
    expect(host.textContent).not.toContain("Recent");
    expect(host.querySelectorAll(".welcome-recent")).toHaveLength(0);
  });

  test("lists recent projects newest-first with shortened home paths", () => {
    localStorage.setItem(
      RECENT_KEY,
      JSON.stringify([
        { name: "Beta", root: "/srv/sites/beta", timestamp: 1 },
        { name: "Alpha", root: "/home/user/dev/alpha", timestamp: 2 },
      ]),
    );
    const host = renderScreen(makeCtx());
    expect(host.querySelector(".welcome-section-title:last-of-type")).toBeTruthy();

    const rows = [...host.querySelectorAll("button.welcome-recent")] as HTMLButtonElement[];
    expect(rows).toHaveLength(2);
    // Sorted by timestamp descending
    expect(rows[0]!.querySelector(".welcome-recent-name")?.textContent).toBe("Alpha");
    expect(rows[1]!.querySelector(".welcome-recent-name")?.textContent).toBe("Beta");
    // Home paths shortened to ~/..., other paths verbatim
    expect(rows[0]!.querySelector(".welcome-recent-path")?.textContent).toBe("~/dev/alpha");
    expect(rows[1]!.querySelector(".welcome-recent-path")?.textContent).toBe("/srv/sites/beta");
    // Full root exposed as tooltip
    expect(rows[0]!.getAttribute("title")).toBe("/home/user/dev/alpha");
  });

  test("clicking a recent project opens it by root", () => {
    localStorage.setItem(
      RECENT_KEY,
      JSON.stringify([{ name: "Alpha", root: "/home/user/dev/alpha", timestamp: 5 }]),
    );
    const ctx = makeCtx();
    const host = renderScreen(ctx);
    const row = host.querySelector("button.welcome-recent") as HTMLButtonElement;
    pointer(row, "click");
    expect(ctx.openRecentProject).toHaveBeenCalledWith("/home/user/dev/alpha");
  });

  test("each recent project has a remove button that drops just that entry", () => {
    localStorage.setItem(
      RECENT_KEY,
      JSON.stringify([
        { name: "Alpha", root: "/a", timestamp: 2 },
        { name: "Beta", root: "/b", timestamp: 1 },
      ]),
    );
    const ctx = makeCtx();
    const host = renderScreen(ctx);
    const removeBtns = [
      ...host.querySelectorAll("button.welcome-recent-remove"),
    ] as HTMLButtonElement[];
    expect(removeBtns).toHaveLength(2);
    pointer(removeBtns[0]!, "click"); // Alpha is newest-first
    expect(ctx.openRecentProject).not.toHaveBeenCalled();
    renderWelcome(host); // Reflect the mutation
    const names = [...host.querySelectorAll(".welcome-recent-name")].map((n) => n.textContent);
    expect(names).toEqual(["Beta"]);
  });

  test("the Clear button empties the recent list", () => {
    localStorage.setItem(RECENT_KEY, JSON.stringify([{ name: "Alpha", root: "/a", timestamp: 1 }]));
    const host = renderScreen(makeCtx());
    const clearBtn = host.querySelector("button.welcome-clear") as HTMLButtonElement;
    expect(clearBtn).toBeTruthy();
    pointer(clearBtn, "click");
    renderWelcome(host);
    expect(host.querySelectorAll(".welcome-recent")).toHaveLength(0);
  });
});

describe("renderWelcome — GitHub App install prompt", () => {
  const INSTALL_URL = "https://github.com/apps/jx-suite/installations/new";

  test("prompts to install the App when the account has no installations", async () => {
    installMockPlatform({
      getAccountStatus: () => Promise.resolve({ appInstallUrl: INSTALL_URL, installations: [] }),
    });
    await hydrateAccountStatus();
    const host = renderScreen(makeCtx());
    const link = host.querySelector("a.welcome-action") as HTMLAnchorElement;
    expect(link).toBeTruthy();
    expect(link.textContent).toContain("Install the Jx Suite GitHub App");
    expect(link.getAttribute("href")).toBe(INSTALL_URL);
    expect(host.textContent).toContain("Repository access");
  });

  test("stays silent with an installation present, without the member, or on unknown status", async () => {
    installMockPlatform({
      getAccountStatus: () =>
        Promise.resolve({
          appInstallUrl: INSTALL_URL,
          installations: [{ account: "octocat", id: 1 }],
        }),
    });
    await hydrateAccountStatus();
    expect(renderScreen(makeCtx()).querySelector("a.welcome-action")).toBeNull();

    installMockPlatform(); // No getAccountStatus member at all.
    await hydrateAccountStatus();
    expect(renderScreen(makeCtx()).querySelector("a.welcome-action")).toBeNull();

    installMockPlatform({ getAccountStatus: () => Promise.reject(new Error("offline")) });
    await hydrateAccountStatus();
    expect(renderScreen(makeCtx()).querySelector("a.welcome-action")).toBeNull();
  });
});

describe("renderWelcome — project catalogue", () => {
  const CATALOGUE = [
    { name: "Portfolio", root: "sites/portfolio", description: "sites/portfolio" },
    { name: "Shop", root: "acme/shop", description: "write access" },
  ];

  test("lists platform projects and opens one through openRecentProject", async () => {
    installMockPlatform({ listProjects: () => Promise.resolve(CATALOGUE) });
    await hydrateProjectList();
    const ctx = makeCtx();
    const host = renderScreen(ctx);
    const rows = [...host.querySelectorAll("button.welcome-catalogue")] as HTMLButtonElement[];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("Portfolio");
    expect(rows[1]!.textContent).toContain("write access");
    pointer(rows[1]!, "click");
    expect(ctx.openRecentProject).toHaveBeenCalledWith("acme/shop");
  });

  test("hides the section when the platform has no catalogue", () => {
    installMockPlatform();
    const host = renderScreen(makeCtx());
    expect(host.querySelectorAll("button.welcome-catalogue")).toHaveLength(0);
  });

  test("entries already in Recent are not duplicated in the catalogue section", async () => {
    localStorage.setItem(
      RECENT_KEY,
      JSON.stringify([{ name: "Portfolio", root: "sites/portfolio", timestamp: 1 }]),
    );
    installMockPlatform({ listProjects: () => Promise.resolve(CATALOGUE) });
    await hydrateProjectList();
    const host = renderScreen(makeCtx());
    const catalogueNames = [
      ...host.querySelectorAll("button.welcome-catalogue .welcome-recent-name"),
    ].map((n) => n.textContent);
    expect(catalogueNames).toEqual(["Shop"]);
    // Section order: Projects (catalogue) renders above Recent.
    expect([...host.querySelectorAll(".welcome-recent-name")].map((n) => n.textContent)).toEqual([
      "Shop",
      "Portfolio",
    ]);
  });
});
