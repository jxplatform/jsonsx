import { beforeEach, describe, expect, mock, test } from "bun:test";

const mockOpenFileDialog = mock(async () => ["/home/user/projects/project.json"]);

mock.module("electrobun/bun", () => ({
  BrowserWindow: class {},
  Electrobun: { start: () => {} },
  Updater: {
    applyUpdate: () => {},
    checkForUpdate: () => ({}),
    downloadUpdate: () => {},
    getLocalInfo: () => ({}),
  },
  Utils: { openFileDialog: mockOpenFileDialog },
}));

const { init, openFileDialog } = await import("../src/utils");

beforeEach(() => {
  mockOpenFileDialog.mockClear();
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
