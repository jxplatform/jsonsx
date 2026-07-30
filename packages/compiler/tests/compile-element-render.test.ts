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
        children: [{ tagName: "span", textContent: '${$map?.item?.name}#${$map["index"]}' }],
        className: "row ${$map.item.kind}",
        tagName: "li",
      },
    },
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

  test('a handler declaring only ["event"] receives the event and can reach state', () => {
    const input = host.querySelector("input") as unknown as HTMLInputElement;
    input.value = "hello";
    input.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);

    // Proves both halves of #113: `event` was the event (not the state object), and the body's bare
    // `state` resolved instead of throwing ReferenceError.
    expect(host.querySelector("#term")?.textContent).toBe("q=hello");
  });
});
