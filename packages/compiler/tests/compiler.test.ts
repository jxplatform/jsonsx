import { describe, test, expect, spyOn } from "bun:test";
import { compile, isDynamic, runCli } from "../src/compiler";
import { isClassJsonSrc } from "../src/shared";
import type { JxMutableNode } from "@jxsuite/schema/types";

// ─── isClassJsonSrc ─────────────────────────────────────────────────────────

describe("isClassJsonSrc", () => {
  test("returns true for .class.json path", () => {
    expect(isClassJsonSrc("./MyClass.class.json")).toBe(true);
  });
  test("returns true for absolute .class.json path", () => {
    expect(isClassJsonSrc("/path/to/Widget.class.json")).toBe(true);
  });
  test("returns false for .json path", () => {
    expect(isClassJsonSrc("./component.json")).toBe(false);
  });
  test("returns false for .js path", () => {
    expect(isClassJsonSrc("./module.js")).toBe(false);
  });
  test("returns false for non-string", () => {
    expect(isClassJsonSrc(null)).toBe(false);
    expect(isClassJsonSrc(undefined)).toBe(false);
    expect(isClassJsonSrc(42)).toBe(false);
  });
});

// ─── isDynamic — Five-Shape state Grammar ────────────────────────────────────

describe("isDynamic", () => {
  test("null → false", () => expect(isDynamic(null as unknown as JxMutableNode)).toBe(false));
  test("non-object → false", () => expect(isDynamic("string")).toBe(false));
  test("fully static node → false", () => {
    expect(isDynamic({ tagName: "div", textContent: "hello" })).toBe(false);
  });

  // Shape 1: Naked values in state → dynamic
  test("naked string in state → true", () => {
    expect(isDynamic({ state: { $name: "hello" } })).toBe(true);
  });
  test("naked number in state → true", () => {
    expect(isDynamic({ state: { $count: 42 } })).toBe(true);
  });
  test("naked boolean in state → true", () => {
    expect(isDynamic({ state: { $flag: false } })).toBe(true);
  });
  test("naked null in state → true", () => {
    expect(isDynamic({ state: { $x: null } })).toBe(true);
  });
  test("naked array in state → true", () => {
    expect(isDynamic({ state: { $items: [1, 2] } })).toBe(true);
  });

  // Shape 2: Expanded signal with default → dynamic
  test("object with default in state → true", () => {
    expect(isDynamic({ state: { $count: { type: "integer", default: 0 } } })).toBe(true);
  });

  // Shape 2b: Pure type def → static
  test("object with only schema keywords (no default) → false", () => {
    expect(isDynamic({ state: { email: { type: "string", format: "email" } } })).toBe(false);
  });

  // Shape 3: Template string in state → dynamic (it's a naked string with ${})
  test("template string in state → true", () => {
    expect(isDynamic({ state: { $label: "${$count.get()} items" } })).toBe(true);
  });

  // Shape 4 & 5: $prototype → dynamic
  test("$prototype in state → true", () => {
    expect(isDynamic({ state: { $r: { $prototype: "Request" } } })).toBe(true);
  });
  test('$prototype: "Function" in state → true', () => {
    expect(isDynamic({ state: { fn: { $prototype: "Function", body: "return 1;" } } })).toBe(true);
  });

  // Plain object in state → dynamic (Signal.State)
  test("plain object in state → true", () => {
    expect(isDynamic({ state: { $cfg: { x: 1, y: 2 } } })).toBe(true);
  });

  // Structural dynamic indicators
  test("$switch on node → true", () => {
    expect(isDynamic({ $switch: { $ref: "#/state/$x" } })).toBe(true);
  });
  test("children.$prototype Array → true", () => {
    expect(isDynamic({ children: { $prototype: "Array" } } as unknown as JxMutableNode)).toBe(true);
  });
  test("$ref in non-reserved property → true", () => {
    expect(
      isDynamic({
        tagName: "span",
        textContent: { $ref: "#/state/$x" },
      } as unknown as JxMutableNode),
    ).toBe(true);
  });

  // Template strings in properties → dynamic
  test("${} template string in textContent property → true", () => {
    expect(isDynamic({ tagName: "span", textContent: "${$count.get()}" })).toBe(true);
  });
  test("${} template string in className property → true", () => {
    expect(isDynamic({ tagName: "div", className: '${$active.get() ? "on" : "off"}' })).toBe(true);
  });

  // Static checks
  test("static property object without $ref → false", () => {
    expect(isDynamic({ tagName: "div", style: { color: "red" } })).toBe(false);
  });
  test("dynamic child in children array → true", () => {
    expect(
      isDynamic({
        tagName: "div",
        children: [{ tagName: "span" }, { tagName: "p", textContent: { $ref: "#/state/$x" } }],
      } as any),
    ).toBe(true);
  });
  test("all-static children array → false", () => {
    expect(
      isDynamic({
        tagName: "ul",
        children: [
          { tagName: "li", textContent: "A" },
          { tagName: "li", textContent: "B" },
        ],
      }),
    ).toBe(false);
  });
  test("empty state (no dynamic entries) → false", () => {
    expect(isDynamic({ state: {} })).toBe(false);
  });
});

