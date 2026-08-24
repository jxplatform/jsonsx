import { Updater } from "electrobun/main";
import type { AppInfo } from "@jxsuite/protocol";

export interface UpdateStatus {
  version: string | null;
  updateAvailable: boolean;
  updateReady: boolean;
  error: string | null;
}

let cachedStatus: UpdateStatus = {
  error: null,
  updateAvailable: false,
  updateReady: false,
  version: null,
};

let notifyWebview: ((version: string) => void) | null = null;

export function setNotifyWebview(fn: (version: string) => void) {
  notifyWebview = fn;
}

export async function getLocalInfo() {
  return Updater.getLocalInfo();
}

export async function checkForUpdate(): Promise<UpdateStatus> {
  try {
    const info = await Updater.checkForUpdate();
    cachedStatus = {
      error: info.error || null,
      updateAvailable: info.updateAvailable,
      updateReady: info.updateReady,
      version: info.version,
    };
  } catch (error: unknown) {
    cachedStatus = {
      ...cachedStatus,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  return cachedStatus;
}

export async function downloadUpdate(): Promise<UpdateStatus> {
  try {
    await Updater.downloadUpdate();
    const info = await Updater.checkForUpdate();
    cachedStatus = {
      error: info.error || null,
      updateAvailable: info.updateAvailable,
      updateReady: info.updateReady,
      version: info.version,
    };
  } catch (error: unknown) {
    cachedStatus = {
      ...cachedStatus,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  return cachedStatus;
}

export async function applyUpdate(): Promise<void> {
  await Updater.applyUpdate();
}

export function getStatus(): UpdateStatus {
  return cachedStatus;
}

/**
 * Version, channel, commit and a human-readable update status for the About screen.
 *
 * Composed here rather than in the webview so that both launchers answer one request with one
 * shape, and each says only what its own build can know — this one has an update feed, and the
 * system-packaged chromium build (`chromium/app-info.ts`) does not.
 */
export async function composeAppInfo(): Promise<AppInfo> {
  const info = await getLocalInfo();
  const status = getStatus();
  const updateStatus = status.error
    ? `Update check failed: ${status.error}`
    : status.updateReady
      ? `Update ready (${status.version ?? "?"})`
      : status.updateAvailable
        ? `Update available (${status.version ?? "?"})`
        : "Up to date";
  return {
    channel: info.channel,
    hash: info.hash,
    updateStatus,
    version: info.version,
  };
}

export function startBackgroundChecks() {
  setTimeout(() => backgroundCheck(), 5000);
  setInterval(() => backgroundCheck(), 4 * 60 * 60 * 1000);
}

async function backgroundCheck() {
  await checkForUpdate();
  if (cachedStatus.updateAvailable && !cachedStatus.updateReady) {
    await downloadUpdate();
  }
  if (cachedStatus.updateReady && cachedStatus.version && notifyWebview) {
    notifyWebview(cachedStatus.version);
  }
}
