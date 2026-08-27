/**
 * Tests for src/format/convert-file.ts — moving one document between formats, in place.
 *
 * Two invariants carry most of the weight here, and neither is visible in the result:
 *
 * 1. **Every refusal fires before anything on disk moves.** Each case asserts the platform saw NO
 *    write and NO rename, not merely that the answer was null — a refusal that has already half-run
 *    is the failure mode this whole ordering exists to prevent.
 * 2. **The converted bytes are written to the OLD path, then renamed.** The backend's refactor pass
 *    runs after the move and re-reads every document in the project, so the other order hands it
 *    markdown at a `.json` path: it throws into `report.errors`, skips tag derivation, and leaves
 *    the moved file's own references unrewritten. The call ORDER is asserted, not just the
 *    outcome.
 */
import { flush, installMockPlatform, resetStudioState, topDialog } from "./harness";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { initLayers } from "../src/ui/layers";
import { problems, resetNotifications, toasts } from "../src/services/notify";
import { setFormats } from "../src/format/format-host";
import { closeAllTabs, openTab, workspace } from "../src/workspace/workspace";
import { convertFile, fileFormatCommands } from "../src/format/convert-file";
import { invalidateUsages } from "../src/services/references";
import { CSV_FORMAT, MARKDOWN_FORMAT, mockFormatAction } from "./format-fixture";
import type { AnyCommand } from "../src/commands/registry";
import type { MockPlatformState } from "./harness";
import type { StudioFormat } from "../src/format/format-host";

/**
 * The document validator, mocked at FILE scope with a per-test answer.
 *
 * `mock.module` is global and is not undone when a test ends, so installing it inside one case
 * silently re-answers every case after it. Hoisting it and resetting the value in `beforeEach` is
 * what keeps "the schema rejects this" from becoming "the schema rejects everything".
 */
let validatorAnswer: string[] | null = [];
void mock.module("../src/services/jx-validate", () => ({
  validateDocOrNull: () => Promise.resolve(validatorAnswer),
}));

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

const PAGE_MD = "---\ntitle: About\n---\n\n# Hello\n";

let state: MockPlatformState;

function install(files: Record<string, string>, overrides: Record<string, unknown> = {}) {
  ({ state } = installMockPlatform(
    { formatAction: mockFormatAction, ...overrides } as never,
    files,
  ));
}

/** The platform calls that touched the filesystem, in order. */
function fsCalls(): string[] {
  return state.calls
    .filter(([name]) => name === "writeFile" || name === "renameFile" || name === "deleteFile")
    .map(([name, ...args]) => `${name} ${(args as string[])[0]}`);
}

/**
 * Confirm (or dismiss) the convert dialog once it is up.
 *
 * Polled rather than flushed once: `convertFile` reaches the dialog through a chain of dynamic
 * imports (deliberately — the command surface must import with no DOM), and how many microtask
 * turns that costs is not a number a test should encode.
 */
async function answerConfirm(confirmed: boolean): Promise<void> {
  for (let i = 0; i < 50 && !topDialog(); i += 1) {
    await flush();
  }
  topDialog()?.dispatchEvent(new Event(confirmed ? "confirm" : "cancel"));
  await flush();
}

/** A second page-capable format, so the "which target?" dialog has something to ask about. */
const MARKDOWN_TWO: StudioFormat = {
  ...MARKDOWN_FORMAT,
  extensions: [".mdx"],
  name: "Mdx",
};

beforeEach(() => {
  resetNotifications();
  toasts.length = 0;
  validatorAnswer = [];
  invalidateUsages();
  closeAllTabs();
  setFormats([MARKDOWN_FORMAT, CSV_FORMAT]);
  resetStudioState({ dirs: new Map(), projectConfig: { content: {} }, projectDirs: ["pages"] });
  install({ "pages/about.md": PAGE_MD });
});

