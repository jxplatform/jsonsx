/// <reference lib="dom" />
/**
 * Pull orchestration that keeps project sync from being blocked by Studio's own automated package
 * updates. The on-open @jxsuite update rewrites package.json and bun.lock without committing, so a
 * teammate pushing the same update makes a later `git pull` refuse to merge. Since those local
 * changes are machine-generated and reproducible, we discard them, pull, and re-run the package
 * sync (re-apply the update if the pulled project is still behind, or `bun install` if the pull
 * brought it). Detection is state-based (git status + content comparison against `@{u}`), never git
 * stderr parsing, so it works identically across backends and locales.
 */

import { errorMessage } from "@jxsuite/schema/parse";
import { getPlatform } from "../platform";
import { showConfirmDialog } from "../ui/layers";
import { showProgressModal } from "../ui/progress-modal";
import { statusMessage } from "../panels/statusbar";
import { applyJxsuiteUpdate, checkJxsuiteUpdate } from "./jxsuite-update";
import type { GitStatusResult } from "../types";

const PKG_PATHS = ["package.json", "bun.lock", "bun.lockb"];

/** Untracked markers across backends: desktop porcelain v1 emits "??", server porcelain v2 "U". */
const UNTRACKED_STATUSES = new Set(["??", "U"]);

/** Above this many dirty files, skip the per-file upstream comparison and leave the error as-is. */
const MAX_CONFLICT_SCAN = 25;

const JXSUITE_PREFIX = "@jxsuite/";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortKeys(entry));
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).toSorted()) {
      out[key] = sortKeys(value[key]);
    }
    return out;
  }
  return value;
}

/** Replace every @jxsuite/* version in dependencies/devDependencies so they compare equal. */
function maskJxsuiteVersions(pkg: Record<string, unknown>): Record<string, unknown> {
  const out = { ...pkg };
  for (const section of ["dependencies", "devDependencies"]) {
    const deps = out[section];
    if (!isRecord(deps)) {
      continue;
    }
    const masked = { ...deps };
    for (const name of Object.keys(masked)) {
      if (name.startsWith(JXSUITE_PREFIX)) {
        masked[name] = "*";
      }
    }
    out[section] = masked;
  }
  return out;
}

/**
 * True when the working package.json differs from the HEAD copy only in the version strings of
 * jxsuite-scoped entries — i.e. exactly what Studio's automated update writes. Added/removed deps
 * or any other edit means a human touched the file.
 */
export function isAutomatedPackageDiff(
  headText: string | null,
  workingText: string | null,
): boolean {
  if (headText === null || workingText === null) {
    return false;
  }
  let head: unknown;
  let working: unknown;
  try {
    head = JSON.parse(headText);
    working = JSON.parse(workingText);
  } catch {
    return false;
  }
  if (!isRecord(head) || !isRecord(working)) {
    return false;
  }
  return (
    JSON.stringify(sortKeys(maskJxsuiteVersions(head))) ===
    JSON.stringify(sortKeys(maskJxsuiteVersions(working)))
  );
}

async function tryShow(path: string, ref: string): Promise<string | null> {
  try {
    return await getPlatform().gitShow({ path, ref });
  } catch {
    return null;
  }
}

async function tryRead(path: string): Promise<string | null> {
  try {
    return await getPlatform().readFile(path);
  } catch {
    return null;
  }
}

export interface PackagePullPlan {
  /** Tracked dirty package files whose upstream (@{u}) content differs from HEAD. */
  discard: string[];
  /** Untracked package files that exist at @{u} ("untracked would be overwritten" case). */
  removeUntracked: string[];
  /** Whether the package.json working copy diverges from HEAD only by automated @jxsuite bumps. */
  automated: boolean;
}

/**
 * Decide which local package files stand in the way of a merge. Only files the upstream actually
 * changed can block the pull, so files whose @{u} content matches HEAD are left alone.
 */
export async function planPackageDiscard(status: GitStatusResult): Promise<PackagePullPlan> {
  const discard: string[] = [];
  const removeUntracked: string[] = [];
  let automated = true;
  for (const path of PKG_PATHS) {
    const entries = status.files.filter((f) => f.path === path);
    if (entries.length === 0) {
      continue;
    }
    const upstream = await tryShow(path, "@{u}");
    if (entries.every((f) => UNTRACKED_STATUSES.has(f.status))) {
      if (upstream !== null) {
        removeUntracked.push(path);
      }
      continue;
    }
    const head = await tryShow(path, "HEAD");
    if (upstream === null || upstream === head) {
      continue;
    }
    discard.push(path);
    if (path === "package.json") {
      automated &&= isAutomatedPackageDiff(head, await tryRead(path));
    }
  }
  return { automated, discard, removeUntracked };
}

function planIsEmpty(plan: PackagePullPlan): boolean {
  return plan.discard.length === 0 && plan.removeUntracked.length === 0;
}

/** True when a dirty non-package file also differs upstream — recovery can't unblock that pull. */
async function otherFilesConflict(status: GitStatusResult): Promise<boolean> {
  const paths = [
    ...new Set(status.files.filter((f) => !PKG_PATHS.includes(f.path)).map((f) => f.path)),
  ];
  if (paths.length > MAX_CONFLICT_SCAN) {
    return true;
  }
  for (const path of paths) {
    const upstream = await tryShow(path, "@{u}");
    if (upstream !== null && upstream !== (await tryShow(path, "HEAD"))) {
      return true;
    }
  }
  return false;
}

