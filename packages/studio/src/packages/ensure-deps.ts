/// <reference lib="dom" />
/**
 * Ensure the active project's dependencies are installed before the editor loads. When the backend
 * reports node_modules is missing, run `bun install` behind a blocking progress modal so component
 * and format resolution see the real dependency tree. No-op on platforms without package support.
 *
 * It REPORTS whether an install actually ran, because "format resolution sees the real dependency
 * tree" was only half true: project activation fetches the format registry before calling this, and
 * `loadFormats` memoises its answer — so on a fresh clone the empty registry it got survived the
 * whole session, and the New File picker offered nothing but JSON in a project whose `project.json`
 * enables the markdown extension. The caller re-fetches on a true.
 */

import { getPlatform } from "../platform";
import { showProgressModal } from "../ui/progress-modal";
import { shouldInstallAutomation } from "../services/automation";

export async function ensureDependenciesInstalled(): Promise<boolean> {
  // Automation/screenshot runs open projects read-only to drive the canvas — they must never mutate
  // The project on disk (a `bun install` would litter node_modules/bun.lock into starter templates).
  if (shouldInstallAutomation(location.search)) {
    return false;
  }
  const platform = getPlatform();
  if (!platform.dependenciesNeedInstall || !platform.installDependencies) {
    return false;
  }
  let needs = false;
  try {
    needs = await platform.dependenciesNeedInstall();
  } catch {
    return false;
  }
  if (!needs) {
    return false;
  }
  const progress = showProgressModal({
    status: "Running bun install…",
    title: "Installing dependencies",
  });
  try {
    const result = await platform.installDependencies();
    if (result.ok) {
      progress.done();
      return true;
    }
    progress.fail(result.log ?? "bun install failed");
  } catch (error) {
    progress.fail(error instanceof Error ? error.message : String(error));
  }
  return false;
}
