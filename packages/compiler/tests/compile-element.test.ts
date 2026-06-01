import { describe, test, expect } from "bun:test";
import { compileElement, compileElementPage } from "../src/compiler";
import { emitElementModule } from "../src/targets/compile-element";
import { resolve } from "node:path";

const fixturesDir = import.meta.dir;
const examplesDir = resolve(fixturesDir, "../../../examples/components");

// ─── compileElement — basic output ──────────────────────────────────────────

describe("compileElement", () => {
  test("compiles a simple custom element from a raw object", async () => {
    const result = await compileElement({
      tagName: "test-basic",
      state: { count: 0 },
      children: [{ tagName: "span", textContent: "${state.count}" }],
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
      tagName: "test-state",
      state: { label: "hello", count: 0, items: [1, 2, 3] },
      children: [],
    });

    const content = result.files[0].content;
    expect(content).toContain("this.state = reactive({");
    expect(content).toContain('label: "hello"');
    expect(content).toContain("count: 0");
    expect(content).toContain("items: [1,2,3]");
  });

  test("functions become methods on state", async () => {
    const result = await compileElement({
      tagName: "test-fn",
      state: {
        count: 0,
        increment: {
          $prototype: "Function",
          body: "state.count++",
        },
      },
      children: [],
    });

    const content = result.files[0].content;
    expect(content).toContain("this.state.increment = (state) => {");
    expect(content).toContain("state.count++");
  });

  test("signal functions become computed", async () => {
    const result = await compileElement({
      tagName: "test-computed",
      state: {
        items: [],
        total: {
          $prototype: "Function",
          body: "return state.items.length",
        },
      },
      children: [],
    });

    const content = result.files[0].content;
    expect(content).toContain("this.state.total = computed(() => {");
    expect(content).toContain("return this.state.items.length");
  });

  test("connectedCallback merges properties and starts effect", async () => {
    const result = await compileElement({
      tagName: "test-connect",
      state: { x: 1 },
      children: [],
    });

    const content = result.files[0].content;
    expect(content).toContain("connectedCallback()");
    expect(content).toContain("this.state[key] = this[key]");
    expect(content).toContain("this.#dispose = effect(() => render(this.template(), this))");
  });

  test("disconnectedCallback disposes effect", async () => {
    const result = await compileElement({
      tagName: "test-disconnect",
      state: {},
      children: [],
    });

    const content = result.files[0].content;
    expect(content).toContain("disconnectedCallback()");
    expect(content).toContain("#dispose");
  });

  test("throws for non-hyphenated tagName", async () => {
    try {
      await compileElement({ tagName: "nohyphen", state: {} });
      expect(true).toBe(false);
    } catch (e) {
      expect((e as Error).message).toContain("must contain a hyphen");
    }
  });

  test("tagName converts to PascalCase class name", async () => {
    const result = await compileElement({
      tagName: "my-cool-element",
      state: {},
      children: [],
    });

    expect(result.files[0].content).toContain("class MyCoolElement extends HTMLElement");
  });
});

// ─── compileElement — template generation ───────────────────────────────────

