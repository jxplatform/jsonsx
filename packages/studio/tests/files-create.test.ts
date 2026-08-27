/**
 * Tests for `createFileIn` — the ONE creation flow, shared by the Files tree, the Library and the
 * content collections.
 *
 * Before P7.1 there were two, and they disagreed about both of the things asserted here. The tree
 * asked for a file NAME and wrote it verbatim; the Manage view asked for a display name, slugified
 * it and appended the type's extension. Neither checked whether the destination already held that
 * name, so creating `about.md` in a directory that had one silently replaced it — with no undo,
 * because the file was never open.
 *
 * The extension is now CHOSEN rather than typed, which adds a third naming mode and one rule that
 * only a picker can break: switching format changes whether the composed name is already taken,
 * with no keystroke to notice. That case has its own test, and it is the whole reason
 * `showPromptDialog` owns the choice rather than a caller rendering one.
 */
import {
  answerPromptDialog,
  flush,
  installMockPlatform,
  pickPromptFormat,
  promptFormatOptions,
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
  capabilities: {
    parse: { identifier: "parse", timing: ["client"] },
    serialize: { identifier: "serialize", timing: ["client"] },
  },
  documentKinds: ["page", "component", "content"],
  exportTarget: false,
  extensions: [".md"],
  mediaType: "text/markdown",
  name: "Markdown",
  remote: false,
  studio: { newFileTemplate: "# New file\n" },
};

/** Parse-only: creatable formats need a serializer, or the first save writes another format. */
const CSV: StudioFormat = {
  capabilities: { parse: { identifier: "parse", timing: ["client"] } },
  documentKinds: ["content"],
  exportTarget: false,
  extensions: [".csv"],
  mediaType: "text/csv",
  name: "Csv",
  remote: true,
  studio: null,
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

/** The validation message currently showing, without touching the field. */
function currentValidation(): string {
  return topDialog()?.querySelector("sp-help-text")?.textContent?.trim() ?? "";
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
  setFormats([MARKDOWN, CSV]);
});

