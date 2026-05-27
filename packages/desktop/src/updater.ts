import { Updater } from "electrobun/bun";

export interface UpdateStatus {
  version: string | null;
  updateAvailable: boolean;
  updateReady: boolean;
  error: string | null;
}

let cachedStatus: UpdateStatus = {
  version: null,
  updateAvailable: false,
  updateReady: false,
  error: null,
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
      version: info.version,
      updateAvailable: info.updateAvailable,
      updateReady: info.updateReady,
      error: info.error || null,
    };
  } catch (e: unknown) {
    cachedStatus = { ...cachedStatus, error: e instanceof Error ? e.message : String(e) };
  }
  return cachedStatus;
}

export async function downloadUpdate(): Promise<UpdateStatus> {
  try {
    await Updater.downloadUpdate();
    const info = await Updater.checkForUpdate();
    cachedStatus = {
      version: info.version,
      updateAvailable: info.updateAvailable,
      updateReady: info.updateReady,
      error: info.error || null,
    };
  } catch (e: unknown) {
    cachedStatus = { ...cachedStatus, error: e instanceof Error ? e.message : String(e) };
  }
  return cachedStatus;
}

export async function applyUpdate(): Promise<void> {
  await Updater.applyUpdate();
}

export function getStatus(): UpdateStatus {
  return cachedStatus;
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