/*
 * A dialog left standing poisons the NEXT test, not this one: `answerConfirm` polls for "a dialog"
 * and would answer the stale one, leaving the real one unanswered and the conversion hanging until
 * the timeout. A failing assertion here would otherwise take the rest of the file with it.
 */
afterEach(() => {
  document.querySelector("#layer-dialog")!.replaceChildren();
});

describe("markdown to JSON", () => {
  test("writes the converted bytes to the OLD path, THEN renames", async () => {
    const pending = convertFile("pages/about.md", ".json");
    await answerConfirm(true);
    expect(await pending).toBe("pages/about.json");
    expect(fsCalls()).toEqual(["writeFile pages/about.md", "renameFile pages/about.md"]);
    expect(state.files.has("pages/about.md")).toBe(false);
  });

  /**
   * FLAT, not the split shape the editor holds.
   *
   * `Markdown.parse` splices frontmatter onto the document root and `Markdown.serialize` re-emits
   * every non-`children` root key as YAML, so flat is the shape the pair round-trips. Writing the
   * split shape — document without frontmatter — would silently drop `title` on the way out.
   */
  test("the frontmatter lands at the document root, beside children", async () => {
    const pending = convertFile("pages/about.md", ".json");
    await answerConfirm(true);
    await pending;
    const written = JSON.parse(state.files.get("pages/about.json")!) as Record<string, unknown>;
    expect(written.title).toBe("About");
    expect(Array.isArray(written.children)).toBe(true);
  });

  test("and reads back as the same markdown", async () => {
    const pending = convertFile("pages/about.md", ".json");
    await answerConfirm(true);
    await pending;
    const back = convertFile("pages/about.json", ".md");
    await answerConfirm(true);
    expect(await back).toBe("pages/about.md");
    expect(state.files.get("pages/about.md")).toContain("title: About");
    expect(state.files.get("pages/about.md")).toContain("# Hello");
  });
});

describe("the consequences, before the button", () => {
  test("the dialog names what moves and that the original does not survive", async () => {
    const pending = convertFile("pages/about.md", ".json");
    await flush();
    expect(topDialog()?.textContent).toContain(
      "pages/about.md becomes pages/about.json. The original file is not kept.",
    );
    await answerConfirm(false);
    expect(await pending).toBeNull();
  });

  test("dismissing it moves nothing", async () => {
    const pending = convertFile("pages/about.md", ".json");
    await answerConfirm(false);
    await pending;
    expect(fsCalls()).toEqual([]);
    expect(state.files.has("pages/about.md")).toBe(true);
  });
});

