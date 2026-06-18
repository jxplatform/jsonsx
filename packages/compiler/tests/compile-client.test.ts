import { describe, expect, test } from "bun:test";
import { compileClient } from "../src/targets/compile-client";
import type { JxDocument } from "@jxsuite/schema/types";

/** Cast a test fixture to a document — fixtures intentionally use partial shapes. */
const asDoc = (d: unknown) => d as JxDocument;

describe("compileClient", () => {
  test("compiles counter example to pre-rendered HTML with bindings", () => {
    const counter = {
      children: [
        {
          style: { color: "#333", fontSize: "1.5rem" },
          tagName: "h1",
          textContent: { $ref: "#/state/label" },
        },
        {
          style: { fontSize: "3rem", fontWeight: "bold" },
          tagName: "p",
          textContent: "${state.count}",
        },
        {
          children: [
            {
              onclick: { $ref: "#/state/decrement" },
              tagName: "button",
              textContent: "\u2212",
            },
            {
              onclick: { $ref: "#/state/increment" },
              tagName: "button",
              textContent: "+",
            },
            {
              onclick: { $ref: "#/state/reset" },
              tagName: "button",
              textContent: "Reset",
            },
          ],
          style: { display: "flex", gap: "0.5rem" },
          tagName: "div",
        },
      ],
      state: {
        count: {
          default: 0,
          description: "Current counter value",
          type: "integer",
        },
        decrement: {
          $prototype: "Function",
          body: "state.count = Math.max(0, state.count - 1)",
        },
        increment: { $prototype: "Function", body: "state.count++" },
        label: {
          $prototype: "Function",
          body: "const c = state.count; return c > 0 ? 'Clicked ' + c + ' time' + (c === 1 ? '' : 's') : 'Click me!';",
        },
        reset: { $prototype: "Function", body: "state.count = 0" },
      },
      style: { display: "block", fontFamily: "system-ui, sans-serif" },
      tagName: "div",
    };

    const result = compileClient(asDoc(counter), {
      reactivitySrc: "https://esm.sh/@vue/reactivity@3.5.32",
      title: "Counter",
    });

    // Should produce HTML and one JS file
    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.path).toBe("app.js");

    // HTML should contain data-bind markers
    expect(result.html).toContain("data-bind");
    expect(result.html).toContain(":text-content=");
    expect(result.html).toContain("@click=");

    // HTML should contain pre-rendered static content
    expect(result.html).toContain("<h1");
    expect(result.html).toContain("<button");

    // HTML should NOT contain custom element registration
    expect(result.html).not.toContain("customElements.define");

    // JS module should have reactive state, bind, on
    const js = result.files[0]!.content;
    expect(js).toContain("const state = reactive({");
    expect(js).toContain("count: 0,");
    expect(js).toContain("const bind = {");
    expect(js).toContain("const on = {");
    expect(js).toContain("hydrate(document)");

    // Should NOT contain the whole expanded signal object
    expect(js).not.toContain('"type":"integer"');
  });

  test("extracts default from expanded signals", () => {
    const doc = {
      children: [{ tagName: "span", textContent: "${state.name}" }],
      state: {
        name: {
          default: "World",
          description: "Name to greet",
          type: "string",
        },
      },
      tagName: "div",
    };

    const result = compileClient(asDoc(doc), { title: "Test" });
    const js = result.files[0]!.content;

    // Should use "World" as the default, not the full object
    expect(js).toContain('name: "World"');
    expect(js).not.toContain('"type":"string"');
  });

  test("handles $ref textContent correctly", () => {
    const doc = {
      children: [{ tagName: "h1", textContent: { $ref: "#/state/label" } }],
      state: {
        label: {
          $prototype: "Function",
          body: "return 'Hello';",
        },
      },
      tagName: "div",
    };

    const result = compileClient(asDoc(doc), { title: "Test" });

    // H1 should have data-bind and :textContent binding
    expect(result.html).toContain("data-bind");
    expect(result.html).toContain(':text-content="label"');
    // Should NOT contain [object Object]
    expect(result.html).not.toContain("[object Object]");
  });

  test("handles event handlers with $ref", () => {
    const doc = {
      children: [
        {
          onclick: { $ref: "#/state/doSomething" },
          tagName: "button",
          textContent: "Click",
        },
      ],
      state: {
        doSomething: { $prototype: "Function", body: "console.log('clicked')" },
      },
      tagName: "div",
    };

    const result = compileClient(asDoc(doc), { title: "Test" });

    expect(result.html).toContain('@click="doSomething"');
    expect(result.html).toContain("data-bind");
  });

  test("handles inline event handlers", () => {
    const doc = {
      children: [
        {
          onclick: { $prototype: "Function", body: "state.count++" },
          tagName: "button",
          textContent: "+",
        },
      ],
      state: { count: 0 },
      tagName: "div",
    };

    const result = compileClient(asDoc(doc), { title: "Test" });

    // Should create an anonymous handler in the `on` object
    expect(result.html).toContain("data-bind");
    expect(result.html).toContain("@click=");
    const js = result.files[0]!.content;
    expect(js).toContain("state.count++");
  });

  test("handles dynamic style properties", () => {
    const doc = {
      children: [
        {
          style: { color: "${state.color}", fontSize: "1rem" },
          tagName: "span",
          textContent: "Hello",
        },
      ],
      state: { color: "red" },
      tagName: "div",
    };

    const result = compileClient(asDoc(doc), { title: "Test" });

    // Static style should be inline
    expect(result.html).toContain("font-size: 1rem");
    // Dynamic style should be a binding
    expect(result.html).toContain(":style.color=");
    expect(result.html).toContain("data-bind");
  });

  test("skips schema-only type defs", () => {
    const doc = {
      children: [{ tagName: "span", textContent: "${state.count}" }],
      state: {
        count: 0,
        nameType: { maxLength: 100, minLength: 1, type: "string" },
      },
      tagName: "div",
    };

    const result = compileClient(asDoc(doc), { title: "Test" });
    const js = result.files[0]!.content;

    // Should skip nameType (schema-only), include count
    expect(js).toContain("count: 0");
    expect(js).not.toContain("nameType");
  });

  test("static node without dynamic values has no data-bind", () => {
    const doc = {
      children: [
        { tagName: "p", textContent: "Static text" },
        { tagName: "span", textContent: "${state.count}" },
      ],
      state: { count: 0 },
      tagName: "div",
    };

    const result = compileClient(asDoc(doc), { title: "Test" });

    // The <p> should NOT have data-bind (it's fully static)
    expect(result.html).toContain("<p>Static text</p>");
    // The <span> should have data-bind
    expect(result.html).toMatch(/<span[^>]*data-bind/);
  });
});

