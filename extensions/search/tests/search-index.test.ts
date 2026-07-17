/**
 * Unit tests for search-index.ts — projectData normalization and the emit capability against a
 * fixture content-collection Map (extensions.md §8.4).
 */

import { describe, expect, test } from "bun:test";
import { SearchIndex } from "../src/search-index";
import type { SearchIndexEnvelope } from "../src/search-index";
import type { ContentLoaderEntry } from "@jxsuite/schema/types";

const DOCS_ENTRIES: ContentLoaderEntry[] = [
  {
    $children: [
      { tagName: "p", textContent: "Sites are folders of pages." },
      { id: "routing", tagName: "h2", textContent: "Routing" },
      { tagName: "p", textContent: "File-based routes map to URLs." },
      { id: "assets", tagName: "h2", textContent: "Assets" },
      { tagName: "p", textContent: "Bundled sidecars land in /assets/." },
    ],
    body: "",
    data: { description: "How sites are built", title: "Site architecture" },
    id: "framework/site",
  },
  {
    $children: [{ tagName: "p", textContent: "Install with bun install." }],
    body: "",
    data: { title: "Install" },
    id: "start/install",
  },
] as unknown as ContentLoaderEntry[];

function sections(): Record<string, unknown> {
  return { content: new Map([["docs", DOCS_ENTRIES]]) };
}

const SECTION = {
  collections: { docs: { basePath: "/docs/", boost: { heading: 2, title: 4 } } },
};

describe("SearchIndex.projectData", () => {
  test("returns the normalized config for _project.search", () => {
    const config = SearchIndex.projectData(SECTION);
    expect(config.output).toBe("/search-index.json");
    expect(config.collections.docs!.basePath).toBe("/docs/");
  });

  test("the export exposes exactly the declared capability methods", () => {
    expect(Object.keys(SearchIndex).toSorted()).toEqual(["emit", "projectData"]);
  });
});

describe("SearchIndex.emit", () => {
  test("emits one envelope at the configured output with page and section documents", () => {
    const files = SearchIndex.emit(SECTION, { projectConfig: {}, sections: sections() });
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe("/search-index.json");

    const envelope = JSON.parse(files[0]!.content) as SearchIndexEnvelope;
    expect(envelope.version).toBe(1);
    expect(envelope.engine).toBe("minisearch");
    expect(envelope.fields.toSorted()).toEqual(["heading", "text", "title"]);
    expect(envelope.boost).toEqual({ heading: 2, title: 4 });

    const ids = envelope.documents.map((d) => d.id);
    expect(ids).toEqual([
      "docs:framework/site",
      "docs:framework/site#routing",
      "docs:framework/site#assets",
      "docs:start/install",
    ]);

    const page = envelope.documents[0]!;
    expect(page.url).toBe("/docs/framework/site/");
    expect(page.title).toBe("Site architecture");
    expect(page.description).toBe("How sites are built");
    expect(page.heading).toBe("");
    expect(page.text).toContain("Sites are folders of pages.");
    expect(page.text).toContain("Bundled sidecars land in /assets/.");

    const section = envelope.documents[1]!;
    expect(section.url).toBe("/docs/framework/site/#routing");
    expect(section.heading).toBe("Routing");
    expect(section.text).toBe("File-based routes map to URLs.");

    // Entries without a title fall back to their id.
    expect(envelope.documents[3]!.title).toBe("Install");
  });

  test("honors trailingSlash never and a custom output path", () => {
    const files = SearchIndex.emit(
      { ...SECTION, output: "/idx/search.json" },
      { projectConfig: { build: { trailingSlash: "never" } }, sections: sections() },
    );
    expect(files[0]!.path).toBe("/idx/search.json");
    const envelope = JSON.parse(files[0]!.content) as SearchIndexEnvelope;
    expect(envelope.documents[0]!.url).toBe("/docs/framework/site");
    expect(envelope.documents[1]!.url).toBe("/docs/framework/site#routing");
  });

  test("sections: false emits page-level documents only", () => {
    const files = SearchIndex.emit(
      { collections: { docs: { basePath: "/docs/", sections: false } } },
      { projectConfig: {}, sections: sections() },
    );
    const envelope = JSON.parse(files[0]!.content) as SearchIndexEnvelope;
    expect(envelope.documents.map((d) => d.id)).toEqual([
      "docs:framework/site",
      "docs:start/install",
    ]);
  });

  test("an unknown collection is skipped with a warning; the envelope still emits", () => {
    const files = SearchIndex.emit(
      { collections: { ghost: { basePath: "/g/" } } },
      { projectConfig: {}, sections: sections() },
    );
    const envelope = JSON.parse(files[0]!.content) as SearchIndexEnvelope;
    expect(envelope.documents).toEqual([]);
  });

  test("tolerates a missing content section entirely", () => {
    const files = SearchIndex.emit(SECTION, { projectConfig: {} });
    const envelope = JSON.parse(files[0]!.content) as SearchIndexEnvelope;
    expect(envelope.documents).toEqual([]);
  });
});
