/**
 * Tests for src/settings/general-settings.ts — favicon, platform adapter, breakpoints, and the
 * global-styles shortcut.
 *
 * Mocks ../src/files/files so "Edit Global Styles" doesn't pull in the full tab-opening machinery.
 * Persistence flows through updateSiteConfig → platform.writeFile("project.json").
 */
import { flush, installMockPlatform, pointer, resetStudioState } from "./harness";
import { describe, expect, mock, test } from "bun:test";
import { projectState } from "../src/store";

import type { MockPlatformState } from "./harness";

const openFileInTab = mock(async (_path: string) => {});
mock.module("../src/files/files.js", () => ({ openFileInTab }));

const { renderGeneralSettings } = await import("../src/settings/general-settings");

type AnyConfig = Record<string, any>;

function setup(cfg: AnyConfig | null): { container: HTMLElement; state: MockPlatformState } {
  const { state } = installMockPlatform();
  resetStudioState({ projectConfig: cfg as unknown });
  const container = document.createElement("div");
  renderGeneralSettings(container);
  return { container, state };
}

function config(): AnyConfig {
  return (projectState as AnyConfig).projectConfig;
}

function buttonByText(root: HTMLElement, text: string): HTMLElement {
  const match = [...root.querySelectorAll("sp-action-button")].find((b) =>
    b.textContent?.includes(text),
  );
  if (!match) {
    throw new Error(`no sp-action-button containing "${text}"`);
  }
  return match as HTMLElement;
}

function setAndFire(el: Element, value: string, type = "change"): void {
  (el as HTMLInputElement).value = value;
  el.dispatchEvent(new Event(type, { bubbles: true }));
}

function mediaRows(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll(".settings-media-row")] as HTMLElement[];
}

// ─── Favicon ─────────────────────────────────────────────────────────────────

describe("favicon", () => {
  test("no favicon shows the dashed placeholder; configured favicon shows preview + path", () => {
    const { container } = setup({});
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("—");

    const { container: withFavicon } = setup({ favicon: "/favicon.ico" });
    const img = withFavicon.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("/favicon.ico");
    expect(withFavicon.textContent).toContain("/favicon.ico");
  });

  test("upload flow stores the file, sets favicon, and re-renders the preview", async () => {
    const { container, state } = setup({});

    const origCreateElement = document.createElement.bind(document);
    let fileInput: HTMLInputElement | null = null;
    (document as any).createElement = (tag: string, ...rest: any[]) => {
      const el = (origCreateElement as any)(tag, ...rest);
      if (tag === "input") {
        fileInput = el;
      }
      return el;
    };
    try {
      pointer(buttonByText(container, "Upload Favicon"), "click");
    } finally {
      (document as any).createElement = origCreateElement;
    }

    expect(fileInput).not.toBeNull();
    expect(fileInput!.type).toBe("file");
    expect(fileInput!.accept).toBe("image/*,.ico,.svg");

    const file = new File(["icon-bytes"], "favicon.ico", { type: "image/x-icon" });
    Object.defineProperty(fileInput!, "files", { configurable: true, value: [file] });
    fileInput!.dispatchEvent(new Event("change"));
    await flush(4);

    const upload = state.calls.find(([name]) => name === "uploadFile");
    expect(upload).toEqual(["uploadFile", "public/favicon.ico", file]);
    expect(config().favicon).toBe("/favicon.ico");
    expect(container.querySelector("img")?.getAttribute("src")).toBe("/favicon.ico");
  });

  test("change event without a selected file is a no-op", async () => {
    const { container, state } = setup({});
    const origCreateElement = document.createElement.bind(document);
    let fileInput: HTMLInputElement | null = null;
    (document as any).createElement = (tag: string, ...rest: any[]) => {
      const el = (origCreateElement as any)(tag, ...rest);
      if (tag === "input") {
        fileInput = el;
      }
      return el;
    };
    try {
      pointer(buttonByText(container, "Upload Favicon"), "click");
    } finally {
      (document as any).createElement = origCreateElement;
    }

    Object.defineProperty(fileInput!, "files", { configurable: true, value: [] });
    fileInput!.dispatchEvent(new Event("change"));
    await flush(4);
    expect(state.calls.filter(([name]) => name === "uploadFile")).toHaveLength(0);
    expect(config().favicon).toBeUndefined();
  });
});

// ─── Platform adapter ────────────────────────────────────────────────────────

