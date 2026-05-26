import { describe, test, expect, beforeEach } from "bun:test";
import { registerPlatform } from "../src/platform.js";
import { loadMarkdown, openFile, saveFile, exportFile } from "../src/files/file-ops.js";
import { activeTab, openTab, closeTab } from "../src/workspace/workspace.js";

// ─── loadMarkdown ─────────────────────────────────────────────────────────────

describe("loadMarkdown", () => {
  test("returns content state for plain markdown", async () => {
    const result = await loadMarkdown("---\ntitle: Test Post\n---\n\n# Hello\n\nWorld");
    expect(result.document).toBeDefined();
    expect(result.document.children).toBeDefined();
    expect(result.frontmatter.title).toBe("Test Post");
  });

  test("returns component state for hyphenated tagName", async () => {
    const result = await loadMarkdown("---\ntagName: my-component\n---\n# Content\n");
    expect(result.document.tagName).toBe("my-component");
    expect(result.frontmatter).toEqual({});
  });

  test("extracts frontmatter keys excluding children", async () => {
    const result = await loadMarkdown("---\ntitle: Test Post\n---\n\n# Content doc");
    expect(result.frontmatter).toBeDefined();
    expect(result.frontmatter.children).toBeUndefined();
    expect(result.frontmatter.title).toBe("Test Post");
  });
});

// ─── openFile ─────────────────────────────────────────────────────────────────

describe("openFile", () => {
  beforeEach(() => {
    registerPlatform(/** @type {any} */ ({}));
    delete (/** @type {any} */ (window).showOpenFilePicker);
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
    /** @type {any} */ (window).showOpenFilePicker = async () => [mockHandle];

    await openFile();

    const tab = activeTab.value;
    expect(tab).not.toBeNull();
    expect(tab.doc.document.tagName).toBe("div");
    expect(tab.doc.dirty).toBe(false);
  });

  test("opens markdown file via showOpenFilePicker", async () => {
    const mockHandle = {
      name: "post.md",
      getFile: async () => ({
        text: async () => "# Hello\n\nContent here",
      }),
    };
    /** @type {any} */ (window).showOpenFilePicker = async () => [mockHandle];

    await openFile();

    const tab = activeTab.value;
    expect(tab).not.toBeNull();
    expect(tab.doc.sourceFormat).toBe("md");
    expect(/** @type {any} */ (tab).fileHandle).toEqual(mockHandle);
  });

  test("handles AbortError silently", async () => {
    const error = new Error("User cancelled");
    error.name = "AbortError";
    /** @type {any} */ (window).showOpenFilePicker = async () => {
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
    /** @type {any} */
    let written = null;
    registerPlatform(
      /** @type {any} */ ({
        writeFile: (/** @type {any} */ path, /** @type {any} */ content) => {
          written = { path, content };
        },
      }),
    );

    openTab({
      id: "test-save",
      documentPath: "pages/index.json",
      document: { tagName: "div", children: [] },
    });
    activeTab.value.doc.dirty = true;

    await saveFile();

    expect(written).not.toBeNull();
    expect(written.path).toBe("pages/index.json");
    expect(activeTab.value.doc.dirty).toBe(false);
  });

  test("saves via File System Access API when fileHandle exists", async () => {
    let writtenContent = null;
    const mockHandle = {
      createWritable: async () => ({
        write: async (/** @type {any} */ content) => {
          writtenContent = content;
        },
        close: async () => {},
      }),
    };

    registerPlatform(/** @type {any} */ ({}));
    openTab({
      id: "test-save-fs",
      fileHandle: /** @type {any} */ (mockHandle),
      document: { tagName: "div", children: [] },
    });
    activeTab.value.doc.dirty = true;

    await saveFile();

    expect(writtenContent).not.toBeNull();
    expect(activeTab.value.doc.dirty).toBe(false);
  });

  test("shows message when no save target", async () => {
    registerPlatform(/** @type {any} */ ({}));
    openTab({
      id: "test-no-target",
      document: { tagName: "div" },
    });

    // Should not throw
    await saveFile();
  });

  test("serializes markdown source format with jxDocToMd", async () => {
    let writtenContent = null;
    registerPlatform(
      /** @type {any} */ ({
        writeFile: (/** @type {any} */ _path, /** @type {any} */ content) => {
          writtenContent = content;
        },
      }),
    );

    openTab({
      id: "test-md-save",
      documentPath: "pages/post.md",
      document: { tagName: "div", children: [{ tagName: "p", textContent: "Hello" }] },
      sourceFormat: "md",
    });
    activeTab.value.doc.dirty = true;

    await saveFile();

    expect(writtenContent).toBeDefined();
    expect(typeof writtenContent).toBe("string");
  });

  test("handles save error gracefully", async () => {
    registerPlatform(
      /** @type {any} */ ({
        writeFile: () => {
          throw new Error("disk full");
        },
      }),
    );

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
    delete (/** @type {any} */ (window).showSaveFilePicker);
    for (const id of activeTab.value ? [activeTab.value.id] : []) {
      closeTab(id);
    }
  });

  test("exports via showSaveFilePicker when available", async () => {
    let writtenContent = null;
    const mockHandle = {
      name: "export.json",
      createWritable: async () => ({
        write: async (/** @type {any} */ content) => {
          writtenContent = content;
        },
        close: async () => {},
      }),
    };
    /** @type {any} */ (window).showSaveFilePicker = async () => mockHandle;

    openTab({
      id: "test-export",
      document: { tagName: "div", children: [] },
    });

    await exportFile();

    expect(writtenContent).not.toBeNull();
    expect(activeTab.value.doc.dirty).toBe(false);
  });

  test("falls back to download when showSaveFilePicker unavailable", async () => {
    let clickedLink = false;
    const origCreate = document.createElement.bind(document);
    document.createElement = (/** @type {any} */ tag, /** @type {any} */ ...args) => {
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
    expect(activeTab.value.doc.dirty).toBe(false);
    document.createElement = origCreate;
  });

  test("uses .md extension for content mode", async () => {
    /** @type {any} */
    let downloadName = null;
    const origCreate = document.createElement.bind(document);
    document.createElement = (/** @type {any} */ tag, /** @type {any} */ ...args) => {
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
    activeTab.value.doc.mode = "content";

    await exportFile();

    expect(downloadName).toBe("content.md");
    document.createElement = origCreate;
  });

  test("handles AbortError silently", async () => {
    const error = new Error("User cancelled");
    error.name = "AbortError";
    /** @type {any} */ (window).showSaveFilePicker = async () => {
      throw error;
    };

    openTab({
      id: "test-abort",
      document: { tagName: "div" },
    });

    await exportFile();
  });
});
