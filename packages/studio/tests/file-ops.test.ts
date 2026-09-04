import "./with-dom.js";
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { registerPlatform } from "../src/platform";
import { exportFile, openFile, parseSourceForPath, saveFile } from "../src/files/file-ops";
import { activeTab, closeTab, openTab } from "../src/workspace/workspace";
import { openMediaTab } from "../src/media/media-open";
import { mockFormatAction, seedMarkdownFormat } from "./format-fixture";
import type { JxMutableNode } from "@jxsuite/schema/types";
import type { StudioPlatform } from "../src/types";

beforeAll(() => {
  seedMarkdownFormat();
});

const formatPlatform = { formatAction: mockFormatAction };

// ─── parseSourceForPath ──────────────────────────────────────────────────────

describe("parseSourceForPath", () => {
  beforeAll(() => {
    registerPlatform(formatPlatform as unknown as StudioPlatform);
  });

  test("returns content state for plain markdown", async () => {
    const result = await parseSourceForPath(
      "post.md",
      "---\ntitle: Test Post\n---\n\n# Hello\n\nWorld",
    );
    expect(result.document).toBeDefined();
    expect((result.document as JxMutableNode).children).toBeDefined();
    expect((result.frontmatter as Record<string, unknown>).title).toBe("Test Post");
    expect(result.mode).toBe("content");
    expect(result.format.name).toBe("Markdown");
  });

  test("returns component state for hyphenated tagName", async () => {
    const result = await parseSourceForPath(
      "comp.md",
      "---\ntagName: my-component\n---\n# Content\n",
    );
    expect((result.document as JxMutableNode).tagName).toBe("my-component");
    expect(result.frontmatter).toEqual({});
    expect(result.mode).toBe("component");
  });

  test("extracts frontmatter keys excluding children", async () => {
    const result = await parseSourceForPath(
      "post.md",
      "---\ntitle: Test Post\n---\n\n# Content doc",
    );
    expect(result.frontmatter).toBeDefined();
    expect((result.frontmatter as Record<string, unknown>).children).toBeUndefined();
    expect((result.frontmatter as Record<string, unknown>).title).toBe("Test Post");
  });

  test("throws for unregistered extensions", async () => {
    // oxlint-disable-next-line typescript/await-thenable -- Bun's expect().rejects.toThrow() returns a real Promise at runtime but is typed `void`; the await must be kept to wait for the rejection.
    await expect(parseSourceForPath("data.toml", "a = 1")).rejects.toThrow(
      /No format class imported/,
    );
  });
});

// ─── openFile ─────────────────────────────────────────────────────────────────

describe("openFile", () => {
  beforeEach(() => {
    registerPlatform(formatPlatform as unknown as StudioPlatform);
    delete (window as any).showOpenFilePicker;
    // Close any existing tabs
    for (const id of activeTab.value ? [activeTab.value.id] : []) {
      closeTab(id);
    }
  });

  test("opens JSON file via showOpenFilePicker", async () => {
    const mockHandle = {
      getFile: async () => ({
        text: async () => JSON.stringify({ children: [], tagName: "div" }),
      }),
      name: "component.json",
    };
    (window as any).showOpenFilePicker = async () => [mockHandle];

    await openFile();

    const tab = activeTab.value;
    expect(tab).not.toBeNull();
    expect(tab!.doc.document.tagName).toBe("div");
    expect(tab!.doc.dirty).toBe(false);
  });

  test("opens markdown file via showOpenFilePicker", async () => {
    const mockHandle = {
      getFile: async () => ({
        text: async () => "# Hello\n\nContent here",
      }),
      name: "post.md",
    };
    (window as any).showOpenFilePicker = async () => [mockHandle];

    await openFile();

    const tab = activeTab.value;
    expect(tab).not.toBeNull();
    expect(tab!.doc.sourceFormat).toBe("Markdown");
    expect((tab as unknown as { fileHandle: unknown }).fileHandle).toEqual(mockHandle);
  });

  test("handles AbortError silently", async () => {
    const error = new Error("User cancelled");
    error.name = "AbortError";
    (window as any).showOpenFilePicker = async () => {
      throw error;
    };

    // Should not throw
    await openFile();
  });
});

