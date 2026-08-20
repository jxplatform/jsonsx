import { describe, expect, test } from "bun:test";
import { compileElement, compileElementPage } from "../src/compiler";
import { emitElementModule } from "../src/targets/compile-element";
import { resolve } from "node:path";
import type { JxDocument } from "@jxsuite/schema/types";

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
    const file = result.files[0]!;
    expect(file.tagName).toBe("test-basic");
    expect(file.content).toContain("class TestBasic extends HTMLElement");
    expect(file.content).toContain("customElements.define('test-basic'");
    expect(file.content).toContain(
      "import { reactive, computed, effect, stop } from '@vue/reactivity'",
    );
    expect(file.content).toContain("import { render, html } from 'lit-html'");
  });

  test("reactive state from state", async () => {
    const result = await compileElement({
      children: [],
      state: { count: 0, items: [1, 2, 3], label: "hello" },
      tagName: "test-state",
    });

    const { content } = result.files[0]!;
    expect(content).toContain("this.state = reactive({");
    expect(content).toContain('label: "hello"');
    expect(content).toContain("count: 0");
    expect(content).toContain("items: [1,2,3]");
  });

  describe("a tag chosen at element creation", () => {
    /*
     * Lit cannot bind a tag name, and `lit-html/static.js`'s `unsafeStatic` — an HTML-injection
     * primitive with an unbounded template cache — is deliberately avoided in this repo. So a
     * chosen tag becomes one TEMPLATE per candidate, keyed by the discriminant: the same shape
     * this emitter already uses for `$switch`, and the reason the schema insists every branch is a
     * literal `TagName` rather than an arbitrary expression.
     */
    const conditional = {
      $expression: {
        initial: "div",
        operator: "?:" as const,
        target: { $ref: "#/state/href" },
        value: "a",
      },
    };

    test("the two-way form emits both branches, each with the subtree", async () => {
      const result = await compileElement({
        children: [
          {
            attributes: { href: "${state.href}" },
            children: [{ tagName: "span" }],
            tagName: conditional,
          },
        ],
        state: { href: "" },
        tagName: "test-chosen-tag",
      });
      const { content } = result.files[0]!;
      expect(content).toContain("${s.href");
      expect(content).toContain("<a");
      expect(content).toContain("</a>");
      expect(content).toContain("<div");
      // The subtree is written once in the DOCUMENT and now once in the BUNDLE too: it is hoisted
      // Into a `const` inside `template()` that both branches reference. Asserted as a COUNT — the
      // Duplicating emitter passed every other assertion in this test.
      expect(content.split("<span").length - 1).toBe(1);
      expect(content).toMatch(/const _c0 = html`/);
      // Declared inside template(), above the return, so it is rebuilt per render and reads `s`.
      expect(content.indexOf("const _c0")).toBeGreaterThan(content.indexOf("const s = this.state"));
      expect(content.indexOf("const _c0")).toBeLessThan(content.indexOf("return html`"));
      // Both branches reference it rather than repeating the subtree.
      expect(content.split("${_c0}").length - 1).toBe(2);
      expect(content).not.toContain("[object Object]");
    });

    test("the multiway form emits a keyed lookup with the fallback", async () => {
      const result = await compileElement({
        children: [
          {
            tagName: {
              $expression: {
                cases: { "1": "h1", "2": "h2" },
                default: "p",
                operator: "switch",
                target: { $ref: "#/state/level" },
              },
            },
          },
        ],
        state: { level: 1 },
        tagName: "test-chosen-heading",
      });
      const { content } = result.files[0]!;
      expect(content).toContain('"1": html');
      expect(content).toContain('"2": html');
      expect(content).toContain("<h1");
      // The required fallback is the `??` arm, not a case key.
      expect(content).toContain("?? html");
      expect(content).toContain("<p");
    });

    test("a plain tag still emits a plain tag", async () => {
      const result = await compileElement({
        children: [{ tagName: "section" }],
        state: {},
        tagName: "test-plain-tag",
      });
      expect(result.files[0]!.content).toContain("<section");
      expect(result.files[0]!.content).not.toContain("?? html");
    });
  });

  describe("a `${…}` state entry is a COMPUTED, the same as at runtime", () => {
    /*
     * The runtime has always said so — `runtime.ts`'s second state pass is
     * `if (typeof def === "string" && def.includes("${")) state[key] = computed(…)` — and
     * `StateEntry`'s schema description reads "string with ${} → computed". The compiler had no
     * such branch and emitted the template as a literal, so ONE component behaved two ways: right
     * in Studio's canvas, which runs the runtime, and wrong on the deployed site, which runs this.
     *
     * Found by building a real site: a `$switch` discriminant shipped as the literal text of its
     * own expression, so the case never matched and the element silently never rendered.
     */
    test("it is emitted as a computed, not as an initial value", async () => {
      const result = await compileElement({
        children: [],
        state: { href: "", linkKey: "${state.href ? 'link' : 'plain'}" },
        tagName: "test-template-state",
      });
      const { content } = result.files[0]!;
      expect(content).toContain(
        "this.state.linkKey = computed(() => `${this.state.href ? 'link' : 'plain'}`)",
      );
      // …and NOT sitting in the initial reactive() block as its own source text.
      expect(content).not.toContain('linkKey: "${state.href');
    });

    test("a plain string with no interpolation stays an initial value", async () => {
      const result = await compileElement({
        children: [],
        state: { label: "hello" },
        tagName: "test-plain-state",
      });
      const { content } = result.files[0]!;
      expect(content).toContain('label: "hello"');
      expect(content).not.toContain("this.state.label = computed");
    });

    test("the discriminant of a $switch resolves, which is what made this visible", async () => {
      const result = await compileElement({
        children: [
          {
            $switch: { $ref: "#/state/imageKey" },
            cases: { set: { tagName: "img" } },
          },
        ],
        state: { image: "", imageKey: "${state.image ? 'set' : ''}" },
        tagName: "test-switch-discriminant",
      });
      const { content } = result.files[0]!;
      expect(content).toContain("this.state.imageKey = computed(");
      // The case lookup reads the computed, so a truthy `image` now selects `set`.
      expect(content).toContain("imageKey]");
    });
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

    const { content } = result.files[0]!;
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

    const { content } = result.files[0]!;
    expect(content).toContain("this.state.total = computed(() => {");
    expect(content).toContain("return this.state.items.length");
  });

  test("connectedCallback merges properties and starts effect", async () => {
    const result = await compileElement({
      children: [],
      state: { x: 1 },
      tagName: "test-connect",
    });

    const { content } = result.files[0]!;
    expect(content).toContain("connectedCallback()");
    expect(content).toContain("this.state[key] = this[key]");
    expect(content).toContain("this.#effects.push(effect(() => render(this.template(), this)))");
  });

  test("disconnectedCallback disposes effect", async () => {
    const result = await compileElement({
      children: [],
      state: {},
      tagName: "test-disconnect",
    });

    const { content } = result.files[0]!;
    expect(content).toContain("disconnectedCallback()");
    expect(content).toContain("for (const _e of this.#effects) { stop(_e); }");
    expect(content).toContain("this.#effects.length = 0;");
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

    expect(result.files[0]!.content).toContain("class MyCoolElement extends HTMLElement");
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

    const { content } = result.files[0]!;
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

    const { content } = result.files[0]!;
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

    const { content } = result.files[0]!;
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

    const { content } = result.files[0]!;
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

    const { content } = result.files[0]!;
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

    const { content } = result.files[0]!;
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

    const { content } = result.files[0]!;
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

    const { content } = result.files[0]!;
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

    const { content } = result.files[0]!;
    expect(content).toContain(".map((item, index)");
    expect(content).toContain("s.items");
  });

  test("mapped array as a member among sibling children (wrapper-less)", async () => {
    const result = await compileElement({
      children: [
        { tagName: "h2", textContent: "Items" },
        {
          $prototype: "Array",
          items: { $ref: "#/state/items" },
          map: { tagName: "li", textContent: "${$map.item}" },
        },
        { tagName: "footer", textContent: "end" },
      ],
      state: { items: [1, 2, 3] },
      tagName: "test-mixed-map",
    });

    const { content } = result.files[0]!;
    // The array expands inline among siblings — no wrapper element, siblings preserved.
    expect(content).toContain("<h2");
    expect(content).toContain("<footer");
    expect(content).toContain(".map((item, index)");
    expect(content).toContain("s.items");
  });

  test("always clears innerHTML before render (no duplicate content on hydration)", async () => {
    const result = await compileElement({
      children: [{ tagName: "span", textContent: "${state.name}" }],
      state: { name: "world" },
      tagName: "test-hydrate",
    });

    const { content } = result.files[0]!;
    expect(content).toContain("this.replaceChildren();");
    expect(content).not.toContain("} else {");
    expect(content).not.toContain("} else {\n      this.replaceChildren();");
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

    const { content } = result.files[0]!;
    expect(content).toContain('type="text"');
    expect(content).toContain('placeholder="Enter..."');
  });
});

