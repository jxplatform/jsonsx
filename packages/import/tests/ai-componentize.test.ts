import { describe, expect, it, beforeAll, beforeEach, afterAll } from "bun:test";
import { componentize } from "../src/componentize.ts";
import { aiComponentize } from "../src/ai-componentize.ts";
import type { JxElement } from "@jxsuite/schema/types";
import type { ComponentizeResult, ExtractedComponent } from "../src/componentize.ts";

/** Deliberately not "gpt-4o-mini": the module has no default, and this proves it forwards ours. */
const TEST_MODEL = "test-model-v1";

function firstEntry(map: Map<string, ExtractedComponent>): [string, ExtractedComponent] {
  const [k, v] = [...map][0]!;
  return [k, v];
}

let mockServer: ReturnType<typeof Bun.serve>;
let mockBaseUrl: string;
let lastRequestBody: Record<string, unknown> | null = null;
let mockResponse: Record<string, unknown> = {};
let mockHandler: ((req: Request) => Response | Promise<Response>) | null = null;

beforeAll(() => {
  mockServer = Bun.serve({
    port: 0,
    async fetch(req) {
      if (mockHandler) {
        return mockHandler(req);
      }
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

beforeEach(() => {
  mockHandler = null;
});

afterAll(() => {
  void mockServer.stop();
});

function craftedComponent(index: number, withState: boolean): ExtractedComponent {
  const template: JxElement = withState
    ? {
        tagName: "div",
        state: { text: "", href: "" },
        children: [
          "${state.text}",
          {
            tagName: "a",
            textContent: "${state.text}",
            attributes: { href: "${state.href}", target: "_blank" },
          },
        ] as JxElement[],
      }
    : { tagName: "div", textContent: `static ${index}` };

  return {
    $id: `ComponentDiv${index}`,
    tagName: `component-div-${index}`,
    template,
    instanceCount: 2,
  };
}

function craftedResult(componentCount = 1, withState = true): ComponentizeResult {
  const components = new Map<string, ExtractedComponent>();
  const children: JxElement[] = [];

  for (let i = 0; i < componentCount; i += 1) {
    const component = craftedComponent(i, withState);
    components.set(`${component.tagName}.json`, component);
    children.push({
      tagName: component.tagName,
      $props: withState ? { text: `Text ${i}`, href: `/link-${i}` } : {},
    });
  }

  return {
    components,
    rewrittenPages: new Map<string, JxElement>([
      ["pages/index.json", { tagName: "div", children }],
    ]),
  };
}

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
      model: TEST_MODEL,
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
      model: TEST_MODEL,
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
      model: TEST_MODEL,
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
      model: TEST_MODEL,
    });

    const names = [...result.components.values()].map((c) => c.tagName);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it("handles empty components gracefully", async () => {
    const result = await aiComponentize(
      { components: new Map(), rewrittenPages: new Map() },
      { apiKey: "test-key", baseUrl: mockBaseUrl, model: TEST_MODEL },
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
      model: TEST_MODEL,
    });

    expect(lastRequestBody).toBeTruthy();
    /* The model is the caller's to name and has no default here. A hardcoded "gpt-4o-mini" was one,
       and it 404s on a backend brokering Workers AI — which callLlm reads as "the LLM failed", so
       every component silently keeps its heuristic name. run.ts holds the CLI's default. */
    expect((lastRequestBody as Record<string, unknown>).model).toBe(TEST_MODEL);
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
      model: TEST_MODEL,
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

  it("falls back to heuristic name on HTTP error", async () => {
    mockHandler = () => new Response("server exploded", { status: 500 });

    const result = await aiComponentize(craftedResult(), {
      apiKey: "test-key",
      baseUrl: mockBaseUrl,
      model: TEST_MODEL,
    });

    const [fileName, comp] = firstEntry(result.components);
    expect(fileName).toBe("component-div-0.json");
    expect(comp.tagName).toBe("component-div-0");
  });

  it("falls back when the response has no message content", async () => {
    mockHandler = () => Response.json({ choices: [] });

    const result = await aiComponentize(craftedResult(), {
      apiKey: "test-key",
      baseUrl: mockBaseUrl,
      model: TEST_MODEL,
    });

    const [, comp] = firstEntry(result.components);
    expect(comp.tagName).toBe("component-div-0");
  });

  it("falls back when the content is not valid JSON", async () => {
    mockHandler = () => Response.json({ choices: [{ message: { content: "not json {{{" } }] });

    const result = await aiComponentize(craftedResult(), {
      apiKey: "test-key",
      baseUrl: mockBaseUrl,
      model: TEST_MODEL,
    });

    const [, comp] = firstEntry(result.components);
    expect(comp.tagName).toBe("component-div-0");
  });

  it("prefixes tag names missing a hyphen with x-", async () => {
    mockResponse = {
      componentName: "product-card",
      tagName: "card",
      props: { text: "text", href: "href" },
    };

    const result = await aiComponentize(craftedResult(), {
      apiKey: "test-key",
      baseUrl: mockBaseUrl,
      model: TEST_MODEL,
    });

    const [fileName, comp] = firstEntry(result.components);
    expect(comp.tagName).toBe("x-card");
    expect(fileName).toBe("x-card.json");
  });

  it("increments the dedup suffix past already-taken names", async () => {
    mockResponse = { componentName: "ui-card", tagName: "ui-card", props: {} };

    const result = await aiComponentize(craftedResult(3, false), {
      apiKey: "test-key",
      baseUrl: mockBaseUrl,
      model: TEST_MODEL,
    });

    const names = [...result.components.values()].map((c) => c.tagName);
    expect(names).toEqual(["ui-card", "ui-card-2", "ui-card-3"]);
  });

  it("keeps original prop names when renames are invalid identifiers", async () => {
    mockResponse = {
      componentName: "bad-props",
      tagName: "bad-props",
      props: { text: "not a valid name!", href: 42 },
    };

    const result = await aiComponentize(craftedResult(), {
      apiKey: "test-key",
      baseUrl: mockBaseUrl,
      model: TEST_MODEL,
    });

    const [, comp] = firstEntry(result.components);
    expect(Object.keys(comp.template.state ?? {}).toSorted()).toEqual(["href", "text"]);
  });

  it("renames props across string children, textContent, and attributes", async () => {
    mockResponse = {
      componentName: "link-card",
      tagName: "link-card",
      props: { text: "title", href: "linkUrl" },
    };

    const result = await aiComponentize(craftedResult(), {
      apiKey: "test-key",
      baseUrl: mockBaseUrl,
      model: TEST_MODEL,
    });

    const [, comp] = firstEntry(result.components);
    expect(comp.template.state).toEqual({ title: "", linkUrl: "" });

    const children = comp.template.children as (JxElement | string)[];
    expect(children[0]).toBe("${state.title}");
    const anchor = children[1] as JxElement;
    expect(anchor.textContent).toBe("${state.title}");
    expect(anchor.attributes).toEqual({ href: "${state.linkUrl}", target: "_blank" });

    const page = result.rewrittenPages.get("pages/index.json")!;
    const callSite = (page.children as JxElement[])[0]!;
    expect(callSite.tagName).toBe("link-card");
    expect(callSite.$props).toEqual({ title: "Text 0", linkUrl: "/link-0" });
  });

  it("reports renamed props through onProgress", async () => {
    mockResponse = {
      componentName: "note-card",
      tagName: "note-card",
      props: { text: "title", href: "href" },
    };

    const messages: string[] = [];
    await aiComponentize(
      craftedResult(),
      { apiKey: "test-key", baseUrl: mockBaseUrl, model: TEST_MODEL },
      (msg) => messages.push(msg),
    );

    expect(messages.some((m) => m.includes("Props: text→title"))).toBe(true);
  });
});

/**
 * The model is a required option, and the guard is textual because a type cannot fail a test run.
 *
 * `"gpt-4o-mini"` was a default inside `callLlm`. That is harmless while the only caller is the CLI
 * pointing at OpenAI, and wrong the moment a backend brokers anything else: Workers AI answers an
 * unknown model with a 404, `callLlm` reads any non-ok response as "the LLM failed", and every
 * component silently keeps its heuristic `component-div-0` name. The default now lives at the call
 * site that knows the provider — `run.ts` — and these two assertions are what keep it from drifting
 * back down.
 */
describe("ai-componentize requires an explicit model", () => {
  it("declares `model` without a `?`, so no caller can omit it", async () => {
    const source = await Bun.file(new URL("../src/ai-componentize.ts", import.meta.url)).text();
    const options = source.slice(source.indexOf("interface AiComponentizeOptions"));
    expect(options.slice(0, options.indexOf("}"))).toContain("\n  model: string;");
  });

  it("hardcodes no model id at all, and run.ts holds the OSS default instead", async () => {
    const source = await Bun.file(new URL("../src/ai-componentize.ts", import.meta.url)).text();
    // Comments may name it — the prose above explains the defect. Executable code may not.
    const code = source.replaceAll(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toContain("gpt-4o-mini");
    const run = await Bun.file(new URL("../src/run.ts", import.meta.url)).text();
    expect(run).toContain('const DEFAULT_AI_MODEL = "gpt-4o-mini";');
  });
});
