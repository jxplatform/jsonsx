import "./with-dom.js";
import { describe, test, expect, beforeEach } from "bun:test";
import { registerPlatform } from "../src/platform";
import { loadMarkdown, openFile, saveFile, exportFile } from "../src/files/file-ops";
import { activeTab, openTab, closeTab } from "../src/workspace/workspace";

// ─── loadMarkdown ─────────────────────────────────────────────────────────────

describe("loadMarkdown", () => {
  test("returns content state for plain markdown", async () => {
    const result = await loadMarkdown("---\ntitle: Test Post\n---\n\n# Hello\n\nWorld");
    expect(result.document).toBeDefined();
    expect((result.document as JxMutableNode).children).toBeDefined();
    expect((result.frontmatter as Record<string, unknown>).title).toBe("Test Post");
  });

  test("returns component state for hyphenated tagName", async () => {
    const result = await loadMarkdown("---\ntagName: my-component\n---\n# Content\n");
    expect((result.document as JxMutableNode).tagName).toBe("my-component");
    expect(result.frontmatter).toEqual({});
  });

  test("extracts frontmatter keys excluding children", async () => {
    const result = await loadMarkdown("---\ntitle: Test Post\n---\n\n# Content doc");
    expect(result.frontmatter).toBeDefined();
    expect((result.frontmatter as Record<string, unknown>).children).toBeUndefined();
    expect((result.frontmatter as Record<string, unknown>).title).toBe("Test Post");
  });
});

// ─── openFile ─────────────────────────────────────────────────────────────────

describe("openFile", () => {
  beforeEach(() => {
    registerPlatform({} as unknown as StudioPlatform);
    delete (window as any).showOpenFilePicker;
    // Close any existing tabs
    for (const id of activeTab.value ? [activeTab.value.id] : []) {
      closeTab(id);
    }
  });

  test("opens JSON file via showOpenFilePicker", async () => {
    const mockHandle = {
      name: "component.json",
      getFile: async () => ({
        text: async () => JSON.stringify({ tagName: "div", children: [] }),
      }),
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
      name: "post.md",
      getFile: async () => ({
        text: async () => "# Hello\n\nContent here",
      }),
    };
    (window as any).showOpenFilePicker = async () => [mockHandle];

    await openFile();

    const tab = activeTab.value;
    expect(tab).not.toBeNull();
    expect(tab!.doc.sourceFormat).toBe("md");
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
      writeFile: (path: any, content: any) => {
        written = { path, content };
      },
    } as any);

    openTab({
      id: "test-save",
      documentPath: "pages/index.json",
      document: { tagName: "div", children: [] },
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
        write: async (content: any) => {
          writtenContent = content;
        },
        close: async () => {},
      }),
    };

    registerPlatform({} as unknown as StudioPlatform);
    openTab({
      id: "test-save-fs",
      fileHandle: mockHandle as unknown as FileSystemFileHandle,
      document: { tagName: "div", children: [] },
    });
    activeTab.value!.doc.dirty = true;

    await saveFile();

    expect(writtenContent).not.toBeNull();
    expect(activeTab.value!.doc.dirty).toBe(false);
  });

  test("shows message when no save target", async () => {
    registerPlatform({} as unknown as StudioPlatform);
    openTab({
      id: "test-no-target",
      document: { tagName: "div" },
    });

    // Should not throw
    await saveFile();
  });

  test("serializes markdown source format with jxDocToMd", async () => {
    let writtenContent = null;
    registerPlatform({
      writeFile: (_path: any, content: any) => {
        writtenContent = content;
      },
    } as any);

    openTab({
      id: "test-md-save",
      documentPath: "pages/post.md",
      document: { tagName: "div", children: [{ tagName: "p", textContent: "Hello" }] },
      sourceFormat: "md",
    });
    activeTab.value!.doc.dirty = true;

    await saveFile();

    expect(writtenContent).toBeDefined();
    expect(typeof writtenContent).toBe("string");
  });

  test("handles save error gracefully", async () => {
    registerPlatform({
      writeFile: () => {
        throw new Error("disk full");
      },
    } as any);

    openTab({
      id: "test-error",
      documentPath: "pages/index.json",
      document: { tagName: "div" },
    });

    // Should not throw
    await saveFile();
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
      name: "export.json",
      createWritable: async () => ({
        write: async (content: any) => {
          writtenContent = content;
        },
        close: async () => {},
      }),
    };
    (window as any).showSaveFilePicker = async () => mockHandle;

    openTab({
      id: "test-export",
      document: { tagName: "div", children: [] },
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
      id: "test-download",
      document: { tagName: "div", children: [] },
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
      id: "test-md-export",
      document: { children: [{ tagName: "p", textContent: "Hello" }] },
      sourceFormat: "md",
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
      id: "test-abort",
      document: { tagName: "div" },
    });

    await exportFile();
  });
});
