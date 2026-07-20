/**
 * Project-catalogue cache tests: hydration from the optional platform.listProjects member,
 * synchronous reads, and graceful degradation when the member is absent or failing.
 */
import { installMockPlatform } from "./harness";
import { beforeEach, describe, expect, test } from "bun:test";
import type { ProjectListEntry } from "../src/types";

const {
  getProjectList,
  hydrateProjectList,
  platformListsProjects,
  resetProjectList,
  seedProjectList,
} = await import("../src/project-list");

const ENTRIES: ProjectListEntry[] = [
  { name: "Site A", root: "sites/a", description: "sites/a" },
  { name: "Site B", root: "acme/site-b", description: "write access" },
];

beforeEach(() => {
  resetProjectList();
});

describe("platformListsProjects", () => {
  test("true when the platform provides listProjects", () => {
    installMockPlatform({ listProjects: () => Promise.resolve(ENTRIES) });
    expect(platformListsProjects()).toBe(true);
  });

  test("false when the member is absent", () => {
    installMockPlatform();
    expect(platformListsProjects()).toBe(false);
  });
});

describe("hydrateProjectList / getProjectList", () => {
  test("hydrates the cache and serves synchronous reads", async () => {
    installMockPlatform({ listProjects: () => Promise.resolve(ENTRIES) });
    expect(getProjectList()).toEqual([]);
    await hydrateProjectList();
    expect(getProjectList()).toEqual(ENTRIES);
  });

  test("resolves to an empty cache when the platform lacks the member", async () => {
    installMockPlatform();
    await hydrateProjectList();
    expect(getProjectList()).toEqual([]);
  });

  test("swallows listProjects failures and leaves the section hidden", async () => {
    installMockPlatform({ listProjects: () => Promise.reject(new Error("boom")) });
    await hydrateProjectList();
    expect(getProjectList()).toEqual([]);
  });

  test("seedProjectList stages a catalogue without a platform round-trip", async () => {
    installMockPlatform({ listProjects: () => Promise.resolve(ENTRIES) });
    seedProjectList([ENTRIES[1]!]);
    expect(getProjectList()).toEqual([ENTRIES[1]!]);
    // A later hydration overwrites the staged catalogue with platform truth.
    await hydrateProjectList();
    expect(getProjectList()).toEqual(ENTRIES);
  });

  test("re-hydration replaces stale entries and reset clears them", async () => {
    let batch = ENTRIES;
    installMockPlatform({ listProjects: () => Promise.resolve(batch) });
    await hydrateProjectList();
    expect(getProjectList()).toHaveLength(2);
    batch = [ENTRIES[0]!];
    await hydrateProjectList();
    expect(getProjectList()).toEqual([ENTRIES[0]!]);
    resetProjectList();
    expect(getProjectList()).toEqual([]);
  });
});
