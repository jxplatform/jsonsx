/**
 * Welcome-screen tests (E9). Renders the start screen into a detached host with a mock platform and
 * seeded recent projects, then asserts the actions, clone visibility, and recent list behavior.
 */
import { installMockPlatform, pointer } from "./harness";
import { beforeEach, describe, expect, mock, test } from "bun:test";

const { initWelcome, renderWelcome } = await import("../src/panels/welcome-screen");

const RECENT_KEY = "jx-studio-recent-projects";

interface Ctx {
  openProject: ReturnType<typeof mock>;
  openRecentProject: ReturnType<typeof mock>;
  openNewProject: ReturnType<typeof mock>;
  cloneRepository: ReturnType<typeof mock>;
}

function makeCtx(): Ctx {
  return {
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
  installMockPlatform();
});

describe("renderWelcome — start actions", () => {
  test("renders title, subtitle, and New/Open actions without clone by default", () => {
    const host = renderScreen(makeCtx());
    expect(host.querySelector(".welcome-title")?.textContent).toBe("Jx Studio");
    expect(host.querySelector(".welcome-subtitle")?.textContent).toBe("Visual component builder");

    const btns = actions(host);
    expect(btns).toHaveLength(2);
    expect(btns[0].textContent).toContain("New Project...");
    expect(btns[1].textContent).toContain("Open Project...");
    // Mock platform has no gitClone, so the clone action is hidden
    expect(host.textContent).not.toContain("Clone Git Repository");
  });

  test("New Project and Open Project buttons invoke the ctx callbacks", () => {
    const ctx = makeCtx();
    const host = renderScreen(ctx);
    const [newBtn, openBtn] = actions(host);
    pointer(newBtn, "click");
    expect(ctx.openNewProject).toHaveBeenCalledTimes(1);
    pointer(openBtn, "click");
    expect(ctx.openProject).toHaveBeenCalledTimes(1);
    expect(ctx.cloneRepository).not.toHaveBeenCalled();
  });

  test("shows the clone action when the platform supports gitClone", () => {
    installMockPlatform({
      gitClone: (async () => ({ ok: true, root: "/cloned" })) as never,
    });
    const ctx = makeCtx();
    const host = renderScreen(ctx);
    const btns = actions(host);
    expect(btns).toHaveLength(3);
    expect(btns[2].textContent).toContain("Clone Git Repository...");
    pointer(btns[2], "click");
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
    expect(rows[0].querySelector(".welcome-recent-name")?.textContent).toBe("Alpha");
    expect(rows[1].querySelector(".welcome-recent-name")?.textContent).toBe("Beta");
    // Home paths shortened to ~/..., other paths verbatim
    expect(rows[0].querySelector(".welcome-recent-path")?.textContent).toBe("~/dev/alpha");
    expect(rows[1].querySelector(".welcome-recent-path")?.textContent).toBe("/srv/sites/beta");
    // Full root exposed as tooltip
    expect(rows[0].getAttribute("title")).toBe("/home/user/dev/alpha");
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
});
