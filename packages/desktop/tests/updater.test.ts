import { afterEach, beforeEach, describe, expect, jest, mock, test } from "bun:test";

const mockGetLocalInfo = mock(() => ({
  baseUrl: "https://updates.example.com",
  channel: "stable",
  hash: "abc123",
  identifier: "com.jsonsx.studio",
  name: "JSONsx Studio",
  version: "1.0.0",
}));

const mockCheckForUpdate = mock(() => ({
  error: null,
  updateAvailable: true,
  updateReady: false,
  version: "1.1.0",
}));

const mockDownloadUpdate = mock(() => {});
const mockApplyUpdate = mock(() => {});

void mock.module("electrobun/bun", () => ({
  BrowserWindow: class {},
  Electrobun: { start: () => {} },
  Updater: {
    applyUpdate: mockApplyUpdate,
    checkForUpdate: mockCheckForUpdate,
    downloadUpdate: mockDownloadUpdate,
    getLocalInfo: mockGetLocalInfo,
  },
  Utils: { openFileDialog: async () => [] },
}));

const {
  getLocalInfo,
  checkForUpdate,
  composeAppInfo,
  downloadUpdate,
  applyUpdate,
  getStatus,
  setNotifyWebview,
  startBackgroundChecks,
} = await import("../src/updater");

beforeEach(() => {
  mockGetLocalInfo.mockClear();
  mockCheckForUpdate.mockClear();
  mockDownloadUpdate.mockClear();
  mockApplyUpdate.mockClear();
});

// ─── getLocalInfo ──────────────────────────────────────────────────────────

describe("getLocalInfo", () => {
  test("returns local update info from Updater", async () => {
    const info = await getLocalInfo();
    expect(info.version).toBe("1.0.0");
    expect(info.hash).toBe("abc123");
    expect(info.channel).toBe("stable");
    expect(mockGetLocalInfo).toHaveBeenCalledTimes(1);
  });
});

// ─── checkForUpdate ────────────────────────────────────────────────────────

describe("checkForUpdate", () => {
  test("returns update status and caches it", async () => {
    const status = await checkForUpdate();
    expect(status.version).toBe("1.1.0");
    expect(status.updateAvailable).toBe(true);
    expect(status.updateReady).toBe(false);
    expect(status.error).toBeNull();

    const cached = getStatus();
    expect(cached).toEqual(status);
  });

  test("handles errors gracefully", async () => {
    mockCheckForUpdate.mockImplementationOnce(() => {
      throw new Error("Network timeout");
    });

    const status = await checkForUpdate();
    expect(status.error).toBe("Network timeout");
  });
});

// ─── downloadUpdate ────────────────────────────────────────────────────────

describe("downloadUpdate", () => {
  test("downloads and re-checks status", async () => {
    mockCheckForUpdate.mockImplementationOnce(() => ({
      error: null,
      updateAvailable: true,
      updateReady: true,
      version: "1.1.0",
    }));

    const status = await downloadUpdate();
    expect(mockDownloadUpdate).toHaveBeenCalledTimes(1);
    expect(status.updateReady).toBe(true);
  });

  test("handles download errors", async () => {
    mockDownloadUpdate.mockImplementationOnce(() => {
      throw new Error("Download failed");
    });

    const status = await downloadUpdate();
    expect(status.error).toBe("Download failed");
  });
});

// ─── applyUpdate ───────────────────────────────────────────────────────────

describe("applyUpdate", () => {
  test("delegates to Updater.applyUpdate", async () => {
    await applyUpdate();
    expect(mockApplyUpdate).toHaveBeenCalledTimes(1);
  });
});

// ─── getStatus ─────────────────────────────────────────────────────────────

describe("getStatus", () => {
  test("returns initial status before any check", () => {
    // Note: status may have been modified by earlier tests in this suite
    const status = getStatus();
    expect(status).toHaveProperty("version");
    expect(status).toHaveProperty("updateAvailable");
    expect(status).toHaveProperty("updateReady");
    expect(status).toHaveProperty("error");
  });
});

