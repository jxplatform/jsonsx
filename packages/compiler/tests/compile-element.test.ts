import { describe, expect, test } from "bun:test";
import { compileElement, compileElementPage } from "../src/compiler";
import { emitElementModule } from "../src/targets/compile-element";
import { resolve } from "node:path";

const fixturesDir = import.meta.dir;
const examplesDir = resolve(fixturesDir, "../../../examples/components");

// ─── compileElement — basic output ──────────────────────────────────────────

describe("compileElement", () => {
  test("compiles a simple custom element from a raw object", async () => {
    const result = await compileElement({
      children: [{ tagName: "span", textContent: "${state.count}" }],
      state: { count: 0 },
      tagName: "test-basic",
    });

    expect(result.files).toHaveLength(1);
    const file = result.files[0];
    expect(file.tagName).toBe("test-basic");
    expect(file.content).toContain("class TestBasic extends HTMLElement");
    expect(file.content).toContain("customElements.define('test-basic'");
    expect(file.content).toContain("import { reactive, computed, effect } from '@vue/reactivity'");
    expect(file.content).toContain("import { render, html } from 'lit-html'");
  });

  test("reactive state from state", async () => {
    const result = await compileElement({
      children: [],
      state: { count: 0, items: [1, 2, 3], label: "hello" },
      tagName: "test-state",
    });

    const { content } = result.files[0];
    expect(content).toContain("this.state = reactive({");
    expect(content).toContain('label: "hello"');
    expect(content).toContain("count: 0");
    expect(content).toContain("items: [1,2,3]");
  });

  test("functions become methods on state", async () => {
    const result = await compileElement({
      children: [],
      state: {
        count: 0,
        increment: {
          $prototype: "Function",
          body: "state.count++",
        },
      },
      tagName: "test-fn",
    });

    const { content } = result.files[0];
    expect(content).toContain("this.state.increment = (state) => {");
    expect(content).toContain("state.count++");
  });

  test("signal functions become computed", async () => {
    const result = await compileElement({
      children: [],
      state: {
        items: [],
        total: {
          $prototype: "Function",
          body: "return state.items.length",
        },
      },
      tagName: "test-computed",
    });

    const { content } = result.files[0];
    expect(content).toContain("this.state.total = computed(() => {");
    expect(content).toContain("return this.state.items.length");
  });

  test("connectedCallback merges properties and starts effect", async () => {
    const result = await compileElement({
      children: [],
      state: { x: 1 },
      tagName: "test-connect",
    });

    const { content } = result.files[0];
    expect(content).toContain("connectedCallback()");
    expect(content).toContain("this.state[key] = this[key]");
    expect(content).toContain("this.#dispose = effect(() => render(this.template(), this))");
  });

  test("disconnectedCallback disposes effect", async () => {
    const result = await compileElement({
      children: [],
      state: {},
      tagName: "test-disconnect",
    });

    const { content } = result.files[0];
    expect(content).toContain("disconnectedCallback()");
    expect(content).toContain("#dispose");
  });

  test("throws for non-hyphenated tagName", async () => {
    try {
      await compileElement({ state: {}, tagName: "nohyphen" });
      expect(true).toBe(false);
    } catch (error) {
      expect((error as Error).message).toContain("must contain a hyphen");
    }
  });

  test("tagName converts to PascalCase class name", async () => {
    const result = await compileElement({
      children: [],
      state: {},
      tagName: "my-cool-element",
    });

    expect(result.files[0].content).toContain("class MyCoolElement extends HTMLElement");
  });
});

// ─── compileElement — template generation ───────────────────────────────────