describe("compileElement — templates", () => {
  test("textContent with template string", async () => {
    const result = await compileElement({
      tagName: "test-text",
      state: { name: "world" },
      children: [{ tagName: "span", textContent: "${state.name}" }],
    });

    const content = result.files[0].content;
    expect(content).toContain("${s.name}");
  });

  test("template string in children array emits unescaped lit expression", async () => {
    const result = await compileElement({
      tagName: "test-tpl-child",
      state: { status: "idle" },
      children: [
        {
          tagName: "button",
          children: ["${state.status === 'submitting' ? 'Sending...' : 'Submit'}"],
        },
      ],
    });

    const content = result.files[0].content;
    expect(content).toContain("s.status === 'submitting' ? 'Sending...' : 'Submit'");
    expect(content).not.toContain("&#39;");
    expect(content).not.toContain("&amp;");
  });

  test("static textContent", async () => {
    const result = await compileElement({
      tagName: "test-static-text",
      state: {},
      children: [{ tagName: "span", textContent: "Hello" }],
    });

    const content = result.files[0].content;
    expect(content).toContain(">Hello</span>");
  });

  test("inner styles use class names (CSS in sidecar, not JS)", async () => {
    const result = await compileElement({
      tagName: "test-style",
      state: {},
      children: [
        {
          tagName: "div",
          style: { display: "flex", gap: "1em", backgroundColor: "#fff" },
        },
      ],
    });

    const content = result.files[0].content;
    expect(content).toContain('class="test-style-0"');
    expect(content).not.toContain("display: flex");
    expect(content).not.toContain("background-color: #fff");
    expect(content).not.toContain('data-jx="');
  });

  test("dynamic style with template expression", async () => {
    const result = await compileElement({
      tagName: "test-dyn-style",
      state: { active: true },
      children: [
        {
          tagName: "div",
          style: { color: "${state.active ? 'red' : 'gray'}" },
        },
      ],
    });

    const content = result.files[0].content;
    expect(content).toContain("color: ${s.active ? 'red' : 'gray'}");
  });

  test("event handlers from $ref", async () => {
    const result = await compileElement({
      tagName: "test-event",
      state: {
        handleClick: { $prototype: "Function", body: 'console.log("clicked")' },
      },
      children: [
        {
          tagName: "button",
          onclick: { $ref: "#/state/handleClick" },
          textContent: "Click",
        },
      ],
    });

    const content = result.files[0].content;
    expect(content).toContain("@click=");
    expect(content).toContain("s.handleClick");
  });

  test("inline event handler", async () => {
    const result = await compileElement({
      tagName: "test-inline-event",
      state: { count: 0 },
      children: [
        {
          tagName: "button",
          onclick: { $prototype: "Function", body: "state.count++" },
          textContent: "Inc",
        },
      ],
    });

    const content = result.files[0].content;
    expect(content).toContain("@click=");
    expect(content).toContain("s.count++");
  });

  test("$props on custom element child", async () => {
    const result = await compileElement({
      tagName: "test-props",
      state: { data: [] },
      children: [
        {
          tagName: "child-el",
          $props: {
            items: { $ref: "#/state/data" },
            label: "test",
          },
        },
      ],
    });

    const content = result.files[0].content;
    expect(content).toContain('.items="${s.data}"');
    expect(content).toContain('.label="${"test"}"');
  });

  test("mapped array", async () => {
    const result = await compileElement({
      tagName: "test-map",
      state: { items: [1, 2, 3] },
      children: {
        $prototype: "Array",
        items: { $ref: "#/state/items" },
        map: {
          tagName: "div",
          textContent: "${$map.item}",
        },
      },
    });

    const content = result.files[0].content;
    expect(content).toContain(".map((item, index)");
    expect(content).toContain("s.items");
  });

  test("always clears innerHTML before render (no duplicate content on hydration)", async () => {
    const result = await compileElement({
      tagName: "test-hydrate",
      state: { name: "world" },
      children: [{ tagName: "span", textContent: "${state.name}" }],
    });

    const content = result.files[0].content;
    expect(content).toContain("this.innerHTML = '';");
    expect(content).not.toContain("} else {");
    expect(content).not.toContain("} else {\n      this.innerHTML = '';");
  });

  test("attributes", async () => {
    const result = await compileElement({
      tagName: "test-attrs",
      state: {},
      children: [
        {
          tagName: "input",
          attributes: { type: "text", placeholder: "Enter..." },
        },
      ],
    });

    const content = result.files[0].content;
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

    const content = result.files[0].content;
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
    // task-manager.json references task-item and task-stats
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
        tagName: "test-page",
        state: { x: 1 },
        children: [{ tagName: "span", textContent: "${state.x}" }],
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
      const result = await compileElementPage(mdPath, { title: "MD Test" });
      expect(result.html).toContain("<!DOCTYPE html>");
      expect(result.html).toContain("<test-markdown></test-markdown>");
      expect(result.files.length).toBeGreaterThanOrEqual(1);
      expect(result.files[0].tagName).toBe("test-markdown");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("custom resolveElementPath callback", async () => {
    const result = await compileElement(
      {
        tagName: "test-resolve",
        state: {},
        children: [],
        $elements: ["./components/child-el.json"],
      },
      {
        resolveElementPath: (refPath: string, _dir: string) =>
          refPath.replace(/\.json$/, ".bundle.js"),
      },
    );

    const root = result.files[result.files.length - 1];
    expect(root.content).toContain("import './components/child-el.bundle.js'");
  });
});

// ─── extractInitialValue — $prototype edge cases ───────────────────────────

describe("compileElement — extractInitialValue prototypes", () => {
  test("LocalStorage $prototype uses default value", async () => {
    const result = await compileElement({
      tagName: "test-localstorage",
      state: {
        theme: { $prototype: "LocalStorage", default: "dark" },
      },
      children: [],
    });

    const content = result.files[0].content;
    expect(content).toContain('theme: "dark"');
  });

  test("LocalStorage $prototype without default uses null", async () => {
    const result = await compileElement({
      tagName: "test-ls-null",
      state: {
        token: { $prototype: "LocalStorage" },
      },
      children: [],
    });

    const content = result.files[0].content;
    expect(content).toContain("token: null");
  });

  test("Request $prototype uses null as initial value", async () => {
    const result = await compileElement({
      tagName: "test-request",
      state: {
        data: { $prototype: "Request", url: "https://api.example.com/data" },
      },
      children: [],
    });

    const content = result.files[0].content;
    expect(content).toContain("data: null");
  });
});

// ─── $src imports ───────────────────────────────────────────────────────────

describe("compileElement — $src imports", () => {
  test("Function with $src generates import and wrapper", async () => {
    const result = await compileElement({
      tagName: "test-src-fn",
      state: {
        handler: {
          $prototype: "Function",
          $src: "./utils.js",
          $export: "handler",
          body: "state.count++",
        },
      },
      children: [],
    });

    const content = result.files[0].content;
    expect(content).toContain("import { handler } from './utils.js'");
    expect(content).toContain("this.state.handler = (state) => handler(state)");
  });

  test("computed Function with $src generates import and computed wrapper", async () => {
    const result = await compileElement({
      tagName: "test-src-computed",
      state: {
        total: {
          $prototype: "Function",
          $src: "./calc.js",
          $export: "total",
          body: "return state.items.length",
        },
      },
      children: [],
    });

    const content = result.files[0].content;
    expect(content).toContain("import { total } from './calc.js'");
    expect(content).toContain("this.state.total = computed(() => total(this.state))");
  });

  test("multiple $src imports from same file are grouped", async () => {
    const result = await compileElement({
      tagName: "test-src-multi",
      state: {
        add: { $prototype: "Function", $src: "./math.js", body: "state.x++" },
        sub: { $prototype: "Function", $src: "./math.js", body: "state.x--" },
      },
      children: [],
    });

    const content = result.files[0].content;
    expect(content).toContain("import { add, sub } from './math.js'");
  });
});

// ─── Dynamic styles on host element ─────────────────────────────────────────

describe("compileElement — dynamic host styles", () => {
  test("template strings in host style emit effect", async () => {
    const content = emitElementModule(
      {
        tagName: "test-dyn-host",
        state: { theme: "blue" },
        style: { color: "${state.theme}", display: "flex" },
        children: [],
      },
      "TestDynHost",
      [],
    );

    expect(content).toContain("effect(() => {");
    expect(content).toContain("this.style['color'] = `${this.state.theme}`");
    // static 'display: flex' should NOT be in the dynamic effect
    expect(content).not.toContain("this.style['display']");
  });
});

// ─── Slot handling ──────────────────────────────────────────────────────────

describe("compileElement — slot handling", () => {
  test("element with slot child saves and restores slotted content", async () => {
    const result = await compileElement({
      tagName: "test-slot",
      state: {},
      children: [{ tagName: "div", children: [{ tagName: "slot" }] }],
    });

    const content = result.files[0].content;
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
      tagName: "test-dyn-attr",
      state: { val: "hello" },
      children: [
        {
          tagName: "div",
          attributes: { "data-x": "${state.val}" },
        },
      ],
    });

    const content = result.files[0].content;
    expect(content).toContain('data-x="${s.val}"');
  });

  test("property bindings with template strings on non-reserved keys", async () => {
    const result = await compileElement({
      tagName: "test-prop-bind",
      state: { val: "test" },
      children: [
        {
          tagName: "custom-child",
          value: "${state.val}",
        },
      ],
    });

    const content = result.files[0].content;
    expect(content).toContain('.value="${s.val}"');
  });

  test("boolean/number child nodes are escaped", async () => {
    const content = emitElementModule(
      {
        tagName: "test-bool-child",
        state: {},
        children: [{ tagName: "div", children: [42] }],
      },
      "TestBoolChild",
      [],
    );

    expect(content).toContain("42");
  });

  test("innerHTML in node definition", async () => {
    const result = await compileElement({
      tagName: "test-innerhtml",
      state: {},
      children: [
        {
          tagName: "div",
          innerHTML: "<b>content</b>",
        },
      ],
    });

    const content = result.files[0].content;
    expect(content).toContain("<b>content</b>");
    expect(content).toContain("<div");
  });
});

