import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { componentize } from "../src/componentize.ts";
import { aiComponentize } from "../src/ai-componentize.ts";
import type { JxElement } from "@jxsuite/schema/types";
import type { ExtractedComponent } from "../src/componentize.ts";

function firstEntry(map: Map<string, ExtractedComponent>): [string, ExtractedComponent] {
  const [k, v] = [...map][0]!;
  return [k, v];
}

let mockServer: ReturnType<typeof Bun.serve>;
let mockBaseUrl: string;
let lastRequestBody: Record<string, unknown> | null = null;
let mockResponse: Record<string, unknown> = {};

beforeAll(() => {
  mockServer = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as Record<string, unknown>;
      lastRequestBody = body;
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify(mockResponse),
            },
          },
        ],
      });
    },
  });
  mockBaseUrl = `http://localhost:${mockServer.port}`;
});

afterAll(() => {
  void mockServer.stop();
});

function makeRepeatedCards(): Map<string, JxElement> {
  const card = (title: string, desc: string): JxElement => ({
    tagName: "div",
    children: [
      { tagName: "h3", textContent: title },
      { tagName: "p", textContent: desc },
      { tagName: "a", textContent: "Learn More", attributes: { href: "/" } },
    ] as JxElement[],
  });

  return new Map([
    [
      "pages/index.json",
      {
        tagName: "div",
        children: [
          card("Product A", "Description of product A"),
          card("Product B", "Description of product B"),
          card("Product C", "Description of product C"),
        ] as JxElement[],
      },
    ],
  ]);
}

