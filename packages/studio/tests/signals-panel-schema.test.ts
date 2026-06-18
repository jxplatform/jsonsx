/**
 * Signals panel — plugin schema-driven forms: renderSchemaFieldsTemplate (enum/boolean/number/
 * json-schema/array-of-objects/json controls, contentType $ref enums) and
 * renderExternalPrototypeEditorTemplate (source/prototype fields, schema cache, async loading).
 */
import {
  flush,
  installMockPlatform,
  pointer,
  resetStudioState,
  resetWorkspaceWithTab,
} from "./harness";
import { beforeEach, describe, expect, test } from "bun:test";
import { html, render } from "lit-html";
import { activeTab } from "../src/workspace/workspace";
import {
  renderExternalPrototypeEditorTemplate,
  renderSchemaFieldsTemplate,
} from "../src/panels/signals-panel";
import { pluginSchemaCache } from "../src/services/code-services";
import type { JxMutableNode } from "@jxsuite/schema/types";

type ValueEl = HTMLElement & { value: string };

function commitValue(el: Element, value: string): void {
  (el as ValueEl).value = value;
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function inputValue(el: Element, value: string): void {
  (el as ValueEl).value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function pluginDef(): Record<string, unknown> {
  const tab = activeTab.value;
  if (!tab) {
    throw new Error("no active tab");
  }
  return (tab.doc.document.state as Record<string, Record<string, unknown>>).plugin as Record<
    string,
    unknown
  >;
}

/** Open a tab whose state holds a single `plugin` def and render schema fields for it. */
function mountSchema(
  schema: Record<string, unknown> | null,
  def: Record<string, unknown>,
  ctx: { renderLeftPanel: () => void } | null = null,
): HTMLElement {
  resetWorkspaceWithTab({
    children: [],
    state: { plugin: def },
    tagName: "div",
  } as unknown as JxMutableNode);
  const container = document.createElement("div");
  const tab = activeTab.value;
  if (!tab) {
    throw new Error("no active tab");
  }
  const S = { document: tab.doc.document } as never;
  render(
    html`${renderSchemaFieldsTemplate(
      schema as never,
      pluginDef() as never,
      "plugin",
      S,
      ctx as never,
    )}`,
    container,
  );
  return container;
}

function fieldEl<T extends Element>(scope: HTMLElement, prop: string, selector: string): T {
  const row = scope.querySelector(`[data-prop="${prop}"]`);
  if (!row) {
    throw new Error(`no field row ${prop}`);
  }
  const el = row.querySelector(selector);
  if (!el) {
    throw new Error(`no ${selector} in row ${prop}`);
  }
  return el as T;
}

beforeEach(() => {
  resetStudioState();
  installMockPlatform();
  pluginSchemaCache.clear();
});

// ─── renderSchemaFieldsTemplate basics ───────────────────────────────────────

describe("renderSchemaFieldsTemplate basics", () => {
  test("no schema or missing properties → renders nothing", () => {
    expect(mountSchema(null, {}).children).toHaveLength(0);
    expect(mountSchema({ type: "object" }, {}).children).toHaveLength(0);
  });

  test("studio-reserved keys are skipped", () => {
    const container = mountSchema(
      {
        properties: {
          $export: { type: "string" },
          $prototype: { type: "string" },
          $src: { type: "string" },
          body: { type: "string" },
          source: { type: "string" },
          timing: { type: "string" },
        },
      },
      {},
    );
    expect(container.querySelectorAll(".style-row")).toHaveLength(1);
    expect(container.querySelector('[data-prop="source"]')).not.toBeNull();
  });

  test("required props get a * suffix and skip the none option in enums", () => {
    const container = mountSchema(
      {
        properties: {
          kind: { enum: ["a", "b"] },
          title: { type: "string" },
        },
        required: ["kind", "title"],
      },
      {},
    );
    expect(container.querySelector('[data-prop="title"] sp-field-label')?.textContent).toBe(
      "title *",
    );
    const noneItems = [...container.querySelectorAll('[data-prop="kind"] sp-menu-item')].filter(
      (el) => el.getAttribute("value") === "__none__",
    );
    expect(noneItems).toHaveLength(0);
  });

  test("string field commits after debounce and clears to undefined", async () => {
    const container = mountSchema(
      { properties: { empty: { type: "string" }, source: { type: "string" } } },
      { empty: "remove-me" },
    );
    inputValue(fieldEl(container, "source", "sp-textfield"), "posts");
    inputValue(fieldEl(container, "empty", "sp-textfield"), "");
    await new Promise((r) => {
      setTimeout(r, 460);
    });
    expect((pluginDef() as { source: string }).source).toBe("posts");
    expect((pluginDef() as { empty?: string }).empty).toBeUndefined();
  });

  test("string field placeholder comes from default, falling back to examples", () => {
    const container = mountSchema(
      {
        properties: {
          a: { default: "dflt", type: "string" },
          b: { examples: ["ex1"], type: "string" },
          c: { type: "string" },
        },
      },
      {},
    );
    expect(fieldEl(container, "a", "sp-textfield").getAttribute("placeholder")).toBe("dflt");
    expect(fieldEl(container, "b", "sp-textfield").getAttribute("placeholder")).toBe("ex1");
  });
});

// ─── Enums (including contentType refs) ──────────────────────────────────────

describe("schema enums", () => {
  test("plain enum renders a picker that commits values and clears via —", () => {
    const container = mountSchema(
      { properties: { layout: { enum: ["grid", "list"] } } },
      { layout: "grid" },
    );
    const picker = fieldEl<ValueEl>(container, "layout", "sp-picker");
    expect(picker.getAttribute("value")).toBe("grid");
    const values = [...container.querySelectorAll('[data-prop="layout"] sp-menu-item')].map((el) =>
      el.getAttribute("value"),
    );
    expect(values).toEqual(["__none__", "grid", "list"]);

    commitValue(picker, "list");
    expect((pluginDef() as { layout: string }).layout).toBe("list");

    commitValue(picker, "__none__");
    expect((pluginDef() as { layout?: string }).layout).toBeUndefined();
  });

  test("picker shows schema default when no value is set", () => {
    const container = mountSchema(
      { properties: { mode: { default: "auto", enum: ["auto", "manual"] } } },
      {},
    );
    expect(fieldEl<ValueEl>(container, "mode", "sp-picker").getAttribute("value")).toBe("auto");
  });

  test("$ref #/$context/contentTypes resolves project content type keys", () => {
    resetStudioState({
      projectConfig: { contentTypes: { page: {}, post: {} } },
    });
    const container = mountSchema(
      { properties: { type: { enum: { $ref: "#/$context/contentTypes" } } } },
      {},
    );
    const values = [...container.querySelectorAll('[data-prop="type"] sp-menu-item')].map((el) =>
      el.getAttribute("value"),
    );
    expect(values).toEqual(["__none__", "page", "post"]);
  });

  test("legacy $contentTypes sentinel resolves the same keys", () => {
    resetStudioState({ projectConfig: { contentTypes: { doc: {} } } });
    const container = mountSchema({ properties: { type: { enum: "$contentTypes" } } }, {});
    const values = [...container.querySelectorAll('[data-prop="type"] sp-menu-item')].map((el) =>
      el.getAttribute("value"),
    );
    expect(values).toEqual(["__none__", "doc"]);
  });

  test("dependent {@param} ref resolves properties of the selected content type", () => {
    resetStudioState({
      projectConfig: {
        contentTypes: {
          post: { schema: { properties: { date: {}, title: {} } } },
        },
      },
    });
    const container = mountSchema(
      {
        properties: {
          field: { enum: { $ref: "#/$context/contentTypes/{@type}/schema/properties" } },
        },
      },
      { type: "post" },
    );
    const values = [...container.querySelectorAll('[data-prop="field"] sp-menu-item')].map((el) =>
      el.getAttribute("value"),
    );
    expect(values).toEqual(["__none__", "date", "title"]);
  });

  test("dependent ref without a selected param falls back to a text field", () => {
    resetStudioState({
      projectConfig: { contentTypes: { post: { schema: { properties: { title: {} } } } } },
    });
    const container = mountSchema(
      {
        properties: {
          field: { enum: { $ref: "#/$context/contentTypes/{@type}/schema/properties" } },
        },
      },
      {},
    );
    expect(container.querySelector('[data-prop="field"] sp-picker')).toBeNull();
    expect(container.querySelector('[data-prop="field"] sp-textfield')).not.toBeNull();
  });

  test("unresolvable enum shapes fall back to a text field", () => {
    const container = mountSchema(
      {
        properties: {
          a: { enum: { $ref: "#/other/path" } },
          b: { enum: {} },
        },
      },
      {},
    );
    expect(container.querySelector('[data-prop="a"] sp-textfield')).not.toBeNull();
    expect(container.querySelector('[data-prop="b"] sp-textfield')).not.toBeNull();
  });
});

// ─── Boolean / number / JSON controls ────────────────────────────────────────

describe("schema typed controls", () => {
  test("boolean renders a checkbox that commits checked state", () => {
    const container = mountSchema({ properties: { live: { type: "boolean" } } }, {});
    const check = fieldEl<HTMLElement & { checked: boolean }>(container, "live", "sp-checkbox");
    check.checked = true;
    check.dispatchEvent(new Event("change", { bubbles: true }));
    expect((pluginDef() as { live: boolean }).live).toBe(true);
  });

  test("integer and number fields parse after debounce; blank clears", async () => {
    const container = mountSchema(
      {
        properties: {
          limit: { maximum: 100, minimum: 1, type: "integer" },
          old: { type: "integer" },
          ratio: { type: "number" },
        },
      },
      { old: 3 },
    );
    commitValue(fieldEl(container, "limit", "sp-number-field"), "7");
    commitValue(fieldEl(container, "ratio", "sp-number-field"), "2.5");
    commitValue(fieldEl(container, "old", "sp-number-field"), "");
    await new Promise((r) => {
      setTimeout(r, 460);
    });
    expect((pluginDef() as { limit: number }).limit).toBe(7);
    expect((pluginDef() as { ratio: number }).ratio).toBe(2.5);
    expect((pluginDef() as { old?: number }).old).toBeUndefined();
  });

  test("array/object props render a JSON textfield committing parsed values", async () => {
    const container = mountSchema(
      {
        properties: {
          bad: { type: "object" },
          tags: { type: "array" },
        },
      },
      { bad: { keep: true } },
    );
    inputValue(fieldEl(container, "tags", "sp-textfield"), '["a","b"]');
    inputValue(fieldEl(container, "bad", "sp-textfield"), "{nope");
    await new Promise((r) => {
      setTimeout(r, 560);
    });
    expect((pluginDef() as { tags: string[] }).tags).toEqual(["a", "b"]);
    // Invalid JSON is ignored
    expect((pluginDef() as { bad: unknown }).bad).toEqual({ keep: true } as never);
  });

  test("json-schema format shows property chips and commits parsed JSON", async () => {
    const container = mountSchema(
      { properties: { shape: { format: "json-schema", type: "object" } } },
      { shape: { properties: { count: { type: "number" }, name: {} }, type: "object" } },
    );
    const chips = [...container.querySelectorAll(".schema-param-editor span")].map((el) =>
      el.textContent?.trim(),
    );
    expect(chips).toContain("count: number");
    expect(chips).toContain("name: any");

    inputValue(
      fieldEl(container, "shape", "sp-textfield"),
      '{"type":"object","properties":{"x":{"type":"string"}}}',
    );
    await new Promise((r) => {
      setTimeout(r, 560);
    });
    expect(
      (pluginDef() as { shape: { properties: Record<string, unknown> } }).shape.properties,
    ).toEqual({ x: { type: "string" } } as never);
  });

  test("json-schema format with a $ref value hides chips; invalid input is ignored", async () => {
    const container = mountSchema(
      { properties: { shape: { format: "json-schema", type: "object" } } },
      { shape: { $ref: "#/defs/thing" } },
    );
    const chips = [...container.querySelectorAll(".schema-param-editor span")];
    expect(chips).toHaveLength(0);

    inputValue(fieldEl(container, "shape", "sp-textfield"), "{broken");
    await new Promise((r) => {
      setTimeout(r, 560);
    });
    expect((pluginDef() as { shape: unknown }).shape).toEqual({ $ref: "#/defs/thing" } as never);
  });
});

// ─── Array-of-objects rows ────────────────────────────────────────────────────

describe("array-of-objects fields", () => {
  const columnsSchema = {
    properties: {
      columns: {
        items: {
          properties: {
            align: { enum: ["left", "right"] },
            label: { default: "col", type: "string" },
            ratio: { type: "number" },
            visible: { type: "boolean" },
            width: { type: "integer" },
          },
          type: "object",
        },
        type: "array",
      },
    },
  };

  test("renders one row per entry with typed inline controls", () => {
    const container = mountSchema(columnsSchema, {
      columns: [{ align: "left", label: "a", ratio: 0.5, visible: true, width: 2 }],
    });
    const row = container.querySelector(".array-object-row") as HTMLElement;
    expect(row).not.toBeNull();
    expect(row.querySelector("sp-picker")).not.toBeNull();
    expect(row.querySelector("sp-switch")).not.toBeNull();
    expect(row.querySelectorAll("sp-number-field")).toHaveLength(2);
    expect(row.querySelector("sp-textfield")).not.toBeNull();
  });

  test("inline text/switch/number/enum edits update the row in place", () => {
    const def = {
      columns: [{ align: "left", label: "a", visible: true, width: 2 }],
    };
    let container = mountSchema(columnsSchema, def);
    const row = () => container.querySelector(".array-object-row") as HTMLElement;
    const cols = () => (pluginDef() as { columns: never[] }).columns;
    // Remount with a plain clone — the tab document is a reactive proxy, which structuredClone
    // Cannot handle, so JSON round-trip instead.
    const remount = () => {
      container = mountSchema(columnsSchema, {
        // oxlint-disable-next-line unicorn/prefer-structured-clone
        columns: JSON.parse(JSON.stringify(cols())),
      });
    };

    inputValue(row().querySelector("sp-textfield") as Element, "renamed");
    expect((cols()[0]! as { label: string }).label).toBe("renamed");

    remount();
    const sw = row().querySelector("sp-switch") as HTMLElement & { checked: boolean };
    sw.checked = false;
    sw.dispatchEvent(new Event("change", { bubbles: true }));
    expect((cols()[0]! as { visible: boolean }).visible).toBe(false);

    remount();
    commitValue(row().querySelectorAll("sp-number-field")[1] as Element, "5");
    expect((cols()[0]! as { width: number }).width).toBe(5);

    remount();
    commitValue(row().querySelectorAll("sp-number-field")[0] as Element, "1.5");
    expect((cols()[0]! as { ratio: number }).ratio).toBe(1.5);

    remount();
    commitValue(row().querySelectorAll("sp-number-field")[1] as Element, "");
    expect((cols()[0]! as { width?: number }).width).toBeUndefined();

    remount();
    commitValue(row().querySelector("sp-picker") as Element, "right");
    expect((cols()[0]! as { align: string }).align).toBe("right");

    remount();
    commitValue(row().querySelector("sp-picker") as Element, "__none__");
    expect((cols()[0]! as { align?: string }).align).toBeUndefined();
  });

  test("add button appends a row seeded with item defaults and notifies ctx", () => {
    let renders = 0;
    const container = mountSchema(
      columnsSchema,
      {},
      {
        renderLeftPanel: () => {
          renders += 1;
        },
      },
    );
    const add = [...container.querySelectorAll("sp-action-button")].find(
      (el) => el.textContent?.trim() === "+ Add",
    );
    pointer(add as Element, "click");
    expect((pluginDef() as { columns: never[] }).columns).toEqual([{ label: "col" }] as never[]);
    expect(renders).toBe(1);
  });

  test("delete removes a row, clearing the key for the last one (null ctx ok)", () => {
    let container = mountSchema(columnsSchema, {
      columns: [{ label: "a" }, { label: "b" }],
    });
    const delButtons = () =>
      [...container.querySelectorAll(".array-object-row sp-action-button")] as Element[];
    pointer(delButtons()[0] as Element, "click");
    expect((pluginDef() as { columns: never[] }).columns).toEqual([{ label: "b" }] as never[]);

    container = mountSchema(columnsSchema, {
      columns: [{ label: "only" }],
    });
    pointer(delButtons()[0] as Element, "click");
    expect((pluginDef() as { columns?: unknown }).columns).toBeUndefined();
  });

  test("inline enum with dependent contentType ref resolves against the row's parent def", () => {
    resetStudioState({
      projectConfig: {
        contentTypes: { post: { schema: { properties: { slug: {}, title: {} } } } },
      },
    });
    const schema = {
      properties: {
        fields: {
          items: {
            properties: {
              name: { enum: { $ref: "#/$context/contentTypes/{@type}/schema/properties" } },
            },
            type: "object",
          },
          type: "array",
        },
      },
    };
    const container = mountSchema(schema, { fields: [{}], type: "post" });
    const values = [...container.querySelectorAll(".array-object-row sp-menu-item")].map((el) =>
      el.getAttribute("value"),
    );
    expect(values).toEqual(["__none__", "slug", "title"]);
  });
});

// ─── renderExternalPrototypeEditorTemplate ───────────────────────────────────

interface ExternalMount {
  container: HTMLElement;
  calls: { left: number };
  rerender: () => void;
}

function mountExternal(
  def: Record<string, unknown>,
  opts: { documentPath?: string } = {},
): ExternalMount {
  resetWorkspaceWithTab({
    children: [],
    state: { plugin: def },
    tagName: "div",
  } as unknown as JxMutableNode);
  const container = document.createElement("div");
  const calls = { left: 0 };
  const tab = activeTab.value;
  if (!tab) {
    throw new Error("no active tab");
  }
  const S = {
    document: tab.doc.document,
    ...(opts.documentPath != null && { documentPath: opts.documentPath }),
  } as never;
  const ctx = {
    renderCanvas: () => {},
    renderLeftPanel: () => {
      calls.left += 1;
      render(
        html`${renderExternalPrototypeEditorTemplate(S, "plugin", pluginDef() as never, ctx)}`,
        container,
      );
    },
    updateSession: () => {},
  };
  const rerender = () =>
    render(
      html`${renderExternalPrototypeEditorTemplate(S, "plugin", pluginDef() as never, ctx)}`,
      container,
    );
  rerender();
  return { calls, container, rerender };
}

describe("renderExternalPrototypeEditorTemplate", () => {
  test("shows Source/Prototype fields when the prototype is not imported", () => {
    const m = mountExternal({ $prototype: "Widget", $src: "./w.js" });
    expect(m.container.querySelector('[data-prop="Source"]')).not.toBeNull();
    expect(m.container.querySelector('[data-prop="Prototype"]')).not.toBeNull();
    expect(m.container.querySelector('[data-prop="Export"]')).toBeNull();
  });

  test("Source/Prototype commits update the def and invalidate the schema cache", () => {
    pluginSchemaCache.set("./w.js::Widget", null);
    pluginSchemaCache.set("./new.js::Widget", { properties: {} });
    const m = mountExternal({ $prototype: "Widget", $src: "./w.js" });
    commitValue(fieldEl(m.container, "Source", "sp-textfield"), "./new.js");
    expect((pluginDef() as { $src: string }).$src).toBe("./new.js");
    expect(pluginSchemaCache.has("./new.js::Widget")).toBe(false);

    pluginSchemaCache.set("./new.js::Gadget", { properties: {} });
    m.rerender();
    commitValue(fieldEl(m.container, "Prototype", "sp-textfield"), "Gadget");
    expect((pluginDef() as { $prototype: string }).$prototype).toBe("Gadget");
    expect(pluginSchemaCache.has("./new.js::Gadget")).toBe(false);
  });

  test("Export field appears when $export is set and commits changes", () => {
    pluginSchemaCache.set("./w.js::Widget", null);
    const m = mountExternal({ $export: "make", $prototype: "Widget", $src: "./w.js" });
    commitValue(fieldEl(m.container, "Export", "sp-textfield"), "build");
    expect((pluginDef() as { $export: string }).$export).toBe("build");
  });

  test("imported prototypes show a hint instead of Source/Prototype fields", () => {
    resetStudioState({ projectConfig: { imports: { Widget: "./plugins/widget.js" } } });
    pluginSchemaCache.set("./plugins/widget.js::Widget", null);
    const m = mountExternal({ $prototype: "Widget" });
    expect(m.container.querySelector('[data-prop="Source"]')).toBeNull();
    expect(m.container.querySelector(".signal-hint")?.textContent?.trim()).toBe("Widget");
  });

  test("cached schema renders its description and config fields", () => {
    pluginSchemaCache.set("./w.js::Widget", {
      description: "A fine widget",
      properties: { color: { type: "string" } },
    });
    const m = mountExternal({ $prototype: "Widget", $src: "./w.js" });
    expect(m.container.textContent).toContain("A fine widget");
    expect(m.container.querySelector('[data-prop="color"] sp-textfield')).not.toBeNull();
  });

  test("cached null schema renders no config section", () => {
    pluginSchemaCache.set("./w.js::Widget", null);
    const m = mountExternal({ $prototype: "Widget", $src: "./w.js" });
    expect(m.container.textContent).not.toContain("Loading schema");
    expect(m.container.querySelectorAll(".style-row")).toHaveLength(2); // Source + Prototype only
  });

  test("uncached schema shows a loading hint, fetches, then re-renders the panel", async () => {
    installMockPlatform({
      fetchPluginSchema: async () => ({ properties: { size: { type: "integer" } } }),
    });
    const m = mountExternal(
      { $prototype: "Widget", $src: "./w.js" },
      { documentPath: "pages/index.json" },
    );
    expect(m.container.textContent).toContain("Loading schema…");
    await flush();
    expect(m.calls.left).toBe(1);
    expect(pluginSchemaCache.get("./w.js::Widget")).toEqual({
      properties: { size: { type: "integer" } },
    });
    expect(m.container.querySelector('[data-prop="size"] sp-number-field')).not.toBeNull();
  });

  test("fetch resolving to null leaves the panel without a schema section", async () => {
    const m = mountExternal({ $prototype: "Widget", $src: "./w.js" });
    expect(m.container.textContent).toContain("Loading schema…");
    await flush();
    expect(m.calls.left).toBe(0);
    expect(pluginSchemaCache.get("./w.js::Widget")).toBeNull();
    m.rerender();
    expect(m.container.textContent).not.toContain("Loading schema");
  });

  test("def without $prototype renders the plain Source/Prototype fields and no schema", () => {
    const m = mountExternal({ $src: "./w.js" });
    expect(m.container.querySelector('[data-prop="Source"]')).not.toBeNull();
    expect(m.container.textContent).not.toContain("Loading schema");
  });
});
