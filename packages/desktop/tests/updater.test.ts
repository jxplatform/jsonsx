import { describe, test, expect, mock, beforeEach, afterEach, jest } from "bun:test";

const mockGetLocalInfo = mock(() => ({
  version: "1.0.0",
  hash: "abc123",
  baseUrl: "https://updates.example.com",
  channel: "stable",
  name: "JSONsx Studio",
  identifier: "com.jsonsx.studio",
}));

const mockCheckForUpdate = mock(() => ({
  version: "1.1.0",
  updateAvailable: true,
  updateReady: false,
  error: null,
}));

const mockDownloadUpdate = mock(() => {});
const mockApplyUpdate = mock(() => {});

mock.module("electrobun/bun", () => ({
  Updater: {
    getLocalInfo: mockGetLocalInfo,
    checkForUpdate: mockCheckForUpdate,
    downloadUpdate: mockDownloadUpdate,
    applyUpdate: mockApplyUpdate,
  },
  Utils: { openFileDialog: async () => [] },
  BrowserWindow: class {},
  Electrobun: { start: () => {} },
}));

const {
  getLocalInfo,
  checkForUpdate,
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
      version: "1.1.0",
      updateAvailable: true,
      updateReady: true,
      error: null,
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
      version: "2.0.0",
      updateAvailable: true,
      updateReady: false,
      error: null,
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
        version: "2.0.0",
        updateAvailable: true,
        updateReady: false,
        error: null,
      }))
      .mockImplementationOnce(() => ({
        version: "2.0.0",
        updateAvailable: true,
        updateReady: true,
        error: null,
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
