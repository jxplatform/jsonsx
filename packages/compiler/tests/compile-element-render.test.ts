/**
 * Compile-element-render.test.ts — executes a compiled element module in a DOM.
 *
 * Every other element test asserts on emitted source text. This one loads the module for real and
 * drives it, because the four defects it covers were all of the kind that string assertions can
 * miss: an import that fails to link, a computed emitted as a raw function, a dead `$map`
 * reference, and a handler argument bound to the wrong value. Each one throws (or silently renders
 * nothing) at runtime while the emitted text still looks plausible.
 *
 * Happy-dom globals are installed before the module is imported — lit-html captures `document` at
 * import time.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";
import { compileElement } from "../src/targets/compile-element";

const TMP = resolve(import.meta.dir, "__test-element-render__");

/** The element under test exercises issues #106, #107, #108 and #113 at once. */
const DOC = {
  children: [
    { oninput: { $ref: "#/state/onSearch" }, tagName: "input" },
    { id: "term", tagName: "p", textContent: "q=${state.term}" },
    {
      $prototype: "Array",
      items: { $ref: "#/state/rows" },
      map: {
        children: [
          { tagName: "span", textContent: '${$map?.item?.name}#${$map["index"]}' },
          { onclick: { $ref: "#/state/pick" }, tagName: "button", textContent: "pick" },
        ],
        className: "row ${$map.item.kind}",
        tagName: "li",
      },
    },
    { id: "picked", tagName: "p", textContent: "picked=${state.picked}" },
  ],
  state: {
    // #106: $export differs from the key. #107: read in `items`, so it must be a computed.
    onSearch: {
      $prototype: "Function",
      body: "state.term = event.target.value;",
      parameters: ["event"],
    },
    raw: [
      { kind: "x", name: "A", on: true },
      { kind: "y", name: "B", on: false },
    ],
    // Reads the iteration context the way examples/components/todo-app.json does.
    pick: {
      $prototype: "Function",
      body: "state.picked = state.$map.item.name + ':' + state.$map.index",
    },
    picked: "",
    rows: { $export: "getRows", $prototype: "Function", $src: "./lib.js" },
    term: "",
  },
  tagName: "ls-board",
};

let host: Element;
let win: Window;

beforeAll(async () => {
  rmSync(TMP, { force: true, recursive: true });
  mkdirSync(TMP, { recursive: true });

  writeFileSync(
    resolve(TMP, "lib.js"),
    "export function getRows(state) { return (state.raw || []).filter((r) => r.on); }\n",
    "utf8",
  );

  const { files } = await compileElement(DOC as never);
  writeFileSync(resolve(TMP, "el.js"), files[0]!.content, "utf8");

  win = new Window({ url: "https://example.test" });
  const globals = globalThis as Record<string, unknown>;
  const source = win as unknown as Record<string, unknown>;
  for (const key of [
    "window",
    "document",
    "HTMLElement",
    "customElements",
    "Node",
    "Element",
    "Event",
    "CustomEvent",
  ]) {
    globals[key] = source[key];
  }

  // Links the aliased import and registers the element — this is where #106 used to die with
  // `SyntaxError: Export named 'rows' not found`, taking the whole page down with it.
  await import(resolve(TMP, "el.js"));

  win.document.body.innerHTML = "<ls-board></ls-board>";
  host = win.document.querySelector("ls-board") as unknown as Element;
  await new Promise((r) => {
    setTimeout(r, 20);
  });
});

afterAll(() => {
  rmSync(TMP, { force: true, recursive: true });
});

describe("compiled element — runtime behaviour", () => {
  test("the module links its aliased $src import and defines the element", () => {
    expect(host).toBeTruthy();
    expect(host.innerHTML).not.toBe("");
  });

  test("a $src entry read as a value renders its returned array", () => {
    // A raw function here would throw `s.rows.map is not a function` and render nothing.
    const rows = [...host.querySelectorAll("li")];
    expect(rows).toHaveLength(1);
  });

  test("$map reads resolve in class and in a nested child", () => {
    const row = host.querySelector("li");
    expect(row?.getAttribute("class")).toBe("row x");
    expect(row?.querySelector("span")?.textContent).toBe("A#0");
  });

  test("a handler inside a map can read its iteration from state", () => {
    const button = host.querySelector("li button") as unknown as HTMLElement;
    button.dispatchEvent(new win.Event("click", { bubbles: true }) as unknown as Event);

    // `state.$map` was never published by the element target, so this read was undefined and
    // Handlers like todo-app's `toggleItem` silently did nothing.
    expect(host.querySelector("#picked")?.textContent).toBe("picked=A:0");
  });

  test('a handler declaring only ["event"] receives the event and can reach state', () => {
    const input = host.querySelector("input") as unknown as HTMLInputElement;
    input.value = "hello";
    input.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);

    // Proves both halves of #113: `event` was the event (not the state object), and the body's bare
    // `state` resolved instead of throwing ReferenceError.
    expect(host.querySelector("#term")?.textContent).toBe("q=hello");
  });
});

