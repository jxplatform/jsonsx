/**
 * Tests for src/settings/general-settings.ts — the Overview section: site identity (name,
 * description, production URL), favicon, and the Project Styles shortcut.
 *
 * Persistence flows through updateSiteConfig → platform.writeFile("project.json"), and every write
 * in this section surfaces its rejection instead of dropping it — that is what the "save failures"
 * block pins.
 *
 * Two things are NOT tested here any more, both because they left. Breakpoints were one of four
 * `$media` definition sites and live in Contexts (tests/contexts-section.test.ts). The platform
 * adapter moved to Deploy in P6.2 (tests/project-sections.test.ts) — Overview says what the site
 * IS, Deploy says where it ships.
 */
import {
  flush,
  installMockPlatform,
  pointer,
  resetStudioState,
  resetWorkspaceWithTab,
} from "./harness";
import { describe, expect, test } from "bun:test";
import { projectState } from "../src/store";

import type { MockPlatformState } from "./harness";
import type { StudioPlatform } from "../src/types";

const { renderGeneralSettings } = await import("../src/settings/general-settings");
const { activeTab } = await import("../src/workspace/workspace");

type AnyConfig = Record<string, any>;

function setup(
  cfg: AnyConfig | null,
  overrides: Partial<StudioPlatform> = {},
): { container: HTMLElement; state: MockPlatformState } {
  const { state } = installMockPlatform(overrides);
  resetStudioState({ projectConfig: cfg as unknown });
  const container = document.createElement("div");
  renderGeneralSettings(container);
  return { container, state };
}

function field(container: HTMLElement, cls: string): HTMLElement {
  const el = container.querySelector(`.${cls}`);
  if (!el) {
    throw new Error(`no .${cls} in the Overview section`);
  }
  return el as HTMLElement;
}

