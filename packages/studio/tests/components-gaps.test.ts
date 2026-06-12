/** Gap coverage for src/files/components.ts — loadComponentRegistry (lines 18-23). */
import { installMockPlatform, resetStudioState } from "./harness";
import { beforeEach, describe, expect, test } from "bun:test";
import { setProjectState } from "../src/store";
import * as components from "../src/files/components";
import type { ComponentMeta } from "../src/types";

describe("loadComponentRegistry", () => {
  beforeEach(() => {
    setProjectState(null);
  });

  test("populates the registry from platform discovery, scoped to projectRoot", async () => {
    resetStudioState({ projectRoot: "my-site" });
    const discovered = [
      { name: "Card", path: "components/card.json" },
      { name: "Nav", path: "components/nav.json" },
    ] as unknown as ComponentMeta[];
    const { state } = installMockPlatform({
      discoverComponents: async (dir?: string) => {
        state.calls.push(["discoverComponents", dir]);
        return discovered;
      },
    });

    await components.loadComponentRegistry();

    expect(components.componentRegistry).toEqual(discovered);
    expect(components._componentRegistryLoaded).toBe(true);
    expect(state.calls).toContainEqual(["discoverComponents", "my-site"]);
  });

  test("passes undefined scope when no project state is set", async () => {
    const { state } = installMockPlatform({
      discoverComponents: async (dir?: string) => {
        state.calls.push(["discoverComponents", dir]);
        return [];
      },
    });

    await components.loadComponentRegistry();

    expect(state.calls).toContainEqual(["discoverComponents", undefined]);
    expect(components.componentRegistry).toEqual([]);
  });

  test("falsy projectRoot falls back to undefined scope", async () => {
    resetStudioState({ projectRoot: "" });
    const { state } = installMockPlatform({
      discoverComponents: async (dir?: string) => {
        state.calls.push(["discoverComponents", dir]);
        return [];
      },
    });

    await components.loadComponentRegistry();

    expect(state.calls).toContainEqual(["discoverComponents", undefined]);
  });

  test("keeps the previous registry and still marks loaded when discovery fails", async () => {
    resetStudioState({ projectRoot: "site" });
    const seeded = [{ name: "Keep", path: "components/keep.json" }] as unknown as ComponentMeta[];
    installMockPlatform({ discoverComponents: async () => seeded });
    await components.loadComponentRegistry();
    expect(components.componentRegistry).toEqual(seeded);

    installMockPlatform({
      discoverComponents: async () => {
        throw new Error("discovery offline");
      },
    });

    await components.loadComponentRegistry();

    expect(components.componentRegistry).toEqual(seeded);
    expect(components._componentRegistryLoaded).toBe(true);
  });
});