// ─── compileElement — $elements dependencies ────────────────────────────────

describe("compileElement — $elements", () => {
  test("compiles task-item.json from file", async () => {
    const result = await compileElement(resolve(examplesDir, "task-item.json"));

    expect(result.files).toHaveLength(1);
    const file = result.files[0]!;
    expect(file.tagName).toBe("task-item");
    expect(file.content).toContain("class TaskItem extends HTMLElement");
    expect(file.content).toContain("this.state.toggleDone");
    expect(file.content).toContain("this.state.removeTask");
  });

  test("compiles task-stats.json with computed signals", async () => {
    const result = await compileElement(resolve(examplesDir, "task-stats.json"));

    const { content } = result.files[0]!;
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
    const root = result.files.slice(2)[0]!;
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
        extensions: ["@jxsuite/parser"],
      });
      const result = await compileElementPage(mdPath, {
        formats,
        title: "MD Test",
      });
      expect(result.html).toContain("<!DOCTYPE html>");
      expect(result.html).toContain("<test-markdown></test-markdown>");
      expect(result.files.length).toBeGreaterThanOrEqual(1);
      expect(result.files[0]!.tagName).toBe("test-markdown");
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

    const root = result.files.at(-1)!;
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

    const { content } = result.files[0]!;
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

    const { content } = result.files[0]!;
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

    const { content } = result.files[0]!;
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

    const { content } = result.files[0]!;
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

    const { content } = result.files[0]!;
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

    const { content } = result.files[0]!;
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

    const { content } = result.files[0]!;
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

    const { content } = result.files[0]!;
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

    const { content } = result.files[0]!;
    expect(content).toContain('.value="${s.val}"');
  });

  test("boolean/number child nodes are escaped", async () => {
    const content = emitElementModule(
      {
        children: [{ children: [42], tagName: "div" }],
        state: {},
        tagName: "test-bool-child",
      } as unknown as JxDocument,
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

    const { content } = result.files[0]!;
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

    const { content } = result.files[0]!;
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

    const { content } = result.files[0]!;
    expect(content).toContain("@click=");
    expect(content).toContain("s.handleClick(s, e)");
  });

  test("a <pre> subtree emits without the lit template's indentation", async () => {
    const result = await compileElement({
      children: [
        {
          tagName: "pre",
          children: [
            {
              tagName: "code",
              children: [
                { tagName: "span", textContent: "const" },
                { tagName: "span", textContent: " x = 1;" },
                "\n",
                { tagName: "span", textContent: "return x;" },
              ],
            },
          ],
        },
      ],
      tagName: "test-pre",
    });

    const { content } = result.files[0]!;
    expect(content).toContain(
      "<pre><code><span>const</span><span> x = 1;</span>\n<span>return x;</span></code></pre>",
    );
  });

  test("attributes, id and className on the map root reach the template", async () => {
    const result = await compileElement({
      children: {
        $prototype: "Array",
        items: { $ref: "#/state/items" },
        map: {
          attributes: {
            "aria-selected": "${index === s.active ? 'true' : 'false'}",
            href: "${item.url}",
            role: "option",
            target: { $ref: "$map/item/target" },
          },
          className: "row ${index === state.active ? 'is-active' : ''}",
          id: "row-${index}",
          tagName: "a",
          textContent: "${$map.item.title}",
        },
      },
      state: { active: 0, items: [] },
      tagName: "test-map-attrs",
    });

    const { content } = result.files[0]!;
    expect(content).toContain('href="${item.url}"');
    expect(content).toContain('role="option"');
    expect(content).toContain("aria-selected=\"${index === s.active ? 'true' : 'false'}\"");
    expect(content).toContain('target="${item.target}"');
    expect(content).toContain('id="row-${index}"');
    // `state.` is rewritten to the component's `s` alias, as everywhere else in the template.
    expect(content).toContain("class=\"row ${index === s.active ? 'is-active' : ''}\"");
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

    const { content } = result.files[0]!;
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

    const { content } = result.files[0]!;
    expect(content).toContain("item.name");
  });

  /*
   * A ref with no recognized prefix is still a path. This used to paste the whole ref after `s.`
   * and emit `s.custom/path` — which is not a parse error but a *division*, `s.custom / path`,
   * against an undeclared identifier. The build reported success and the value was NaN.
   */
  test("unknown ref without #/state/ prefix is lowered as a path under s", async () => {
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

    const { content } = result.files[0]!;
    expect(content).toContain("s.custom.path");
    expect(content).not.toContain("s.custom/path");
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

    const { content } = result.files[0]!;
    expect(content).toContain("item.title");
    expect(content).toContain("item.handler");
    expect(content).not.toContain("s.$map.");
    expect(content).not.toContain("s.$map/");
  });

  test("Request prototype state initializes as null", async () => {
    const result = await compileElement({
      children: [{ tagName: "div", textContent: "loading" }],
      state: {
        data: { $prototype: "Request", url: "/api/items" },
      },
      tagName: "test-request",
    });
    const { content } = result.files[0]!;
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
    const { content } = result.files[0]!;
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
    const { content } = result.files[0]!;
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
    const { content } = result.files[0]!;
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
    const { content } = result.files[0]!;
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
    const { content } = result.files[0]!;
    expect(content).toContain('popovertarget="my-menu"');
    expect(content).toContain("popover");
  });
});