// ─── Additional coverage: prototypes and bindings ──────────────────────────────

describe("compileClient — prototypes", () => {
  test("LocalStorage generates localStorage init with key and default", () => {
    const doc = {
      children: [],
      state: {
        prefs: {
          $prototype: "LocalStorage",
          default: { theme: "dark" },
          key: "user-prefs",
        },
      },
      tagName: "div",
    };
    const { files } = compileClient(asDoc(doc), { title: "Test" });
    const js = files[0]!.content;
    expect(js).toContain("localStorage");
    expect(js).toContain("user-prefs");
    expect(js).toContain("JSON.parse");
    expect(js).toContain("effect(");
  });

  test("SessionStorage generates sessionStorage init", () => {
    const doc = {
      children: [],
      state: { token: { $prototype: "SessionStorage", key: "auth-token" } },
      tagName: "div",
    };
    const { files } = compileClient(asDoc(doc), { title: "Test" });
    const js = files[0]!.content;
    expect(js).toContain("sessionStorage");
    expect(js).toContain("auth-token");
  });

  test("Request with headers and body generates fetch options", () => {
    const doc = {
      children: [],
      state: {
        data: {
          $prototype: "Request",
          body: { action: "save" },
          headers: { "Content-Type": "application/json" },
          method: "POST",
          url: "/api/submit",
        },
      },
      tagName: "div",
    };
    const { files } = compileClient(asDoc(doc), { title: "Test" });
    const js = files[0]!.content;
    expect(js).toContain("method:");
    expect(js).toContain("POST");
    expect(js).toContain("headers:");
    expect(js).toContain("body:");
  });

  test("Request with template URL checks for undefined", () => {
    const doc = {
      children: [],
      state: {
        id: 1,
        user: { $prototype: "Request", url: "/api/${state.id}" },
      },
      tagName: "div",
    };
    const { files } = compileClient(asDoc(doc), { title: "Test" });
    const js = files[0]!.content;
    expect(js).toContain("undefined");
    expect(js).toContain("const url = `");
  });

  test("Cookie generates document.cookie read and parse", () => {
    const doc = {
      children: [],
      state: {
        session: { $prototype: "Cookie", default: "anon", name: "sid" },
      },
      tagName: "div",
    };
    const { files } = compileClient(asDoc(doc), { title: "Test" });
    const js = files[0]!.content;
    expect(js).toContain("document.cookie");
    expect(js).toContain("sid");
    expect(js).toContain("decodeURIComponent");
  });

  test("manual Request emits only a comment", () => {
    const doc = {
      children: [],
      state: { data: { $prototype: "Request", manual: true, url: "/api" } },
      tagName: "div",
    };
    const { files } = compileClient(asDoc(doc), { title: "Test" });
    const js = files[0]!.content;
    expect(js).toContain("manual Request");
    expect(js).not.toContain("fetch(url");
  });
});

