/// <reference lib="dom" />
/**
 * Ensure the active project's dependencies are installed before the editor loads. When the backend
 * reports node_modules is missing, run `bun install` behind a blocking progress modal so component
 * and format resolution see the real dependency tree. No-op on platforms without package support.
 */

import { getPlatform } from "../platform";
import { showProgressModal } from "../ui/progress-modal";

export async function ensureDependenciesInstalled(): Promise<void> {
  const platform = getPlatform();
  if (!platform.dependenciesNeedInstall || !platform.installDependencies) {
    return;
  }
  let needs = false;
  try {
    needs = await platform.dependenciesNeedInstall();
  } catch {
    return;
  }
  if (!needs) {
    return;
  }
  const progress = showProgressModal({
    status: "Running bun install…",
    title: "Installing dependencies",
  });
  try {
    const result = await platform.installDependencies();
    if (result.ok) {
      progress.done();
    } else {
      progress.fail(result.log ?? "bun install failed");
    }
  } catch (error) {
    progress.fail(error instanceof Error ? error.message : String(error));
  }
}