// ─── $src `$export` aliasing (issue #106) ───────────────────────────────────

describe("compileElement — $src $export aliasing", () => {
  test("aliases the import when $export differs from the state key", async () => {
    const result = await compileElement({
      children: [],
      state: {
        filtered: { $export: "filterLeads", $prototype: "Function", $src: "./lib.js" },
      },
      tagName: "test-alias",
    });

    const { content } = result.files[0]!;
    // The local binding stays the state key, because that is what the rest of the module calls.
    expect(content).toContain("import { filterLeads as filtered } from './lib.js'");
    expect(content).not.toContain("import { filtered } from './lib.js'");
  });

  test("imports the bare key when $export is absent or matches the key", async () => {
    const result = await compileElement({
      children: [],
      state: {
        same: { $export: "same", $prototype: "Function", $src: "./a.js" },
        unnamed: { $prototype: "Function", $src: "./b.js" },
      },
      tagName: "test-noalias",
    });

    const { content } = result.files[0]!;
    expect(content).toContain("import { same } from './a.js'");
    expect(content).toContain("import { unnamed } from './b.js'");
    expect(content).not.toContain(" as ");
  });

  test("two keys may alias the same export from one module", async () => {
    const result = await compileElement({
      children: [],
      state: {
        a: { $export: "shared", $prototype: "Function", $src: "./m.js" },
        b: { $export: "shared", $prototype: "Function", $src: "./m.js" },
      },
      tagName: "test-dual-alias",
    });

    expect(result.files[0]!.content).toContain("import { shared as a, shared as b } from './m.js'");
  });
});

