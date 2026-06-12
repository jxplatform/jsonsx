/**
 * Studio shell (C7): ?project= + ?file= pointing at a registered content format — studio.ts parses
 * through the format host and switches the opened tab into content mode.
 */
import "./harness";
import { describe, expect, test } from "bun:test";
import { bootStudio, statusMessages, waitFor } from "./studio-shell-fixture";
import { activeTab } from "../src/workspace/workspace";

const MARKDOWN_FORMAT = {
  capabilities: { parse: { identifier: "parse", timing: ["server"] } },
  documentKinds: ["content", "page"],
  exportTarget: false,
  extensions: [".md"],
  mediaType: "text/markdown",
  name: "Markdown",
  remote: false,
  studio: null,
};

await bootStudio({
  overrides: {
    formatAction: (async (payload: Record<string, unknown>) => {
      if (payload.action === "parse") {
        return {
          children: [{ children: [], tagName: "p", textContent: "Hello world" }],
          title: "Hello",
        };
      }
      throw new Error(`unexpected format action: ${String(payload.action)}`);
    }) as any,
    listFormats: (async () => [MARKDOWN_FORMAT]) as any,
    resolveSiteContext: (async () => ({ sitePath: null })) as any,
  },
  seedFiles: {
    "posts/hello.md": "# Hello\n\nHello world",
  },
  url: "http://localhost/?project=/abs/mdsite&file=posts/hello.md",
});

await waitFor(() => statusMessages.includes("Opened posts/hello.md"));

describe("?project= with a format-parsed content file", () => {
  test("opens the parsed document in a tab with its source format", () => {
    expect(statusMessages).toContain("Opened posts/hello.md");
    const tab = activeTab.value!;
    expect(tab.id).toBe("posts/hello.md");
    expect(tab.doc.sourceFormat).toBe("Markdown");
    expect((tab.doc.document as any).children[0].textContent).toBe("Hello world");
  });

  test("separates frontmatter and switches the tab into content mode", () => {
    const tab = activeTab.value!;
    expect(tab.doc.mode).toBe("content");
    expect((tab.doc.document as any).title).toBeUndefined();
    expect((tab.doc.content?.frontmatter as any)?.title).toBe("Hello");
  });
});