describe("naming", () => {
  test("with no `format` the field is a FILE NAME and is taken verbatim — the i18n contract", async () => {
    const pending = createFileIn({ dir: "pages", suggestedName: "untitled.json" });
    await flush();
    expect(topDialog()!.querySelector("sp-picker")).toBeNull();
    await answerPromptDialog("About Us.json");
    expect(await pending).toBe("pages/About Us.json");
  });

  test("a `fixed` format asks for a DISPLAY NAME and slugifies it — the collection's contract", async () => {
    const pending = createFileIn({
      dir: "content",
      format: { ext: ".md", kind: "fixed" },
      title: "New Post",
    });
    await flush();
    expect(topDialog()!.textContent).toContain("Creating in content/");
    expect(topDialog()!.querySelector("sp-picker")).toBeNull();
    await answerPromptDialog("My First Post!");
    expect(await pending).toBe("content/my-first-post.md");
  });

  test("a picker asks for a NAME and appends the picked extension, verbatim", async () => {
    const pending = createFileIn({
      dir: "pages",
      format: { kind: "choose" },
      suggestedName: "untitled",
    });
    await flush();
    await answerPromptDialog("About Us", ".md");
    expect(await pending).toBe("pages/About Us.md");
  });

  /**
   * The stem is NOT slugified, and that is load-bearing rather than lax: the slugifier lowercases
   * and strips everything outside `[a-z0-9-]`, so `[slug]` becomes `slug` — and eight shipped
   * starters carry `pages/[slug].json`. A picker that slugified would make a dynamic route
   * uncreatable and would say nothing about it.
   */
  test("a dynamic route's brackets survive the picker", async () => {
    const pending = createFileIn({
      dir: "pages",
      format: { kind: "choose" },
      suggestedName: "untitled",
    });
    await flush();
    await answerPromptDialog("[slug]", ".json");
    expect(await pending).toBe("pages/[slug].json");
  });

  test("a name already carrying the picked extension is composed once, not doubled", async () => {
    const pending = createFileIn({
      dir: "pages",
      format: { kind: "choose" },
      suggestedName: "untitled",
    });
    await flush();
    await answerPromptDialog("hero.json", ".json");
    expect(await pending).toBe("pages/hero.json");
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

describe("the picker's rows", () => {
  test("JSON first, then every format that can be both read and written, then Other…", async () => {
    const pending = createFileIn({
      dir: "pages",
      format: { kind: "choose" },
      suggestedName: "untitled",
    });
    await flush();
    // `.csv` is absent: Csv declares no serializer, so the first save of one would fall through to
    // The default content format and write ANOTHER format's bytes into it.
    expect(promptFormatOptions()).toEqual([
      [".json", "JSON (.json)"],
      [".md", "Markdown (.md)"],
      ["__other__", "Other…"],
    ]);
    await answerPromptDialog(null);
    await pending;
  });

  test("a document kind narrows them", async () => {
    const pending = createFileIn({
      dir: "pages",
      format: { docKind: "page", kind: "choose" },
      suggestedName: "untitled",
    });
    await flush();
    expect(promptFormatOptions().map(([value]) => value)).toEqual([".json", ".md", "__other__"]);
    await answerPromptDialog(null);
    await pending;

    const contentOnly = createFileIn({
      dir: "pages",
      format: { docKind: "content", kind: "choose" },
      suggestedName: "untitled",
    });
    await flush();
    expect(promptFormatOptions().map(([value]) => value)).toEqual([".json", ".md", "__other__"]);
    await answerPromptDialog(null);
    await contentOnly;
  });

  test("a locked choice offers that format and Other…, and nothing else", async () => {
    const pending = createFileIn({
      dir: "content",
      format: { because: "posts entries are .md files.", ext: ".md", kind: "locked" },
      suggestedName: "untitled",
    });
    await flush();
    expect(promptFormatOptions()).toEqual([
      [".md", "Markdown (.md)"],
      ["__other__", "Other…"],
    ]);
    await answerPromptDialog(null);
    await pending;
  });

  test("with no formats installed the picker is JSON and Other… — so Other… stays reachable", async () => {
    setFormats([]);
    const pending = createFileIn({
      dir: "pages",
      format: { kind: "choose" },
      suggestedName: "untitled",
    });
    await flush();
    expect(promptFormatOptions()).toEqual([
      [".json", "JSON (.json)"],
      ["__other__", "Other…"],
    ]);
    await answerPromptDialog(null);
    await pending;
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

  /**
   * The case a caller-rendered picker could not have fixed.
   *
   * Nothing is typed here: the name is valid for Markdown and taken for JSON, and only the pick
   * changes. `showPromptDialog` owns the choice precisely so `validate` re-runs against it — a
   * dialog that compared error strings, as the keystroke path does, would leave the refusal on
   * screen after the reader switched away from it.
   */
  test("switching format re-runs the collision check with no keystroke", async () => {
    listing.pages = [
      { name: "index.json", path: "pages/index.json", type: "file" },
      { name: "about.md", path: "pages/about.md", type: "file" },
    ];
    install();
    const pending = createFileIn({
      dir: "pages",
      format: { defaultExt: ".json", kind: "choose" },
      suggestedName: "untitled",
    });
    await flush();
    expect(await validationFor("about")).toBe("");

    await pickPromptFormat(".md");
    expect(currentValidation()).toContain("about.md already exists in pages/.");

    await pickPromptFormat(".json");
    expect(currentValidation()).toBe("");
    await answerPromptDialog(null);
    await pending;
  });

  test("collisions are case-insensitive, because the filesystem often is", async () => {
    const pending = createFileIn({ dir: "pages", suggestedName: "untitled.json" });
    await flush();
    expect(await validationFor("INDEX.json")).toContain("already exists in pages/");
    await answerPromptDialog(null);
    await pending;
  });

  test("so is a display name that slugifies onto an existing file", async () => {
    const pending = createFileIn({ dir: "content", format: { ext: ".md", kind: "fixed" } });
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

    const asName = createFileIn({ dir: "content", format: { ext: ".md", kind: "fixed" } });
    await flush();
    expect(await validationFor("  ")).toBe("Enter a name.");
    await answerPromptDialog(null);
    await asName;

    const withPicker = createFileIn({ dir: "pages", format: { kind: "choose" } });
    await flush();
    expect(await validationFor(" ")).toBe("Enter a file name.");
    await answerPromptDialog(null);
    await withPicker;
  });

  test("a display name of pure punctuation slugifies to nothing, and says so", async () => {
    const pending = createFileIn({ dir: "content", format: { ext: ".md", kind: "fixed" } });
    await flush();
    expect(await validationFor("!!!")).toContain("at least one letter or number");
    await answerPromptDialog(null);
    await pending;
  });

  test("a name whose extension contradicts the pick is refused, naming both sides", async () => {
    const pending = createFileIn({
      dir: "pages",
      format: { defaultExt: ".json", kind: "choose" },
      suggestedName: "untitled",
    });
    await flush();
    expect(await validationFor("hero.md")).toBe("You picked JSON (.json); this name ends in .md.");
    // An extension no format claims is a stem that happens to have a dot, and is composed as one.
    expect(await validationFor("v1.2")).toBe("");
    await answerPromptDialog(null);
    await pending;
  });

  test("a path is refused where the field is a name, and offered the row that accepts one", async () => {
    const pending = createFileIn({
      dir: "pages",
      format: { kind: "choose" },
      suggestedName: "untitled",
    });
    await flush();
    expect(await validationFor("blog/hero")).toContain("Pick Other…");
    await pickPromptFormat("__other__");
    expect(currentValidation()).toBe("");
    await answerPromptDialog(null);
    await pending;
  });

  test("an escaping name is refused in every mode", async () => {
    const pending = createFileIn({ dir: "pages", suggestedName: "untitled.json" });
    await flush();
    expect(await validationFor("../secrets.json")).toContain("outside the destination folder");
    expect(await validationFor("/etc/passwd")).toContain("starts or ends with a slash");
    await answerPromptDialog(null);
    await pending;
  });

  /**
   * The escape hatch must not defeat the constraint it exists beside. A `credits.txt` in a
   * collection folder is co-located media and is fine; a `post.json` there would be discovered as
   * an entry of a collection whose entries are `.md`, and nothing downstream would say so.
   */
  test("Other… inside a locked collection refuses a FOREIGN document, and only that", async () => {
    const pending = createFileIn({
      dir: "content",
      format: { because: "posts entries are .md files.", ext: ".md", kind: "locked" },
      suggestedName: "untitled",
    });
    await flush();
    await pickPromptFormat("__other__");
    expect(await validationFor("post.json")).toBe("posts entries are .md files.");
    expect(await validationFor("credits.txt")).toBe("");
    expect(await validationFor("notes.md")).toBe("");
    await answerPromptDialog(null);
    await pending;
  });
});

describe("what gets written", () => {
  test("the format's template, when the extension has one", async () => {
    const pending = createFileIn({ dir: "content", format: { ext: ".md", kind: "fixed" } });
    await flush();
    await answerPromptDialog("Notes");
    await pending;
    expect(written).toEqual([{ content: "# New file\n", path: "content/notes.md" }]);
  });

  test("a blank DOCUMENT for a .json the reader picked from the format list", async () => {
    const pending = createFileIn({
      dir: "pages",
      format: { kind: "choose" },
      suggestedName: "untitled",
    });
    await flush();
    await answerPromptDialog("hero", ".json");
    await pending;
    expect(JSON.parse(written[0]!.content)).toEqual({
      children: [{ children: [], tagName: "p" }],
      tagName: "div",
    });
  });

  /**
   * A `.json` typed through Other… is data, not a document — a `nav.json`, a fixture. It gets `{}`,
   * which is at least openable; the `BLANK_DOCUMENT` above would put a `<div><p>` into a file the
   * author meant as a map, and `""` would be a file that reports "no format" the moment it is
   * clicked.
   */
  test("an empty object for a .json typed through Other…", async () => {
    const pending = createFileIn({
      dir: "pages",
      format: { kind: "choose" },
      suggestedName: "untitled",
    });
    await flush();
    await answerPromptDialog("data.json", "__other__");
    await pending;
    expect(written).toEqual([{ content: "{}\n", path: "pages/data.json" }]);
  });

  test("nothing at all for an extension no format claims", async () => {
    listing.styles = [];
    const pending = createFileIn({
      dir: "styles",
      format: { kind: "choose" },
      suggestedName: "untitled",
    });
    await flush();
    await answerPromptDialog("main.css", "__other__");
    await pending;
    expect(written).toEqual([{ content: "", path: "styles/main.css" }]);
  });

  test("the caller's own body wins over both", async () => {
    const pending = createFileIn({
      content: "---\ntitle: x\n---\n",
      dir: "content",
      format: { ext: ".md", kind: "fixed" },
    });
    await flush();
    await answerPromptDialog("Seeded");
    await pending;
    expect(written[0]!.content).toBe("---\ntitle: x\n---\n");
  });

  /**
   * A lazy body is the only way a caller can seed content whose FORMAT it does not know until the
   * dialog resolves — the Library's New ▸ Component, which must write a `tagName` a markdown
   * template does not carry.
   */
  test("a body function is handed the settled extension and the composed name", async () => {
    const seen: [string, string][] = [];
    const pending = createFileIn({
      content: (ext, fileName) => {
        seen.push([ext, fileName]);
        return `seeded for ${ext}`;
      },
      dir: "pages",
      format: { kind: "choose" },
      suggestedName: "untitled",
    });
    await flush();
    await answerPromptDialog("card", ".md");
    await pending;
    expect(seen).toEqual([[".md", "card.md"]]);
    expect(written[0]!.content).toBe("seeded for .md");
  });

  test("a body function answering nothing falls back to the format's template", async () => {
    const pending = createFileIn({
      // How the Library's component seed declines a `.json`: there is no format to ask.
      content: (): string | undefined => undefined,
      dir: "content",
      format: { ext: ".md", kind: "fixed" },
    });
    await flush();
    await answerPromptDialog("Notes");
    await pending;
    expect(written[0]!.content).toBe("# New file\n");
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
    const pending = createFileIn({ dir: "brand-new", format: { ext: ".md", kind: "fixed" } });
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
