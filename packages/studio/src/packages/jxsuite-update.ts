/// <reference lib="dom" />
/**
 * On project open, offer to bring the project's `@jxsuite/*` dependencies up to their newest
 * PUBLISHED versions — each package to its own latest, asked of the npm registry.
 *
 * It used to target `VERSION`, the version this Studio build embeds, and bump every `@jxsuite/*`
 * range to `^VERSION` in one move. That was right exactly once: when the whole suite released
 * together, so "the version Studio is" and "the newest version of each package" were the same
 * string. They are not any more — the packages release on their own cadences, and `@jxsuite/parser`
 * being at 1.2.0 while Studio is 2.0.1 is the normal case, not a fault. Targeting the embedded
 * version therefore proposed a version that may never have been published, for a package whose real
 * latest it had not looked at.
 *
 * **Studio's own copies are not involved.** The app resolves `@jxsuite/*` from its own install
 * (that is the hermetic host rule the schema loader enforces), so the project's ranges govern `jx
 * build` and the project's types — not the running app. There is no reason for them to match
 * Studio, and pinning them to it was the residue of an assumption that is no longer true.
 *
 * The registry lookup is `platform.outdatedPackages()`, the same seam the dependencies editor uses.
 * A host that does not offer it (the cloud session, which manages dependencies server-side) simply
 * gets no prompt: without the registry there is no honest target, and guessing is what this
 * replaced.
 */

import { html } from "lit-html";
import { getPlatform } from "../platform";
import { shouldInstallAutomation } from "../services/automation";
import { showConfirmDialog } from "../ui/layers";
import { showProgressModal } from "../ui/progress-modal";
import { notify } from "../services/notify";
import { isUpgrade } from "./semver";

const JXSUITE_PREFIX = "@jxsuite/";

export interface JxsuiteUpdate {
  name: string;
  /** The range pinned in package.json, e.g. `^1.2.0`. */
  current: string;
  /** THIS package's newest published version — not a suite-wide number. */
  latest: string;
  dev: boolean;
}

/**
 * The project's `@jxsuite/*` dependencies that are behind their own newest published version.
 *
 * Empty when there is nothing to do, when the host cannot reach the registry, or when it offers no
 * lookup at all. Every failure path is empty rather than thrown: this runs on project open, and a
 * registry that is unreachable on a train is not an error the author needs to see.
 */
export async function checkJxsuiteUpdate(): Promise<JxsuiteUpdate[]> {
  const platform = getPlatform();
  if (!platform.outdatedPackages) {
    return [];
  }
  let reported;
  try {
    reported = await platform.outdatedPackages();
  } catch {
    return [];
  }
  const outdated: JxsuiteUpdate[] = [];
  for (const p of reported) {
    /*
     * `isUpgrade`, not merely "differs from latest". `outdatedPackages` reports any difference, and
     * a project deliberately pinned AHEAD of the registry — a prerelease, or a range bumped before
     * the publish landed — would otherwise be offered a downgrade described as an update.
     */
    if (p.name.startsWith(JXSUITE_PREFIX) && isUpgrade(p.current, p.latest)) {
      outdated.push({ current: p.current, dev: Boolean(p.dev), latest: p.latest, name: p.name });
    }
  }
  return outdated;
}

/**
 * The dismissal is remembered against the exact set of versions declined.
 *
 * It used to be keyed on the single target version, which no longer exists. Keying on the set means
 * a later publish of any one package asks again — which is the behaviour you want from "not now",
 * and the reason this is not keyed on the project alone.
 */
function dismissKey(root: string, outdated: JxsuiteUpdate[]): string {
  const signature = outdated
    .map((p) => `${p.name}@${p.latest}`)
    .toSorted()
    .join(",");
  return `jx:jxsuite-update-dismissed:${root}:${signature}`;
}

function isDismissed(root: string, outdated: JxsuiteUpdate[]): boolean {
  try {
    return localStorage.getItem(dismissKey(root, outdated)) === "1";
  } catch {
    return false;
  }
}

function setDismissed(root: string, outdated: JxsuiteUpdate[]): void {
  try {
    localStorage.setItem(dismissKey(root, outdated), "1");
  } catch {
    /* Ignore storage errors */
  }
}

/** Pin each package to `^<its own latest>` and reinstall, behind a progress modal. */
export async function applyJxsuiteUpdate(outdated: JxsuiteUpdate[]): Promise<void> {
  const platform = getPlatform();
  if (!platform.setPackageVersions || outdated.length === 0) {
    return;
  }
  const progress = showProgressModal({
    status: "Updating @jxsuite packages…",
    title: "Updating dependencies",
  });
  try {
    const result = await platform.setPackageVersions(
      // Per package. One shared `^${target}` for all of them is the bug this module was refactored
      // To remove.
      outdated.map((p) => ({ dev: p.dev, name: p.name, version: `^${p.latest}` })),
    );
    if (result.ok) {
      progress.done();
      notify.success(`Updated ${outdated.length} @jxsuite package(s) to their latest versions.`);
    } else {
      progress.fail(result.log ?? "Update failed");
    }
  } catch (error) {
    progress.fail(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Prompt to update on open. Skips when there is nothing to do or the user already declined this
 * exact set of versions for this project (remembered in localStorage).
 */
export async function maybePromptJxsuiteUpdate(projectRoot: string): Promise<void> {
  // Automation/screenshot runs open projects read-only to drive the canvas — the same rule
  // Ensure-deps.ts states, and for the same reason: confirming here calls `setPackageVersions`,
  // Which rewrites the opened project's package.json.
  //
  // It also has to hold when nobody confirms anything. `showConfirmDialog` renders an
  // `<sp-dialog-wrapper open underlay>`, and an underlay swallows every pointer event across the
  // Viewport — so a prompt raised at boot means every subsequent click in a shot lands in a scrim.
  // That is not hypothetical: it put this dialog into the middle of 33 committed screenshots,
  // Including docs/images/hero.png, which is the jxsuite.com marketing hero.
  //
  // Correct pins are NOT sufficient on their own. `outdatedPackages` compares the range's base
  // Version against the registry's `latest` (packages/server/src/packages.ts: `latest ===
  // StripRange(p.version)`), not whether the range resolves it — so a project pinned `^1.4.1` is
  // "outdated" the moment 1.4.2 publishes, and every starter shot would be scrimmed again by the
  // Next patch release of any @jxsuite package.
  if (shouldInstallAutomation(location.search)) {
    return;
  }
  const platform = getPlatform();
  if (!platform.setPackageVersions) {
    return;
  }
  const outdated = await checkJxsuiteUpdate();
  if (outdated.length === 0 || isDismissed(projectRoot, outdated)) {
    return;
  }
  const list = outdated.map((p) => `${p.name} ${p.current} → ^${p.latest}`).join("\n");
  const confirmed = await showConfirmDialog(
    "Update @jxsuite packages?",
    html`Newer versions of these packages have been published. Update the project to them?
      <br /><br /><span
        style="font-size:var(--spectrum-font-size-75, 12px);color:var(--fg-dim);white-space:pre-line"
        >${list}</span
      >`,
    { cancelLabel: "Not now", confirmLabel: "Update" },
  );
  if (!confirmed) {
    setDismissed(projectRoot, outdated);
    return;
  }
  await applyJxsuiteUpdate(outdated);
}