function errorText(container: HTMLElement): string | undefined {
  return container.querySelector(".settings-field-error")?.textContent?.trim();
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

// ─── Site identity ───────────────────────────────────────────────────────────
//
// The New Project wizard collects name + location only and tells the user to set the rest "from
// Settings". These three fields are what makes that sentence true: before them, description and
// Production URL had no editing surface anywhere in Studio, and the name was editable only at
// Creation time.

describe("site name", () => {
  test("shows the configured name and persists a trimmed edit", async () => {
    const { container, state } = setup({ name: "Old Name" });
    const input = field(container, "settings-site-name");
    expect((input as unknown as { value: string }).value).toBe("Old Name");

    setAndFire(input, "  Bistro  ");
    await flush();
    expect(config().name).toBe("Bistro");
    expect(JSON.parse(state.files.get("project.json")!).name).toBe("Bistro");
    expect(errorText(container)).toBeUndefined();
  });

  test("a blank name is refused, not written — a nameless project is not a state to reach", async () => {
    const { container, state } = setup({ name: "Bistro" });
    setAndFire(field(container, "settings-site-name"), "   ");
    await flush();
    expect(config().name).toBe("Bistro");
    expect(state.calls.filter(([name]) => name === "writeFile")).toHaveLength(0);
    expect(errorText(container)).toBe("A project name is required.");
    // The control snaps back to the value that is actually on disk.
    expect((field(container, "settings-site-name") as unknown as { value: string }).value).toBe(
      "Bistro",
    );
  });
});

describe("description", () => {
  const withMeta = (content: string) => ({
    $head: [
      { attributes: { content: "width=device-width", name: "viewport" }, tagName: "meta" },
      { attributes: { content, name: "description" }, tagName: "meta" },
    ],
  });

  test("reads the $head description meta, not a top-level key", () => {
    // `description` is not a top-level project.json key — the composed project schema is closed
    // (unevaluatedProperties: false) — so it lives exactly where @jxsuite/create writes it.
    const { container } = setup(withMeta("A neighbourhood bistro."));
    expect(
      (field(container, "settings-site-description") as unknown as { value: string }).value,
    ).toBe("A neighbourhood bistro.");
  });

  test("editing rewrites the existing meta in place, leaving other head entries alone", async () => {
    const { container, state } = setup(withMeta("Old copy."));
    setAndFire(field(container, "settings-site-description"), "  New copy.  ");
    await flush();
    const head = JSON.parse(state.files.get("project.json")!).$head;
    expect(head).toEqual([
      { attributes: { content: "width=device-width", name: "viewport" }, tagName: "meta" },
      { attributes: { content: "New copy.", name: "description" }, tagName: "meta" },
    ]);
  });

  test("a project with no description meta gets one appended", async () => {
    const { container, state } = setup({ $head: [] });
    setAndFire(field(container, "settings-site-description"), "First words.");
    await flush();
    expect(JSON.parse(state.files.get("project.json")!).$head).toEqual([
      { attributes: { content: "First words.", name: "description" }, tagName: "meta" },
    ]);
  });

  test("a project with no $head at all gets the array created", async () => {
    const { container } = setup({});
    setAndFire(field(container, "settings-site-description"), "Hello.");
    await flush();
    expect(config().$head).toEqual([
      { attributes: { content: "Hello.", name: "description" }, tagName: "meta" },
    ]);
  });

  test("clearing it removes the meta rather than leaving an empty one", async () => {
    const { container } = setup(withMeta("Old copy."));
    setAndFire(field(container, "settings-site-description"), "   ");
    await flush();
    expect(config().$head).toEqual([
      { attributes: { content: "width=device-width", name: "viewport" }, tagName: "meta" },
    ]);
  });

  test("clearing when there was never a description writes no meta", async () => {
    const { container } = setup({ $head: [] });
    setAndFire(field(container, "settings-site-description"), "");
    await flush();
    expect(config().$head).toEqual([]);
  });
});

describe("production URL", () => {
  test("persists an absolute address", async () => {
    const { container, state } = setup({});
    setAndFire(field(container, "settings-site-url"), " https://example.com ");
    await flush();
    expect(config().url).toBe("https://example.com");
    expect(JSON.parse(state.files.get("project.json")!).url).toBe("https://example.com");
  });

  test("a bare hostname is refused — the sitemap needs a full address", async () => {
    const { container, state } = setup({ url: "https://example.com" });
    setAndFire(field(container, "settings-site-url"), "example.com");
    await flush();
    expect(config().url).toBe("https://example.com");
    expect(state.calls.filter(([name]) => name === "writeFile")).toHaveLength(0);
    expect(errorText(container)).toBe("Enter a full address starting with http:// or https://");
  });

  test("clearing it drops the key instead of writing an empty string", async () => {
    const { container, state } = setup({ url: "https://example.com" });
    setAndFire(field(container, "settings-site-url"), "");
    await flush();
    expect("url" in JSON.parse(state.files.get("project.json")!)).toBe(false);
    expect(config().url).toBeUndefined();
  });
});

// ─── Save failures ───────────────────────────────────────────────────────────

describe("save failures", () => {
  const failing = {
    writeFile: async () => {
      throw new Error("EROFS: read-only file system");
    },
  } as unknown as Partial<StudioPlatform>;

  test("a rejected project.json write is shown under the field, not swallowed", async () => {
    const { container } = setup({ name: "Bistro" }, failing);
    setAndFire(field(container, "settings-site-name"), "Trattoria");
    await flush(4);
    expect(errorText(container)).toBe("Could not save project.json — EROFS: read-only file system");
  });

  test("a failure on a field with no control of its own lands at the top of the section", async () => {
    const { container } = setup({ $head: [] }, failing);
    setAndFire(field(container, "settings-site-description"), "A bistro");
    await flush(4);
    const shown = container.querySelector(".settings-field-error")!;
    expect(shown.textContent?.trim()).toContain("Could not save project.json");
  });

  test("a later success clears the error", async () => {
    const { container } = setup({ name: "Bistro" }, failing);
    setAndFire(field(container, "settings-site-name"), "Trattoria");
    await flush(4);
    expect(errorText(container)).toBeDefined();

    // Re-register a working platform and retry through the same container.
    installMockPlatform();
    setAndFire(field(container, "settings-site-name"), "Trattoria");
    await flush(4);
    expect(errorText(container)).toBeUndefined();
    expect(config().name).toBe("Trattoria");
  });

  test("a failed favicon upload reports the upload, not a phantom save", async () => {
    const { container } = setup({}, {
      uploadFile: async () => {
        throw new Error("disk full");
      },
    } as unknown as Partial<StudioPlatform>);

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

    const file = new File(["x"], "favicon.ico", { type: "image/x-icon" });
    Object.defineProperty(fileInput!, "files", { configurable: true, value: [file] });
    fileInput!.dispatchEvent(new Event("change"));
    await flush(4);

    expect(errorText(container)).toBe("Could not upload the favicon — disk full");
    expect(config().favicon).toBeUndefined();
  });
});

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
  test("is no longer on Overview — it is a Deploy fact, not an identity one", () => {
    const { container } = setup({ build: { adapter: "static" } });
    expect(container.querySelector("sp-picker")).toBeNull();
  });
});

// ─── Global styles shortcut ──────────────────────────────────────────────────

describe("global styles shortcut", () => {
  test("Edit Global Styles switches the SAME document to the Project Styles editor", () => {
    resetWorkspaceWithTab();
    const { container } = setup({});
    pointer(buttonByText(container, "Edit Global Styles"), "click");
    // Nothing closes and nothing re-opens: project.json is already the document on screen.
    expect(activeTab.value?.session.ui.canvasMode).toBe("stylebook");
  });
});