describe("compileElement — templates", () => {
  test("textContent with template string", async () => {
    const result = await compileElement({
      children: [{ tagName: "span", textContent: "${state.name}" }],
      state: { name: "world" },
      tagName: "test-text",
    });

    const { content } = result.files[0];
    expect(content).toContain("${s.name}");
  });

  test("template string in children array emits unescaped lit expression", async () => {
    const result = await compileElement({
      children: [
        {
          children: ["${state.status === 'submitting' ? 'Sending...' : 'Submit'}"],
          tagName: "button",
        },
      ],
      state: { status: "idle" },
      tagName: "test-tpl-child",
    });

    const { content } = result.files[0];
    expect(content).toContain("s.status === 'submitting' ? 'Sending...' : 'Submit'");
    expect(content).not.toContain("&#39;");
    expect(content).not.toContain("&amp;");
  });

  test("static textContent", async () => {
    const result = await compileElement({
      children: [{ tagName: "span", textContent: "Hello" }],
      state: {},
      tagName: "test-static-text",
    });

    const { content } = result.files[0];
    expect(content).toContain(">Hello</span>");
  });

  test("inner styles use class names (CSS in sidecar, not JS)", async () => {
    const result = await compileElement({
      children: [
        {
          style: { backgroundColor: "#fff", display: "flex", gap: "1em" },
          tagName: "div",
        },
      ],
      state: {},
      tagName: "test-style",
    });

    const { content } = result.files[0];
    expect(content).toContain('class="test-style-0"');
    expect(content).not.toContain("display: flex");
    expect(content).not.toContain("background-color: #fff");
    expect(content).not.toContain('data-jx="');
  });

  test("dynamic style with template expression", async () => {
    const result = await compileElement({
      children: [
        {
          style: { color: "${state.active ? 'red' : 'gray'}" },
          tagName: "div",
        },
      ],
      state: { active: true },
      tagName: "test-dyn-style",
    });

    const { content } = result.files[0];
    expect(content).toContain("color: ${s.active ? 'red' : 'gray'}");
  });

  test("event handlers from $ref", async () => {
    const result = await compileElement({
      children: [
        {
          onclick: { $ref: "#/state/handleClick" },
          tagName: "button",
          textContent: "Click",
        },
      ],
      state: {
        handleClick: { $prototype: "Function", body: 'console.log("clicked")' },
      },
      tagName: "test-event",
    });

    const { content } = result.files[0];
    expect(content).toContain("@click=");
    expect(content).toContain("s.handleClick");
  });

  test("inline event handler", async () => {
    const result = await compileElement({
      children: [
        {
          onclick: { $prototype: "Function", body: "state.count++" },
          tagName: "button",
          textContent: "Inc",
        },
      ],
      state: { count: 0 },
      tagName: "test-inline-event",
    });

    const { content } = result.files[0];
    expect(content).toContain("@click=");
    expect(content).toContain("s.count++");
  });

  test("$props on custom element child", async () => {
    const result = await compileElement({
      children: [
        {
          $props: {
            items: { $ref: "#/state/data" },
            label: "test",
          },
          tagName: "child-el",
        },
      ],
      state: { data: [] },
      tagName: "test-props",
    });

    const { content } = result.files[0];
    expect(content).toContain('.items="${s.data}"');
    expect(content).toContain('.label="${"test"}"');
  });

  test("mapped array", async () => {
    const result = await compileElement({
      children: {
        $prototype: "Array",
        items: { $ref: "#/state/items" },
        map: {
          tagName: "div",
          textContent: "${$map.item}",
        },
      },
      state: { items: [1, 2, 3] },
      tagName: "test-map",
    });

    const { content } = result.files[0];
    expect(content).toContain(".map((item, index)");
    expect(content).toContain("s.items");
  });

  test("always clears innerHTML before render (no duplicate content on hydration)", async () => {
    const result = await compileElement({
      children: [{ tagName: "span", textContent: "${state.name}" }],
      state: { name: "world" },
      tagName: "test-hydrate",
    });

    const { content } = result.files[0];
    expect(content).toContain("this.innerHTML = '';");
    expect(content).not.toContain("} else {");
    expect(content).not.toContain("} else {\n      this.innerHTML = '';");
  });

  test("attributes", async () => {
    const result = await compileElement({
      children: [
        {
          attributes: { placeholder: "Enter...", type: "text" },
          tagName: "input",
        },
      ],
      state: {},
      tagName: "test-attrs",
    });

    const { content } = result.files[0];
    expect(content).toContain('type="text"');
    expect(content).toContain('placeholder="Enter..."');
  });
});

