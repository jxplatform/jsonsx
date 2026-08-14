/**
 * Tests for `createFileIn` — the ONE creation flow, shared by the Files tree and the Library.
 *
 * Before P7.1 there were two, and they disagreed about both of the things asserted here. The tree
 * asked for a file NAME and wrote it verbatim; the Manage view asked for a display name, slugified
 * it and appended the type's extension. Neither checked whether the destination already held that
 * name, so creating `about.md` in a directory that had one silently replaced it — with no undo,
 * because the file was never open.
 */
import {
  answerPromptDialog,
  flush,
  installMockPlatform,
  resetStudioState,
  topDialog,
} from "./harness";
import { beforeEach, describe, expect, test } from "bun:test";
import { initLayers } from "../src/ui/layers";
import { problems, resetNotifications, toasts } from "../src/services/notify";
import { setFormats } from "../src/format/format-host";
import { createFileIn } from "../src/files/files";
import type { StudioFormat } from "../src/format/format-host";
import type { DirEntry } from "../src/types";

for (const id of ["layer-popover", "layer-modal", "layer-dialog"]) {
  if (!document.querySelector(`#${id}`)) {
    const el = document.createElement("div");
    el.id = id;
    document.body.append(el);
  }
}
initLayers();

globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
  setTimeout(() => cb(0), 0);
  return 0;
}) as typeof requestAnimationFrame;

const MARKDOWN: StudioFormat = {
  capabilities: {},
  documentKinds: ["content"],
  exportTarget: false,
  extensions: [".md"],
  mediaType: "text/markdown",
  name: "Markdown",
  remote: false,
  studio: { newFileTemplate: "# New file\n" },
};

let written: { path: string; content: string }[];
let listing: Record<string, DirEntry[]>;

function install(overrides: Record<string, unknown> = {}) {
  written = [];
  installMockPlatform({
    listDirectory: (path: string) => {
      const entries = listing[path];
      return entries ? Promise.resolve(entries) : Promise.reject(new Error(`ENOENT: ${path}`));
    },
    writeFile: (path: string, content: string) => {
      written.push({ content, path });
      return Promise.resolve();
    },
    ...overrides,
  });
}

/** The validation message the open dialog is currently showing for `value`. */
async function validationFor(value: string): Promise<string> {
  const field = topDialog()!.querySelector("sp-textfield") as HTMLInputElement;
  field.value = value;
  field.dispatchEvent(new Event("input", { bubbles: true }));
  await flush();
  const help = topDialog()!.querySelector("sp-help-text");
  return help?.textContent?.trim() ?? "";
}

beforeEach(() => {
  resetNotifications();
  toasts.length = 0;
  listing = {
    content: [{ name: "hello.md", path: "content/hello.md", type: "file" }],
    pages: [{ name: "index.json", path: "pages/index.json", type: "file" }],
  };
  install();
  resetStudioState({ dirs: new Map(), projectConfig: null, projectDirs: ["pages"] });
  setFormats([MARKDOWN]);
});

describe("naming", () => {
  test("with no `ext` the field is a FILE NAME and is taken verbatim — the tree's contract", async () => {
    const pending = createFileIn({ dir: "pages", suggestedName: "untitled.json" });
    await flush();
    await answerPromptDialog("About Us.json");
    expect(await pending).toBe("pages/About Us.json");
  });

  test("with an `ext` the field is a DISPLAY NAME and is slugified — the Library's contract", async () => {
    const pending = createFileIn({ dir: "content", ext: ".md", title: "New Post" });
    await flush();
    expect(topDialog()!.textContent).toContain("Creating in content/");
    await answerPromptDialog("My First Post!");
    expect(await pending).toBe("content/my-first-post.md");
  });

  test("the project root is named as the root, not as `./`", async () => {
    listing["."] = [];
    const pending = createFileIn({ dir: "." });
    await flush();
    expect(topDialog()!.textContent).toContain("Creating in the project root.");
    await answerPromptDialog("notes.md");
    expect(await pending).toBe("notes.md");
  });
});