// ─── saveFile ─────────────────────────────────────────────────────────────────

describe("saveFile", () => {
  beforeEach(() => {
    // Close existing tabs and open a fresh one for each test
    for (const id of activeTab.value ? [activeTab.value.id] : []) {
      closeTab(id);
    }
  });

  test("saves via platform when documentPath exists", async () => {
    let written: any = null;
    registerPlatform({
      ...formatPlatform,
      writeFile: (path: any, content: any) => {
        written = { content, path };
      },
    } as any);

    openTab({
      document: { children: [], tagName: "div" },
      documentPath: "pages/index.json",
      id: "test-save",
    });
    activeTab.value!.doc.dirty = true;

    await saveFile();

    expect(written).not.toBeNull();
    expect(written.path).toBe("pages/index.json");
    expect(activeTab.value!.doc.dirty).toBe(false);
  });

  test("saves via File System Access API when fileHandle exists", async () => {
    let writtenContent = null;
    const mockHandle = {
      createWritable: async () => ({
        close: async () => {},
        write: async (content: any) => {
          writtenContent = content;
        },
      }),
    };

    registerPlatform(formatPlatform as unknown as StudioPlatform);
    openTab({
      document: { children: [], tagName: "div" },
      fileHandle: mockHandle as unknown as FileSystemFileHandle,
      id: "test-save-fs",
    });
    activeTab.value!.doc.dirty = true;

    await saveFile();

    expect(writtenContent).not.toBeNull();
    expect(activeTab.value!.doc.dirty).toBe(false);
  });

  test("shows message when no save target", async () => {
    registerPlatform(formatPlatform as unknown as StudioPlatform);
    openTab({
      document: { tagName: "div" },
      id: "test-no-target",
    });

    // Should not throw
    await saveFile();
  });

  test("serializes markdown source format via the format class", async () => {
    let writtenContent = null;
    registerPlatform({
      ...formatPlatform,
      writeFile: (_path: any, content: any) => {
        writtenContent = content;
      },
    } as any);

    openTab({
      document: {
        children: [{ tagName: "p", textContent: "Hello" }],
        tagName: "div",
      },
      documentPath: "pages/post.md",
      id: "test-md-save",
      sourceFormat: "Markdown",
    });
    activeTab.value!.doc.dirty = true;

    await saveFile();

    expect(writtenContent).toBeDefined();
    expect(typeof writtenContent).toBe("string");
  });

  test("component with duplicate default slots still saves (warn, not block)", async () => {
    let written: any = null;
    registerPlatform({
      ...formatPlatform,
      writeFile: (path: any, content: any) => {
        written = { content, path };
      },
    } as any);

    openTab({
      document: {
        children: [{ tagName: "slot" }, { tagName: "slot" }],
        tagName: "my-card",
      },
      documentPath: "components/my-card.json",
      id: "test-slot-warn",
    });
    activeTab.value!.doc.dirty = true;

    // Should not throw; warning is surfaced via statusbar but the save proceeds
    await saveFile();

    expect(written).not.toBeNull();
    expect(written.path).toBe("components/my-card.json");
    expect(activeTab.value!.doc.dirty).toBe(false);
  });

  test("component with valid slots saves without warning", async () => {
    let written: any = null;
    registerPlatform({
      ...formatPlatform,
      writeFile: (path: any, content: any) => {
        written = { content, path };
      },
    } as any);

    openTab({
      document: {
        children: [{ tagName: "slot" }, { attributes: { name: "header" }, tagName: "slot" }],
        tagName: "my-card",
      },
      documentPath: "components/my-card.json",
      id: "test-slot-ok",
    });
    activeTab.value!.doc.dirty = true;

    await saveFile();

    expect(written).not.toBeNull();
    expect(activeTab.value!.doc.dirty).toBe(false);
  });

  test("handles save error gracefully", async () => {
    registerPlatform({
      ...formatPlatform,
      writeFile: () => {
        throw new Error("disk full");
      },
    } as any);

    openTab({
      document: { tagName: "div" },
      documentPath: "pages/index.json",
      id: "test-error",
    });

    // Should not throw
    await saveFile();
  });

  /* A media tab reaches `saveFile` through the ordinary ⌘S: `file.save` is gated on `documentOpen`
     alone, and a media tab has a `documentPath`. Before the guard, `serializeDocument` returned the
     stub `openMediaTab` gives every media tab and `writeFile` put it on disk, so saving with a PNG
     open destroyed the PNG. The assertion is that NOTHING is written — a returned `false` alone would
     have passed against the broken code, which wrote and then reported success. */
  test("refuses a media tab rather than writing the stub document over the file", async () => {
    const writes: unknown[][] = [];
    registerPlatform({
      ...formatPlatform,
      uploadFile: (...args: unknown[]) => {
        writes.push(["uploadFile", ...args]);
        return { path: String(args[0]) };
      },
      writeFile: (...args: unknown[]) => {
        writes.push(["writeFile", ...args]);
      },
    } as any);

    const tab = openMediaTab("public/hero.png");

    expect(await saveFile(tab)).toBe(false);
    expect(writes).toEqual([]);
  });

  /* `.svg` is the one media type with a second, TEXT mode, so a guard written against
     `canvasMode === "media"` would have left it able to overwrite itself from the Code view. It is a
     media file either way, which is what the guard actually keys on. */
  test("refuses an .svg media tab, whose source alternate has the same stub behind it", async () => {
    const writes: unknown[][] = [];
    registerPlatform({
      ...formatPlatform,
      writeFile: (...args: unknown[]) => {
        writes.push(args);
      },
    } as any);

    const tab = openMediaTab("public/icon.svg");
    tab.session.ui.canvasMode = "source";

    expect(await saveFile(tab)).toBe(false);
    expect(writes).toEqual([]);
  });
});

