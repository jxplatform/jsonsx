/**
 * Tests for src/about/about-modal.ts — the About dialog.
 *
 * Asserts modal lifecycle (open once, Escape/close button), the build-metadata rows (which fall
 * back to "dev"/"unknown" under test since the build-time defines are absent), the lazy package
 * list, and that the desktop update section only renders when the platform implements the optional
 * getAppInfo method.
 */
import { flush, installMockPlatform, pointer } from "./harness";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { initLayers } from "../src/ui/layers";

const { closeAboutModal, openAboutModal } = await import("../src/about/about-modal");

for (const id of ["layer-popover", "layer-modal", "layer-dialog"]) {
  if (!document.querySelector(`#${id}`)) {
    const el = document.createElement("div");
    el.id = id;
    document.body.append(el);
  }
}
initLayers();

function modalLayer(): HTMLElement {
  return document.querySelector("#layer-modal") as HTMLElement;
}

function modal(): HTMLElement | null {
  return modalLayer().querySelector(".about-modal");
}

function metaRow(label: string): string | undefined {
  const rows = [...(modal()?.querySelectorAll(".about-meta-row") ?? [])];
  const row = rows.find((r) => r.querySelector(".about-meta-label")?.textContent === label);
  return row?.querySelector(".about-meta-value")?.textContent ?? undefined;
}

beforeEach(() => {
  installMockPlatform({
    listPackages: async () => [
      { name: "@jxsuite/runtime", version: "9.9.9" },
      { name: "@jxsuite/studio", version: "9.9.9" },
    ],
  });
});

afterEach(() => {
  closeAboutModal();
});

describe("openAboutModal", () => {
  test("renders the modal with header and build metadata", async () => {
    openAboutModal();
    await flush();
    expect(modal()).not.toBeNull();
    expect(modal()?.querySelector(".settings-modal-title")?.textContent).toBe("About Jx Studio");
    expect(modalLayer().querySelector("sp-underlay")).not.toBeNull();
    // Build-time defines are absent under test → fallbacks.
    expect(metaRow("Version")).toBe("dev");
    expect(metaRow("Build date")).toBe("—");
    expect(metaRow("Commit")).toBe("unknown");
  });

  test("renders external links", async () => {
    openAboutModal();
    await flush();
    const links = [...(modal()?.querySelectorAll(".about-links a") ?? [])];
    expect(links.map((a) => a.textContent)).toEqual(["GitHub", "Documentation", "License"]);
    expect(links.every((a) => (a as HTMLAnchorElement).href.startsWith("https://"))).toBe(true);
  });

  test("loads the package list lazily", async () => {
    openAboutModal();
    // Synchronously the list is still loading.
    expect(modal()?.querySelector(".about-muted")?.textContent).toContain("Loading");
    await flush();
    const rows = [...(modal()?.querySelectorAll(".about-package-row") ?? [])];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.querySelector(".about-package-name")?.textContent).toBe("@jxsuite/runtime");
    expect(rows[0]?.querySelector(".about-package-version")?.textContent).toBe("9.9.9");
  });

  test("a second open while already open is a no-op", async () => {
    openAboutModal();
    await flush();
    openAboutModal();
    await flush();
    expect(modalLayer().querySelectorAll(".about-modal")).toHaveLength(1);
  });
});

describe("desktop update info", () => {
  test("hides the channel/updates rows when getAppInfo is absent", async () => {
    openAboutModal();
    await flush();
    expect(metaRow("Channel")).toBeUndefined();
    expect(metaRow("Updates")).toBeUndefined();
  });

  test("shows channel and update status when getAppInfo is present", async () => {
    installMockPlatform({
      listPackages: async () => [],
      getAppInfo: async () => ({
        version: "1.2.3",
        channel: "stable",
        hash: "deadbee",
        updateStatus: "Up to date",
      }),
    });
    openAboutModal();
    await flush();
    expect(metaRow("Channel")).toBe("stable");
    expect(metaRow("Updates")).toBe("Up to date");
  });

  test("omits the updates row when getAppInfo reports no status", async () => {
    installMockPlatform({
      listPackages: async () => [],
      getAppInfo: async () => ({ version: "1.2.3", channel: "canary", hash: "deadbee" }),
    });
    openAboutModal();
    await flush();
    expect(metaRow("Channel")).toBe("canary");
    expect(metaRow("Updates")).toBeUndefined();
  });

  test("swallows a failing getAppInfo and still renders core metadata", async () => {
    installMockPlatform({
      listPackages: async () => [],
      getAppInfo: async () => {
        throw new Error("rpc down");
      },
    });
    openAboutModal();
    await flush();
    expect(modal()).not.toBeNull();
    expect(metaRow("Channel")).toBeUndefined();
    expect(metaRow("Version")).toBe("dev");
  });
});

describe("degraded loading", () => {
  test("a failing listPackages falls back to an empty list", async () => {
    installMockPlatform({
      listPackages: async () => {
        throw new Error("registry down");
      },
    });
    openAboutModal();
    await flush();
    expect(modal()?.querySelector(".about-muted")?.textContent).toContain("No packages");
  });
});

describe("closing", () => {
  test("Escape closes the modal", async () => {
    openAboutModal();
    await flush();
    modal()?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
    expect(modal()).toBeNull();
  });

  test("the close button closes the modal", async () => {
    openAboutModal();
    await flush();
    const btn = modal()?.querySelector('sp-action-button[title="Close"]') as HTMLElement;
    pointer(btn, "click");
    expect(modal()).toBeNull();
  });

  test("the underlay close event closes the modal", async () => {
    openAboutModal();
    await flush();
    modalLayer().querySelector("sp-underlay")?.dispatchEvent(new Event("close"));
    expect(modal()).toBeNull();
  });

  test("closeAboutModal without an open modal is a no-op", () => {
    expect(() => closeAboutModal()).not.toThrow();
    expect(modal()).toBeNull();
  });
});