// ─── emitMappedArray edge cases ─────────────────────────────────────────────

describe("compileElement — emitMappedArray edge cases", () => {
  test("$props without $ref in mapped array", async () => {
    const result = await compileElement({
      tagName: "test-map-props",
      state: { items: [] },
      children: {
        $prototype: "Array",
        items: { $ref: "#/state/items" },
        map: {
          tagName: "child-el",
          $props: { title: "Static" },
          textContent: "${$map.item}",
        },
      },
    });

    const content = result.files[0].content;
    expect(content).toContain('.title="${"Static"}"');
    expect(content).toContain(".map((item, index)");
  });

  test("event handlers in mapped array", async () => {
    const result = await compileElement({
      tagName: "test-map-event",
      state: {
        items: [],
        handleClick: { $prototype: "Function", body: 'console.log("click")' },
      },
      children: {
        $prototype: "Array",
        items: { $ref: "#/state/items" },
        map: {
          tagName: "button",
          onclick: { $ref: "#/state/handleClick" },
          textContent: "${$map.item}",
        },
      },
    });

    const content = result.files[0].content;
    expect(content).toContain("@click=");
    expect(content).toContain("s.handleClick(s, e)");
  });

  test("children in mapped array", async () => {
    const result = await compileElement({
      tagName: "test-map-children",
      state: { items: [] },
      children: {
        $prototype: "Array",
        items: { $ref: "#/state/items" },
        map: {
          tagName: "div",
          children: [{ tagName: "span", textContent: "nested" }],
        },
      },
    });

    const content = result.files[0].content;
    expect(content).toContain(".map((item, index)");
    expect(content).toContain("<span");
    expect(content).toContain(">nested</span>");
  });
});