// ─── compile — output structure ───────────────────────────────────────────────

describe("compile — output structure", () => {
  test("returns { html, files } with html as a full HTML document string", async () => {
    const { html } = await compile({ tagName: "div", textContent: "hi" });
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<html");
    expect(html).toContain("<head>");
    expect(html).toContain("<body>");
  });

  test("returns files array (empty for static)", async () => {
    const { files } = await compile({ tagName: "div", textContent: "hi" });
    expect(Array.isArray(files)).toBe(true);
    expect(files.length).toBe(0);
  });

  test('default title is "Jx App"', async () => {
    const { html } = await compile({ tagName: "div" });
    expect(html).toContain("<title>Jx App</title>");
  });

  test("custom title is escaped and inserted", async () => {
    const { html } = await compile({ tagName: "div" }, { title: "My <App>" });
    expect(html).toContain("My &lt;App&gt;");
  });
});

// ─── compile — static nodes ───────────────────────────────────────────────────

describe("compile — static nodes", () => {
  test("static node emits plain HTML element", async () => {
    const { html } = await compile({ tagName: "p", textContent: "hello" });
    expect(html).toContain("<p>hello</p>");
  });

  test("id attribute", async () => {
    const { html } = await compile({ tagName: "div", id: "main" });
    expect(html).toContain('id="main"');
  });

  test("className → class attribute", async () => {
    const { html } = await compile({ tagName: "div", className: "box card" });
    expect(html).toContain('class="box card"');
  });

  test("hidden attribute", async () => {
    const { html } = await compile({ tagName: "div", hidden: true });
    expect(html).toContain(" hidden");
  });

  test("tabIndex → tabindex attribute", async () => {
    const { html } = await compile({ tagName: "div", tabIndex: 0 });
    expect(html).toContain('tabindex="0"');
  });

  test("title attribute", async () => {
    const { html } = await compile({ tagName: "div", title: "tip" });
    expect(html).toContain('title="tip"');
  });

  test("lang attribute", async () => {
    const { html } = await compile({ tagName: "div", lang: "fr" });
    expect(html).toContain('lang="fr"');
  });

  test("dir attribute", async () => {
    const { html } = await compile({ tagName: "div", dir: "rtl" });
    expect(html).toContain('dir="rtl"');
  });

  test("inline style from style object", async () => {
    const { html } = await compile({
      tagName: "div",
      style: { backgroundColor: "red", fontSize: "16px" },
    });
    expect(html).toContain("background-color: red");
    expect(html).toContain("font-size: 16px");
  });

  test("style with nested selector excluded from inline", async () => {
    const { html } = await compile({
      tagName: "div",
      style: { color: "blue", ":hover": { color: "red" } },
    });
    const inlineMatch = html.match(/style="([^"]*)"/);
    if (inlineMatch) {
      expect(inlineMatch[1]).not.toContain(":hover");
    }
  });

  test("custom attributes block — string value", async () => {
    const { html } = await compile({ tagName: "div", attributes: { "data-id": "abc" } });
    expect(html).toContain('data-id="abc"');
  });

  test("custom attributes block — number value", async () => {
    const { html } = await compile({ tagName: "div", attributes: { "data-n": 42 } });
    expect(html).toContain('data-n="42"');
  });

  test("custom attributes block — boolean value", async () => {
    const { html } = await compile({ tagName: "div", attributes: { "data-flag": true } });
    expect(html).toContain('data-flag="true"');
  });

  test("textContent escaped", async () => {
    const { html } = await compile({ tagName: "p", textContent: '<b>bold</b> & "quotes"' });
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt; &amp; &quot;quotes&quot;");
  });

  test("innerHTML emitted as trusted raw HTML", async () => {
    const { html } = await compile({ tagName: "div", innerHTML: "<b>raw</b>" });
    expect(html).toContain("<b>raw</b>");
  });

  test("static children rendered recursively", async () => {
    const { html } = await compile({
      tagName: "ul",
      children: [
        { tagName: "li", textContent: "first" },
        { tagName: "li", textContent: "second" },
      ],
    });
    expect(html).toContain("<li>first</li>");
    expect(html).toContain("<li>second</li>");
  });

  test("node with no textContent, innerHTML, or children → empty inner", async () => {
    const { html } = await compile({ tagName: "br" });
    expect(html).toContain("<br></br>");
  });

  test("no dynamic content → no module script", async () => {
    const { html } = await compile({ tagName: "div" });
    expect(html).not.toContain('type="module"');
  });

  test("pure type def state → static output (no custom element)", async () => {
    const { html, files } = await compile({
      tagName: "div",
      state: { email: { type: "string", format: "email" } },
      textContent: "hello",
    });
    expect(files.length).toBe(0);
    expect(html).toContain("hello");
    expect(html).not.toContain("importmap");
  });
});