describe("refusals — all of them before anything moves", () => {
  test("a file no rule allows", async () => {
    install({ "styles/main.css": "body{}" });
    expect(await convertFile("styles/main.css", ".json")).toBeNull();
    expect(fsCalls()).toEqual([]);
    expect(problems.at(-1)?.path).toBe("styles/main.css");
  });

  test("a target the per-file rule does not allow, even though the argument declares it", async () => {
    // The command's `format` enum is project-wide by necessity; the per-file rule still decides.
    expect(await convertFile("pages/about.md", ".md")).toBeNull();
    expect(fsCalls()).toEqual([]);
  });

  test("an open tab with unsaved changes", async () => {
    openTab({
      document: { children: [], tagName: "div" },
      documentPath: "pages/about.md",
      id: "pages/about.md",
    });
    workspace.tabs.get("pages/about.md")!.doc.dirty = true;
    expect(await convertFile("pages/about.md", ".json")).toBeNull();
    expect(fsCalls()).toEqual([]);
    expect(problems.at(-1)?.detail).toContain("Save or discard");
  });

  test("a destination that already exists", async () => {
    install({ "pages/about.json": "{}", "pages/about.md": PAGE_MD });
    expect(await convertFile("pages/about.md", ".json")).toBeNull();
    expect(fsCalls()).toEqual([]);
    expect(problems.at(-1)?.message).toContain("pages/about.json already exists");
  });

  /**
   * Fail CLOSED, unlike the creation dialog.
   *
   * There a destination that cannot be listed is usually one that does not exist yet and the write
   * is the authority. Here the parent provably exists, and the operation below is `rename(2)`,
   * which replaces its destination without a word — neither backend stats it first.
   */
  test("a destination that cannot even be checked", async () => {
    install(
      { "pages/about.md": PAGE_MD },
      { listDirectory: () => Promise.reject(new Error("EIO")) },
    );
    expect(await convertFile("pages/about.md", ".json")).toBeNull();
    expect(fsCalls()).toEqual([]);
    expect(problems.at(-1)?.message).toContain("Could not check");
  });

  test("a serializer that throws — reported with its own message, nothing written", async () => {
    // `serialize.ts` refuses an element whose tagName is chosen at render time, on purpose. The
    // Conversion reports that refusal verbatim rather than restating it: the message already names
    // The candidates and tells the author to keep the element in a JSON component.
    install(
      { "pages/about.json": '{"tagName":"div","children":[]}' },
      {
        formatAction: (payload: Record<string, unknown>) =>
          payload.action === "serialize"
            ? Promise.reject(new Error("Markdown cannot express a tag chosen at creation"))
            : mockFormatAction(payload),
      },
    );
    expect(await convertFile("pages/about.json", ".md")).toBeNull();
    expect(fsCalls()).toEqual([]);
    expect(problems.at(-1)?.detail).toContain("cannot express a tag chosen at creation");
  });

  test("a file that cannot be read is reported, not converted", async () => {
    install({ "pages/about.md": PAGE_MD }, { readFile: () => Promise.reject(new Error("EIO")) });
    expect(await convertFile("pages/about.md", ".json")).toBeNull();
    expect(fsCalls()).toEqual([]);
    expect(problems.at(-1)?.message).toContain("Could not read");
  });

  test("a write that fails leaves the rename unattempted", async () => {
    install(
      { "pages/about.md": PAGE_MD },
      { writeFile: () => Promise.reject(new Error("ENOSPC")) },
    );
    const pending = convertFile("pages/about.md", ".json");
    await answerConfirm(true);
    expect(await pending).toBeNull();
    expect(state.calls.some(([name]) => name === "renameFile")).toBe(false);
  });
});

describe("when the rename fails", () => {
  test("the original bytes are put back, so nothing is left half-converted", async () => {
    install(
      { "pages/about.md": PAGE_MD },
      { renameFile: () => Promise.reject(new Error("EXDEV")) },
    );
    const pending = convertFile("pages/about.md", ".json");
    await answerConfirm(true);
    expect(await pending).toBeNull();
    // Two writes: the converted bytes, then the restore. The file is its old self again.
    expect(state.files.get("pages/about.md")).toBe(PAGE_MD);
    expect(problems.at(-1)?.detail).toContain("EXDEV");
  });
});

