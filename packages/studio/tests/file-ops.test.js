import { describe, test, expect, beforeEach } from "bun:test";
import { registerPlatform } from "../src/platform.js";

import { loadMarkdown, openFile, saveFile, exportFile } from "../src/files/file-ops.js";

// ─── loadMarkdown ─────────────────────────────────────────────────────────────

describe("loadMarkdown", () => {
  test("returns content state for plain markdown", async () => {
    const state = await loadMarkdown("---\ntitle: Test Post\n---\n\n# Hello\n\nWorld", null);
    expect(state.sourceFormat).toBe("md");
    expect(state.mode).toBe("content");
    expect(state.dirty).toBe(false);
    expect(state.document).toBeDefined();
    expect(state.document.children).toBeDefined();
    expect(state.content.frontmatter.title).toBe("Test Post");
  });

  test("stores rawMarkdown source", async () => {
    const source = "# Hello\n\nWorld";
    const state = await loadMarkdown(source, null);
    expect(state.rawMarkdown).toBe(source);
  });

  test("stores fileHandle reference", async () => {
    const handle = { name: "test.md" };
    const state = await loadMarkdown("# Test", handle);
    expect(state.fileHandle).toBe(handle);
  });

  test("returns component state for hyphenated tagName", async () => {
    const state = await loadMarkdown("---\ntagName: my-component\n---\n# Content\n", null);
    expect(state.sourceFormat).toBe("md");
    expect(state.dirty).toBe(false);
    expect(state.document.tagName).toBe("my-component");
    expect(state.mode).not.toBe("content");
  });

  test("extracts frontmatter keys excluding children", async () => {
    const state = await loadMarkdown("---\ntitle: Test Post\n---\n\n# Content doc", null);
    expect(state.content.frontmatter).toBeDefined();
    expect(state.content.frontmatter.children).toBeUndefined();
    expect(state.content.frontmatter.title).toBe("Test Post");
  });
});

// ─── openFile ─────────────────────────────────────────────────────────────────

describe("openFile", () => {
  beforeEach(() => {
    registerPlatform({});
    // Clean up any showOpenFilePicker mock
    delete (/** @type {any} */ (window).showOpenFilePicker);
  });

  test("uses file input fallback when showOpenFilePicker unavailable", async () => {
    let inputCreated = false;
    const origCreate = document.createElement.bind(document);
    document.createElement = (/** @type {any} */ tag, /** @type {any} */ ...args) => {
      const el = origCreate(tag, ...args);
      if (tag === "input") {
        inputCreated = true;
        el.click = () => {}; // prevent actual click
      }
      return el;
    };

    await openFile({
      S: {},
      commit: () => {},
      renderToolbar: () => {},
    });

    expect(inputCreated).toBe(true);
    document.createElement = origCreate;
  });

  test("opens JSON file via showOpenFilePicker", async () => {
    /** @type {any} */
    let committed = null;
    const mockHandle = {
      name: "component.json",
      getFile: async () => ({
        text: async () => JSON.stringify({ tagName: "div", children: [] }),
      }),
    };
    /** @type {any} */ (window).showOpenFilePicker = async () => [mockHandle];

    registerPlatform({ locateFile: () => "pages/component.json" });

    await openFile({
      S: {},
      commit: (/** @type {any} */ s) => {
        committed = s;
      },
      renderToolbar: () => {},
    });

    expect(committed).not.toBeNull();
    expect(committed.document.tagName).toBe("div");
    expect(committed.fileHandle).toBe(mockHandle);
    expect(committed.dirty).toBe(false);
  });

  test("opens markdown file via showOpenFilePicker", async () => {
    /** @type {any} */
    let committed = null;
    const mockHandle = {
      name: "post.md",
      getFile: async () => ({
        text: async () => "# Hello\n\nContent here",
      }),
    };
    /** @type {any} */ (window).showOpenFilePicker = async () => [mockHandle];

    await openFile({
      S: {},
      commit: (/** @type {any} */ s) => {
        committed = s;
      },
      renderToolbar: () => {},
    });

    expect(committed).not.toBeNull();
    expect(committed.sourceFormat).toBe("md");
    expect(committed.fileHandle).toBe(mockHandle);
  });

  test("handles AbortError silently", async () => {
    const error = new Error("User cancelled");
    error.name = "AbortError";
    /** @type {any} */ (window).showOpenFilePicker = async () => {
      throw error;
    };

    // Should not throw
    await openFile({
      S: {},
      commit: () => {},
      renderToolbar: () => {},
    });
  });
});