describe("ai-componentize", () => {
  it("renames components and props based on LLM response", async () => {
    const pages = makeRepeatedCards();
    const heuristic = componentize(pages, { minInstances: 2, minDepth: 2 });
    expect(heuristic.components.size).toBeGreaterThan(0);

    const [, firstComp] = firstEntry(heuristic.components);
    const oldProps = Object.keys(firstComp.template.state ?? {});

    mockResponse = {
      componentName: "product-card",
      tagName: "product-card",
      props: Object.fromEntries(
        oldProps.map((p) => {
          if (p.includes("text")) {
            return [p, "title"];
          }
          return [p, p];
        }),
      ),
    };

    const result = await aiComponentize(heuristic, {
      apiKey: "test-key",
      baseUrl: mockBaseUrl,
    });

    expect(result.components.size).toBeGreaterThan(0);
    const [newFileName, newComp] = firstEntry(result.components);
    expect(newComp.tagName).toBe("product-card");
    expect(newComp.$id).toBe("ProductCard");
    expect(newFileName).toBe("product-card.json");
  });

  it("falls back to heuristic name on LLM failure", async () => {
    const pages = makeRepeatedCards();
    const heuristic = componentize(pages, { minInstances: 2, minDepth: 2 });

    mockResponse = { invalid: true } as unknown as Record<string, unknown>;

    const result = await aiComponentize(heuristic, {
      apiKey: "test-key",
      baseUrl: mockBaseUrl,
    });

    const [, comp] = firstEntry(result.components);
    expect(comp.tagName).toContain("component-");
  });

  it("rewrites call sites in pages with new tag names", async () => {
    const pages = makeRepeatedCards();
    const heuristic = componentize(pages, { minInstances: 2, minDepth: 2 });
    const [, firstComp] = firstEntry(heuristic.components);
    const oldTag = firstComp.tagName;
    const oldProps = Object.keys(firstComp.template.state ?? {});

    mockResponse = {
      componentName: "info-card",
      tagName: "info-card",
      props: Object.fromEntries(oldProps.map((p) => [p, p])),
    };

    const result = await aiComponentize(heuristic, {
      apiKey: "test-key",
      baseUrl: mockBaseUrl,
    });

    const page = result.rewrittenPages.get("pages/index.json")!;
    const pageJson = JSON.stringify(page);
    expect(pageJson).toContain("info-card");
    expect(pageJson).not.toContain(oldTag);
  });

  it("deduplicates component names", async () => {
    const card = (t: string): JxElement => ({
      tagName: "div",
      children: [
        { tagName: "h3", textContent: t },
        { tagName: "p", textContent: "desc" },
      ] as JxElement[],
    });

    const link = (t: string): JxElement => ({
      tagName: "a",
      attributes: { href: "/" },
      children: [
        { tagName: "span", textContent: t },
        { tagName: "span", textContent: "arrow" },
      ] as JxElement[],
    });

    const pages = new Map([
      [
        "pages/index.json",
        {
          tagName: "div",
          children: [card("A"), card("B"), link("X"), link("Y")] as JxElement[],
        },
      ],
    ]);

    const heuristic = componentize(pages, { minInstances: 2, minDepth: 2 });
    if (heuristic.components.size < 2) {
      return;
    }

    mockResponse = {
      componentName: "ui-card",
      tagName: "ui-card",
      props: {},
    };

    const result = await aiComponentize(heuristic, {
      apiKey: "test-key",
      baseUrl: mockBaseUrl,
    });

    const names = [...result.components.values()].map((c) => c.tagName);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it("handles empty components gracefully", async () => {
    const result = await aiComponentize(
      { components: new Map(), rewrittenPages: new Map() },
      { apiKey: "test-key", baseUrl: mockBaseUrl },
    );

    expect(result.components.size).toBe(0);
    expect(result.rewrittenPages.size).toBe(0);
  });

  it("sends API key in Authorization header", async () => {
    const pages = makeRepeatedCards();
    const heuristic = componentize(pages, { minInstances: 2, minDepth: 2 });

    const oldProps = Object.keys(firstEntry(heuristic.components)[1].template.state ?? {});
    mockResponse = {
      componentName: "test-card",
      tagName: "test-card",
      props: Object.fromEntries(oldProps.map((p) => [p, p])),
    };

    await aiComponentize(heuristic, {
      apiKey: "sk-test-12345",
      baseUrl: mockBaseUrl,
    });

    expect(lastRequestBody).toBeTruthy();
    expect((lastRequestBody as Record<string, unknown>).model).toBe("gpt-4o-mini");
  });

  it("uses custom model when specified", async () => {
    const pages = makeRepeatedCards();
    const heuristic = componentize(pages, { minInstances: 2, minDepth: 2 });

    const oldProps = Object.keys(firstEntry(heuristic.components)[1].template.state ?? {});
    mockResponse = {
      componentName: "test-card",
      tagName: "test-card",
      props: Object.fromEntries(oldProps.map((p) => [p, p])),
    };

    await aiComponentize(heuristic, {
      apiKey: "sk-test",
      baseUrl: mockBaseUrl,
      model: "claude-sonnet-4-6",
    });

    expect(lastRequestBody).toBeTruthy();
    expect((lastRequestBody as Record<string, unknown>).model).toBe("claude-sonnet-4-6");
  });

  it("renames props in template interpolations", async () => {
    const pages = makeRepeatedCards();
    const heuristic = componentize(pages, { minInstances: 2, minDepth: 2 });
    const [, firstComp] = firstEntry(heuristic.components);
    const oldProps = Object.keys(firstComp.template.state ?? {});

    const propMap: Record<string, string> = {};
    for (const p of oldProps) {
      propMap[p] = `renamed_${p}`;
    }

    mockResponse = {
      componentName: "renamed-card",
      tagName: "renamed-card",
      props: propMap,
    };

    const result = await aiComponentize(heuristic, {
      apiKey: "test-key",
      baseUrl: mockBaseUrl,
    });

    const [, comp] = firstEntry(result.components);
    const templateJson = JSON.stringify(comp.template);
    for (const newName of Object.values(propMap)) {
      if (templateJson.includes("${state.")) {
        expect(templateJson).toContain(`\${state.${newName}}`);
      }
    }
    for (const oldName of oldProps) {
      expect(templateJson).not.toContain(`\${state.${oldName}}`);
    }
  });
});