// ─── Bodyless $src classification (issue #107) ──────────────────────────────

describe("compileElement — bodyless $src classification", () => {
  /** @param {Record<string, unknown>} extra */
  const compile = (children: unknown, extraState: Record<string, unknown> = {}) =>
    compileElement({
      children,
      state: {
        rows: { $export: "getRows", $prototype: "Function", $src: "./lib.js" },
        ...extraState,
      },
      tagName: "test-src-class",
    } as unknown as JxDocument);

  test("a bodyless $src read as a value becomes a computed", async () => {
    // `items` reads the entry's return value, so the template needs the array, not the function.
    const result = await compile({
      $prototype: "Array",
      items: { $ref: "#/state/rows" },
      map: { tagName: "li", textContent: "${$map.item}" },
    });

    const { content } = result.files[0]!;
    expect(content).toContain("this.state.rows = computed(() => rows(this.state));");
    expect(content).not.toContain("this.state.rows = (state) => rows(state);");
  });

  test("a bodyless $src bound to an on* event stays callable", async () => {
    const result = await compile([{ onclick: { $ref: "#/state/rows" }, tagName: "button" }]);

    expect(result.files[0]!.content).toContain("this.state.rows = (state) => rows(state);");
  });

  test("a bodyless $src invoked from a template string stays callable", async () => {
    const result = await compile([{ tagName: "p", textContent: "n=${state.rows(state)}" }]);

    expect(result.files[0]!.content).toContain("this.state.rows = (state) => rows(state);");
  });

  test("a bodyless $src invoked by an $expression call node stays callable", async () => {
    const result = await compile([{ tagName: "p", textContent: "x" }], {
      total: { $expression: { operator: "call", target: { $ref: "#/state/rows" }, value: [] } },
    });

    expect(result.files[0]!.content).toContain("this.state.rows = (state) => rows(state);");
  });

  test("a bodyless $src lifecycle hook stays callable", async () => {
    const result = await compileElement({
      children: [],
      state: { onMount: { $prototype: "Function", $src: "./lib.js" } },
      tagName: "test-src-lifecycle",
    });

    const { content } = result.files[0]!;
    // A computed here would be *evaluated* by the `typeof … === 'function'` probe and never called.
    expect(content).toContain("this.state.onMount = (state) => onMount(state);");
    expect(content).not.toContain("this.state.onMount = computed(");
  });
});

// ─── $map bindings in compiled templates (issue #108) ───────────────────────