// ─── refToExpr edge cases ───────────────────────────────────────────────────

describe("compileElement — refToExpr edge cases", () => {
  test("$map/ prefix resolves to dotted path", async () => {
    const result = await compileElement({
      tagName: "test-map-ref",
      state: { items: [] },
      children: {
        $prototype: "Array",
        items: { $ref: "#/state/items" },
        map: {
          tagName: "span",
          $props: { name: { $ref: "$map/item/name" } },
        },
      },
    });

    const content = result.files[0].content;
    expect(content).toContain("item.name");
  });

  test("unknown ref without #/state/ prefix uses s. prefix", async () => {
    const result = await compileElement({
      tagName: "test-unknown-ref",
      state: { items: [] },
      children: [
        {
          tagName: "div",
          $props: { data: { $ref: "custom/path" } },
        },
      ],
    });

    const content = result.files[0].content;
    expect(content).toContain("s.custom/path");
  });

  test("$map/ prefix ref resolves to dot path without s. prefix", async () => {
    const result = await compileElement({
      tagName: "test-map-ref",
      state: { items: { type: "array", default: [] } },
      children: [
        {
          tagName: "ul",
          children: {
            $prototype: "Array",
            items: { $ref: "#/state/items" },
            map: {
              tagName: "li",
              $props: { label: { $ref: "$map/item/title" } },
              onclick: { $ref: "$map/item/handler" },
            },
          },
        },
      ],
    });

    const content = result.files[0].content;
    expect(content).toContain("item.title");
    expect(content).toContain("item.handler");
    expect(content).not.toContain("s.$map");
  });

  test("Request prototype state initializes as null", async () => {
    const result = await compileElement({
      tagName: "test-request",
      state: {
        data: { $prototype: "Request", url: "/api/items" },
      },
      children: [{ tagName: "div", textContent: "loading" }],
    });
    const content = result.files[0].content;
    expect(content).toContain("data: null");
  });

  test("plain string child in lit template is escaped", async () => {
    const result = await compileElement({
      tagName: "test-plain-text",
      state: { items: { type: "array", default: [] } },
      children: [
        {
          tagName: "ul",
          children: {
            $prototype: "Array",
            items: { $ref: "#/state/items" },
            map: {
              tagName: "li",
              children: ["Hello world"],
            },
          },
        },
      ],
    });
    const content = result.files[0].content;
    expect(content).toContain("Hello world");
  });
});