// ─── saveFile ─────────────────────────────────────────────────────────────────

describe("saveFile", () => {
  test("saves via platform when documentPath exists", async () => {
    /** @type {any} */
    let written = null;
    registerPlatform({
      writeFile: (/** @type {any} */ path, /** @type {any} */ content) => {
        written = { path, content };
      },
    });

    /** @type {any} */
    let committed = null;
    await saveFile({
      S: {
        documentPath: "pages/index.json",
        document: { tagName: "div", children: [] },
        mode: "component",
      },
      commit: (/** @type {any} */ s) => {
        committed = s;
      },
      renderToolbar: () => {},
    });

    expect(written).not.toBeNull();
    expect(written.path).toBe("pages/index.json");
    expect(committed.dirty).toBe(false);
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

    registerPlatform({});
    /** @type {any} */
    let committed = null;
    await saveFile({
      S: {
        fileHandle: mockHandle,
        document: { tagName: "div", children: [] },
        mode: "component",
      },
      commit: (/** @type {any} */ s) => {
        committed = s;
      },
      renderToolbar: () => {},
    });

    expect(writtenContent).not.toBeNull();
    expect(committed.dirty).toBe(false);
  });

  test("shows message when no save target", async () => {
    registerPlatform({});
    // Should not throw
    await saveFile({
      S: { document: { tagName: "div" }, mode: "component" },
      commit: () => {},
      renderToolbar: () => {},
    });
  });

  test("serializes markdown source format with jxDocToMd", async () => {
    let writtenContent = null;
    registerPlatform({
      writeFile: (/** @type {any} */ _path, /** @type {any} */ content) => {
        writtenContent = content;
      },
    });

    await saveFile({
      S: {
        documentPath: "pages/post.md",
        sourceFormat: "md",
        document: { tagName: "div", children: [{ tagName: "p", textContent: "Hello" }] },
        mode: "component",
      },
      commit: () => {},
      renderToolbar: () => {},
    });

    expect(writtenContent).toBeDefined();
    expect(typeof writtenContent).toBe("string");
  });

  test("handles save error gracefully", async () => {
    registerPlatform({
      writeFile: () => {
        throw new Error("disk full");
      },
    });

    await saveFile({
      S: {
        documentPath: "pages/index.json",
        document: { tagName: "div" },
        mode: "component",
      },
      commit: () => {},
      renderToolbar: () => {},
    });
  });
});

// ─── exportFile ───────────────────────────────────────────────────────────────

describe("exportFile", () => {
  beforeEach(() => {
    delete (/** @type {any} */ (window).showSaveFilePicker);
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

    /** @type {any} */
    let committed = null;
    await exportFile({
      S: {
        document: { tagName: "div", children: [] },
        mode: "component",
      },
      commit: (/** @type {any} */ s) => {
        committed = s;
      },
      renderToolbar: () => {},
    });

    expect(writtenContent).not.toBeNull();
    expect(committed.dirty).toBe(false);
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

    /** @type {any} */
    let committed = null;
    await exportFile({
      S: {
        document: { tagName: "div", children: [] },
        mode: "component",
      },
      commit: (/** @type {any} */ s) => {
        committed = s;
      },
      renderToolbar: () => {},
    });

    expect(clickedLink).toBe(true);
    expect(committed.dirty).toBe(false);
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

    await exportFile({
      S: {
        document: { children: [{ tagName: "p", textContent: "Hello" }] },
        mode: "content",
        content: { frontmatter: {} },
      },
      commit: () => {},
      renderToolbar: () => {},
    });

    expect(downloadName).toBe("content.md");
    document.createElement = origCreate;
  });

  test("handles AbortError silently", async () => {
    const error = new Error("User cancelled");
    error.name = "AbortError";
    /** @type {any} */ (window).showSaveFilePicker = async () => {
      throw error;
    };

    await exportFile({
      S: { document: { tagName: "div" }, mode: "component" },
      commit: () => {},
      renderToolbar: () => {},
    });
  });
});