describe("compileElement — $map template bindings", () => {
  test("binds $map in the map callback so ${$map.item} resolves", async () => {
    const result = await compileElement({
      children: {
        $prototype: "Array",
        items: { $ref: "#/state/items" },
        map: { tagName: "li", textContent: "${$map.item.name}" },
      },
      state: { items: [] },
      tagName: "test-map-bind",
    });

    const { content } = result.files[0]!;
    expect(content).toContain("const $map = { item, index };");
    expect(content).toContain("${$map.item.name}");
  });

  test("resolves $map on map descendants, id and className included", async () => {
    const result = await compileElement({
      children: {
        $prototype: "Array",
        items: { $ref: "#/state/items" },
        map: {
          children: [
            {
              className: "cell ${state.active}",
              id: "s-${$map.index}",
              tagName: "span",
              textContent: "${$map.item.name}",
            },
          ],
          className: "row ${state.active} ${$map.item.kind}",
          tagName: "li",
        },
      },
      state: { active: 0, items: [] },
      tagName: "test-map-descendants",
    });

    const { content } = result.files[0]!;
    expect(content).toContain('id="s-${$map.index}"');
    // `state.` still rewrites to the `s` alias alongside the untouched $map read.
    expect(content).toContain('class="row ${s.active} ${$map.item.kind}"');
    // Descendants of the map root took no template rewriting at all before, so a `state.` read in a
    // Nested id/class reached the module unresolved.
    expect(content).toContain('class="cell ${s.active}"');
    expect(content).not.toContain('class="cell ${state.active}"');
  });

  test("supports the optional-chaining and bracket access forms", async () => {
    const result = await compileElement({
      children: {
        $prototype: "Array",
        items: { $ref: "#/state/items" },
        map: { tagName: "li", textContent: '${$map?.item?.name}${$map["index"]}' },
      },
      state: { items: [] },
      tagName: "test-map-forms",
    });

    const { content } = result.files[0]!;
    expect(content).toContain("${$map?.item?.name}");
    expect(content).toContain('${$map["index"]}');
  });

  test("omits the $map binding when the template never references it", async () => {
    const result = await compileElement({
      children: {
        $prototype: "Array",
        items: { $ref: "#/state/items" },
        map: { tagName: "li", textContent: "${item.name}" },
      },
      state: { items: [] },
      tagName: "test-map-nobind",
    });

    const { content } = result.files[0]!;
    expect(content).not.toContain("const $map =");
    expect(content).toContain(".map((item, index) => html`");
  });

  test("leaves a literal $map. mention in static text alone", async () => {
    const result = await compileElement({
      children: [{ tagName: "p", textContent: "write $map.item to read the item" }],
      state: {},
      tagName: "test-map-literal",
    });

    expect(result.files[0]!.content).toContain("write $map.item to read the item");
  });
});

// ─── Request auto-fetch (issue #109) ────────────────────────────────────────

describe("compileElement — Request auto-fetch", () => {
  test("emits a fetch effect on connect that assigns the response", async () => {
    const result = await compileElement({
      children: [],
      state: { leads: { $prototype: "Request", timing: "client", url: "/api/leads" } },
      tagName: "test-req-basic",
    });

    const { content } = result.files[0]!;
    expect(content).toContain('const url = "/api/leads";');
    expect(content).toContain("fetch(url)");
    expect(content).toContain("this.state.leads = d;");
    expect(content).toContain("this.state.leads = { error: String(e) };");
    // Still initialised to null, and the fetch runs after the $props merge.
    expect(content).toContain("leads: null");
    expect(content.indexOf("data-jx-props")).toBeLessThan(content.indexOf("fetch(url)"));
  });

  test("rewrites a templated url through this.state without touching literal text", async () => {
    const result = await compileElement({
      children: [],
      state: {
        q: "",
        rows: { $prototype: "Request", url: "/api/state.json?q=${state.q}" },
      },
      tagName: "test-req-template",
    });

    const { content } = result.files[0]!;
    expect(content).toContain("const url = `/api/state.json?q=${this.state.q}`;");
    expect(content).not.toContain("/api/this.state.json");
    expect(content).toContain(
      'if (!url || url === "undefined" || url.includes("undefined")) return;',
    );
  });

  test("honours manual by emitting no fetch", async () => {
    const result = await compileElement({
      children: [],
      state: { d: { $prototype: "Request", manual: true, url: "/api/d" } },
      tagName: "test-req-manual",
    });

    const { content } = result.files[0]!;
    expect(content).toContain("manual Request — fetch triggered by user action");
    expect(content).not.toContain("fetch(url");
  });

  test("passes method, headers and body through to fetch", async () => {
    const result = await compileElement({
      children: [],
      state: {
        d: {
          $prototype: "Request",
          body: { q: 1 },
          headers: { "X-Key": "v" },
          method: "POST",
          url: "/api/d",
        },
      },
      tagName: "test-req-opts",
    });

    const { content } = result.files[0]!;
    expect(content).toContain('method: "POST"');
    expect(content).toContain('headers: {"X-Key":"v"}');
    expect(content).toContain(String.raw`body: "{\"q\":1}"`);
  });

  test("stops the fetch effects on disconnect", async () => {
    const result = await compileElement({
      children: [],
      state: { d: { $prototype: "Request", url: "/api/d" } },
      tagName: "test-req-dispose",
    });

    const { content } = result.files[0]!;
    // Calling an @vue/reactivity runner re-runs it, so teardown has to use stop().
    expect(content).toContain("import { reactive, computed, effect, stop } from '@vue/reactivity'");
    expect(content).toContain("#effects = [];");
    expect(content).toContain("this.#effects.push(effect(() => {");
    expect(content).toContain("for (const _e of this.#effects) { stop(_e); }");
  });

  test("adds no Request machinery to a document without one", async () => {
    const result = await compileElement({
      children: [{ tagName: "p", textContent: "hi" }],
      state: { n: 0 },
      tagName: "test-req-none",
    });

    const { content } = result.files[0]!;
    expect(content).not.toContain("fetch(url");
    expect(content).not.toContain("auto-fetch");
  });
});

