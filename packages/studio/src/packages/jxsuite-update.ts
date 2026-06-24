/// <reference lib="dom" />
/**
 * On project open, compare the project's `@jxsuite/*` dependency ranges to the version this Studio
 * build embeds (`VERSION`). If the project is behind, prompt the user to bump them to match and —
 * on confirm — rewrite the ranges and reinstall. The target is the embedded version (not npm
 * latest) so a project always lines up with the runtime/compiler the running app actually uses.
 */

import { html } from "lit-html";
import { getPlatform } from "../platform";
import { VERSION } from "../version";
import { showConfirmDialog } from "../ui/layers";
import { showProgressModal } from "../ui/progress-modal";
import { statusMessage } from "../panels/statusbar";
import { isComparable, isUpgrade } from "./semver";
import type { PackageInfo } from "../types";

const JXSUITE_PREFIX = "@jxsuite/";

export interface JxsuiteUpdate {
  name: string;
  current: string;
  dev: boolean;
}

/**
 * Compare the project's @jxsuite/* deps to the embedded version. Returns the packages behind the
 * target plus the target version, or null when there's nothing to do (dev build, no project, or all
 * already current/ahead).
 */
export async function checkJxsuiteUpdate(): Promise<{
  target: string;
  outdated: JxsuiteUpdate[];
} | null> {
  const target = VERSION;
  if (!isComparable(target)) {
    return null; // "dev" / non-semver build — no reliable target
  }
  const platform = getPlatform();
  let pkgs: PackageInfo[];
  try {
    pkgs = await platform.listPackages();
  } catch {
    return null;
  }
  const outdated: JxsuiteUpdate[] = [];
  for (const p of pkgs) {
    if (!p.name.startsWith(JXSUITE_PREFIX) || !isComparable(p.version)) {
      continue;
    }
    if (isUpgrade(p.version, target)) {
      outdated.push({ current: p.version, dev: Boolean(p.dev), name: p.name });
    }
  }
  return outdated.length > 0 ? { outdated, target } : null;
}

function dismissKey(root: string, target: string): string {
  return `jx:jxsuite-update-dismissed:${root}:${target}`;
}

function isDismissed(root: string, target: string): boolean {
  try {
    return localStorage.getItem(dismissKey(root, target)) === "1";
  } catch {
    return false;
  }
}

function setDismissed(root: string, target: string): void {
  try {
    localStorage.setItem(dismissKey(root, target), "1");
  } catch {
    /* Ignore storage errors */
  }
}

/** Apply a set of @jxsuite bumps to `^target` and reinstall, behind a progress modal. */
export async function applyJxsuiteUpdate(outdated: JxsuiteUpdate[], target: string): Promise<void> {
  const platform = getPlatform();
  if (!platform.setPackageVersions) {
    return;
  }
  const progress = showProgressModal({
    status: "Updating @jxsuite packages…",
    title: "Updating dependencies",
  });
  try {
    const result = await platform.setPackageVersions(
      outdated.map((p) => ({ dev: p.dev, name: p.name, version: `^${target}` })),
    );
    if (result.ok) {
      progress.done();
      statusMessage(`Updated ${outdated.length} @jxsuite package(s) to ${target}`);
    } else {
      progress.fail(result.log ?? "Update failed");
    }
  } catch (error) {
    progress.fail(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Prompt to update @jxsuite packages on open. Skips when there's nothing to do or the user already
 * declined this exact target for this project (remembered in localStorage).
 */
export async function maybePromptJxsuiteUpdate(projectRoot: string): Promise<void> {
  const platform = getPlatform();
  if (!platform.setPackageVersions) {
    return;
  }
  const check = await checkJxsuiteUpdate();
  if (!check || isDismissed(projectRoot, check.target)) {
    return;
  }
  const list = check.outdated.map((p) => `${p.name} ${p.current} → ^${check.target}`).join("\n");
  const confirmed = await showConfirmDialog(
    "Update @jxsuite packages?",
    html`This project uses older @jxsuite packages. Update them to match Studio ${check.target}?
      <br /><br /><span style="font-size:12px;color:var(--fg-dim);white-space:pre-line"
        >${list}</span
      >`,
    { cancelLabel: "Not now", confirmLabel: "Update" },
  );
  if (!confirmed) {
    setDismissed(projectRoot, check.target);
    return;
  }
  await applyJxsuiteUpdate(check.outdated, check.target);
}