describe("refusing in the field", () => {
  test("a name already taken in the destination is refused before anything is written", async () => {
    const pending = createFileIn({ dir: "pages", suggestedName: "untitled.json" });
    await flush();
    expect(await validationFor("index.json")).toContain("already exists in pages/");
    await answerPromptDialog(null);
    await pending;
    expect(written).toEqual([]);
  });

  test("so is one that slugifies onto an existing file", async () => {
    const pending = createFileIn({ dir: "content", ext: ".md" });
    await flush();
    expect(await validationFor("Hello")).toContain("already exists in content/");
    await answerPromptDialog(null);
    await pending;
  });

  test("an empty name is refused, in the wording the prompt actually asked for", async () => {
    const asFile = createFileIn({ dir: "pages" });
    await flush();
    expect(await validationFor("   ")).toBe("Enter a file name.");
    await answerPromptDialog(null);
    await asFile;

    const asName = createFileIn({ dir: "content", ext: ".md" });
    await flush();
    expect(await validationFor("  ")).toBe("Enter a name.");
    await answerPromptDialog(null);
    await asName;
  });

  test("a display name of pure punctuation slugifies to nothing, and says so", async () => {
    const pending = createFileIn({ dir: "content", ext: ".md" });
    await flush();
    expect(await validationFor("!!!")).toContain("at least one letter or number");
    await answerPromptDialog(null);
    await pending;
  });
});

describe("what gets written", () => {
  test("the format's template, when the extension has one", async () => {
    const pending = createFileIn({ dir: "content", ext: ".md" });
    await flush();
    await answerPromptDialog("Notes");
    await pending;
    expect(written).toEqual([{ content: "# New file\n", path: "content/notes.md" }]);
  });

  test("a blank document, when no format claims the extension", async () => {
    const pending = createFileIn({ dir: "pages", suggestedName: "untitled.json" });
    await flush();
    await answerPromptDialog("hero.json");
    await pending;
    expect(JSON.parse(written[0]!.content)).toEqual({
      children: [{ children: [], tagName: "p" }],
      tagName: "div",
    });
  });

  test("the caller's own body wins over both", async () => {
    const pending = createFileIn({ content: "---\ntitle: x\n---\n", dir: "content", ext: ".md" });
    await flush();
    await answerPromptDialog("Seeded");
    await pending;
    expect(written[0]!.content).toBe("---\ntitle: x\n---\n");
  });
});

describe("outcomes", () => {
  test("cancelling writes nothing and answers null", async () => {
    const pending = createFileIn({ dir: "pages" });
    await flush();
    await answerPromptDialog(null);
    expect(await pending).toBeNull();
    expect(written).toEqual([]);
  });

  test("a destination that cannot be listed is not fatal — the write is the authority", async () => {
    const pending = createFileIn({ dir: "brand-new", ext: ".md" });
    await flush();
    await answerPromptDialog("First");
    expect(await pending).toBe("brand-new/first.md");
  });

  test("a failed write is a Problem carrying the path and the caller's own source", async () => {
    install({ writeFile: () => Promise.reject(new Error("EACCES")) });
    const pending = createFileIn({ dir: "pages", source: "Library" });
    await flush();
    await answerPromptDialog("hero.json");
    expect(await pending).toBeNull();
    const problem = problems.at(-1)!;
    expect(problem.message).toBe("Could not create pages/hero.json.");
    expect(problem.path).toBe("pages/hero.json");
    expect(problem.source).toBe("Library");
    expect(problem.detail).toContain("EACCES");
  });

  test('the source defaults to "Files"', async () => {
    install({ writeFile: () => Promise.reject(new Error("EACCES")) });
    const pending = createFileIn({ dir: "pages" });
    await flush();
    await answerPromptDialog("hero.json");
    await pending;
    expect(problems.at(-1)!.source).toBe("Files");
  });
});