// ─── Declared handler parameters (issue #113) ──────────────────────────────

describe("compileElement — declared handler parameters", () => {
  test('maps a declared ["event"] onto the event argument, binding state too', async () => {
    const result = await compileElement({
      children: [{ oninput: { $ref: "#/state/onSearch" }, tagName: "input" }],
      state: {
        onSearch: {
          $prototype: "Function",
          body: "state.term = event.target.value;",
          parameters: ["event"],
        },
        term: "",
      },
      tagName: "test-param-event",
    });

    const { content } = result.files[0]!;
    // Call sites pass (state, event); the declared name is mapped by name, not by position.
    expect(content).toContain("this.state.onSearch = (state, e) => {");
    expect(content).toContain("const _fn = (event) => {");
    expect(content).toContain("return _fn(e);");
    expect(content).toContain('@input="${(e) => s.onSearch(s, e)}"');
  });

  test("binds state even when no parameter is declared at all", async () => {
    const result = await compileElement({
      children: [],
      state: { bump: { $prototype: "Function", arguments: [], body: "state.n++;" }, n: 0 },
      tagName: "test-param-none",
    });

    const { content } = result.files[0]!;
    expect(content).toContain("this.state.bump = (state, e) => {");
    expect(content).toContain("return _fn();");
  });

  test('emits the direct form when the declaration already starts with "state"', async () => {
    const result = await compileElement({
      children: [],
      state: {
        a: { $prototype: "Function", body: "state.n++;", parameters: ["state"] },
        b: { $prototype: "Function", body: "state.n = 1;", parameters: ["state", "event"] },
        n: 0,
      },
      tagName: "test-param-aligned",
    });

    const { content } = result.files[0]!;
    expect(content).toContain("this.state.a = (state) => {");
    expect(content).toContain("this.state.b = (state, event) => {");
    expect(content).not.toContain("const _fn =");
  });

  test("binds declared parameters on an inline on* handler too", async () => {
    // Examples/components/task-manager.json declares `["state", "event"]` inline on an `oninput`.
    const result = await compileElement({
      children: [
        {
          oninput: {
            $prototype: "Function",
            body: "state.text = event.target.value",
            parameters: ["state", "event"],
          },
          tagName: "input",
        },
      ],
      state: { text: "" },
      tagName: "test-inline-params",
    });

    const { content } = result.files[0]!;
    expect(content).toContain(
      '@input="${(e) => { ((state, event) => { state.text = event.target.value })(s, e); }}"',
    );
  });

  test("a declared name other than event resolves on an inline handler", async () => {
    const result = await compileElement({
      children: [
        {
          onclick: {
            $prototype: "Function",
            body: "state.text = evt.type",
            parameters: ["state", "evt"],
          },
          tagName: "b",
        },
      ],
      state: { text: "" },
      tagName: "test-inline-named",
    });

    // Previously emitted a free `evt`, which threw ReferenceError; `event` only ever "worked" by
    // Accidentally resolving to the deprecated window.event global.
    expect(result.files[0]!.content).toContain(
      "((state, evt) => { state.text = evt.type })(s, e);",
    );
  });

  test("leaves an inline handler that declares nothing on the plain rewrite", async () => {
    const result = await compileElement({
      children: [{ onclick: { $prototype: "Function", body: "state.text = 1" }, tagName: "i" }],
      state: { text: "" },
      tagName: "test-inline-plain",
    });

    expect(result.files[0]!.content).toContain('@click="${(e) => { s.text = 1 }}"');
  });

  test("maps a $src handler's declared parameters as well", async () => {
    const result = await compileElement({
      children: [{ onclick: { $ref: "#/state/save" }, tagName: "button" }],
      state: {
        save: { $export: "saveIt", $prototype: "Function", parameters: ["event"], $src: "./l.js" },
      },
      tagName: "test-param-src",
    });

    expect(result.files[0]!.content).toContain("this.state.save = (state, e) => save(e);");
  });
});