// ─── compileElement — $elements dependencies ────────────────────────────────

describe("compileElement — $elements", () => {
  test("compiles task-item.json from file", async () => {
    const result = await compileElement(resolve(examplesDir, "task-item.json"));

    expect(result.files).toHaveLength(1);
    const file = result.files[0];
    expect(file.tagName).toBe("task-item");
    expect(file.content).toContain("class TaskItem extends HTMLElement");
    expect(file.content).toContain("this.state.toggleDone");
    expect(file.content).toContain("this.state.removeTask");
  });

  test("compiles task-stats.json with computed signals", async () => {
    const result = await compileElement(resolve(examplesDir, "task-stats.json"));

    const { content } = result.files[0];
    expect(content).toContain("class TaskStats extends HTMLElement");
    expect(content).toContain("this.state.total = computed(");
    expect(content).toContain("this.state.done = computed(");
    expect(content).toContain("this.state.remaining = computed(");
  });

  test("compiles task-manager.json with $elements deps", async () => {
    const result = await compileElement(resolve(examplesDir, "task-manager.json"));

    // Should have 3 files: task-item, task-stats, task-manager
    expect(result.files).toHaveLength(3);
    expect(result.files.map((f) => f.tagName)).toEqual(["task-item", "task-stats", "task-manager"]);

    // Root element (task-manager) should import the deps
    const root = result.files[2];
    expect(root.content).toContain("import './task-item.js'");
    expect(root.content).toContain("import './task-stats.js'");
  });

  test("does not duplicate visited elements from file", async () => {
    // Task-manager.json references task-item and task-stats
    // Compiling it should not produce duplicates
    const result = await compileElement(resolve(examplesDir, "task-manager.json"));

    const tagNames = result.files.map((f) => f.tagName);
    // Each tag should appear exactly once
    const unique = [...new Set(tagNames)];
    expect(tagNames.length).toBe(unique.length);
  });
});

// ─── compileElementPage ─────────────────────────────────────────────────────