// ─── compile — dynamic documents ──────────────────────────────────────────────

describe("compile — dynamic documents (standard tagName → client target)", () => {
  test("dynamic root with standard tag emits pre-rendered HTML + JS module", async () => {
    const { html, files } = await compile(
      { tagName: "div", state: { $count: 0 } },
      { title: "My Counter" },
    );
    expect(html).toContain("importmap");
    expect(html).toContain("@vue/reactivity");
    expect(files.length).toBe(1);
    expect(files[0].path).toBe("app.js");
    // Client target: pre-rendered HTML, no custom element tag
    expect(html).not.toContain("<my-counter>");
    // Should have reactive state in JS
    expect(files[0].content).toContain("const state = reactive({");
  });

  test("dynamic root with expanded signal uses client target", async () => {
    const { html, files } = await compile(
      { tagName: "div", state: { $x: { type: "integer", default: 1 } } },
      { title: "My Widget" },
    );
    expect(files.length).toBe(1);
    expect(files[0].path).toBe("app.js");
    expect(html).not.toContain("<my-widget>");
    // JS should extract default value correctly
    expect(files[0].content).toContain("$x: 1,");
  });

  test("fully static doc has no module files and no importmap", async () => {
    const { html, files } = await compile({ tagName: "div", textContent: "static" });
    expect(files.length).toBe(0);
    expect(html).not.toContain("importmap");
    expect(html).not.toContain('type="module"');
  });

  test("static parent with dynamic child: routes to client target", async () => {
    const { html, files } = await compile({
      tagName: "main",
      children: [
        { tagName: "p", textContent: "static" },
        { tagName: "span", state: { $v: 0 } },
      ],
    });
    // isDynamic detects the dynamic child → client target
    expect(files.length).toBe(1);
    expect(html).toContain("importmap");
    expect(html).not.toContain("<jx-app>");
  });

  test("${} template string in property makes node dynamic → client target", async () => {
    const { html, files } = await compile({
      tagName: "main",
      children: [
        { tagName: "p", textContent: "static" },
        { tagName: "span", textContent: "${$count.get()}" },
      ],
    });
    // Dynamic child → client target
    expect(files.length).toBe(1);
    expect(html).toContain("importmap");
    expect(html).not.toContain("<jx-app>");
  });

  test("no hydration island markers in output", async () => {
    const { html } = await compile({
      tagName: "div",
      state: { $count: 0 },
    });
    expect(html).not.toContain("data-jx-island");
    expect(html).not.toContain("application/jx+json");
  });
});

