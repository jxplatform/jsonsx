// oxlint-disable typescript/await-thenable -- bun test .resolves/.rejects matchers are typed `void` but return real Promises at runtime; the await is required.
import { beforeEach, describe, expect, mock, test } from "bun:test";

const mockOpenFileDialog = mock(async () => ["/home/user/projects/project.json"]);
const mockOpenExternal = mock((_url: string) => true);

void mock.module("electrobun/bun", () => ({
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
  test("hands the url to the shell and reports what it returned", async () => {
    await init();
    expect(openExternal("https://example.com/page")).toBe(true);
    expect(mockOpenExternal).toHaveBeenCalledWith("https://example.com/page");
  });

  test("reports false when the shell declines", async () => {
    await init();
    mockOpenExternal.mockImplementationOnce(() => false);
    expect(openExternal("https://example.com")).toBe(false);
  });

  test("reports false rather than throwing when the shell call throws", async () => {
    await init();
    mockOpenExternal.mockImplementationOnce(() => {
      throw new Error("no portal");
    });
    expect(openExternal("https://example.com")).toBe(false);
  });
});
