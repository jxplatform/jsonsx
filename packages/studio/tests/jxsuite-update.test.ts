/**
 * Src/packages/jxsuite-update.ts — the on-open @jxsuite update prompt.
 *
 * The behaviour under test CHANGED: the target is each package's own newest published version, read
 * from the registry through `platform.outdatedPackages()`, not the version this Studio build
 * embeds. So the cases that matter are the ones a suite-wide target got wrong — packages on
 * different versions, a package with no newer publish, and a project pinned ahead of the registry.
 */
import { flush, installMockPlatform } from "./harness";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { initLayers } from "../src/ui/layers";
import { problems, resetNotifications } from "../src/services/notify";
import { resetActivities } from "../src/panels/activity-panel";
import type { OutdatedInfo } from "@jxsuite/protocol";
import type { StudioPlatform } from "../src/types";

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

/** A host whose registry lookup answers with `reported`. */
function withRegistry(reported: OutdatedInfo[], extra: Partial<StudioPlatform> = {}) {
  installMockPlatform({ outdatedPackages: async () => reported, ...extra });
}

afterEach(() => {
  localStorage.clear();
  (document.querySelector("#layer-dialog") as HTMLElement).innerHTML = "";
  (document.querySelector("#layer-modal") as HTMLElement).innerHTML = "";
  resetNotifications();
  resetActivities();
});

describe("checkJxsuiteUpdate", () => {
  test("each package is measured against ITS OWN latest, not one suite-wide number", async () => {
    /*
     * The case the old code could not express. Three @jxsuite packages on three different versions,
     * two behind their own latest by different amounts — and a single target would have proposed
     * one version for all three, at least two of which were never published.
     */
    withRegistry([
      { current: "^1.2.0", dev: true, latest: "1.4.0", name: "@jxsuite/parser" },
      { current: "^2.0.1", latest: "2.3.0", name: "@jxsuite/runtime" },
      { current: "^0.9.0", latest: "0.9.0", name: "@jxsuite/schema" },
      { current: "^4.0.0", latest: "4.6.0", name: "hono" },
    ]);
    const outdated = await checkJxsuiteUpdate();
    expect(outdated).toEqual([
      { current: "^1.2.0", dev: true, latest: "1.4.0", name: "@jxsuite/parser" },
      { current: "^2.0.1", dev: false, latest: "2.3.0", name: "@jxsuite/runtime" },
    ]);
  });

  test("a project pinned AHEAD of the registry is not offered a downgrade", async () => {
    // `outdatedPackages` reports any DIFFERENCE from latest. A prerelease, or a range bumped before
    // The publish landed, is not something to "update".
    withRegistry([{ current: "^2.0.0", latest: "1.9.0", name: "@jxsuite/runtime" }]);
    expect(await checkJxsuiteUpdate()).toEqual([]);
  });

  test("nothing to do when no @jxsuite package is behind", async () => {
    withRegistry([{ current: "^4.0.0", latest: "4.6.0", name: "hono" }]);
    expect(await checkJxsuiteUpdate()).toEqual([]);
  });

  test("an unreachable registry is silence, not an error", async () => {
    // This runs on project open. Being offline is not something to interrupt the author about.
    withRegistry([]);
    installMockPlatform({
      outdatedPackages: async () => {
        throw new Error("getaddrinfo ENOTFOUND registry.npmjs.org");
      },
    });
    expect(await checkJxsuiteUpdate()).toEqual([]);
  });

  test("a host with no registry lookup at all gets no prompt", async () => {
    // The cloud session manages dependencies server-side and offers no `outdatedPackages`. Without
    // The registry there is no honest target, and guessing one is what this module stopped doing.
    installMockPlatform({});
    expect(await checkJxsuiteUpdate()).toEqual([]);
  });
});

describe("maybePromptJxsuiteUpdate", () => {
  test("confirm pins each package to its OWN latest", async () => {
    let received: unknown;
    withRegistry(
      [
        { current: "^1.2.0", dev: true, latest: "1.4.0", name: "@jxsuite/parser" },
        { current: "^2.0.1", latest: "2.3.0", name: "@jxsuite/runtime" },
      ],
      {
        setPackageVersions: async (u) => {
          received = u;
          return { ok: true };
        },
      },
    );
    const p = maybePromptJxsuiteUpdate("/project");
    await flush();
    const d = dialog();
    expect(d).not.toBeNull();
    d?.dispatchEvent(new Event("confirm"));
    await p;
    await flush();
    expect(received).toEqual([
      { dev: true, name: "@jxsuite/parser", version: "^1.4.0" },
      { dev: false, name: "@jxsuite/runtime", version: "^2.3.0" },
    ]);
  });

  test("cancel is remembered against the exact versions declined", async () => {
    withRegistry([{ current: "^1.2.0", latest: "1.4.0", name: "@jxsuite/parser" }], {
      setPackageVersions: async () => ({ ok: true }),
    });
    const p = maybePromptJxsuiteUpdate("/project");
    await flush();
    dialog()?.dispatchEvent(new Event("cancel"));
    await p;
    expect(localStorage.getItem("jx:jxsuite-update-dismissed:/project:@jxsuite/parser@1.4.0")).toBe(
      "1",
    );

    (document.querySelector("#layer-dialog") as HTMLElement).innerHTML = "";
    await maybePromptJxsuiteUpdate("/project");
    await flush();
    expect(dialog()).toBeNull();
  });

  test("a NEWER publish asks again, rather than staying dismissed forever", async () => {
    /* The reason the key is the version set and not the project. Declining 1.4.0 says nothing about
       1.5.0, and under the old single-target key a decline could outlive several releases. */
    withRegistry([{ current: "^1.2.0", latest: "1.4.0", name: "@jxsuite/parser" }], {
      setPackageVersions: async () => ({ ok: true }),
    });
    const first = maybePromptJxsuiteUpdate("/project");
    await flush();
    dialog()?.dispatchEvent(new Event("cancel"));
    await first;
    (document.querySelector("#layer-dialog") as HTMLElement).innerHTML = "";

    withRegistry([{ current: "^1.2.0", latest: "1.5.0", name: "@jxsuite/parser" }], {
      setPackageVersions: async () => ({ ok: true }),
    });
    void maybePromptJxsuiteUpdate("/project");
    await flush();
    expect(dialog()).not.toBeNull();
  });

  test("no-op when the platform cannot set versions", async () => {
    withRegistry([{ current: "^1.2.0", latest: "1.4.0", name: "@jxsuite/parser" }]);
    await maybePromptJxsuiteUpdate("/project");
    await flush();
    expect(dialog()).toBeNull();
  });
});

describe("applyJxsuiteUpdate", () => {
  test("surfaces the failure log as a Problem when the bump fails", async () => {
    installMockPlatform({
      setPackageVersions: async () => ({ log: "version conflict", ok: false }),
    });
    await applyJxsuiteUpdate([
      { current: "^1.2.0", dev: false, latest: "1.4.0", name: "@jxsuite/parser" },
    ]);
    await flush();
    expect(problems[0]?.message).toContain("version conflict");
  });

  test("an empty list installs nothing and opens no modal", async () => {
    let called = false;
    installMockPlatform({
      setPackageVersions: async () => {
        called = true;
        return { ok: true };
      },
    });
    await applyJxsuiteUpdate([]);
    expect(called).toBe(false);
  });
});