describe("the open tab", () => {
  test("follows to the new path and carries the TARGET's format", async () => {
    openTab({
      document: { children: [] },
      documentPath: "pages/about.md",
      id: "pages/about.md",
      sourceFormat: "Markdown",
    });
    const pending = convertFile("pages/about.md", ".json");
    await answerConfirm(true);
    await pending;

    expect(workspace.tabs.has("pages/about.md")).toBe(false);
    const tab = workspace.tabs.get("pages/about.json");
    expect(tab).toBeDefined();
    /* Rebuilt, not reloaded. `reloadFileInTab` sets only the document and the frontmatter, so a
       reloaded tab would keep the OLD format's modes and its serializer — and the next ⌘S would
       write markdown into a `.json` file. */
    expect(tab?.doc.sourceFormat).toBeNull();
  });

  test("a tab converted INTO a format is rebuilt through that format's parser", async () => {
    install({ "pages/about.json": '{"title":"About","children":[]}' });
    openTab({
      document: { children: [] },
      documentPath: "pages/about.json",
      id: "pages/about.json",
      sourceFormat: null,
    });
    const pending = convertFile("pages/about.json", ".md");
    await answerConfirm(true);
    await pending;
    const tab = workspace.tabs.get("pages/about.md");
    expect(tab?.doc.sourceFormat).toBe("Markdown");
    // The frontmatter is SPLIT off the document again, the way the editor holds a markdown file.
    expect(tab?.doc.content.frontmatter).toMatchObject({ title: "About" });
  });

  test("a rebuilt tab whose result will not parse leaves the CONVERSION done", async () => {
    /* The bytes on disk are the ones just written and the move has already happened, so a parse
       failure here is a stale tab, not a failed convert. Reporting it as a failure would be a lie
       about a file that really did convert. */
    let parses = 0;
    install(
      { "pages/about.json": '{"title":"About","children":[]}' },
      {
        formatAction: (payload: Record<string, unknown>) => {
          if (payload.action === "parse") {
            parses += 1;
            if (parses > 1) {
              return Promise.reject(new Error("unreadable"));
            }
          }
          return mockFormatAction(payload);
        },
      },
    );
    openTab({
      document: { children: [] },
      documentPath: "pages/about.json",
      id: "pages/about.json",
    });
    const pending = convertFile("pages/about.json", ".md");
    await answerConfirm(true);
    expect(await pending).toBe("pages/about.md");
    expect(state.files.has("pages/about.md")).toBe(true);
    expect(state.files.has("pages/about.json")).toBe(false);
  });

  test("a file nobody has open converts without opening one", async () => {
    const pending = convertFile("pages/about.md", ".json");
    await answerConfirm(true);
    await pending;
    expect(workspace.tabs.size).toBe(0);
  });
});

describe("choosing the target", () => {
  test("one target answers itself — no dialog before the confirmation", async () => {
    // With only Markdown installed this is every conversion in the project, which is why the picker
    // Below is a real control and not a formality.
    const pending = convertFile("pages/about.md");
    await answerConfirm(true);
    expect(await pending).toBe("pages/about.json");
  });

  test("two or more ask, and the pick decides", async () => {
    // The second format serializes through the first's implementation; what is under test is the
    // Choice, not a second dialect.
    install(
      { "pages/about.md": PAGE_MD },
      {
        formatAction: (payload: Record<string, unknown>) =>
          mockFormatAction({ ...payload, format: "Markdown" }),
      },
    );
    setFormats([MARKDOWN_FORMAT, MARKDOWN_TWO, CSV_FORMAT]);
    const pending = convertFile("pages/about.md");
    for (let i = 0; i < 50 && !topDialog()?.querySelector("sp-picker"); i += 1) {
      await flush();
    }
    const picker = topDialog()!.querySelector("sp-picker") as HTMLElement & { value: string };
    expect(
      [...topDialog()!.querySelectorAll("sp-menu-item")].map((el) => el.getAttribute("value")),
    ).toEqual([".json", ".mdx"]);
    picker.value = ".mdx";
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    // The target dialog, then the consequences dialog — two questions, in that order.
    topDialog()!.dispatchEvent(new Event("confirm"));
    for (let i = 0; i < 50 && !topDialog()?.textContent?.includes("about.mdx"); i += 1) {
      await flush();
    }
    topDialog()!.dispatchEvent(new Event("confirm"));
    await flush();
    expect(await pending).toBe("pages/about.mdx");
  });

  test("dismissing the target dialog moves nothing", async () => {
    setFormats([MARKDOWN_FORMAT, MARKDOWN_TWO, CSV_FORMAT]);
    const pending = convertFile("pages/about.md");
    for (let i = 0; i < 50 && !topDialog(); i += 1) {
      await flush();
    }
    topDialog()!.dispatchEvent(new Event("cancel"));
    await flush();
    expect(await pending).toBeNull();
    expect(fsCalls()).toEqual([]);
  });
});

