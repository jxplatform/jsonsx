/**
 * How a project file is addressed as a Monaco model, and why comparisons get their own namespace.
 *
 * The module is deliberately Monaco-free, so this needs no editor and no DOM: the whole point of
 * the file is that a caller can work out a URI without dragging 12.6 MB onto the cold-start path.
 */

import { describe, expect, test } from "bun:test";
import { diffModelUrisFor, modelUriFor, monacoLangForPath } from "../src/services/model-uri";

describe("modelUriFor", () => {
  test("addresses an ordinary file by its project-relative path", () => {
    expect(modelUriFor("pages/index.json")).toBe("file:///pages/index.json");
  });

  test("keeps the two generated entry schemas in a reserved namespace", () => {
    // Their natural URIs collide with the schema ids, and Monaco's JSON adapter resets the schema
    // Registered under the same id when such a model is disposed.
    expect(modelUriFor("project.schema.json")).toBe("file:///.jx/generated/project.schema.json");
  });
});

describe("diffModelUrisFor", () => {
  test("gives a comparison two URIs, neither of them the file's own", () => {
    /* The collision this prevents is a THIRD claimant on one path: a source editor, a Code lens and
       a comparison can all want `pages/index.json` at once, and two models on one URI throws. The
       existing guards ask about panes and presets, and neither can see this one. */
    const uris = diffModelUrisFor("primary", "pages/index.json");
    expect(uris.head).toBe("file:///.jx/diff/primary/head/pages/index.json");
    expect(uris.work).toBe("file:///.jx/diff/primary/work/pages/index.json");
    expect(uris.head).not.toBe(modelUriFor("pages/index.json"));
    expect(uris.work).not.toBe(modelUriFor("pages/index.json"));
  });

  test("the two sides never collide with each other", () => {
    const uris = diffModelUrisFor("primary", "a.json");
    expect(uris.head).not.toBe(uris.work);
  });

  test("two panes comparing one file get four distinct URIs", () => {
    // The primary can hold a comparison in Code while a Diff lens beside it holds the same file's.
    const primary = diffModelUrisFor("primary", "a.json");
    const secondary = diffModelUrisFor("secondary", "a.json");
    expect(new Set([primary.head, primary.work, secondary.head, secondary.work]).size).toBe(4);
  });

  test("stays clear of the generated-schema namespace", () => {
    const uris = diffModelUrisFor("primary", "project.schema.json");
    expect(uris.head).not.toContain("/.jx/generated/");
  });
});

describe("monacoLangForPath", () => {
  test("names the languages monaco-setup actually contributes", () => {
    expect(monacoLangForPath("a.json")).toBe("json");
    expect(monacoLangForPath("a.ts")).toBe("typescript");
    expect(monacoLangForPath("a.mts")).toBe("typescript");
    expect(monacoLangForPath("a.js")).toBe("javascript");
    expect(monacoLangForPath("a.mjs")).toBe("javascript");
    // Every alias, because an unlisted one silently becomes plaintext.
    expect(monacoLangForPath("a.cjs")).toBe("javascript");
    expect(monacoLangForPath("a.cts")).toBe("typescript");
  });

  test("names the rest anyway, since a comparison can be over any changed file", () => {
    expect(monacoLangForPath("a.css")).toBe("css");
    expect(monacoLangForPath("a.md")).toBe("markdown");
    expect(monacoLangForPath("a.html")).toBe("html");
    expect(monacoLangForPath("a.htm")).toBe("html");
    expect(monacoLangForPath("a.yml")).toBe("yaml");
    expect(monacoLangForPath("a.yaml")).toBe("yaml");
  });

  test("falls back to plaintext rather than forcing an unknown extension into a language", () => {
    // Red and green come from the diff algorithm, not the tokenizer, so plaintext loses syntax
    // Highlighting and nothing else.
    expect(monacoLangForPath(".gitignore")).toBe("plaintext");
    expect(monacoLangForPath("Makefile")).toBe("plaintext");
    expect(monacoLangForPath("a.weird")).toBe("plaintext");
  });

  test("is case-insensitive about the extension", () => {
    expect(monacoLangForPath("A.JSON")).toBe("json");
  });
});