// ─── exportFile ───────────────────────────────────────────────────────────────

describe("exportFile", () => {
  beforeEach(() => {
    delete (window as any).showSaveFilePicker;
    for (const id of activeTab.value ? [activeTab.value.id] : []) {
      closeTab(id);
    }
  });

  test("exports via showSaveFilePicker when available", async () => {
    let writtenContent = null;
    const mockHandle = {
      createWritable: async () => ({
        close: async () => {},
        write: async (content: any) => {
          writtenContent = content;
        },
      }),
      name: "export.json",
    };
    (window as any).showSaveFilePicker = async () => mockHandle;

    openTab({
      document: { children: [], tagName: "div" },
      id: "test-export",
    });

    await exportFile();

    expect(writtenContent).not.toBeNull();
    expect(activeTab.value!.doc.dirty).toBe(false);
  });

  test("falls back to download when showSaveFilePicker unavailable", async () => {
    let clickedLink = false;
    const origCreate = document.createElement.bind(document);
    document.createElement = (tag: any, ...args: any) => {
      const el = origCreate(tag, ...args);
      if (tag === "a") {
        el.click = () => {
          clickedLink = true;
        };
      }
      return el;
    };

    openTab({
      document: { children: [], tagName: "div" },
      id: "test-download",
    });

    await exportFile();

    expect(clickedLink).toBe(true);
    expect(activeTab.value!.doc.dirty).toBe(false);
    document.createElement = origCreate;
  });

  test("uses .md extension for content mode", async () => {
    let downloadName: any = null;
    const origCreate = document.createElement.bind(document);
    document.createElement = (tag: any, ...args: any) => {
      const el = origCreate(tag, ...args);
      if (tag === "a") {
        el.click = () => {
          downloadName = el.download;
        };
      }
      return el;
    };

    openTab({
      document: { children: [{ tagName: "p", textContent: "Hello" }] },
      id: "test-md-export",
      sourceFormat: "Markdown",
    });
    // Content mode is set by sourceFormat being "md" in createTab
    // But for this test we need mode=content explicitly
    activeTab.value!.doc.mode = "content";

    await exportFile();

    expect(downloadName).toBe("content.md");
    document.createElement = origCreate;
  });

  test("handles AbortError silently", async () => {
    const error = new Error("User cancelled");
    error.name = "AbortError";
    (window as any).showSaveFilePicker = async () => {
      throw error;
    };

    openTab({
      document: { tagName: "div" },
      id: "test-abort",
    });

    await exportFile();
  });
});
