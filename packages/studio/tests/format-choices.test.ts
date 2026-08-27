/**
 * Tests for src/format/format-choices.ts — the two derived predicates behind "which format may I
 * create?" and "which format may I convert to?".
 *
 * The pair of fixtures is the point. Csv and Toml are BOTH `content`-only formats and they fail the
 * rules for different declared reasons — Csv has no serializer, Toml has every capability Markdown
 * has — so a rule that happened to exclude one by accident cannot pass both halves.
 */
import { resetStudioState } from "./harness";
import { beforeEach, describe, expect, test } from "bun:test";
import { setFormats } from "../src/format/format-host";
import {
  convertTargetExtensions,
  convertTargets,
  creationFormats,
  knownDocumentExtensions,
} from "../src/format/format-choices";
import { CSV_FORMAT, MARKDOWN_FORMAT, TOML_FORMAT } from "./format-fixture";

const POSTS = {
  content: {
    posts: { format: "Markdown", schema: { properties: {} }, source: "./content/posts/" },
  },
};

beforeEach(() => {
  setFormats([MARKDOWN_FORMAT, CSV_FORMAT, TOML_FORMAT]);
  resetStudioState({ projectConfig: POSTS });
});

describe("creationFormats", () => {
  test("JSON first, then every extension the studio can both read and write", () => {
    expect(creationFormats()).toEqual([
      { ext: ".json", label: "JSON (.json)" },
      { ext: ".md", label: "Markdown (.md)" },
      { ext: ".toml", label: "Toml (.toml)" },
    ]);
  });

  test("a parse-only format is absent, because its first save would write another format", () => {
    // `files/file-ops.ts`'s `serializeDocument` falls through to `defaultContentFormat()` for a tab
    // Whose own format cannot serialize — so a `.csv` created here would be saved as markdown.
    expect(creationFormats().map((row) => row.ext)).not.toContain(".csv");
  });

  test("a document kind narrows the list", () => {
    expect(creationFormats("page").map((row) => row.ext)).toEqual([".json", ".md"]);
    expect(creationFormats("content").map((row) => row.ext)).toEqual([".json", ".md", ".toml"]);
  });

  test("an empty registry still offers JSON, so the picker is never a dead control", () => {
    setFormats([]);
    expect(creationFormats()).toEqual([{ ext: ".json", label: "JSON (.json)" }]);
  });

  test("a split parse/serialize claim across two classes still yields the row", () => {
    // The registry legalises this deliberately, so the lookup is per (extension, capability) and
    // Never per format row.
    setFormats([
      {
        ...MARKDOWN_FORMAT,
        capabilities: { parse: { identifier: "parse", timing: [] } },
        name: "Reader",
      },
      {
        ...MARKDOWN_FORMAT,
        capabilities: { serialize: { identifier: "serialize", timing: [] } },
        name: "Writer",
      },
    ]);
    expect(creationFormats().map((row) => row.ext)).toEqual([".json", ".md"]);
  });
});

describe("knownDocumentExtensions", () => {
  test("every registered extension plus .json, creatable or not", () => {
    // Broader than `creationFormats` on purpose: a typed `notes.csv` must be RECOGNISED as naming a
    // Format, so it can be refused, rather than treated as a stem that happens to have a dot.
    expect([...knownDocumentExtensions()].toSorted()).toEqual([".csv", ".json", ".md", ".toml"]);
  });
});

describe("convertTargets", () => {
  test("a markdown page offers JSON, and a JSON page offers markdown", () => {
    expect(convertTargets("pages/about.md")).toEqual([{ ext: ".json", label: "JSON (.json)" }]);
    expect(convertTargets("pages/about.json")).toEqual([{ ext: ".md", label: "Markdown (.md)" }]);
  });

  test("components too, by the kind their directory implies", () => {
    expect(convertTargets("components/card.md").map((t) => t.ext)).toEqual([".json"]);
    expect(convertTargets("components/card.json").map((t) => t.ext)).toEqual([".md"]);
  });

  test("a content-only format is never an endpoint, in either direction", () => {
    // Csv (no serializer) and Toml (parse AND serialize) are both excluded, and for the same
    // Declared reason: neither claims `page` or `component`, so neither claims `parse` returns a
    // Jx document at all.
    expect(convertTargets("pages/data.csv")).toEqual([]);
    expect(convertTargets("pages/data.toml")).toEqual([]);
    expect(convertTargets("pages/about.json").map((t) => t.ext)).not.toContain(".toml");
  });

  test("nothing outside pages/ and components/ is convertible", () => {
    // Which is what keeps `project.json`, `package.json`, `tsconfig.json` and a `nav.json` off the
    // Menu without a hand-written deny list.
    expect(convertTargets("project.json")).toEqual([]);
    expect(convertTargets("package.json")).toEqual([]);
    expect(convertTargets("data/nav.json")).toEqual([]);
    expect(convertTargets("README.md")).toEqual([]);
    expect(convertTargets("styles/main.css")).toEqual([]);
  });

  test("layouts refuse — they are JSON at both readers and no kind can say so", () => {
    expect(convertTargets("layouts/base.json")).toEqual([]);
    resetStudioState({ projectConfig: { ...POSTS, layout: "./components/base.json" } });
    expect(convertTargets("components/base.json")).toEqual([]);
    // …and only that one.
    expect(convertTargets("components/card.json").map((t) => t.ext)).toEqual([".md"]);
  });

  test("a collection's files refuse, in BOTH directions", () => {
    resetStudioState({
      projectConfig: {
        content: { posts: { format: "Markdown", source: "./components/posts/" } },
      },
    });
    // Converting an entry drops it out of its collection's discovery glob…
    expect(convertTargets("components/posts/hello.md")).toEqual([]);
    // …and converting a co-located file INTO the collection's format enlists it unseeded.
    expect(convertTargets("components/posts/notes.json")).toEqual([]);
  });

  test("an unreachable registry offers nothing rather than guessing", () => {
    setFormats([]);
    expect(convertTargets("pages/about.json")).toEqual([]);
    expect(convertTargets("pages/about.md")).toEqual([]);
  });

  test("no path, no answer", () => {
    expect(convertTargets(null)).toEqual([]);
    expect(convertTargets("")).toEqual([]);
  });
});

describe("convertTargetExtensions", () => {
  test("every extension that is a target somewhere — the command argument's declared values", () => {
    // Necessarily broader than any single file's answer: a command argument's enum cannot depend on
    // Another argument, so the per-file rule still decides and `convertFile` re-checks it.
    expect(convertTargetExtensions()).toEqual([".json", ".md"]);
  });

  test("it is a getter's worth of work, so it follows the registry", () => {
    setFormats([]);
    expect(convertTargetExtensions()).toEqual([".json"]);
  });
});
