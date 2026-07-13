/**
 * Account onboarding status — a synchronous render cache over the optional
 * `platform.getAccountStatus` PAL member (cloud GitHub-App installations). Hydrated once at boot
 * (studio.ts) like the project-list cache; the welcome screen reads it synchronously to prompt
 * "install the GitHub App" when the user has no repository access yet.
 */
import { getPlatform, hasPlatform } from "./platform";
import type { AccountStatus } from "./types";

let cache: AccountStatus | null = null;

/** Refresh the cache from the platform; null when unsupported, failing, or unknown. */
export async function hydrateAccountStatus(): Promise<void> {
  if (!hasPlatform() || typeof getPlatform().getAccountStatus !== "function") {
    cache = null;
    return;
  }
  try {
    cache = (await getPlatform().getAccountStatus?.()) ?? null;
  } catch {
    // Onboarding prompts are progressive enhancement; unknown status never nags.
    cache = null;
  }
}

/** Synchronous snapshot for render paths (never awaits); null = unknown. */
export function getAccountStatus(): AccountStatus | null {
  return cache;
}

/** True when the account verifiably has no repository access yet and we know where to fix it. */
export function needsAppInstall(): boolean {
  return cache !== null && cache.installations.length === 0 && Boolean(cache.appInstallUrl);
}

/** Reset seam for tests. */
export function resetAccountStatus(): void {
  cache = null;
}
