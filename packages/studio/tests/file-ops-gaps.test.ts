/**
 * Gap coverage for src/files/file-ops.ts — openFile fallback input + no-format error, saveFile
 * inline-edit/no-tab guards, exportFile no-tab/error paths, and serializeDocument's content-mode
 * default-format branch.
 */
import { flush, installMockPlatform } from "./harness";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { activeTab, closeAllTabs, openTab } from "../src/workspace/workspace";
import { setFormats } from "../src/format/format-host";
import { mockFormatAction, seedMarkdownFormat } from "./format-fixture";

// SaveFile now flushes pending canvas text over the iframe bridge instead of calling the parent
// Realm's `isEditing()` (which was dead — editing lives in the canvas iframe). Stub the bridge so
// The save path is reachable without mounting a canvas, and record that it was asked to flush.
let flushCalls = 0;
void mock.module("../src/canvas/iframe-host", () => ({
  flushCanvasEdits: async () => {
    flushCalls += 1;
  },
}));

const { exportFile, openFile, saveFile, serializeDocument } = await import("../src/files/file-ops");

beforeEach(() => {
  flushCalls = 0;
  closeAllTabs();
  seedMarkdownFormat();
  installMockPlatform({ formatAction: mockFormatAction });
  delete (window as any).showOpenFilePicker;
  delete (window as any).showSaveFilePicker;
});

// ─── openFile ─────────────────────────────────────────────────────────────────

describe("openFile gaps", () => {
  test("rejects files with no registered format via picker", async () => {
    (window as any).showOpenFilePicker = async () => [
      {
        getFile: async () => ({ text: async () => "a = 1" }),
        name: "data.toml",
      },
    ];

    await openFile();

    expect(activeTab.value).toBeNull();
  });

  test("non-AbortError from the picker is swallowed into a status message", async () => {
    (window as any).showOpenFilePicker = async () => {
      throw new Error("picker exploded");
    };

    await openFile();

    expect(activeTab.value).toBeNull();
  });

  describe("fallback file input (no showOpenFilePicker)", () => {
    let origCreate: typeof document.createElement;
    let input: HTMLInputElement | null = null;

    beforeEach(() => {
      input = null;
      origCreate = document.createElement.bind(document);
      document.createElement = ((tag: string, ...args: unknown[]) => {
        const el = (origCreate as any)(tag, ...args);
        if (tag === "input") {
          input = el as HTMLInputElement;
          el.click = () => {};
        }
        return el;
      }) as typeof document.createElement;
    });

    afterEach(() => {
      document.createElement = origCreate;
    });

    test("opens the chosen file when the input changes", async () => {
      await openFile();

      expect(input).not.toBeNull();
      expect(input!.type).toBe("file");
      expect(input!.accept).toContain(".json");
      expect(input!.accept).toContain(".md");

      Object.defineProperty(input!, "files", {
        configurable: true,
        value: [
          {
            name: "fallback.json",
            text: async () => JSON.stringify({ children: [], tagName: "main" }),
          },
        ],
      });
      input!.dispatchEvent(new Event("change"));
      await flush();

      expect(activeTab.value).not.toBeNull();
      expect(activeTab.value!.doc.document.tagName).toBe("main");
    });

    test("change with no selected file is a no-op", async () => {
      await openFile();

      Object.defineProperty(input!, "files", { configurable: true, value: [] });
      input!.dispatchEvent(new Event("change"));
      await flush();

      expect(activeTab.value).toBeNull();
    });
  });
});

// ─── saveFile ─────────────────────────────────────────────────────────────────

describe("saveFile gaps", () => {
  test("returns early when no tab is open", async () => {
    const { state } = installMockPlatform({ formatAction: mockFormatAction });

    await saveFile();

    expect(state.calls.filter(([name]) => name === "writeFile")).toHaveLength(0);
  });

  test("flushes pending canvas text BEFORE serializing", async () => {
    // Text reaches the document on an idle tick, so without this a save mid-sentence writes the
    // File without the sentence.
    const { state } = installMockPlatform({ formatAction: mockFormatAction });
    openTab({
      document: { children: [], tagName: "div" },
      documentPath: "pages/index.json",
      id: "save-editing",
    });

    await saveFile();

    expect(flushCalls).toBe(1);
    expect(state.files.has("pages/index.json")).toBe(true);
  });

  test("does not flush when there is no tab to save", async () => {
    closeAllTabs();
    await saveFile();
    expect(flushCalls).toBe(0);
  });
});

// ─── exportFile ───────────────────────────────────────────────────────────────

describe("exportFile gaps", () => {
  test("returns early when no tab is open", async () => {
    let pickerCalled = false;
    (window as any).showSaveFilePicker = async () => {
      pickerCalled = true;
      throw new Error("should not reach");
    };

    await exportFile();

    expect(pickerCalled).toBe(false);
  });

  test("non-AbortError during export becomes a status message, tab stays dirty", async () => {
    (window as any).showSaveFilePicker = async () => {
      throw new Error("disk detached");
    };
    openTab({ document: { children: [], tagName: "div" }, id: "export-err" });
    activeTab.value!.doc.dirty = true;

    await exportFile();

    expect(activeTab.value!.doc.dirty).toBe(true);
  });
});

// ─── serializeDocument — content mode via default content format ─────────────

describe("serializeDocument content mode", () => {
  test("serializes through the default content format without frontmatter", async () => {
    const tab = openTab({
      document: { children: [{ tagName: "p", textContent: "Hello world" }] },
      id: "content-no-fm",
    });
    tab.doc.mode = "content";
    tab.doc.sourceFormat = null;
    tab.doc.content.frontmatter = {};

    const out = await serializeDocument(tab);

    expect(out).toContain("Hello world");
    expect(out.startsWith("---")).toBe(false);
  });

  test("includes frontmatter when present", async () => {
    const tab = openTab({
      document: { children: [{ tagName: "p", textContent: "Body text" }] },
      id: "content-fm",
    });
    tab.doc.mode = "content";
    tab.doc.sourceFormat = null;
    tab.doc.content.frontmatter = { title: "My Post" };

    const out = await serializeDocument(tab);

    expect(out).toContain("title: My Post");
    expect(out).toContain("Body text");
  });

  test("handles a missing content.frontmatter object", async () => {
    const tab = openTab({
      document: { children: [{ tagName: "p", textContent: "Bare" }] },
      id: "content-no-content",
    });
    tab.doc.mode = "content";
    tab.doc.sourceFormat = null;
    (tab.doc as any).content = null;

    const out = await serializeDocument(tab);

    expect(out).toContain("Bare");
  });

  test("falls back to JSON when no content format is registered", async () => {
    setFormats([]);
    const doc = { children: [{ tagName: "p", textContent: "Raw" }], tagName: "div" };
    const tab = openTab({ document: doc, id: "content-json-fallback" });
    tab.doc.mode = "content";
    tab.doc.sourceFormat = null;

    const out = await serializeDocument(tab);

    expect(JSON.parse(out)).toEqual(doc);
  });
});
