/**
 * A markdown page on the preview origin — the format registry, reached for real.
 *
 * `live-preview-gaps.test.ts` mocks `@jxsuite/compiler/format-host` away, and that is exactly how a
 * defect survived: its stub answered `.md` whatever arguments it was handed, so a host that built
 * the registry WITHOUT the project's config looked identical to one that built it with. The
 * registry reads its extension list out of `project.json`, so an omitted config is not "no parser
 * for `.md`" but "no extensions at all", and every markdown page in every starter reported that it
 * needed a parser this host does not run — while the host was running one.
 *
 * So this suite mocks nothing: a real `@jxsuite/parser` against a real tree, which is the only
 * arrangement in which that mistake is visible.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  clearLivePreviewOverlay,
  setLivePreviewOverlay,
  startLivePreview,
  stopLivePreviews,
} from "../src/live-preview";

/** Declares the parser, so `.md` has a format class behind it. */
const WITH_PARSER = resolve(import.meta.dir, "__test-live-preview-md__");
/** The same tree, declaring no extensions — where the named error is the RIGHT answer. */
const NO_PARSER = resolve(import.meta.dir, "__test-live-preview-md-bare__");

const PAGE = `---
title: Written in markdown
---

# Hello from markdown

A paragraph the composer never sees as JSON.
`;

function write(root: string, relPath: string, content: string | object) {
  const abs = resolve(root, relPath);
  mkdirSync(resolve(abs, ".."), { recursive: true });
  writeFileSync(
    abs,
    typeof content === "string" ? content : JSON.stringify(content, null, 2),
    "utf8",
  );
}

async function bodyOf(origin: string, route: string) {
  const res = await fetch(`${origin}${route}`);
  return { body: await res.text(), status: res.status };
}

beforeAll(() => {
  for (const root of [WITH_PARSER, NO_PARSER]) {
    rmSync(root, { force: true, recursive: true });
    write(root, "pages/index.md", PAGE);
  }
  write(WITH_PARSER, "project.json", { extensions: ["@jxsuite/parser"], name: "Markdown" });
  write(NO_PARSER, "project.json", { name: "Markdown, unparsed" });
});

afterEach(() => {
  clearLivePreviewOverlay(WITH_PARSER);
  clearLivePreviewOverlay(NO_PARSER);
});

afterAll(() => {
  stopLivePreviews();
  for (const root of [WITH_PARSER, NO_PARSER]) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("a page the project's own extension parses", () => {
  test("renders, rather than reporting a parser this host does run", async () => {
    const { origin } = await startLivePreview(WITH_PARSER);

    const { body, status } = await bodyOf(origin, "/");
    expect(status).toBe(200);
    expect(body).not.toContain("could not be read as a page");
    expect(body).toContain("Hello from markdown");
  });

  // Frontmatter is the document's own top level, so `title` has to reach the composed `<head>`.
  test("its frontmatter is the document, not a preamble to drop", async () => {
    const { origin } = await startLivePreview(WITH_PARSER);

    const { body } = await bodyOf(origin, "/");
    expect(body).toContain("<title>Written in markdown</title>");
  });

  /*
   * A markdown page is a routed page like any other. The route table is built from paths, so it
   * never depended on the parser — which is what made the failure look like a rendering bug rather
   * than a registry one.
   */
  test("it is a route whether or not anything can parse it", async () => {
    const bare = await startLivePreview(NO_PARSER);

    expect(bare.routes).toBe(1);
    const { body, status } = await bodyOf(bare.origin, "/");
    expect(status).toBe(500);
    expect(body).toContain("pages/index.md could not be read as a page");
  });
});

describe("the config the registry is built from", () => {
  /*
   * `project.json` NAMES the extensions, so it is read through the overlay like every other read
   * here. An author who adds `@jxsuite/parser` in Studio sees markdown render on the next reload
   * rather than after a save — and the file that decides it is the one being edited.
   */
  test("an unsaved `project.json` that adds the parser renders the page", async () => {
    const { origin } = await startLivePreview(NO_PARSER);
    const before = await bodyOf(origin, "/");
    expect(before.body).toContain("could not be read as a page");

    setLivePreviewOverlay(
      NO_PARSER,
      "project.json",
      JSON.stringify({ extensions: ["@jxsuite/parser"], name: "Markdown, unparsed" }),
    );

    const { body, status } = await bodyOf(origin, "/");
    expect(status).toBe(200);
    expect(body).toContain("Hello from markdown");
  });
});