describe("compile — dynamic documents (custom element tagName → element target)", () => {
  test("hyphenated tagName routes to element target", async () => {
    const { html, files } = await compile({ tagName: "my-counter", state: { count: 0 } });
    expect(html).toContain("importmap");
    expect(html).toContain("@vue/reactivity");
    expect(html).toContain("lit-html");
    expect(files.length).toBe(1);
    expect((files[0] as { tagName?: string }).tagName).toBe("my-counter");
    expect(html).toContain("<my-counter></my-counter>");
    expect(html).toContain('src="./my-counter.js"');
  });

  test("custom element module contains class definition", async () => {
    const { files } = await compile({
      tagName: "my-widget",
      state: { x: { type: "integer", default: 1 } },
    });
    expect(files.length).toBe(1);
    expect(files[0].content).toContain("class MyWidget extends HTMLElement");
    expect(files[0].content).toContain("customElements.define('my-widget'");
  });
});

// ─── compile — CSS extraction ─────────────────────────────────────────────────

describe("compile — CSS extraction", () => {
  test("nested :selector extracted to <style> block", async () => {
    const { html } = await compile({
      tagName: "button",
      id: "btn",
      style: { color: "blue", ":hover": { color: "red" } },
    });
    expect(html).toContain("<style>");
    expect(html).toContain("#btn:hover");
    expect(html).toContain("color: red");
  });

  test(".class selector in style", async () => {
    const { html } = await compile({
      tagName: "div",
      className: "card hero",
      style: { ".inner": { padding: "1rem" } },
    });
    expect(html).toContain(".card.inner");
  });

  test("&.compound selector in style", async () => {
    const { html } = await compile({
      tagName: "div",
      id: "root",
      style: { "&.active": { outline: "2px solid blue" } },
    });
    expect(html).toContain("#root.active");
  });

  test("[attr] selector in style", async () => {
    const { html } = await compile({
      tagName: "input",
      id: "inp",
      style: { "[disabled]": { opacity: "0.5" } },
    });
    expect(html).toContain("#inp[disabled]");
  });

  test("node with no id or className gets auto-scoped class", async () => {
    const { html } = await compile({
      tagName: "nav",
      style: { ":first-child": { fontWeight: "bold" } },
    });
    expect(html).toContain('class="jx-0"');
    expect(html).toContain(".jx-0:first-child");
  });

  test("flat styles emitted as CSS rules in <style> block", async () => {
    const { html } = await compile({ tagName: "div", style: { color: "red" } });
    expect(html).toContain("<style>");
    expect(html).toContain("color: red");
  });

  test("nested styles in child nodes collected", async () => {
    const { html } = await compile({
      tagName: "div",
      children: [
        { tagName: "p", id: "para", style: { ":hover": { textDecoration: "underline" } } },
      ],
    });
    expect(html).toContain("#para:hover");
    expect(html).toContain("text-decoration: underline");
  });

  test("nested selector inside media block", async () => {
    const { html } = await compile({
      tagName: "div",
      id: "box",
      $media: { "--md": "(min-width: 768px)" },
      style: {
        "@--md": { fontSize: "2rem", ":hover": { color: "blue" } },
      },
    });
    expect(html).toContain("@media (min-width: 768px)");
    expect(html).toContain("font-size: 2rem");
    expect(html).toContain("#box:hover");
    expect(html).toContain("color: blue");
  });
});