describe("compileElementPage", () => {
  test("generates HTML with import map", async () => {
    const result = await compileElementPage(
      {
        children: [{ tagName: "span", textContent: "${state.x}" }],
        state: { x: 1 },
        tagName: "test-page",
      },
      { title: "Test Page" },
    );

    expect(result.html).toContain("<!DOCTYPE html>");
    expect(result.html).toContain("<title>Test Page</title>");
    expect(result.html).toContain('"@vue/reactivity"');
    expect(result.html).toContain('"lit-html"');
    expect(result.html).toContain("<test-page></test-page>");
    expect(result.html).toContain('type="module"');
  });

  test("compiles .md markdown file input", async () => {
    const { writeFileSync, mkdirSync, rmSync } = await import("node:fs");
    const tmpDir = resolve(import.meta.dir, "__tmp_md_test__");
    mkdirSync(tmpDir, { recursive: true });
    const mdPath = resolve(tmpDir, "test-markdown.md");
    writeFileSync(
      mdPath,
      `---
tagName: test-markdown
state:
  count: 0
---

# Hello

Paragraph content
`,
    );
    try {
      const { buildProjectFormatRegistry } = await import("../src/site/format-host");
      const formats = await buildProjectFormatRegistry(tmpDir, {
        imports: { Markdown: "@jxsuite/parser/Markdown.class.json" },
      });
      const result = await compileElementPage(mdPath, {
        formats,
        title: "MD Test",
      });
      expect(result.html).toContain("<!DOCTYPE html>");
      expect(result.html).toContain("<test-markdown></test-markdown>");
      expect(result.files.length).toBeGreaterThanOrEqual(1);
      expect(result.files[0].tagName).toBe("test-markdown");
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  test("custom resolveElementPath callback", async () => {
    const result = await compileElement(
      {
        $elements: ["./components/child-el.json"],
        children: [],
        state: {},
        tagName: "test-resolve",
      },
      {
        resolveElementPath: (refPath: string, _dir: string | null) =>
          refPath.replace(/\.json$/, ".bundle.js"),
      },
    );

    const root = result.files.at(-1);
    expect(root.content).toContain("import './components/child-el.bundle.js'");
  });
});

// ─── extractInitialValue — $prototype edge cases ───────────────────────────

describe("compileElement — extractInitialValue prototypes", () => {
  test("LocalStorage $prototype uses default value", async () => {
    const result = await compileElement({
      children: [],
      state: {
        theme: { $prototype: "LocalStorage", default: "dark" },
      },
      tagName: "test-localstorage",
    });

    const { content } = result.files[0];
    expect(content).toContain('theme: "dark"');
  });

  test("LocalStorage $prototype without default uses null", async () => {
    const result = await compileElement({
      children: [],
      state: {
        token: { $prototype: "LocalStorage" },
      },
      tagName: "test-ls-null",
    });

    const { content } = result.files[0];
    expect(content).toContain("token: null");
  });

  test("Request $prototype uses null as initial value", async () => {
    const result = await compileElement({
      children: [],
      state: {
        data: { $prototype: "Request", url: "https://api.example.com/data" },
      },
      tagName: "test-request",
    });

    const { content } = result.files[0];
    expect(content).toContain("data: null");
  });
});

// ─── $src imports ───────────────────────────────────────────────────────────

describe("compileElement — $src imports", () => {
  test("Function with $src generates import and wrapper", async () => {
    const result = await compileElement({
      children: [],
      state: {
        handler: {
          $export: "handler",
          $prototype: "Function",
          $src: "./utils.js",
          body: "state.count++",
        },
      },
      tagName: "test-src-fn",
    });

    const { content } = result.files[0];
    expect(content).toContain("import { handler } from './utils.js'");
    expect(content).toContain("this.state.handler = (state) => handler(state)");
  });

  test("computed Function with $src generates import and computed wrapper", async () => {
    const result = await compileElement({
      children: [],
      state: {
        total: {
          $export: "total",
          $prototype: "Function",
          $src: "./calc.js",
          body: "return state.items.length",
        },
      },
      tagName: "test-src-computed",
    });

    const { content } = result.files[0];
    expect(content).toContain("import { total } from './calc.js'");
    expect(content).toContain("this.state.total = computed(() => total(this.state))");
  });

  test("multiple $src imports from same file are grouped", async () => {
    const result = await compileElement({
      children: [],
      state: {
        add: { $prototype: "Function", $src: "./math.js", body: "state.x++" },
        sub: { $prototype: "Function", $src: "./math.js", body: "state.x--" },
      },
      tagName: "test-src-multi",
    });

    const { content } = result.files[0];
    expect(content).toContain("import { add, sub } from './math.js'");
  });
});

// ─── Dynamic styles on host element ─────────────────────────────────────────

describe("compileElement — dynamic host styles", () => {
  test("template strings in host style emit effect", async () => {
    const content = emitElementModule(
      {
        children: [],
        state: { theme: "blue" },
        style: { color: "${state.theme}", display: "flex" },
        tagName: "test-dyn-host",
      },
      "TestDynHost",
      [],
    );

    expect(content).toContain("effect(() => {");
    expect(content).toContain("this.style['color'] = `${this.state.theme}`");
    // Static 'display: flex' should NOT be in the dynamic effect
    expect(content).not.toContain("this.style['display']");
  });
});

// ─── Slot handling ──────────────────────────────────────────────────────────

describe("compileElement — slot handling", () => {
  test("element with slot child saves and restores slotted content", async () => {
    const result = await compileElement({
      children: [{ children: [{ tagName: "slot" }], tagName: "div" }],
      state: {},
      tagName: "test-slot",
    });

    const { content } = result.files[0];
    expect(content).toContain("const _slotted = Array.from(this.childNodes)");
    expect(content).toContain("const _slot = this.querySelector('slot')");
    expect(content).toContain("_slot.before(n)");
    expect(content).toContain("_slot.remove()");
  });
});

// ─── emitLitNode — attributes and property bindings ─────────────────────────

describe("compileElement — emitLitNode edge cases", () => {
  test("dynamic attribute with template string", async () => {
    const result = await compileElement({
      children: [
        {
          attributes: { "data-x": "${state.val}" },
          tagName: "div",
        },
      ],
      state: { val: "hello" },
      tagName: "test-dyn-attr",
    });

    const { content } = result.files[0];
    expect(content).toContain('data-x="${s.val}"');
  });

  test("property bindings with template strings on non-reserved keys", async () => {
    const result = await compileElement({
      children: [
        {
          tagName: "custom-child",
          value: "${state.val}",
        },
      ],
      state: { val: "test" },
      tagName: "test-prop-bind",
    });

    const { content } = result.files[0];
    expect(content).toContain('.value="${s.val}"');
  });

  test("boolean/number child nodes are escaped", async () => {
    const content = emitElementModule(
      {
        children: [{ children: [42], tagName: "div" }],
        state: {},
        tagName: "test-bool-child",
      } as unknown as import("@jxsuite/schema/types").JxDocument,
      "TestBoolChild",
      [],
    );

    expect(content).toContain("42");
  });

  test("innerHTML in node definition", async () => {
    const result = await compileElement({
      children: [
        {
          innerHTML: "<b>content</b>",
          tagName: "div",
        },
      ],
      state: {},
      tagName: "test-innerhtml",
    });

    const { content } = result.files[0];
    expect(content).toContain("<b>content</b>");
    expect(content).toContain("<div");
  });
});

// ─── emitMappedArray edge cases ─────────────────────────────────────────────

describe("compileElement — emitMappedArray edge cases", () => {
  test("$props without $ref in mapped array", async () => {
    const result = await compileElement({
      children: {
        $prototype: "Array",
        items: { $ref: "#/state/items" },
        map: {
          $props: { title: "Static" },
          tagName: "child-el",
          textContent: "${$map.item}",
        },
      },
      state: { items: [] },
      tagName: "test-map-props",
    });

    const { content } = result.files[0];
    expect(content).toContain('.title="${"Static"}"');
    expect(content).toContain(".map((item, index)");
  });

  test("event handlers in mapped array", async () => {
    const result = await compileElement({
      children: {
        $prototype: "Array",
        items: { $ref: "#/state/items" },
        map: {
          onclick: { $ref: "#/state/handleClick" },
          tagName: "button",
          textContent: "${$map.item}",
        },
      },
      state: {
        handleClick: { $prototype: "Function", body: 'console.log("click")' },
        items: [],
      },
      tagName: "test-map-event",
    });

    const { content } = result.files[0];
    expect(content).toContain("@click=");
    expect(content).toContain("s.handleClick(s, e)");
  });

  test("children in mapped array", async () => {
    const result = await compileElement({
      children: {
        $prototype: "Array",
        items: { $ref: "#/state/items" },
        map: {
          children: [{ tagName: "span", textContent: "nested" }],
          tagName: "div",
        },
      },
      state: { items: [] },
      tagName: "test-map-children",
    });

    const { content } = result.files[0];
    expect(content).toContain(".map((item, index)");
    expect(content).toContain("<span");
    expect(content).toContain(">nested</span>");
  });
});

// ─── refToExpr edge cases ───────────────────────────────────────────────────

describe("compileElement — refToExpr edge cases", () => {
  test("$map/ prefix resolves to dotted path", async () => {
    const result = await compileElement({
      children: {
        $prototype: "Array",
        items: { $ref: "#/state/items" },
        map: {
          $props: { name: { $ref: "$map/item/name" } },
          tagName: "span",
        },
      },
      state: { items: [] },
      tagName: "test-map-ref",
    });

    const { content } = result.files[0];
    expect(content).toContain("item.name");
  });

  test("unknown ref without #/state/ prefix uses s. prefix", async () => {
    const result = await compileElement({
      children: [
        {
          $props: { data: { $ref: "custom/path" } },
          tagName: "div",
        },
      ],
      state: { items: [] },
      tagName: "test-unknown-ref",
    });

    const { content } = result.files[0];
    expect(content).toContain("s.custom/path");
  });

  test("$map/ prefix ref resolves to dot path without s. prefix", async () => {
    const result = await compileElement({
      children: [
        {
          children: {
            $prototype: "Array",
            items: { $ref: "#/state/items" },
            map: {
              $props: { label: { $ref: "$map/item/title" } },
              onclick: { $ref: "$map/item/handler" },
              tagName: "li",
            },
          },
          tagName: "ul",
        },
      ],
      state: { items: { default: [], type: "array" } },
      tagName: "test-map-ref",
    });

    const { content } = result.files[0];
    expect(content).toContain("item.title");
    expect(content).toContain("item.handler");
    expect(content).not.toContain("s.$map");
  });

  test("Request prototype state initializes as null", async () => {
    const result = await compileElement({
      children: [{ tagName: "div", textContent: "loading" }],
      state: {
        data: { $prototype: "Request", url: "/api/items" },
      },
      tagName: "test-request",
    });
    const { content } = result.files[0];
    expect(content).toContain("data: null");
  });

  test("plain string child in lit template is escaped", async () => {
    const result = await compileElement({
      children: [
        {
          children: {
            $prototype: "Array",
            items: { $ref: "#/state/items" },
            map: {
              children: ["Hello world"],
              tagName: "li",
            },
          },
          tagName: "ul",
        },
      ],
      state: { items: { default: [], type: "array" } },
      tagName: "test-plain-text",
    });
    const { content } = result.files[0];
    expect(content).toContain("Hello world");
  });
});

// ─── $media propagation through opts ──────────────────────────────────────────

describe("compileElement — $media opts", () => {
  test("assigns class names when $media opts are provided", async () => {
    const result = await compileElement(
      {
        children: [
          {
            style: {
              "@--md": { display: "block" },
              display: "none",
            },
            tagName: "button",
          },
        ],
        tagName: "test-media-prop",
      },
      { $media: { "--md": "(max-width: 768px)" } },
    );
    const { content } = result.files[0];
    expect(content).toContain('class="test-media-prop-0"');
  });

  test("component's own $media takes precedence over opts $media", async () => {
    const result = await compileElement(
      {
        $media: { "--md": "(max-width: 900px)" },
        children: [
          {
            style: { "@--md": { color: "red" } },
            tagName: "div",
          },
        ],
        tagName: "test-media-override",
      },
      { $media: { "--md": "(max-width: 768px)" } },
    );
    const { content } = result.files[0];
    expect(content).toContain('class="test-media-override-0"');
  });

  test("assigns class names for elements with @starting-style", async () => {
    const result = await compileElement({
      children: [
        {
          style: {
            ":popover-open": { transform: "translateX(0)" },
            "@starting-style": {
              ":popover-open": { transform: "translateX(100%)" },
            },
            transform: "translateX(100%)",
          },
          tagName: "nav",
        },
      ],
      tagName: "test-starting-style",
    });
    const { content } = result.files[0];
    expect(content).toContain('class="test-starting-style-0"');
  });

  test("popover and popovertarget attributes are rendered", async () => {
    const result = await compileElement({
      children: [
        {
          attributes: { "aria-label": "Toggle", popovertarget: "my-menu" },
          tagName: "button",
          textContent: "Menu",
        },
        {
          attributes: { popover: "" },
          children: [{ attributes: { href: "/" }, tagName: "a", textContent: "Home" }],
          id: "my-menu",
          tagName: "nav",
        },
      ],
      tagName: "test-popover-attrs",
    });
    const { content } = result.files[0];
    expect(content).toContain('popovertarget="my-menu"');
    expect(content).toContain("popover");
  });
});