async function applyDiscard(plan: PackagePullPlan): Promise<void> {
  const platform = getPlatform();
  if (plan.discard.length > 0) {
    // Unstage unconditionally: desktop porcelain v1 doesn't report a staged flag.
    // Restoring an unstaged tracked file is a no-op.
    await platform.gitUnstage(plan.discard);
    await platform.gitDiscard(plan.discard);
  }
  for (const path of plan.removeUntracked) {
    await platform.deleteFile(path);
  }
}

/**
 * Bring packages back in line after a pull that touched (or followed a discard of) package files:
 * re-apply the @jxsuite update if the pulled project is still behind, otherwise `bun install` so
 * node_modules matches the pulled lockfile. Never throws — a successful pull must not turn into an
 * error banner; failures surface through the progress modal.
 */
async function syncPackagesAfterPull(): Promise<void> {
  const platform = getPlatform();
  let check: Awaited<ReturnType<typeof checkJxsuiteUpdate>> = null;
  try {
    check = await checkJxsuiteUpdate();
  } catch {
    check = null;
  }
  if (check && platform.setPackageVersions) {
    // No re-prompt: the discarded local changes came from an update the user already accepted.
    await applyJxsuiteUpdate(check.outdated, check.target);
    return;
  }
  if (!platform.installDependencies) {
    return;
  }
  const progress = showProgressModal({
    status: "Running bun install…",
    title: "Syncing dependencies",
  });
  try {
    const result = await platform.installDependencies();
    if (result.ok) {
      progress.done();
    } else {
      progress.fail(result.log ?? "bun install failed");
    }
  } catch (error) {
    progress.fail(errorMessage(error));
  }
}

/**
 * Discard per plan, pull, and re-sync. A discard is always followed by a package re-sync — even
 * when the pull fails — so the project is never stranded without the update it had before.
 */
async function discardPullAndSync(plan: PackagePullPlan): Promise<void> {
  const platform = getPlatform();
  try {
    await applyDiscard(plan);
  } catch (error) {
    throw new Error(`Could not reset local package files: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  try {
    await platform.gitPull();
  } catch (error) {
    await syncPackagesAfterPull();
    throw error;
  }
  statusMessage("Local package updates were superseded by pulled changes");
  await syncPackagesAfterPull();
}

async function recoverAfterFailedPull(original: unknown): Promise<void> {
  const platform = getPlatform();
  let status: GitStatusResult;
  try {
    status = await platform.gitStatus();
  } catch {
    throw original;
  }
  if (!(status.behind > 0)) {
    throw original;
  }
  const plan = await planPackageDiscard(status);
  if (planIsEmpty(plan) || (await otherFilesConflict(status))) {
    throw original;
  }
  if (!plan.automated) {
    const confirmed = await showConfirmDialog(
      "Discard local package changes?",
      "package.json / bun.lock have local edits that conflict with incoming changes. Discard them, pull, and re-sync packages?",
      { confirmLabel: "Discard and pull", destructive: true },
    );
    if (!confirmed) {
      throw original;
    }
  }
  await discardPullAndSync(plan);
}

/**
 * Snapshot the package files (aligned to PKG_PATHS). Lists the root once and reads only the files
 * that exist, so absent lockfiles (cloud projects don't commit one) never trigger a console 404
 * from a blind read. Listing failure falls back to probing all paths.
 */
/**
 * Snapshot the package files (aligned to PKG_PATHS). Lists the root once and reads only the files
 * that exist, so absent lockfiles (cloud projects don't commit one) never trigger a console 404
 * from a blind read. Listing failure falls back to probing all paths.
 */
async function snapshotPackageFiles(): Promise<(string | null)[]> {
  let present: Set<string>;
  try {
    const entries = await getPlatform().listDirectory("");
    present = new Set(entries.filter((e) => e.type === "file").map((e) => e.name));
  } catch {
    present = new Set(PKG_PATHS);
  }
  return Promise.all(
    PKG_PATHS.map((path) => (present.has(path) ? tryRead(path) : Promise.resolve(null))),
  );
}

/**
 * Pull with automatic recovery from conflicts caused by Studio's own package updates. Throws only
 * when the pull genuinely fails for reasons recovery can't (or shouldn't) fix.
 */
export async function pullWithPackageSync(): Promise<void> {
  const platform = getPlatform();
  const before = await snapshotPackageFiles();

  // Preemptive: fetch so `behind` is current, then reset automated package edits that would
  // Block the merge — manual package.json edits fall through to the plain pull + confirm path.
  let status: GitStatusResult | null = null;
  try {
    await platform.gitFetch();
    status = await platform.gitStatus();
  } catch {
    status = null; // Offline or status failure — the plain pull will report the real error
  }
  if (status && status.behind > 0) {
    const plan = await planPackageDiscard(status);
    if (!planIsEmpty(plan) && plan.automated) {
      await discardPullAndSync(plan);
      return;
    }
  }

  try {
    await platform.gitPull();
  } catch (error) {
    await recoverAfterFailedPull(error);
    return;
  }
  const after = await snapshotPackageFiles();
  if (before.some((content, i) => content !== after[i])) {
    await syncPackagesAfterPull();
  }
}

/**
 * Pull remote changes as soon as a project opens, ahead of the install check and update prompt, so
 * a session starts from the current remote state. Never throws and never blocks the open — failures
 * (offline, no upstream, unrelated conflicts) surface as a status message only.
 */
export async function autoSyncProjectOnOpen(): Promise<void> {
  const platform = getPlatform();
  let status: GitStatusResult;
  try {
    status = await platform.gitStatus();
  } catch {
    return;
  }
  if (!status?.isRepo || (status.remotes?.length ?? 0) === 0) {
    return;
  }
  statusMessage("Syncing project…");
  try {
    await pullWithPackageSync();
  } catch (error) {
    statusMessage(`Sync skipped: ${errorMessage(error)}`);
  }
}