describe("compile — Class route ($prototype: 'Class')", () => {
  test("routes $prototype: Class to compileClassJson", async () => {
    const classDef = {
      $prototype: "Class",
      title: "Counter",
      $defs: {
        fields: {
          count: {
            role: "field",
            access: "public",
            scope: "instance",
            identifier: "count",
            default: 0,
          },
        },
        methods: {
          increment: { role: "method", identifier: "increment", body: "this.count++;" },
        },
      },
    };
    const { html, files } = await compile(classDef);
    expect(html).toBe("");
    expect(files.length).toBe(1);
    expect(files[0].path).toContain("Counter.js");
    expect(files[0].content).toContain("class Counter");
    expect(files[0].content).toContain("increment");
  });

  test("Class route uses source path for output when given string path", async () => {
    const { writeFileSync, mkdirSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const fixDir = join(import.meta.dir, "_fixtures_class");
    mkdirSync(fixDir, { recursive: true });
    const classPath = join(fixDir, "Widget.class.json");
    writeFileSync(
      classPath,
      JSON.stringify({
        $prototype: "Class",
        title: "Widget",
        $defs: {
          fields: {
            active: {
              role: "field",
              access: "public",
              scope: "instance",
              identifier: "active",
              default: false,
            },
          },
        },
      }),
    );
    try {
      const { html, files } = await compile(classPath);
      expect(html).toBe("");
      expect(files[0].path).toContain("Widget.js");
      expect(files[0].content).toContain("class Widget");
    } finally {
      rmSync(fixDir, { recursive: true, force: true });
    }
  });
});

// ─── compile — file-based input ─────────────────────────────────────────────

describe("compile — file-based input", () => {
  test("reads and compiles JSON file by path", async () => {
    const { writeFileSync, mkdirSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const fixDir = join(import.meta.dir, "_fixtures_file");
    mkdirSync(fixDir, { recursive: true });
    const filePath = join(fixDir, "page.json");
    writeFileSync(filePath, JSON.stringify({ tagName: "div", textContent: "from file" }));
    try {
      const { html } = await compile(filePath);
      expect(html).toContain("from file");
    } finally {
      rmSync(fixDir, { recursive: true, force: true });
    }
  });
});

// ─── compile — markdown file input ───────────────────────────────────────────

describe("compile — markdown file input", () => {
  test("reads and compiles .md file by path", async () => {
    const { writeFileSync, mkdirSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const fixDir = join(import.meta.dir, "_fixtures_md");
    mkdirSync(fixDir, { recursive: true });
    const filePath = join(fixDir, "page.md");
    writeFileSync(filePath, "# Hello World\n\nSome paragraph text.\n");
    try {
      const { html } = await compile(filePath);
      expect(html).toContain("Hello World");
    } finally {
      rmSync(fixDir, { recursive: true, force: true });
    }
  });
});

// ─── compile — CLI (runCli) ──────────────────────────────────────────────────

describe("runCli", () => {
  test("writes output file when given output path", async () => {
    const { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const fixDir = join(import.meta.dir, "_fixtures_cli");
    mkdirSync(fixDir, { recursive: true });
    const srcPath = join(fixDir, "page.json");
    const outPath = join(fixDir, "output.html");
    writeFileSync(srcPath, JSON.stringify({ tagName: "div", textContent: "cli test" }));
    try {
      await runCli(srcPath, outPath);
      expect(existsSync(outPath)).toBe(true);
      const content = readFileSync(outPath, "utf8");
      expect(content).toContain("cli test");
    } finally {
      rmSync(fixDir, { recursive: true, force: true });
    }
  });

  test("writes to stdout when no output path given", async () => {
    const { writeFileSync, mkdirSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const fixDir = join(import.meta.dir, "_fixtures_cli2");
    mkdirSync(fixDir, { recursive: true });
    const srcPath = join(fixDir, "page.json");
    writeFileSync(srcPath, JSON.stringify({ tagName: "p", textContent: "stdout output" }));
    const writeSpy = spyOn(process.stdout, "write");
    try {
      await runCli(srcPath);
      const output = writeSpy.mock.calls.map((c) => c[0]).join("");
      expect(output).toContain("stdout output");
    } finally {
      writeSpy.mockRestore();
      rmSync(fixDir, { recursive: true, force: true });
    }
  });

  test("writes module files alongside output for dynamic docs", async () => {
    const { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const fixDir = join(import.meta.dir, "_fixtures_cli3");
    mkdirSync(fixDir, { recursive: true });
    const srcPath = join(fixDir, "app.json");
    const outPath = join(fixDir, "index.html");
    writeFileSync(
      srcPath,
      JSON.stringify({ tagName: "div", state: { $count: 0 }, textContent: "dynamic" }),
    );
    try {
      await runCli(srcPath, outPath);
      expect(existsSync(outPath)).toBe(true);
      expect(existsSync(join(fixDir, "app.js"))).toBe(true);
      const moduleContent = readFileSync(join(fixDir, "app.js"), "utf8");
      expect(moduleContent).toContain("reactive");
    } finally {
      rmSync(fixDir, { recursive: true, force: true });
    }
  });

  test("writes server handler file when server entries exist", async () => {
    const { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const fixDir = join(import.meta.dir, "_fixtures_cli4");
    mkdirSync(fixDir, { recursive: true });
    const srcPath = join(fixDir, "app.json");
    const outPath = join(fixDir, "index.html");
    const handlerPath = join(fixDir, "handler.js");
    writeFileSync(
      handlerPath,
      "export function saveData(ctx) { return ctx.json({ ok: true }); }\n",
    );
    writeFileSync(
      srcPath,
      JSON.stringify({
        tagName: "div",
        state: {
          $save: {
            timing: "server",
            $src: "./handler.js",
            $export: "saveData",
          },
        },
      }),
    );
    try {
      await runCli(srcPath, outPath);
      const serverPath = join(fixDir, "index-server.js");
      expect(existsSync(serverPath)).toBe(true);
      const serverContent = readFileSync(serverPath, "utf8");
      expect(serverContent).toContain("saveData");
    } finally {
      rmSync(fixDir, { recursive: true, force: true });
    }
  });

  test("rejects on invalid input", async () => {
    const { writeFileSync, mkdirSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const fixDir = join(import.meta.dir, "_fixtures_cli5");
    mkdirSync(fixDir, { recursive: true });
    const srcPath = join(fixDir, "bad.json");
    writeFileSync(srcPath, "not valid json {{{");
    try {
      await expect(runCli(srcPath)).rejects.toThrow();
    } finally {
      rmSync(fixDir, { recursive: true, force: true });
    }
  });
});

// ─── escapeHtml (exercised via compile) ───────────────────────────────────────

describe("escapeHtml — via compile output", () => {
  test("& escaped", async () => {
    const { html } = await compile({ tagName: "p", textContent: "a & b" });
    expect(html).toContain("a &amp; b");
  });
  test("< escaped", async () => {
    const { html } = await compile({ tagName: "p", textContent: "a < b" });
    expect(html).toContain("a &lt; b");
  });
  test("> escaped", async () => {
    const { html } = await compile({ tagName: "p", textContent: "a > b" });
    expect(html).toContain("a &gt; b");
  });
  test('" escaped in title', async () => {
    const { html } = await compile({ tagName: "p" }, { title: 'say "hi"' });
    expect(html).toContain("say &quot;hi&quot;");
  });
  test("' escaped in title", async () => {
    const { html } = await compile({ tagName: "p" }, { title: "it's fine" });
    expect(html).toContain("it&#39;s fine");
  });
});
