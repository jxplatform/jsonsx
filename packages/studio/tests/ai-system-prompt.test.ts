/**
 * Tests for src/services/ai-system-prompt.ts — the dynamic system prompt builder.
 *
 * BuildSystemPrompt() assembles a large prompt from static reference sections plus optional context
 * (open document, project config, components). These tests drive every optional section so the
 * document summary (element tree, typed state, imported elements) and project summary (tokens,
 * components, breakpoints) branches are all exercised.
 */
import "./with-dom.ts";
import { describe, expect, test } from "bun:test";
import { buildSystemPrompt } from "../src/services/ai-system-prompt";
import type { ComponentEntry } from "../src/files/components";
import type { JxMutableNode, ProjectConfig } from "@jxsuite/schema/types";

describe("ai-system-prompt — buildSystemPrompt", () => {
  test("emits the static core sections with no context", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("expert Jx builder assistant");
    expect(prompt).toContain("## Error Recovery");
    expect(prompt).not.toContain("## Current Document");
    expect(prompt).not.toContain("## Project Context");
  });

  test("summarizes the open document: element tree, typed state, and imported elements", () => {
    const document = {
      $elements: ["my-button", { $ref: "site-card" }, {}],
      $id: "DemoPage",
      children: [
        { tagName: "h1", textContent: "Title" },
        { children: [{ tagName: "span", textContent: "x" }], tagName: "section" },
      ],
      state: {
        count: 5, // Scalar (number)
        dataSrc: { $prototype: "Data", url: "/api" }, // Data source
        flag: null, // Non-object → typeof
        greet: { $prototype: "Function", body: "return 1" }, // Function
        label: "hello", // Non-object string → typeof
        scalarObj: {}, // Object with no markers → "Scalar"
        typed: { type: "number" }, // Typed (number)
      },
      tagName: "div",
    } as unknown as JxMutableNode;

    const prompt = buildSystemPrompt({ document });
    expect(prompt).toContain("## Current Document");
    expect(prompt).toContain("Document: DemoPage");
    expect(prompt).toContain("Element tree");
    expect(prompt).toContain("State keys (7)");
    expect(prompt).toContain("Function");
    expect(prompt).toContain("Data source");
    expect(prompt).toContain("Typed (number)");
    expect(prompt).toContain("Scalar");
    expect(prompt).toContain("Imported elements:");
    expect(prompt).toContain("my-button");
    expect(prompt).toContain("site-card");
    expect(prompt).toContain("(unknown)");
  });

  test("an unnamed document with no state or imports still summarizes", () => {
    const document = {
      children: [{ tagName: "p", textContent: "hi" }],
      tagName: "div",
    } as unknown as JxMutableNode;
    const prompt = buildSystemPrompt({ document });
    expect(prompt).toContain("Document: (unnamed)");
    expect(prompt).not.toContain("State keys");
    expect(prompt).not.toContain("Imported elements");
  });

  test("summarizes project context: name, root, components, tokens, and breakpoints", () => {
    const projectConfig = {
      $media: { lg: "min-width: 1200px", sm: "max-width: 600px" },
      name: "Demo Site",
      style: {
        "--color-accent": "#ff0000",
        "--font-body": "Inter",
        "--radius-md": "8px", // "other" token group
        notAToken: "ignored", // Not a -- token → filtered out
      },
    } as unknown as ProjectConfig;

    const components = [
      { $id: "Card", path: "components/card.json", tagName: "my-card" },
      { path: "components/nav.json", tag: "my-nav" }, // Tag fallback
      { name: "thing-widget" }, // Name fallback
      { path: "components/orphan.json" }, // Path fallback, no $id
    ] as unknown as ComponentEntry[];

    const prompt = buildSystemPrompt({
      components,
      projectConfig,
      projectRoot: "/projects/demo",
    });

    expect(prompt).toContain("## Project Context");
    expect(prompt).toContain("Project: Demo Site");
    expect(prompt).toContain("Root: /projects/demo");
    expect(prompt).toContain("Available components");
    expect(prompt).toContain("<my-card> — Card (components/card.json)");
    expect(prompt).toContain("<my-nav>");
    expect(prompt).toContain("<thing-widget>");
    expect(prompt).toContain("Design tokens");
    expect(prompt).toContain("--color-accent: #ff0000");
    expect(prompt).toContain("--font-body: Inter");
    expect(prompt).toContain("--radius-md: 8px");
    expect(prompt).not.toContain("notAToken");
    expect(prompt).toContain("Responsive breakpoints");
  });

  test("a context-less but truthy project config yields no Project Context section", () => {
    const prompt = buildSystemPrompt({ projectConfig: {} as unknown as ProjectConfig });
    expect(prompt).not.toContain("## Project Context");
  });
});
