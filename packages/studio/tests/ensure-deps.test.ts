/** Tests for src/packages/ensure-deps.ts — blocking install-on-open. */
import { flush, installMockPlatform } from "./harness";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { initLayers } from "../src/ui/layers";
import { ensureDependenciesInstalled } from "../src/packages/ensure-deps";

beforeAll(() => {
  for (const id of ["layer-popover", "layer-modal", "layer-dialog"]) {
    if (!document.querySelector(`#${id}`)) {
      const el = document.createElement("div");
      el.id = id;
      document.body.append(el);
    }
  }
  initLayers();
});

function card(): Element | null {
  return (document.querySelector("#layer-modal") as HTMLElement).querySelector(".progress-modal");
}

afterEach(() => {
  (document.querySelector("#layer-modal") as HTMLElement).innerHTML = "";
});

describe("ensureDependenciesInstalled", () => {
  test("no-op when the platform lacks package methods", async () => {
    installMockPlatform();
    await ensureDependenciesInstalled();
    expect(card()).toBeNull();
  });

  test("skips install when dependencies are already present", async () => {
    let installs = 0;
    installMockPlatform({
      dependenciesNeedInstall: async () => false,
      installDependencies: async () => {
        installs += 1;
        return { ok: true };
      },
    });
    await ensureDependenciesInstalled();
    expect(installs).toBe(0);
    expect(card()).toBeNull();
  });

  test("runs install behind a modal and closes on success", async () => {
    let installs = 0;
    installMockPlatform({
      dependenciesNeedInstall: async () => true,
      installDependencies: async () => {
        installs += 1;
        return { ok: true };
      },
    });
    await ensureDependenciesInstalled();
    await flush();
    expect(installs).toBe(1);
    expect(card()).toBeNull();
  });

  test("surfaces the failure log when install fails", async () => {
    installMockPlatform({
      dependenciesNeedInstall: async () => true,
      installDependencies: async () => ({ log: "EACCES denied", ok: false }),
    });
    await ensureDependenciesInstalled();
    await flush();
    expect(card()?.textContent).toContain("EACCES denied");
  });

  test("skips install entirely in automation mode (never mutates the project)", async () => {
    const { happyDOM } = globalThis as unknown as { happyDOM: { setURL: (u: string) => void } };
    happyDOM.setURL("http://localhost:3000/packages/studio/index.html?automation=1");
    let installs = 0;
    let checked = 0;
    installMockPlatform({
      dependenciesNeedInstall: async () => {
        checked += 1;
        return true;
      },
      installDependencies: async () => {
        installs += 1;
        return { ok: true };
      },
    });
    try {
      await ensureDependenciesInstalled();
      expect(checked).toBe(0);
      expect(installs).toBe(0);
      expect(card()).toBeNull();
    } finally {
      happyDOM.setURL("http://localhost:3000/packages/studio/index.html");
    }
  });

  test("swallows a throwing dependenciesNeedInstall", async () => {
    installMockPlatform({
      dependenciesNeedInstall: async () => {
        throw new Error("rpc down");
      },
      installDependencies: async () => ({ ok: true }),
    });
    await ensureDependenciesInstalled();
    expect(card()).toBeNull();
  });

  test("shows the failure view when install throws", async () => {
    installMockPlatform({
      dependenciesNeedInstall: async () => true,
      installDependencies: async () => {
        throw new Error("spawn ENOENT");
      },
    });
    await ensureDependenciesInstalled();
    await flush();
    expect(card()?.textContent).toContain("spawn ENOENT");
  });
});