describe("platform adapter", () => {
  test("picker defaults to static and lists all adapters", () => {
    const { container } = setup({});
    const picker = container.querySelector("sp-picker")!;
    const options = [...picker.querySelectorAll("sp-menu-item")].map((m) =>
      m.getAttribute("value"),
    );
    expect(options).toEqual(["static", "bun", "node", "cloudflare-workers", "cloudflare-pages"]);
  });

  test("changing the adapter merges into build config and persists", async () => {
    const { container, state } = setup({ build: { outDir: "dist" } });
    setAndFire(container.querySelector("sp-picker")!, "bun");
    await flush();
    expect(config().build).toEqual({ adapter: "bun", outDir: "dist" });
    const written = JSON.parse(state.files.get("project.json")!);
    expect(written.build.adapter).toBe("bun");
  });
});

// ─── Breakpoints ─────────────────────────────────────────────────────────────

describe("breakpoints", () => {
  const media = { "--": "1280px", "--sm": "(max-width: 600px)" };

  test("base row is fixed; named rows are editable with a remove button", () => {
    const { container } = setup({ $media: { ...media } });
    const rows = mediaRows(container);
    expect(rows.length).toBe(2);
    expect(rows[0]!.querySelector(".settings-media-name-fixed")?.textContent).toBe("Base");
    expect(rows[0]!.querySelector("sp-action-button")).toBeNull();
    expect(
      (rows[1]!.querySelector(".settings-media-name") as HTMLInputElement).getAttribute("value"),
    ).toBeNull(); // Bound via property
    expect(rows[1]!.querySelector('[title="Remove breakpoint"]')).not.toBeNull();
  });

  test("changing a breakpoint value persists it", async () => {
    const { container, state } = setup({ $media: { ...media } });
    setAndFire(
      mediaRows(container)[1]!.querySelector(".settings-media-value")!,
      "(max-width: 700px)",
    );
    await flush();
    expect(config().$media["--sm"]).toBe("(max-width: 700px)");
    expect(JSON.parse(state.files.get("project.json")!).$media["--sm"]).toBe("(max-width: 700px)");
  });

  test("renaming a breakpoint prefixes -- and preserves order", async () => {
    const { container } = setup({ $media: { ...media, "--lg": "(min-width: 1000px)" } });
    setAndFire(mediaRows(container)[1]!.querySelector(".settings-media-name")!, "mobile");
    await flush();
    expect(Object.keys(config().$media)).toEqual(["--", "--mobile", "--lg"]);
    expect(config().$media["--mobile"]).toBe("(max-width: 600px)");
  });

  test("renaming with an explicit -- prefix keeps it; same name is a no-op", async () => {
    const { container, state } = setup({ $media: { ...media } });
    setAndFire(mediaRows(container)[1]!.querySelector(".settings-media-name")!, "--tablet");
    await flush();
    expect(config().$media["--tablet"]).toBe("(max-width: 600px)");

    const writes = state.calls.filter(([name]) => name === "writeFile").length;
    const fresh = document.createElement("div");
    renderGeneralSettings(fresh);
    setAndFire(mediaRows(fresh)[1]!.querySelector(".settings-media-name")!, "tablet");
    await flush();
    expect(state.calls.filter(([name]) => name === "writeFile").length).toBe(writes);
  });

  test("remove deletes the breakpoint and re-renders", async () => {
    const { container, state } = setup({ $media: { ...media } });
    pointer(mediaRows(container)[1]!.querySelector('[title="Remove breakpoint"]')!, "click");
    await flush();
    expect(config().$media).toEqual({ "--": "1280px" });
    expect(JSON.parse(state.files.get("project.json")!).$media["--sm"]).toBeUndefined();
  });

  test("add appends a --new breakpoint with a default query", async () => {
    const { container } = setup({ $media: { ...media } });
    pointer(buttonByText(container, "+ Add Breakpoint"), "click");
    await flush();
    expect(config().$media["--new"]).toBe("(max-width: 480px)");
  });

  test("missing $media renders an empty list and a usable add button", async () => {
    const { container } = setup({});
    expect(mediaRows(container).length).toBe(0);
    pointer(buttonByText(container, "+ Add Breakpoint"), "click");
    await flush();
    expect(config().$media).toEqual({ "--new": "(max-width: 480px)" });
  });
});

// ─── Global styles shortcut ──────────────────────────────────────────────────

describe("global styles shortcut", () => {
  test("Edit Global Styles closes the settings modal and opens project.json", async () => {
    const { container } = setup({});
    pointer(buttonByText(container, "Edit Global Styles"), "click");
    // The handler lazy-imports settings-modal; give the dynamic import time to settle.
    await flush(20);
    expect(openFileInTab).toHaveBeenCalledWith("project.json");
  });
});
