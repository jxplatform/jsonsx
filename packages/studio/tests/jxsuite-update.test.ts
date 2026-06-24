/** Tests for src/packages/jxsuite-update.ts — the on-open @jxsuite update prompt. */
import { flush, installMockPlatform } from "./harness";
import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { initLayers } from "../src/ui/layers";

// Build-time VERSION is "dev" under test; pin it so the comparison logic is exercised.
void mock.module("../src/version", () => ({
  APP_NAME: "Jx Studio",
  BUILD_DATE: "",
  GIT_COMMIT: "test",
  LINKS: { docs: "", github: "", license: "" },
  VERSION: "0.30.1",
}));

const { applyJxsuiteUpdate, checkJxsuiteUpdate, maybePromptJxsuiteUpdate } =
  await import("../src/packages/jxsuite-update");

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

function dialog(): HTMLElement | null {
  return document.querySelector("#layer-dialog sp-dialog-wrapper");
}

function progressCard(): Element | null {
  return (document.querySelector("#layer-modal") as HTMLElement).querySelector(".progress-modal");
}

afterEach(() => {
  localStorage.clear();
  (document.querySelector("#layer-dialog") as HTMLElement).innerHTML = "";
  (document.querySelector("#layer-modal") as HTMLElement).innerHTML = "";
});

describe("checkJxsuiteUpdate", () => {
  test("reports @jxsuite deps behind the embedded version", async () => {
    installMockPlatform({
      listPackages: async () => [
        { dev: true, name: "@jxsuite/compiler", version: "^0.19.0" },
        { name: "@jxsuite/runtime", version: "^0.30.1" },
        { name: "hono", version: "^4.0.0" },
      ],
    });
    const check = await checkJxsuiteUpdate();
    expect(check?.target).toBe("0.30.1");
    expect(check?.outdated.map((o) => o.name)).toEqual(["@jxsuite/compiler"]);
    expect(check?.outdated[0]?.dev).toBe(true);
  });

  test("returns null when all @jxsuite deps are current/ahead", async () => {
    installMockPlatform({
      listPackages: async () => [{ name: "@jxsuite/runtime", version: "^0.31.0" }],
    });
    expect(await checkJxsuiteUpdate()).toBeNull();
  });

  test("returns null when listPackages throws", async () => {
    installMockPlatform({
      listPackages: async () => {
        throw new Error("registry down");
      },
    });
    expect(await checkJxsuiteUpdate()).toBeNull();
  });
});

describe("maybePromptJxsuiteUpdate", () => {
  test("confirm applies the bump to ^target via setPackageVersions", async () => {
    let received: unknown;
    installMockPlatform({
      listPackages: async () => [{ dev: true, name: "@jxsuite/compiler", version: "^0.19.0" }],
      setPackageVersions: async (u) => {
        received = u;
        return { ok: true };
      },
    });
    const p = maybePromptJxsuiteUpdate("/project");
    await flush();
    const d = dialog();
    expect(d).not.toBeNull();
    d?.dispatchEvent(new Event("confirm"));
    await p;
    await flush();
    expect(received).toEqual([{ dev: true, name: "@jxsuite/compiler", version: "^0.30.1" }]);
  });

  test("cancel records dismissal and skips the prompt next time", async () => {
    installMockPlatform({
      listPackages: async () => [{ name: "@jxsuite/runtime", version: "^0.19.0" }],
      setPackageVersions: async () => ({ ok: true }),
    });
    const p = maybePromptJxsuiteUpdate("/project");
    await flush();
    dialog()?.dispatchEvent(new Event("cancel"));
    await p;
    expect(localStorage.getItem("jx:jxsuite-update-dismissed:/project:0.30.1")).toBe("1");

    (document.querySelector("#layer-dialog") as HTMLElement).innerHTML = "";
    await maybePromptJxsuiteUpdate("/project");
    await flush();
    expect(dialog()).toBeNull();
  });

  test("no-op when the platform cannot set versions", async () => {
    installMockPlatform({
      listPackages: async () => [{ name: "@jxsuite/runtime", version: "^0.19.0" }],
    });
    await maybePromptJxsuiteUpdate("/project");
    await flush();
    expect(dialog()).toBeNull();
  });
});

describe("applyJxsuiteUpdate", () => {
  test("surfaces the failure log when the bump fails", async () => {
    installMockPlatform({
      setPackageVersions: async () => ({ log: "version conflict", ok: false }),
    });
    await applyJxsuiteUpdate(
      [{ current: "^0.19.0", dev: false, name: "@jxsuite/runtime" }],
      "0.30.1",
    );
    await flush();
    expect(progressCard()?.textContent).toContain("version conflict");
  });
});
