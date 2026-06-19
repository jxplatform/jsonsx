import "./with-dom.js";
import { describe, expect, test } from "bun:test";
import { buildComponentInstance, computeRelativePath } from "../src/files/components";
import type { JxMutableNode } from "@jxsuite/schema/types";

// ─── buildComponentInstance ─────────────────────────────────────────────────

describe("buildComponentInstance", () => {
  test("no props, no slots — bare instance without children key", () => {
    const instance = buildComponentInstance({ tagName: "my-card" });
    expect(instance).toEqual({ $props: {}, tagName: "my-card" });
    expect("children" in instance).toBe(false);
  });

  test("prop defaults fill $props", () => {
    const instance = buildComponentInstance({
      props: [
        { default: "Hello", name: "title" },
        { name: "subtitle" }, // No default → empty string
      ],
      tagName: "my-card",
    });
    expect(instance.$props).toEqual({ subtitle: "", title: "Hello" });
  });

  test("slots without fallback inject no children", () => {
    const instance = buildComponentInstance({
      slots: [{ name: "" }, { name: "header" }],
      tagName: "my-card",
    });
    expect("children" in instance).toBe(false);
  });

  test("default-slot fallback is injected as-is", () => {
    const fallback = [{ tagName: "p", textContent: "Default" }, "loose text"];
    const instance = buildComponentInstance({
      slots: [{ fallback, name: "" }],
      tagName: "my-card",
    });
    expect(instance.children).toEqual(fallback);
  });

  test("named-slot element fallback gets a slot attribute", () => {
    const instance = buildComponentInstance({
      slots: [{ fallback: [{ tagName: "h2", textContent: "Title" }], name: "header" }],
      tagName: "my-card",
    });
    const child = (instance.children as JxMutableNode[])[0]!;
    expect(child.attributes).toEqual({ slot: "header" });
    expect(child.tagName).toBe("h2");
  });

  test("author-set slot attribute on fallback is preserved", () => {
    const instance = buildComponentInstance({
      slots: [
        {
          fallback: [{ attributes: { slot: "forwarded" }, tagName: "div" }],
          name: "header",
        },
      ],
      tagName: "my-card",
    });
    const child = (instance.children as JxMutableNode[])[0]!;
    expect(child.attributes).toEqual({ slot: "forwarded" });
  });

  test("string fallback in a named slot is wrapped in a span", () => {
    const instance = buildComponentInstance({
      slots: [{ fallback: ["Plain text"], name: "header" }],
      tagName: "my-card",
    });
    const child = (instance.children as JxMutableNode[])[0]!;
    expect(child).toEqual({
      attributes: { slot: "header" },
      children: ["Plain text"],
      tagName: "span",
    });
  });

  test("fallback children are cloned, not shared", () => {
    const fallback = [{ tagName: "p", textContent: "Default" }];
    const comp = { slots: [{ fallback, name: "" }], tagName: "my-card" };
    const a = buildComponentInstance(comp);
    const b = buildComponentInstance(comp);
    expect(a.children).not.toBe(b.children);
    expect((a.children as JxMutableNode[])[0]).not.toBe(fallback[0]);
  });

  test("multiple slots combine fallback children in order", () => {
    const instance = buildComponentInstance({
      slots: [
        { fallback: [{ tagName: "h2", textContent: "Title" }], name: "header" },
        { fallback: [{ tagName: "p", textContent: "Body" }], name: "" },
      ],
      tagName: "my-card",
    });
    const children = instance.children as JxMutableNode[];
    expect(children).toHaveLength(2);
    expect(children[0]!.attributes).toEqual({ slot: "header" });
    expect(children[1]!.attributes).toBeUndefined();
  });
});

// ─── computeRelativePath ────────────────────────────────────────────────────

describe("computeRelativePath", () => {
  test("same directory", () => {
    expect(computeRelativePath("pages/index.json", "pages/button.json")).toBe("./button.json");
  });

  test("child directory", () => {
    expect(computeRelativePath("pages/index.json", "pages/components/card.json")).toBe(
      "./components/card.json",
    );
  });

  test("parent directory", () => {
    expect(computeRelativePath("pages/about/index.json", "pages/button.json")).toBe(
      "../button.json",
    );
  });

  test("sibling directory", () => {
    expect(computeRelativePath("pages/about/index.json", "components/card.json")).toBe(
      "../../components/card.json",
    );
  });

  test("deeply nested to root", () => {
    expect(computeRelativePath("pages/a/b/c/index.json", "components/x.json")).toBe(
      "../../../../components/x.json",
    );
  });

  test("null fromDocPath returns ./ prefix", () => {
    expect(computeRelativePath(null, "components/button.json")).toBe("./components/button.json");
  });

  test("empty fromDocPath returns ./ prefix", () => {
    expect(computeRelativePath("", "components/button.json")).toBe("./components/button.json");
  });

  test("handles backslashes (Windows paths)", () => {
    expect(computeRelativePath(String.raw`pages\index.json`, String.raw`pages\button.json`)).toBe(
      "./button.json",
    );
  });

  test("common prefix is computed correctly", () => {
    expect(computeRelativePath("src/pages/home.json", "src/components/nav.json")).toBe(
      "../components/nav.json",
    );
  });
});