describe("compileClient — mapped arrays", () => {
  test("generates lit-html imports for mapped arrays", () => {
    const doc = {
      children: [
        {
          children: {
            $prototype: "Array",
            items: { $ref: "#/state/items" },
            map: { tagName: "li", textContent: "${$map.item.name}" },
          },
          tagName: "ul",
        },
      ],
      state: { items: [{ name: "A" }] },
      tagName: "div",
    };
    const { files } = compileClient(asDoc(doc), { title: "Test" });
    const js = files[0]!.content;
    expect(js).toContain("import { html, render } from 'lit-html'");
    expect(js).toContain(".map((item, index)");
  });

  test("mapped array as a member among sibling children (wrapper-less)", () => {
    const doc = {
      children: [
        {
          children: [
            { tagName: "li", textContent: "header" },
            {
              $prototype: "Array",
              items: { $ref: "#/state/items" },
              map: { tagName: "li", textContent: "${$map.item.name}" },
            },
            { tagName: "li", textContent: "footer" },
          ],
          tagName: "ul",
        },
      ],
      state: { items: [{ name: "A" }] },
      tagName: "div",
    };
    const { files, html } = compileClient(asDoc(doc), { title: "Test" });
    const js = files[0]!.content;
    // Whole children region rendered via one lit binding on the <ul>, no extra wrapper element.
    expect(js).toContain("import { html, render } from 'lit-html'");
    expect(js).toContain(".map((item, index)");
    expect(js).toContain("header");
    expect(js).toContain("footer");
    // The <ul> itself carries the render binding — no extra wrapper element is introduced.
    expect(html).toContain('<ul data-bind :render="_children0"></ul>');
  });

  test("two mapped arrays as siblings under one parent", () => {
    const doc = {
      children: [
        {
          children: [
            { $prototype: "Array", items: { $ref: "#/state/a" }, map: { tagName: "i" } },
            { $prototype: "Array", items: { $ref: "#/state/b" }, map: { tagName: "b" } },
          ],
          tagName: "div",
        },
      ],
      state: { a: [], b: [] },
      tagName: "div",
    };
    const { files } = compileClient(asDoc(doc), { title: "Test" });
    const js = files[0]!.content;
    // Both arrays live in a single lit children binding (one part per parent — no collision).
    expect(js.match(/\.map\(\(item, index\)/g)?.length).toBe(2);
  });

  test("mapped array with static items array", () => {
    const doc = {
      children: [
        {
          children: {
            $prototype: "Array",
            items: ["one", "two"],
            map: { tagName: "li", textContent: "${$map.item}" },
          },
          tagName: "ul",
        },
      ],
      tagName: "div",
    };
    const { files } = compileClient(asDoc(doc), { title: "Test" });
    const js = files[0]!.content;
    expect(js).toContain('["one","two"]');
  });

  test("mapped array with nested children in map template", () => {
    const doc = {
      children: [
        {
          children: {
            $prototype: "Array",
            items: { $ref: "#/state/todos" },
            map: {
              children: [
                { tagName: "span", textContent: "${$map.item.text}" },
                { tagName: "button", textContent: "X" },
              ],
              tagName: "div",
            },
          },
          tagName: "div",
        },
      ],
      state: { todos: [] },
      tagName: "div",
    };
    const { files } = compileClient(asDoc(doc), { title: "Test" });
    const js = files[0]!.content;
    expect(js).toContain("<span>");
    expect(js).toContain("<button>");
  });

  test("mapped array with style in map template", () => {
    const doc = {
      children: [
        {
          children: {
            $prototype: "Array",
            items: { $ref: "#/state/items" },
            map: {
              style: { color: "red", fontWeight: "bold" },
              tagName: "div",
              textContent: "${$map.item}",
            },
          },
          tagName: "div",
        },
      ],
      state: { items: [] },
      tagName: "div",
    };
    const { files } = compileClient(asDoc(doc), { title: "Test" });
    const js = files[0]!.content;
    expect(js).toContain("color: red");
    expect(js).toContain("font-weight: bold");
  });
});

describe("compileClient — $ref bindings and attributes", () => {
  test("$ref attribute creates :attr binding", () => {
    const doc = {
      children: [
        {
          attributes: { href: { $ref: "#/state/link" } },
          tagName: "a",
          textContent: "Home",
        },
      ],
      state: { link: "/home" },
      tagName: "div",
    };
    const { html, files } = compileClient(asDoc(doc), { title: "Test" });
    expect(html).toContain(':attr.href="link"');
    expect(files[0]!.content).toContain("() => state.link");
  });

  test("template attribute creates :attr binding", () => {
    const doc = {
      children: [
        {
          attributes: { href: "/item/${state.id}" },
          tagName: "a",
          textContent: "View",
        },
      ],
      state: { id: 5 },
      tagName: "div",
    };
    const { html } = compileClient(asDoc(doc), { title: "Test" });
    expect(html).toContain(":attr.href=");
    expect(html).toContain("data-bind");
  });

  test("$ref on non-reserved prop creates property binding", () => {
    const doc = {
      children: [{ tagName: "input", value: { $ref: "#/state/val" } }],
      state: { val: "hello" },
      tagName: "div",
    };
    const { html } = compileClient(asDoc(doc), { title: "Test" });
    expect(html).toContain(':value="val"');
  });

  test("template on non-reserved prop creates property binding", () => {
    const doc = {
      children: [{ tagName: "div", title: "Position: ${state.x}" }],
      state: { x: 10 },
      tagName: "div",
    };
    const { html } = compileClient(asDoc(doc), { title: "Test" });
    expect(html).toContain(":title=");
  });

  test("nested $ref path uses underscore-delimited key", () => {
    const doc = {
      children: [{ tagName: "span", textContent: { $ref: "#/state/user/name" } }],
      state: { user: { name: "Alice" } },
      tagName: "div",
    };
    const { html, files } = compileClient(asDoc(doc), { title: "Test" });
    expect(html).toContain(':text-content="user_name"');
    expect(files[0]!.content).toContain("state.user.name");
  });
});

describe("compileClient — module structure", () => {
  test("Function with $src generates import statement", () => {
    const doc = {
      children: [],
      state: {
        compute: { $prototype: "Function", $src: "./helpers.js" },
        transform: { $prototype: "Function", $src: "./helpers.js" },
      },
      tagName: "div",
    };
    const { files } = compileClient(asDoc(doc), { title: "Test" });
    const js = files[0]!.content;
    expect(js).toContain("import { compute, transform } from './helpers.js'");
  });

  test("includes computed import when computed entries present", () => {
    const doc = {
      children: [],
      state: {
        count: 0,
        doubled: { $prototype: "Function", body: "return state.count * 2;" },
      },
      tagName: "div",
    };
    const { files } = compileClient(asDoc(doc), { title: "Test" });
    const js = files[0]!.content;
    expect(js).toContain("import { reactive, effect, computed }");
  });

  test("hydrate includes render branch when lit-html is used", () => {
    const doc = {
      children: [
        {
          children: {
            $prototype: "Array",
            items: { $ref: "#/state/items" },
            map: { tagName: "li", textContent: "${$map.item}" },
          },
          tagName: "ul",
        },
      ],
      state: { items: [] },
      tagName: "div",
    };
    const { files } = compileClient(asDoc(doc), { title: "Test" });
    const js = files[0]!.content;
    expect(js).toContain("'render'");
    expect(js).toContain("render(bind[key](), el)");
  });

  test("custom modulePath reflected in output", () => {
    const doc = { children: [], tagName: "div" };
    const { html, files } = compileClient(asDoc(doc), {
      modulePath: "scripts/main.js",
      title: "Test",
    });
    expect(html).toContain('src="./scripts/main.js"');
    expect(files[0]!.path).toBe("scripts/main.js");
  });

  test("null/undefined children are handled gracefully", () => {
    const doc = { children: [null, undefined, "text"], tagName: "div" };
    const { html } = compileClient(asDoc(doc), { title: "Test" });
    expect(html).toContain("text");
  });

  test("self-closing tags in mapped array", () => {
    const doc = {
      children: [
        {
          children: {
            $prototype: "Array",
            items: { $ref: "#/state/images" },
            map: { tagName: "img" },
          },
          tagName: "div",
        },
      ],
      state: { images: [] },
      tagName: "div",
    };
    const { files } = compileClient(asDoc(doc), { title: "Test" });
    const js = files[0]!.content;
    expect(js).toContain("<img>");
  });

  test("primitive number child node renders as text", () => {
    const doc = { children: [42], tagName: "div" };
    const { html } = compileClient(asDoc(doc), { title: "Test" });
    expect(html).toContain("42");
  });

  test("primitive boolean child node renders as text", () => {
    const doc = { children: [true], tagName: "div" };
    const { html } = compileClient(asDoc(doc), { title: "Test" });
    expect(html).toContain("true");
  });
});

describe("compileClient — template string state entries", () => {
  test("naked template string in state becomes computed", () => {
    const doc = {
      children: [{ tagName: "span", textContent: "${state.$label}" }],
      state: { $count: 5, $label: "${$count} items" },
      tagName: "div",
    };
    const { files } = compileClient(asDoc(doc), { title: "Test" });
    const js = files[0]!.content;
    // Should be a computed, not a plain state entry
    expect(js).toContain("computed(");
    expect(js).toContain("$label");
  });
});

describe("compileClient — innerHTML and textContent edge cases", () => {
  test("innerHTML property in pre-rendered node", () => {
    const doc = {
      children: [{ innerHTML: "<b>bold</b>", tagName: "div" }],
      state: {},
      tagName: "div",
    };
    const { html } = compileClient(asDoc(doc), { title: "Test" });
    expect(html).toContain("<b>bold</b>");
  });

  test("textContent resolution fallback on dynamic content with binding", () => {
    // A node that has textContent as a template AND a $ref handler → needsBind=true
    // And textContent resolution may throw for unresolvable refs
    const doc = {
      children: [
        {
          onclick: { $ref: "#/state/handler" },
          tagName: "span",
          textContent: "${state.nonexistent.deep.path}",
        },
      ],
      state: {
        handler: { $prototype: "Function", body: "console.log('hi')" },
      },
      tagName: "div",
    };
    const { html } = compileClient(asDoc(doc), { title: "Test" });
    // Should still render the span (with empty inner content on throw)
    expect(html).toContain("<span");
  });
});

describe("compileClient — mapped array advanced features", () => {
  test("self-closing input tag in mapped array", () => {
    const doc = {
      children: [
        {
          children: {
            $prototype: "Array",
            items: { $ref: "#/state/fields" },
            map: { tagName: "input" },
          },
          tagName: "div",
        },
      ],
      state: { fields: [] },
      tagName: "div",
    };
    const { files } = compileClient(asDoc(doc), { title: "Test" });
    const js = files[0]!.content;
    expect(js).toContain("<input");
    // Self-closing should NOT have </input>
    expect(js).not.toContain("</input>");
  });

  test("attributes in map template (static and dynamic)", () => {
    const doc = {
      children: [
        {
          children: {
            $prototype: "Array",
            items: { $ref: "#/state/items" },
            map: {
              attributes: { "data-x": "static", "data-y": "${$map.item.id}" },
              tagName: "li",
              textContent: "${$map.item.name}",
            },
          },
          tagName: "ul",
        },
      ],
      state: { items: [] },
      tagName: "div",
    };
    const { files } = compileClient(asDoc(doc), { title: "Test" });
    const js = files[0]!.content;
    expect(js).toContain('data-x="static"');
    expect(js).toContain("data-y=");
    expect(js).toContain("item.id");
  });

  test("dynamic style value (template string) in map template", () => {
    const doc = {
      children: [
        {
          children: {
            $prototype: "Array",
            items: { $ref: "#/state/items" },
            map: {
              style: { color: "${$map.item.color}", fontSize: "14px" },
              tagName: "span",
              textContent: "${$map.item.text}",
            },
          },
          tagName: "div",
        },
      ],
      state: { items: [] },
      tagName: "div",
    };
    const { files } = compileClient(asDoc(doc), { title: "Test" });
    const js = files[0]!.content;
    expect(js).toContain("color:");
    expect(js).toContain("item.color");
    expect(js).toContain("font-size: 14px");
  });

  test("event handler with $ref in map template", () => {
    const doc = {
      children: [
        {
          children: {
            $prototype: "Array",
            items: { $ref: "#/state/items" },
            map: {
              onclick: { $ref: "#/state/$handler" },
              tagName: "button",
              textContent: "${$map.item.label}",
            },
          },
          tagName: "div",
        },
      ],
      state: {
        $handler: { $prototype: "Function", body: "console.log('clicked')" },
        items: [],
      },
      tagName: "div",
    };
    const { files } = compileClient(asDoc(doc), { title: "Test" });
    const js = files[0]!.content;
    expect(js).toContain("@click=");
    expect(js).toContain("on.$handler");
  });

  test("event handler with Function $prototype in map template", () => {
    const doc = {
      children: [
        {
          children: {
            $prototype: "Array",
            items: { $ref: "#/state/items" },
            map: {
              onclick: {
                $prototype: "Function",
                body: "items.splice($map.index, 1)",
              },
              tagName: "button",
              textContent: "Delete",
            },
          },
          tagName: "div",
        },
      ],
      state: { items: [] },
      tagName: "div",
    };
    const { files } = compileClient(asDoc(doc), { title: "Test" });
    const js = files[0]!.content;
    expect(js).toContain("@click=");
    expect(js).toContain("items.splice(index, 1)");
  });

  test("contentEditable on mapped array item", () => {
    const doc = {
      children: [
        {
          children: {
            $prototype: "Array",
            items: { $ref: "#/state/items" },
            map: {
              contentEditable: "true",
              tagName: "div",
              textContent: "${$map.item.text}",
            },
          },
          tagName: "div",
        },
      ],
      state: { items: [] },
      tagName: "div",
    };
    const { files } = compileClient(asDoc(doc), { title: "Test" });
    const js = files[0]!.content;
    expect(js).toContain('contenteditable="true"');
  });

  test("textContent as $ref object in map template", () => {
    const doc = {
      children: [
        {
          children: {
            $prototype: "Array",
            items: { $ref: "#/state/items" },
            map: {
              tagName: "span",
              textContent: { $ref: "#/state/label" },
            },
          },
          tagName: "div",
        },
      ],
      state: { items: [], label: "hello" },
      tagName: "div",
    };
    const { files } = compileClient(asDoc(doc), { title: "Test" });
    const js = files[0]!.content;
    expect(js).toContain("state.label");
  });

  test("innerHTML in map template", () => {
    const doc = {
      children: [
        {
          children: {
            $prototype: "Array",
            items: { $ref: "#/state/items" },
            map: {
              innerHTML: "<b>${$map.item.html}</b>",
              tagName: "div",
            },
          },
          tagName: "div",
        },
      ],
      state: { items: [] },
      tagName: "div",
    };
    const { files } = compileClient(asDoc(doc), { title: "Test" });
    const js = files[0]!.content;
    expect(js).toContain("<b>");
    expect(js).toContain("item.html");
  });
});

describe("compileClient — $src function handlers", () => {
  test("$src function is imported and called as computed", () => {
    const doc = {
      children: [
        {
          onclick: { $ref: "#/state/doSomething" },
          tagName: "button",
          textContent: "Go",
        },
      ],
      state: {
        doSomething: { $prototype: "Function", $src: "./actions.js" },
      },
      tagName: "div",
    };
    const { files } = compileClient(asDoc(doc), { title: "Test" });
    const js = files[0]!.content;
    // Should import and have a handler that calls it directly
    expect(js).toContain("import { doSomething } from './actions.js'");
    expect(js).toContain("doSomething(");
  });
});

describe("compileClient — refToBindingKey edge cases", () => {
  test("non-#/state/ prefix ref uses full path with underscores", () => {
    const doc = {
      children: [
        {
          tagName: "span",
          textContent: { $ref: "custom/path/value" },
        },
      ],
      state: { val: "x" },
      tagName: "div",
    };
    const { html } = compileClient(asDoc(doc), { title: "Test" });
    // Should convert slashes to underscores for the non-standard ref
    expect(html).toContain(':text-content="custom_path_value"');
  });
});

describe("compileClient — self-closing element with mapped array", () => {
  test("self-closing tag with mapped array returns void element markup", () => {
    const doc = {
      children: [
        {
          children: {
            $prototype: "Array",
            items: { $ref: "#/state/items" },
            map: { tagName: "span", textContent: "${$map.item.name}" },
          },
          tagName: "input",
        },
      ],
      state: {
        items: { default: [{ name: "a" }], type: "array" },
      },
      tagName: "div",
    };
    const { html } = compileClient(asDoc(doc), { title: "Test" });
    expect(html).toContain("<input");
    expect(html).not.toContain("</input>");
  });
});
