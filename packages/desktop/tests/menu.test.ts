import { beforeEach, describe, expect, mock, test } from "bun:test";

// ─── Mock electrobun/main (ApplicationMenu) ─────────────────────────────────

let capturedMenu: unknown = null;
let clickHandler: ((event: unknown) => unknown) | null = null;
const setApplicationMenu = mock((menu: unknown) => {
  capturedMenu = menu;
});
const on = mock((event: string, handler: (event: unknown) => unknown) => {
  if (event === "application-menu-clicked") {
    clickHandler = handler;
  }
});

void mock.module("electrobun/main", () => ({
  ApplicationMenu: { on, setApplicationMenu },
}));

// ─── Mock ./utils and ./window-manager ──────────────────────────────────────

const openFileDialog = mock(async (): Promise<string | null> => null);
void mock.module("../src/utils", () => ({
  openDirectoryDialog: mock(async (): Promise<string | null> => null),
  openFileDialog,
}));

const openProjectWindow = mock((_root: string | null) => ({}));
void mock.module("../src/window-manager", () => ({ openProjectWindow }));

// ─── Import module under test ────────────────────────────────────────────────

const { installApplicationMenu } = await import("../src/menu");

interface MenuItem {
  label?: string;
  action?: string;
  accelerator?: string;
  type?: string;
  role?: string;
  submenu?: MenuItem[];
}

function fire(action?: string): Promise<unknown> {
  return Promise.resolve(clickHandler!({ data: action == null ? {} : { action } }));
}

beforeEach(() => {
  setApplicationMenu.mockClear();
  on.mockClear();
  openFileDialog.mockClear();
  openProjectWindow.mockClear();
  openFileDialog.mockResolvedValue(null);
});

describe("installApplicationMenu", () => {
  test("registers a File menu with the multi-window entry points", () => {
    installApplicationMenu();
    expect(setApplicationMenu).toHaveBeenCalledTimes(1);
    const menu = capturedMenu as MenuItem[];
    const file = menu.find((m) => m.label === "File")!;
    expect(file).toBeDefined();
    const actions = file.submenu!.map((i) => i.action ?? i.role ?? i.type);
    expect(actions).toEqual(["new-window", "open-project", "divider", "close"]);
    expect(on).toHaveBeenCalledWith("application-menu-clicked", expect.any(Function));
  });

  test("new-window action opens a welcome window", async () => {
    installApplicationMenu();
    await fire("new-window");
    expect(openProjectWindow).toHaveBeenCalledWith(null);
  });

  test("open-project opens the chosen project's directory", async () => {
    installApplicationMenu();
    openFileDialog.mockResolvedValueOnce("/home/me/site/project.json");
    await fire("open-project");
    expect(openFileDialog).toHaveBeenCalledTimes(1);
    expect(openProjectWindow).toHaveBeenCalledWith("/home/me/site");
  });

  test("open-project ignores a non-project.json selection", async () => {
    installApplicationMenu();
    openFileDialog.mockResolvedValueOnce("/home/me/site/readme.md");
    await fire("open-project");
    expect(openProjectWindow).not.toHaveBeenCalled();
  });

  test("open-project does nothing when the dialog is cancelled", async () => {
    installApplicationMenu();
    openFileDialog.mockResolvedValueOnce(null);
    await fire("open-project");
    expect(openProjectWindow).not.toHaveBeenCalled();
  });

  test("ignores clicks with an unknown or missing action", async () => {
    installApplicationMenu();
    await fire("some-other-action");
    await fire();
    expect(openProjectWindow).not.toHaveBeenCalled();
    expect(openFileDialog).not.toHaveBeenCalled();
  });
});