// ─── setNotifyWebview ──────────────────────────────────────────────────────

describe("setNotifyWebview", () => {
  test("sets the notification callback (no-op until backgroundCheck triggers)", () => {
    const callback = mock(() => {});
    setNotifyWebview(callback);
    expect(callback).not.toHaveBeenCalled();
  });
});

// ─── startBackgroundChecks ────────────────────────────────────────────────

describe("startBackgroundChecks", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("schedules background check that calls checkForUpdate", async () => {
    mockCheckForUpdate.mockClear();
    mockDownloadUpdate.mockClear();

    mockCheckForUpdate.mockImplementation(() => ({
      error: null,
      updateAvailable: true,
      updateReady: false,
      version: "2.0.0",
    }));

    startBackgroundChecks();
    jest.advanceTimersByTime(5000);

    // Allow async handlers to flush
    await Promise.resolve();
    await Promise.resolve();

    expect(mockCheckForUpdate).toHaveBeenCalled();
    expect(mockDownloadUpdate).toHaveBeenCalled();
  });

  test("notifies webview when update is ready", async () => {
    const notifyCallback = mock(() => {});
    setNotifyWebview(notifyCallback);
    mockCheckForUpdate.mockClear();
    mockDownloadUpdate.mockClear();

    mockCheckForUpdate
      .mockImplementationOnce(() => ({
        error: null,
        updateAvailable: true,
        updateReady: false,
        version: "2.0.0",
      }))
      .mockImplementationOnce(() => ({
        error: null,
        updateAvailable: true,
        updateReady: true,
        version: "2.0.0",
      }));

    startBackgroundChecks();
    jest.advanceTimersByTime(5000);

    // Allow async handlers to flush
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(notifyCallback).toHaveBeenCalledWith("2.0.0");
  });
});

// ─── composeAppInfo (the About screen's payload) ────────────────────────────

/*
 * The wording used to live in the electrobun webview, which is why the chromium launcher — with no
 * updater to call — could not answer the About screen at all. It is composed on the Bun side now,
 * so each launcher says only what its own build can know.
 */
describe("composeAppInfo", () => {
  test("carries version, channel and hash from the local info", async () => {
    mockCheckForUpdate.mockImplementationOnce(() => ({
      error: null,
      updateAvailable: false,
      updateReady: false,
      version: null,
    }));
    await checkForUpdate();
    const info = await composeAppInfo();
    expect(info).toEqual({
      channel: "stable",
      hash: "abc123",
      updateStatus: "Up to date",
      version: "1.0.0",
    });
  });

  test("names an available update, then a ready one", async () => {
    mockCheckForUpdate.mockImplementationOnce(() => ({
      error: null,
      updateAvailable: true,
      updateReady: false,
      version: "1.1.0",
    }));
    await checkForUpdate();
    const available = await composeAppInfo();
    expect(available.updateStatus).toBe("Update available (1.1.0)");

    mockCheckForUpdate.mockImplementationOnce(() => ({
      error: null,
      updateAvailable: true,
      updateReady: true,
      version: "1.1.0",
    }));
    await checkForUpdate();
    const ready = await composeAppInfo();
    expect(ready.updateStatus).toBe("Update ready (1.1.0)");
  });

  test("a version-less update is named rather than hidden", async () => {
    mockCheckForUpdate.mockImplementationOnce(() => ({
      error: null,
      updateAvailable: true,
      updateReady: false,
      version: null,
    }));
    await checkForUpdate();
    const info = await composeAppInfo();
    expect(info.updateStatus).toBe("Update available (?)");
  });

  test("reports a failed check instead of claiming to be up to date", async () => {
    mockCheckForUpdate.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    await checkForUpdate();
    const info = await composeAppInfo();
    expect(info.updateStatus).toBe("Update check failed: boom");
  });
});