describe("what the plan reports", () => {
  /** Give the mock a reference index, which it does not carry by default. */
  function withReferences(files: { path: string; count: number }[]) {
    install(
      { "pages/about.md": PAGE_MD },
      {
        capabilities: { findReferences: true },
        findReferences: () =>
          Promise.resolve({ errors: [], files, refsTotal: files.reduce((n, f) => n + f.count, 0) }),
      },
    );
  }

  test("the reference count, in the CONVERT wording — repaired, not merely unchanged", async () => {
    withReferences([{ count: 2, path: "pages/index.json" }]);
    const pending = convertFile("pages/about.md", ".json");
    await flush();
    expect(topDialog()?.textContent).toContain(
      "2 references in 1 file will be updated automatically to point at the new file.",
    );
    // The rename's closing promise is absent, and deliberately: the document's own syntax changes,
    // So "nothing else changes" would be false about the very file the reader is looking at.
    expect(topDialog()?.textContent).not.toContain("Nothing else changes");
    await answerConfirm(false);
    await pending;
  });

  test("a document the schema accepts is not remarked on at all", async () => {
    const pending = convertFile("pages/about.md", ".json");
    await flush();
    expect(topDialog()?.textContent).not.toContain("document schema");
    await answerConfirm(false);
    await pending;
  });

  test("an UNAVAILABLE schema check says so — it is not the same as valid", async () => {
    // The "never render 0" rule of §9.1.1, one layer down: `validateDoc` fails open, so a
    // Conversion that asked it would claim validity on the strength of a schema nobody compiled.
    validatorAnswer = null;
    const pending = convertFile("pages/about.md", ".json");
    await flush();
    expect(topDialog()?.textContent).toContain("could not be checked against the document schema");
    await answerConfirm(false);
    await pending;
  });

  /**
   * Compared as TEXT, not as documents.
   *
   * A document comparison reports a difference for every normalization the format legitimately
   * performs — Markdown alone turns a bare `textContent` into `children: [{ tagName: "p" }]` — and
   * a warning that fires on nearly every file is one nobody reads. Serializing twice asks the only
   * question the author cares about: will the file I open tomorrow still say this?
   */
  test("a format that does not round-trip its own output warns before the button", async () => {
    let round = 0;
    install(
      { "pages/about.json": '{"title":"About","children":[]}' },
      {
        formatAction: (payload: Record<string, unknown>) => {
          if (payload.action !== "serialize") {
            return mockFormatAction(payload);
          }
          round += 1;
          return Promise.resolve(round === 1 ? "---\ntitle: About\n---\n" : "drifted\n");
        },
      },
    );
    const pending = convertFile("pages/about.json", ".md");
    await flush();
    expect(topDialog()?.textContent).toContain("will not read back identically");
    await answerConfirm(false);
    await pending;
  });

  test("a stability check that cannot be answered stays silent rather than inventing a warning", async () => {
    // Serializing succeeds; reading the result back throws. Unanswerable is not the same as
    // Unstable, and the schema and serialize checks already speak for what can actually fail.
    let call = 0;
    install(
      { "pages/about.json": '{"title":"About","children":[]}' },
      {
        formatAction: (payload: Record<string, unknown>) => {
          call += 1;
          return payload.action === "parse" && call > 1
            ? Promise.reject(new Error("unreadable"))
            : mockFormatAction(payload);
        },
      },
    );
    const pending = convertFile("pages/about.json", ".md");
    await flush();
    expect(topDialog()?.textContent).not.toContain("will not read back identically");
    await answerConfirm(false);
    await pending;
  });

  test("a document the schema REJECTS is a blocker naming where, and nothing moves", async () => {
    validatorAnswer = ["/children/0: must be object", "/children/0: must be string"];
    expect(await convertFile("pages/about.md", ".json")).toBeNull();
    expect(fsCalls()).toEqual([]);
    // The pointers, deduplicated: ajv yields one message per schema branch, so five lines about one
    // Key would otherwise name it five times.
    expect(problems.at(-1)?.detail).toBe(
      "The result would not be a valid Jx document (/children/0).",
    );
  });
});

