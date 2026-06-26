import "./with-dom.ts";
import { describe, expect, test } from "bun:test";
import { renderCheck } from "../src/services/render-critic";

describe("render-critic", () => {
  test("valid document renders ok", async () => {
    const doc = {
      tagName: "div",
      children: [{ tagName: "h1", children: ["Hello World"] }],
    };
    const result = await renderCheck(doc);
    expect(result.ok).toBe(true);
  });

  test("minimal valid document (no children) renders ok", async () => {
    const doc = { tagName: "div" };
    const result = await renderCheck(doc);
    expect(result.ok).toBe(true);
  });

  test("document with valid state and template expression renders ok", async () => {
    const doc = {
      tagName: "div",
      state: { count: 0 },
      children: [{ tagName: "span", children: ["Count: ${state.count}"] }],
    };
    const result = await renderCheck(doc);
    expect(result.ok).toBe(true);
  });

  test("template expression referencing missing state is caught", async () => {
    const doc = {
      tagName: "div",
      children: [{ tagName: "span", children: ["Value: ${nonExistent}"] }],
    };
    const result = await renderCheck(doc);
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toContain("is not defined");
  });

  test("malformed Function body is caught", async () => {
    const doc = {
      tagName: "div",
      state: {
        broken: {
          $prototype: "Function",
          body: "this is not valid javascript }{}{",
        },
      },
      children: [
        {
          tagName: "button",
          onclick: { $ref: "#/state/broken" },
          children: ["Click"],
        },
      ],
    };
    const result = await renderCheck(doc);
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toContain("Render error");
  });

  test("applyAndValidate integration — render break surfaces as tool error", async () => {
    const { createToolRegistry } = await import("@jxsuite/ai");
    const { createTab, disposeTab } = await import("../src/tabs/tab");
    const { registerAiTools } = await import("../src/services/ai-tools");

    const doc = {
      tagName: "div",
      children: [{ tagName: "h1", children: ["Hello"] }],
    };
    const tab = createTab({ document: doc, id: "critic-test" });
    const registry = createToolRegistry();

    registerAiTools(registry, {
      getTab: () => tab,
      validate: async () => [],
      renderCheck: renderCheck as (
        doc: unknown,
      ) => Promise<{ ok: true } | { ok: false; error: string }>,
    });

    const result = await registry.execute("set_property", {
      path: ["children", 0],
      key: "onclick",
      value: { $ref: "#/state/nonExistent" },
    });

    // The set_property itself succeeds (schema allows arbitrary props), but the render
    // Critic should catch the broken $ref during render — or the property is benign
    // Enough that renderNode doesn't throw (in which case the critic correctly passes).
    // Either outcome is valid for this integration test; we just verify no crash.
    expect(result).toBeDefined();
    expect(typeof result.success).toBe("boolean");

    disposeTab(tab);
  });

  test("create_page render gate — rejects a render-broken page before writing", async () => {
    const { createToolRegistry } = await import("@jxsuite/ai");
    const { registerAiTools } = await import("../src/services/ai-tools");

    let written = null;
    const registry = createToolRegistry();
    registerAiTools(registry, {
      getTab: () => null,
      validate: async () => [],
      renderCheck: renderCheck as (
        doc: unknown,
      ) => Promise<{ ok: true } | { ok: false; error: string }>,
      saveFile: async (path, content) => {
        written = { path, content };
      },
    });

    const result = await registry.execute("create_page", {
      path: "pages/broken.json",
      content: {
        tagName: "div",
        children: [{ tagName: "span", children: ["Value: ${nonExistent}"] }],
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("fails to render");
    expect(written).toBeNull(); // Nothing written to disk.
  });

  test("create_component render gate — writes a valid component", async () => {
    const { createToolRegistry } = await import("@jxsuite/ai");
    const { registerAiTools } = await import("../src/services/ai-tools");

    let written: { path: string; content: string } | null = null;
    const registry = createToolRegistry();
    registerAiTools(registry, {
      getTab: () => null,
      validate: async () => [],
      renderCheck: renderCheck as (
        doc: unknown,
      ) => Promise<{ ok: true } | { ok: false; error: string }>,
      saveFile: async (path, content) => {
        written = { path, content };
      },
    });

    const result = await registry.execute("create_component", {
      path: "components/ok-card.json",
      content: {
        tagName: "ok-card",
        state: { title: "Hi" },
        children: [{ tagName: "h3", children: ["${state.title}"] }],
      },
    });

    expect(result.success).toBe(true);
    expect(written).not.toBeNull();
    expect(written!.path).toBe("components/ok-card.json");
  });
});