describe("compiled element — $props delivery", () => {
  let propsHost: Element;

  beforeAll(async () => {
    const { files } = await compileElement({
      children: [{ tagName: "h3", textContent: "${state.label}" }],
      state: { label: { default: "DEFAULT" } },
      tagName: "ls-prop-row",
    } as never);
    writeFileSync(resolve(TMP, "prop-row.js"), files[0]!.content, "utf8");
    await import(resolve(TMP, "prop-row.js"));
  });

  test("a literal props.* attribute reaches state and is cleaned up", async () => {
    win.document.body.innerHTML = `<ls-prop-row props.label="FROM-ITEM"></ls-prop-row>`;
    await new Promise((r) => {
      setTimeout(r, 20);
    });
    propsHost = win.document.querySelector("ls-prop-row") as unknown as Element;

    // This is the shape an island map template and a JSON-authored instance both emit. The compiled
    // Element read only `data-jx-props`, so the prop was ignored and the attribute left behind.
    expect(propsHost.textContent?.trim()).toBe("FROM-ITEM");
    expect(propsHost.hasAttribute("props.label")).toBe(false);
  });

  test("a property set before upgrade still wins", async () => {
    win.document.body.innerHTML = "";
    const el = win.document.createElement("ls-prop-row") as unknown as Record<string, unknown> &
      Element;
    el.label = "VIA-PROPERTY";
    win.document.body.append(el as never);
    await new Promise((r) => {
      setTimeout(r, 20);
    });

    // The path a lit `.label=${…}` binding takes when the definition arrives after the render.
    expect(el.textContent?.trim()).toBe("VIA-PROPERTY");
  });

  test("an unknown props.* attribute is left alone", async () => {
    win.document.body.innerHTML = `<ls-prop-row props.nope="x"></ls-prop-row>`;
    await new Promise((r) => {
      setTimeout(r, 20);
    });
    const el = win.document.querySelector("ls-prop-row") as unknown as Element;

    expect(el.hasAttribute("props.nope")).toBe(true);
    expect(el.textContent?.trim()).toBe("DEFAULT");
  });
});

// ── The shipped todo-app example, end to end ─────────────────────────────────

describe("compiled element — examples/components/todo-app.json", () => {
  let app: Element;

  beforeAll(async () => {
    const { files } = await compileElement(
      resolve(import.meta.dir, "../../../examples/components/todo-app.json"),
    );
    writeFileSync(resolve(TMP, "todo-app.js"), files.at(-1)!.content, "utf8");
    await import(resolve(TMP, "todo-app.js"));

    win.document.body.innerHTML = "<todo-app></todo-app>";
    await new Promise((r) => {
      setTimeout(r, 30);
    });
    app = win.document.querySelector("todo-app") as unknown as Element;
  });

  test("renders its seeded items", () => {
    expect(app.querySelectorAll("li")).toHaveLength(2);
  });

  test("its checkbox toggles the row that was clicked", () => {
    const { state } = app as unknown as { state: { items: { done: boolean }[] } };
    expect(state.items.map((i) => i.done)).toEqual([false, false]);

    const boxes = [...app.querySelectorAll("li input[type=checkbox]")];
    boxes[1]!.dispatchEvent(new win.Event("click", { bubbles: true }) as unknown as Event);

    // Two defects met on this one handler: `toggleItem` was classified a computed because its guard
    // Clause contains a bare `return`, and `state.$map` was never published for map handlers. Either
    // One alone left the checkbox doing nothing at all, with nothing thrown.
    expect(state.items.map((i) => i.done)).toEqual([false, true]);
  });
});
