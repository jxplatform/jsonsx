/**
 * Project catalogue — a synchronous render cache over the optional `platform.listProjects` PAL
 * member (dev server sites, cloud platforms). Hydrated once at boot (studio.ts) like the
 * recent-projects cache; the welcome screen reads it synchronously.
 */
import { getPlatform, hasPlatform } from "./platform";
import type { ProjectListEntry } from "./types";

let cache: ProjectListEntry[] = [];

/** True when the active platform exposes a project catalogue. */
export function platformListsProjects(): boolean {
  return hasPlatform() && typeof getPlatform().listProjects === "function";
}

/** Refresh the cache from the platform; resolves to [] when unsupported or failing. */
export async function hydrateProjectList(): Promise<void> {
  if (!platformListsProjects()) {
    cache = [];
    return;
  }
  try {
    cache = (await getPlatform().listProjects?.()) ?? [];
  } catch {
    // Catalogue is progressive enhancement; a failed fetch leaves the section hidden.
    cache = [];
  }
}

/** Synchronous snapshot for render paths (never awaits). */
export function getProjectList(): ProjectListEntry[] {
  return cache;
}

/** Reset seam for tests. */
export function resetProjectList(): void {
  cache = [];
}
