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

/** Where the user can widen the App's repository access, for the repo picker's access footer. */
export interface RepoAccessLinks {
  /** One entry per installation that reports its settings page, in the platform's order. */
  manage: { account: string; url: string }[];
  /** Install the App on an account that has none yet (also covers "another organization"). */
  installUrl?: string;
}

/**
 * Links that let the user grant the App access to more repositories: each installation's own
 * settings page plus the install URL for accounts it has not reached yet. Null when the status is
 * unknown (platform without `getAccountStatus`, or a failed hydrate) or when nothing is linkable —
 * callers render no access affordance rather than a dead link.
 */
export function getRepoAccessLinks(): RepoAccessLinks | null {
  if (cache === null) {
    return null;
  }
  const manage = cache.installations.flatMap((entry) =>
    entry.manageUrl
      ? [{ account: entry.account ?? `Installation ${entry.id}`, url: entry.manageUrl }]
      : [],
  );
  if (manage.length === 0 && !cache.appInstallUrl) {
    return null;
  }
  return { manage, ...(cache.appInstallUrl ? { installUrl: cache.appInstallUrl } : {}) };
}

/** Reset seam for tests. */
export function resetAccountStatus(): void {
  cache = null;
}