// ─── $map context for handlers bound inside a map ───────────────────────────

describe("compileElement — $map context for map handlers", () => {
  test("a handler on the map root publishes its iteration to state", async () => {
    const result = await compileElement({
      children: {
        $prototype: "Array",
        items: { $ref: "#/state/items" },
        map: { onclick: { $ref: "#/state/pick" }, tagName: "li" },
      },
      state: { items: [], pick: { $prototype: "Function", body: "state.i = state.$map.index" } },
      tagName: "test-mapctx-root",
    });

    const { content } = result.files[0]!;
    expect(content).toContain('@click="${(e) => { s.$map = $map; s.pick(s, e); }}"');
  });

  test("a handler on a map descendant publishes it too", async () => {
    const result = await compileElement({
      children: {
        $prototype: "Array",
        items: { $ref: "#/state/items" },
        map: {
          children: [{ onclick: { $ref: "#/state/pick" }, tagName: "button" }],
          tagName: "li",
        },
      },
      state: { items: [], pick: { $prototype: "Function", body: "state.i = state.$map.index" } },
      tagName: "test-mapctx-descendant",
    });

    const { content } = result.files[0]!;
    // Examples/components/todo-app.json binds its checkbox handler exactly here, and it read
    // `state.$map?.index` — which was undefined, so the handler early-returned and did nothing.
    expect(content).toContain('@click="${(e) => { s.$map = $map; s.pick(s, e); }}"');
    expect(content).toContain("const $map = { item, index };");
  });

  test("an inline and an $expression handler inside a map publish it as well", async () => {
    const result = await compileElement({
      children: {
        $prototype: "Array",
        items: { $ref: "#/state/items" },
        map: {
          children: [
            { onclick: { $prototype: "Function", body: "state.n++" }, tagName: "b" },
            {
              onclick: { $expression: { operator: "increment", target: { $ref: "#/state/n" } } },
              tagName: "i",
            },
          ],
          tagName: "li",
        },
      },
      state: { items: [], n: 0 },
      tagName: "test-mapctx-inline",
    });

    const { content } = result.files[0]!;
    expect(content).toContain('@click="${(e) => { s.$map = $map; s.n++ }}"');
    expect(content).toMatch(/@click="\$\{\(e\) => \{ s\.\$map = \$map; s\.n/);
  });

  test("a handler outside any map is emitted unchanged", async () => {
    const result = await compileElement({
      children: [{ onclick: { $ref: "#/state/pick" }, tagName: "button" }],
      state: { pick: { $prototype: "Function", body: "state.n++" } },
      tagName: "test-mapctx-none",
    });

    const { content } = result.files[0]!;
    expect(content).toContain('@click="${(e) => s.pick(s, e)}"');
    expect(content).not.toContain("s.$map");
  });

  test("a nested map shadows the outer iteration", async () => {
    const result = await compileElement({
      children: {
        $prototype: "Array",
        items: { $ref: "#/state/groups" },
        map: {
          children: {
            $prototype: "Array",
            items: { $ref: "$map/item/rows" },
            map: { onclick: { $ref: "#/state/pick" }, tagName: "span" },
          },
          tagName: "li",
        },
      },
      state: { groups: [], pick: { $prototype: "Function", body: "state.n++" } },
      tagName: "test-mapctx-nested",
    });

    const { content } = result.files[0]!;
    // Two callbacks, each with its own binding — the inner assignment resolves to the inner one.
    expect(content.match(/const \$map = \{ item, index \};/g)).toHaveLength(2);
  });
});

// ─── Effect disposal ────────────────────────────────────────────────────────

describe("compileElement — effect disposal", () => {
  test("every effect the element creates lands in one registry", async () => {
    const result = await compileElement({
      children: [{ tagName: "p", textContent: "x" }],
      state: { c: "red", d: { $prototype: "Request", url: "/api/d" } },
      style: { color: "${state.c}" },
      tagName: "test-dispose-all",
    });

    const { content } = result.files[0]!;
    // Render effect, dynamic host style effect, and Request auto-fetch — three pushes.
    expect(content.match(/this\.#effects\.push\(effect\(/g)).toHaveLength(3);
    expect(content).toContain("this.#effects.push(effect(() => render(this.template(), this)))");
  });

  test("the dynamic host-style effect is closed through the registry push", async () => {
    const result = await compileElement({
      children: [],
      state: { c: "red" },
      style: { color: "${state.c}" },
      tagName: "test-dispose-style",
    });

    const { content } = result.files[0]!;
    expect(content).toContain("this.#effects.push(effect(() => {");
    expect(content).toContain("}));");
  });

  test("disconnect stops the runners rather than calling them", async () => {
    const result = await compileElement({
      children: [],
      state: {},
      tagName: "test-dispose-stop",
    });

    const { content } = result.files[0]!;
    // Calling an @vue/reactivity runner RE-RUNS the effect — it renders once more into a detached
    // Element and stays subscribed. `stop()` is the only thing that ends it.
    expect(content).toContain("for (const _e of this.#effects) { stop(_e); }");
    expect(content).not.toContain("this.#dispose()");
  });
});

// ─── $props delivery ───────────────────────────────────────────────────────

describe("compileElement — $props delivery", () => {
  test("a template-valued $prop is a binding, not literal text", async () => {
    const result = await compileElement({
      children: [{ $props: { label: "${state.who}" }, tagName: "ls-row" }],
      state: { who: "Ann" },
      tagName: "test-props-tpl",
    });

    const { content } = result.files[0]!;
    expect(content).toContain('.label="${s.who}"');
    // Was JSON-quoted, handing the component the template's own source as its value.
    expect(content).not.toContain('.label="${"${state.who}"}"');
  });

  test("a template-valued $prop inside a map reads the item", async () => {
    const result = await compileElement({
      children: {
        $prototype: "Array",
        items: { $ref: "#/state/rows" },
        map: { $props: { label: "${$map.item.name}" }, tagName: "ls-row" },
      },
      state: { rows: [] },
      tagName: "test-props-map",
    });

    const { content } = result.files[0]!;
    expect(content).toContain('.label="${$map.item.name}"');
  });

  test("$ref and static $props are unchanged", async () => {
    const result = await compileElement({
      children: {
        $prototype: "Array",
        items: { $ref: "#/state/rows" },
        map: { $props: { k: "static", n: { $ref: "$map/index" } }, tagName: "ls-row" },
      },
      state: { rows: [] },
      tagName: "test-props-plain",
    });

    const { content } = result.files[0]!;
    expect(content).toContain('.n="${index}"');
    expect(content).toContain('.k="${"static"}"');
  });

  test("connectedCallback reads literal props.* attributes", async () => {
    const result = await compileElement({
      children: [{ tagName: "h3", textContent: "${state.label}" }],
      state: { label: { default: "DEFAULT" } },
      tagName: "test-props-attr",
    });

    const { content } = result.files[0]!;
    // Mirrors the interpreted runtime: island-rendered and JSON-authored instances both deliver
    // Props as `props.*` attributes, and the compiled element used to ignore them entirely.
    expect(content).toContain(
      "const _pn = this.getAttributeNames().filter(n => n.startsWith('props.') && n.length > 6);",
    );
    expect(content).toContain("const _k = _n.slice(6);");
    expect(content).toContain("if (_k in this.state) {");
    expect(content).toContain("this.state[_k] = this.getAttribute(_n);");
    expect(content).toContain("this.removeAttribute(_n);");
  });
});

// ─── $ref schemes other than state ──────────────────────────────────────────

describe("compileElement — the non-state $ref schemes", () => {
  /*
   * These used to fall through to the state branch, so `parent#/user` emitted `s.parent#/user` —
   * a syntax error that took the whole element module down with it. They mirror `compileRef` in
   * @jxsuite/runtime, and a prop reaches an element through `state`, so `parent#/` reads from `s`
   * exactly as `#/state/` does.
   */
  test("parent, window and document refs each compile to their own accessor", async () => {
    const result = await compileElement({
      $props: { user: { type: "string" } },
      children: [
        { tagName: "span", textContent: { $ref: "parent#/user" } },
        { tagName: "em", textContent: { $ref: "window#/location/href" } },
        { tagName: "b", textContent: { $ref: "document#/title" } },
      ],
      state: {},
      tagName: "test-ref-schemes",
    });

    const { content } = result.files[0]!;
    expect(content).toContain("s.user");
    expect(content).toContain("window.location");
    expect(content).toContain("document.title");
    // The defect itself: no scheme prefix survives into the emitted expression.
    expect(content).not.toContain("parent#/");
    expect(content).not.toContain("window#/");
    expect(content).not.toContain("document#/");
  });
});