// ─── $media propagation through opts ──────────────────────────────────────────

describe("compileElement — $media opts", () => {
  test("assigns class names when $media opts are provided", async () => {
    const result = await compileElement(
      {
        tagName: "test-media-prop",
        children: [
          {
            tagName: "button",
            style: {
              display: "none",
              "@--md": { display: "block" },
            },
          },
        ],
      },
      { $media: { "--md": "(max-width: 768px)" } },
    );
    const content = result.files[0].content;
    expect(content).toContain('class="test-media-prop-0"');
  });

  test("component's own $media takes precedence over opts $media", async () => {
    const result = await compileElement(
      {
        tagName: "test-media-override",
        $media: { "--md": "(max-width: 900px)" },
        children: [
          {
            tagName: "div",
            style: { "@--md": { color: "red" } },
          },
        ],
      },
      { $media: { "--md": "(max-width: 768px)" } },
    );
    const content = result.files[0].content;
    expect(content).toContain('class="test-media-override-0"');
  });

  test("assigns class names for elements with @starting-style", async () => {
    const result = await compileElement({
      tagName: "test-starting-style",
      children: [
        {
          tagName: "nav",
          style: {
            transform: "translateX(100%)",
            ":popover-open": { transform: "translateX(0)" },
            "@starting-style": {
              ":popover-open": { transform: "translateX(100%)" },
            },
          },
        },
      ],
    });
    const content = result.files[0].content;
    expect(content).toContain('class="test-starting-style-0"');
  });

  test("popover and popovertarget attributes are rendered", async () => {
    const result = await compileElement({
      tagName: "test-popover-attrs",
      children: [
        {
          tagName: "button",
          attributes: { popovertarget: "my-menu", "aria-label": "Toggle" },
          textContent: "Menu",
        },
        {
          tagName: "nav",
          id: "my-menu",
          attributes: { popover: "" },
          children: [{ tagName: "a", attributes: { href: "/" }, textContent: "Home" }],
        },
      ],
    });
    const content = result.files[0].content;
    expect(content).toContain('popovertarget="my-menu"');
    expect(content).toContain("popover");
  });
});