describe("the command record", () => {
  const record = () =>
    fileFormatCommands()[0]! as AnyCommand & {
      run: (ctx: unknown, args: Record<string, unknown>) => Promise<void>;
    };

  test("is declared for the file context menu, and asks only for the file", () => {
    const args = record().args as { properties: Record<string, unknown>; required: string[] };
    expect(record().id).toBe("file.convertFormat");
    expect(record().menus).toEqual(["context/file"]);
    /* `required` is passed EXPLICITLY. `argsSchema` defaults it to every key, and a required
       `format` would make the row silently never render — a file row can state which file it is,
       never which format the reader wants. */
    expect(args.required).toEqual(["source"]);
    expect(Object.keys(args.properties).toSorted()).toEqual(["format", "source"]);
  });

  test("its format enum is derived when READ, not when the record was built", () => {
    const args = record().args as { properties: { format: { enum: string[] } } };
    expect(args.properties.format.enum).toEqual([".json", ".md"]);
    setFormats([]);
    // A snapshot taken at module scope would still say [".json", ".md"] here — and the palette, the
    // AI tool list and the shot contract all read the property, not the builder.
    expect(args.properties.format.enum).toEqual([".json"]);
  });

  test("nothing restores a convert, and the record says so rather than pretending", () => {
    expect(record().undo).toBe("none");
    expect(record().aiTool?.name).toBe("convert_file_format");
  });

  test("run converts the file it names, with a stated format", async () => {
    const pending = record().run({}, { format: ".json", source: "pages/about.md" });
    await answerConfirm(true);
    await pending;
    expect(state.files.has("pages/about.json")).toBe(true);
  });

  test("run with no stated format lets the one target answer for itself", async () => {
    const pending = record().run({}, { source: "pages/about.md" });
    await answerConfirm(true);
    await pending;
    expect(state.files.has("pages/about.json")).toBe(true);
  });
});

describe("reporting a partial refactor", () => {
  test("a reference the backend could not rewrite becomes a warning naming the file", async () => {
    install(
      { "pages/about.md": PAGE_MD },
      {
        renameFile: (from: string, to: string) => {
          state.files.set(to, state.files.get(from)!);
          state.files.delete(from);
          return Promise.resolve({
            errors: [{ error: 'No serializer for "x.csv"', path: "x.csv" }],
            from,
            ok: true,
            to,
          });
        },
      },
    );
    const pending = convertFile("pages/about.md", ".json");
    await answerConfirm(true);
    await pending;
    /* Reported through the SAME `notifyMoveOutcome` a rename and a drag-move use: one warning that
       names the files, in place of a plain success. Under the write-then-rename ordering the
       refactor reads correct bytes, so an entry here means a reference really was left stale. */
    const shown = [...toasts, ...problems];
    expect(shown.some((n) => n.message.includes("references in 1 file could not be updated"))).toBe(
      true,
    );
    expect(shown.some((n) => (n.detail ?? "").includes("x.csv"))).toBe(true);
    expect(shown.every((n) => n.severity !== "success")).toBe(true);
  });

  test("the success line names the references it moved", async () => {
    install(
      { "pages/about.md": PAGE_MD },
      {
        renameFile: (from: string, to: string) => {
          state.files.set(to, state.files.get(from)!);
          state.files.delete(from);
          return Promise.resolve({
            from,
            ok: true,
            references: { files: [], filesChanged: 2, refsUpdated: 3 },
            to,
          });
        },
      },
    );
    const pending = convertFile("pages/about.md", ".json");
    await answerConfirm(true);
    await pending;
    expect(toasts.at(-1)?.message).toBe(
      "Converted to about.json; updated 3 reference(s) in 2 file(s)",
    );
  });
});
