// oxlint-disable typescript/await-thenable -- bun test .resolves/.rejects matchers are typed `void` but return real Promises at runtime; the await is required.
import { beforeEach, describe, expect, mock, test } from "bun:test";

const mockOpenFileDialog = mock(async () => ["/home/user/projects/project.json"]);
const mockOpenExternal = mock((_url: string) => true);

/* The OS opener is a real process launch — mocked here so a test run never opens a browser window
   on the machine running it, and so the argument vector itself can be asserted. */
const spawnCalls: { command: string; args: string[] }[] = [];
let spawnThrows = false;
const unref = mock(() => {});
const mockSpawn = mock((command: string, args: string[]) => {
  if (spawnThrows) {
    throw new Error("no such binary");
  }
  spawnCalls.push({ args, command });
  return { unref };
});
void mock.module("node:child_process", () => ({ spawn: mockSpawn }));

void mock.module("electrobun/main", () => ({
  BrowserWindow: class {},
  Electrobun: { start: () => {} },
  Updater: {
    applyUpdate: () => {},
    checkForUpdate: () => ({}),
    downloadUpdate: () => {},
    getLocalInfo: () => ({}),
  },
  Utils: { openExternal: mockOpenExternal, openFileDialog: mockOpenFileDialog },
}));

const { init, openFileDialog, openDirectoryDialog, openExternal } = await import("../src/utils");

beforeEach(() => {
  mockOpenFileDialog.mockClear();
  mockOpenExternal.mockClear();
});

// ─── init ──────────────────────────────────────────────────────────────────

describe("init", () => {
  test("does not throw", async () => {
    await expect(init()).resolves.toBeUndefined();
  });
});

// ─── openFileDialog ────────────────────────────────────────────────────────

describe("openFileDialog", () => {
  test("returns first selected path trimmed", async () => {
    await init();
    const result = await openFileDialog();
    expect(result).toBe("/home/user/projects/project.json");
    expect(mockOpenFileDialog).toHaveBeenCalledTimes(1);
  });

  test("passes correct options to Utils.openFileDialog", async () => {
    await init();
    await openFileDialog();
    const [call] = mockOpenFileDialog.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(call.allowedFileTypes).toBe("json");
    expect(call.canChooseFiles).toBe(true);
    expect(call.canChooseDirectory).toBe(false);
    expect(call.allowsMultipleSelection).toBe(false);
  });

  test("returns null when dialog cancelled (empty array)", async () => {
    await init();
    mockOpenFileDialog.mockImplementationOnce(async () => []);
    const result = await openFileDialog();
    expect(result).toBeNull();
  });

  test("returns null when dialog returns array with empty string", async () => {
    await init();
    mockOpenFileDialog.mockImplementationOnce(async () => [""]);
    const result = await openFileDialog();
    expect(result).toBeNull();
  });

  test("returns null when dialog returns array with whitespace-only string", async () => {
    await init();
    mockOpenFileDialog.mockImplementationOnce(async () => ["  "]);
    const result = await openFileDialog();
    expect(result).toBeNull();
  });

  test("trims whitespace from returned path", async () => {
    await init();
    mockOpenFileDialog.mockImplementationOnce(async () => ["  /path/to/file.json  "]);
    const result = await openFileDialog();
    expect(result).toBe("/path/to/file.json");
  });
});

// ─── openDirectoryDialog ─────────────────────────────────────────────────────

describe("openDirectoryDialog", () => {
  test("returns the chosen folder and requests a directory (not a file)", async () => {
    await init();
    mockOpenFileDialog.mockImplementationOnce(async () => ["/home/user/projects"]);
    const result = await openDirectoryDialog();
    expect(result).toBe("/home/user/projects");
    const [call] = mockOpenFileDialog.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(call.canChooseDirectory).toBe(true);
    expect(call.canChooseFiles).toBe(false);
  });

  test("returns null when the picker is cancelled", async () => {
    await init();
    mockOpenFileDialog.mockImplementationOnce(async () => []);
    expect(await openDirectoryDialog()).toBeNull();
  });

  test("trims whitespace from the returned folder", async () => {
    await init();
    mockOpenFileDialog.mockImplementationOnce(async () => ["  /home/user/proj  "]);
    expect(await openDirectoryDialog()).toBe("/home/user/proj");
  });
});

// ─── openExternal ────────────────────────────────────────────────────────────

/* Studio's Preview mode routes link clicks here so the target opens in the user's real browser
   rather than a webview with no address bar, history or devtools. It reports failure instead of
   throwing, because the caller's fallback is `window.open` inside the webview. */
describe("openExternal", () => {
  beforeEach(() => {
    spawnCalls.length = 0;
    spawnThrows = false;
  });

  test("hands the url to the shell, and nothing else needs to happen", async () => {
    await init();
    expect(openExternal("https://example.com/page")).toBe(true);
    expect(mockOpenExternal).toHaveBeenCalledWith("https://example.com/page");
    expect(spawnCalls).toHaveLength(0);
  });

  /* The shell declining is not the end of the road any more: the chromium launcher never loads
     electrobun at all, so if this were the answer, every url on that build would be dropped. */
  test("falls back to the OS opener when the shell declines", async () => {
    await init();
    mockOpenExternal.mockImplementationOnce(() => false);
    expect(openExternal("https://example.com")).toBe(true);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.args).toContain("https://example.com");
  });

  test("falls back to the OS opener when the shell call throws", async () => {
    await init();
    mockOpenExternal.mockImplementationOnce(() => {
      throw new Error("no portal");
    });
    expect(openExternal("https://example.com")).toBe(true);
    expect(spawnCalls).toHaveLength(1);
  });

  test("reports false when the OS has no opener either, so the caller can use window.open", async () => {
    await init();
    mockOpenExternal.mockImplementationOnce(() => false);
    spawnThrows = true;
    expect(openExternal("https://example.com")).toBe(false);
  });

  /*
   * The opener resolves a scheme to whatever handler the desktop registered for it, and the pages
   * whose links arrive here are the project's own content. A non-web scheme is refused rather than
   * handed to a program of the page's choosing.
   */
  test("refuses a scheme that is not the web", async () => {
    await init();
    mockOpenExternal.mockImplementation(() => false);
    try {
      expect(openExternal("file:///etc/passwd")).toBe(false);
      // oxlint-disable-next-line no-script-url -- the point of the test is that this is refused
      expect(openExternal("javascript:alert(1)")).toBe(false);
      expect(openExternal("not a url at all")).toBe(false);
      expect(spawnCalls).toHaveLength(0);
      // `mailto` is what a previewed page's contact link actually is.
      expect(openExternal("mailto:hi@example.com")).toBe(true);
    } finally {
      mockOpenExternal.mockImplementation(() => true);
    }
  });

  test("passes the url as one argument, never as a command line", async () => {
    await init();
    mockOpenExternal.mockImplementationOnce(() => false);
    openExternal("https://example.com/?a=1&b=2");
    const [call] = spawnCalls;
    expect(call!.args.at(-1)).toBe("https://example.com/?a=1&b=2");
    expect(call!.command).not.toBe("sh");
    expect(unref).toHaveBeenCalled();
  });
});
