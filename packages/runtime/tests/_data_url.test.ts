import { GlobalRegistrator } from "@happy-dom/global-registrator";

import { describe, test, expect, mock } from "bun:test";
import { buildScope, Jx } from "../src/runtime";

try {
  GlobalRegistrator.register();
} catch {}

const wait = () =>
  new Promise((r) => {
    setTimeout(r, 0);
  });
const BASE = "http://localhost/";

describe("buildScope", () => {
  test("loads $src Function and resolves export", async () => {
    const dataUrl = "data:text/javascript,export function myFn(state) { return 42; }";
    const state = await buildScope(
      {
        state: {
          myFn: { $prototype: "Function", $src: dataUrl },
        },
      },
      {},
      BASE,
    );
    expect(state.myFn).toBe(42);
  });
});

describe("Jx", () => {
  test("calls onMount if present in scope via $src", async () => {
    const target = document.createElement("div");
    const srcUrl = new URL("_test_handlers.js", import.meta.url).href;
    await Jx(
      {
        state: {
          onMount: { $prototype: "Function", $src: srcUrl },
        },
        tagName: "div",
      },
      target,
    );
    await wait();
    expect((globalThis as any)._testMounted).toBe(true);
    delete (globalThis as any)._testMounted;
  });

  test("fetches string source", async () => {
    const doc = { tagName: "article" };
    global.fetch = mock(() =>
      Promise.resolve({
        json: () => Promise.resolve(doc),
        ok: true,
      }),
    ) as any;
    const target = document.createElement("div");
    await Jx("http://example.com/test.json", target);
    expect(target.children[0]!.tagName.toLowerCase()).toBe("article");
  });
});
