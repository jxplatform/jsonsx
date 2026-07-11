/**
 * Tests for src/ui/schema-form.ts — the reusable schema→form engine: control dispatch per
 * type/format/enum, onChange patch semantics, registered-control overrides, inline fields, and enum
 * resolution through a SchemaFormContext (including the real ContentCollection.class.json enum
 * refs).
 */
import { pointer } from "./harness";
import { describe, expect, test } from "bun:test";
import { html, render } from "lit-html";
import {
  getFormControl,
  parseNumericField,
  registerFormControl,
  renderForm,
  renderInlineField,
  resolveFormEnum,
} from "../src/ui/schema-form";
import { resolveContextPointer } from "../src/services/context-resolver";
import contentCollectionClass from "@jxsuite/parser/ContentCollection.class.json";
import type { JsonSchema, SchemaFormContext } from "../src/ui/schema-form";

type ValueEl = HTMLElement & { value: string };

function commitValue(el: Element, value: string): void {
  (el as ValueEl).value = value;
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function inputValue(el: Element, value: string): void {
  (el as ValueEl).value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

const settle = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

interface Mount {
  container: HTMLElement;
  patches: Record<string, unknown>[];
  renders: { count: number };
}

/** Render a form over `value`, recording onChange patches. */
function mountForm(
  schema: JsonSchema,
  value: Record<string, unknown>,
  opts: {
    context?: SchemaFormContext;
    ui?: Record<string, { control?: string; enum?: unknown }>;
    withRerender?: boolean;
  } = {},
): Mount {
  const container = document.createElement("div");
  const patches: Record<string, unknown>[] = [];
  const renders = { count: 0 };
  render(
    html`${renderForm(schema, value, {
      onChange: (patch) => patches.push(patch),
      ...(opts.context && { context: opts.context }),
      ...(opts.ui && { ui: opts.ui }),
      ...(opts.withRerender && {
        rerender: () => {
          renders.count += 1;
        },
      }),
    })}`,
    container,
  );
  return { container, patches, renders };
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

const ctxOver = (projectConfig: Record<string, unknown>): SchemaFormContext => ({
  resolvePointer: (ptr, scope) =>
    resolveContextPointer(ptr, { projectConfig, ...(scope !== undefined && { scope }) }),
});

// ─── parseNumericField / resolveFormEnum ─────────────────────────────────────

describe("parseNumericField", () => {
  test("parses integers, floats, and blank input", () => {
    expect(parseNumericField("7.9", true)).toBe(7);
    expect(parseNumericField("7.9", false)).toBe(7.9);
    expect(Number.isNaN(parseNumericField("  ", true))).toBe(true);
  });
});

describe("resolveFormEnum", () => {
  const ctx = ctxOver({ content: { page: {}, post: {} } });

  test("plain arrays pass through", () => {
    expect(resolveFormEnum(["a", "b"], ctx)).toEqual(["a", "b"]);
  });

  test("$ref objects resolve through the context (object → keys)", () => {
    expect(resolveFormEnum({ $ref: "#/$context/content" }, ctx)).toEqual(["page", "post"]);
  });

  test("string-array resolutions map to strings", () => {
    const listCtx: SchemaFormContext = { resolvePointer: () => ["x", 1] };
    expect(resolveFormEnum({ $ref: "#/$context/anything" }, listCtx)).toEqual(["x", "1"]);
  });

  test("sentinel strings route through the resolver", () => {
    const sentinelCtx: SchemaFormContext = {
      resolvePointer: (ptr) => (ptr === "$contentTypes" ? { doc: {} } : undefined),
    };
    expect(resolveFormEnum("$contentTypes", sentinelCtx)).toEqual(["doc"]);
  });

  test("unresolvable shapes and missing context yield undefined", () => {
    expect(resolveFormEnum({ $ref: "#/$context/nope" }, ctx)).toBeUndefined();
    expect(resolveFormEnum({}, ctx)).toBeUndefined();
    expect(resolveFormEnum({ $ref: 5 }, ctx)).toBeUndefined();
    expect(resolveFormEnum(42, ctx)).toBeUndefined();
    expect(resolveFormEnum("$contentTypes")).toBeUndefined();
  });
});

// ─── Basic dispatch and patch semantics ──────────────────────────────────────

describe("renderForm dispatch", () => {
  test("required props get a * suffix; ps.name overrides the row prop", () => {
    const m = mountForm(
      {
        properties: {
          renamed: { name: "customProp", type: "string" },
          title: { type: "string" },
        },
        required: ["title"],
      },
      {},
    );
    expect(m.container.querySelector('[data-prop="title"] sp-field-label')?.textContent).toBe(
      "title *",
    );
    expect(m.container.querySelector('[data-prop="customProp"]')).not.toBeNull();
  });

  test("string fields commit debounced patches; blank clears to undefined", async () => {
    const m = mountForm(
      { properties: { empty: { type: "string" }, source: { type: "string" } } },
      { empty: "remove-me" },
    );
    inputValue(fieldEl(m.container, "source", "sp-textfield"), "posts");
    inputValue(fieldEl(m.container, "empty", "sp-textfield"), "");
    await settle(460);
    expect(m.patches).toContainEqual({ source: "posts" });
    expect(m.patches).toContainEqual({ empty: undefined });
  });

  test("string placeholder prefers default, falls back to examples", () => {
    const m = mountForm(
      {
        properties: {
          a: { default: "dflt", type: "string" },
          b: { examples: ["ex1"], type: "string" },
        },
      },
      {},
    );
    expect(fieldEl(m.container, "a", "sp-textfield").getAttribute("placeholder")).toBe("dflt");
    expect(fieldEl(m.container, "b", "sp-textfield").getAttribute("placeholder")).toBe("ex1");
  });

  test("enum picker commits values, clears via —, and hides — for required props", () => {
    const m = mountForm(
      {
        properties: {
          kind: { enum: ["x", "y"] },
          layout: { default: "grid", enum: ["grid", "list"] },
        },
        required: ["kind"],
      },
      {},
    );
    const layoutPicker = fieldEl<ValueEl>(m.container, "layout", "sp-picker");
    expect(layoutPicker.getAttribute("value")).toBe("grid");
    commitValue(layoutPicker, "list");
    commitValue(layoutPicker, "__none__");
    expect(m.patches).toEqual([{ layout: "list" }, { layout: undefined }]);

    const noneItems = [...m.container.querySelectorAll('[data-prop="kind"] sp-menu-item')].filter(
      (el) => el.getAttribute("value") === "__none__",
    );
    expect(noneItems).toHaveLength(0);
  });

  test("boolean renders a checkbox committing checked state", () => {
    const m = mountForm({ properties: { live: { type: "boolean" } } }, {});
    const check = fieldEl<HTMLElement & { checked: boolean }>(m.container, "live", "sp-checkbox");
    check.checked = true;
    check.dispatchEvent(new Event("change", { bubbles: true }));
    expect(m.patches).toEqual([{ live: true }]);
  });

  test("integer/number fields parse after debounce; blank clears", async () => {
    const m = mountForm(
      {
        properties: {
          limit: { maximum: 100, minimum: 1, type: "integer" },
          old: { type: "integer" },
          ratio: { type: "number" },
        },
      },
      { old: 3 },
    );
    expect(fieldEl(m.container, "limit", "sp-number-field").getAttribute("min")).toBe("1");
    expect(fieldEl(m.container, "limit", "sp-number-field").getAttribute("max")).toBe("100");
    commitValue(fieldEl(m.container, "limit", "sp-number-field"), "7");
    commitValue(fieldEl(m.container, "ratio", "sp-number-field"), "2.5");
    commitValue(fieldEl(m.container, "old", "sp-number-field"), "");
    await settle(460);
    expect(m.patches).toContainEqual({ limit: 7 });
    expect(m.patches).toContainEqual({ ratio: 2.5 });
    expect(m.patches).toContainEqual({ old: undefined });
  });

  test("array/object props render a JSON textfield committing parsed values only", async () => {
    const m = mountForm(
      { properties: { bad: { type: "object" }, tags: { default: [], type: "array" } } },
      { bad: { keep: true } },
    );
    expect(fieldEl(m.container, "tags", "sp-textfield").getAttribute("placeholder")).toBe("[]");
    inputValue(fieldEl(m.container, "tags", "sp-textfield"), '["a","b"]');
    inputValue(fieldEl(m.container, "bad", "sp-textfield"), "{nope");
    await settle(560);
    expect(m.patches).toEqual([{ tags: ["a", "b"] }]);
  });

  test("json-schema format shows property chips and commits parsed JSON", async () => {
    const m = mountForm(
      { properties: { shape: { format: "json-schema", type: "object" } } },
      { shape: { properties: { count: { type: "number" }, name: {} }, type: "object" } },
    );
    const chips = [...m.container.querySelectorAll(".schema-param-editor span")].map((el) =>
      el.textContent?.trim(),
    );
    expect(chips).toContain("count: number");
    expect(chips).toContain("name: any");

    inputValue(fieldEl(m.container, "shape", "sp-textfield"), '{"type":"object"}');
    await settle(560);
    inputValue(fieldEl(m.container, "shape", "sp-textfield"), "{broken");
    await settle(560);
    // The invalid input is ignored; only the parsed JSON committed
    expect(m.patches).toEqual([{ shape: { type: "object" } }]);
  });

  test("json-schema format with a $ref value keeps the editor and hides chips", () => {
    const m = mountForm(
      { properties: { shape: { format: "json-schema", type: "object" } } },
      { shape: { $ref: "#/defs/thing" } },
    );
    expect(m.container.querySelector('[data-prop="shape"] .schema-param-editor')).not.toBeNull();
    expect(m.container.querySelectorAll(".schema-param-editor span")).toHaveLength(0);
  });
});

// ─── $ref bindings ───────────────────────────────────────────────────────────

describe("$ref binding dispatch", () => {
  const schema: JsonSchema = { properties: { id: { type: "string" } } };

  test("without a registered binding control, a plain ref textfield edits the $ref", () => {
    const m = mountForm(schema, { id: { $ref: "#/$params/sku" } });
    const tf = fieldEl<ValueEl>(m.container, "id", "sp-textfield");
    expect(tf.value).toBe("#/$params/sku");
    commitValue(tf, "#/other/path");
    commitValue(tf, "  ");
    expect(m.patches).toEqual([{ id: { $ref: "#/other/path" } }, { id: undefined }]);
  });

  test("a registered binding control takes over $ref values", () => {
    registerFormControl(
      "binding",
      ({ key, value, ctx }) =>
        html`<div class="stub-binding" data-key=${key} data-prefix=${ctx.fieldKeyPrefix ?? ""}>
          ${(value as { $ref: string }).$ref} ${(ctx.params ?? []).join(",")}
        </div>`,
    );
    const m = mountForm(
      schema,
      { id: { $ref: "#/$params/sku" } },
      {
        context: {
          fieldKeyPrefix: "cfg",
          params: ["sku"],
          resolvePointer: () => {
            // No context data in this test
          },
        },
      },
    );
    const stub = m.container.querySelector(".stub-binding") as HTMLElement | null;
    expect(stub).not.toBeNull();
    expect(stub?.dataset.key).toBe("id");
    expect(stub?.dataset.prefix).toBe("cfg");
    expect(stub?.textContent).toContain("#/$params/sku");
    expect(stub?.textContent).toContain("sku");
  });

  test("bind button appears with route params and commits the first param ref", () => {
    const m = mountForm(
      schema,
      { id: "abc" },
      {
        context: {
          params: ["sku", "lang"],
          resolvePointer: () => {
            // No context data in this test
          },
        },
        withRerender: true,
      },
    );
    const btn = fieldEl(m.container, "id", "sp-action-button");
    pointer(btn, "click");
    expect(m.patches).toEqual([{ id: { $ref: "#/$params/sku" } }]);
    expect(m.renders.count).toBe(1);
  });

  test("no bind button without params", () => {
    const m = mountForm(schema, { id: "abc" });
    expect(m.container.querySelector('[data-prop="id"] sp-action-button')).toBeNull();
  });
});

// ─── ui overrides and the control registry ──────────────────────────────────

describe("control registry and ui overrides", () => {
  test("registered controls are retrievable and win via ui overrides", () => {
    registerFormControl(
      "stub-control",
      ({ key, value, onChange }) =>
        html`<button class="stub-control" @click=${() => onChange(`${String(value)}!`)}>
          ${key}
        </button>`,
    );
    expect(getFormControl("stub-control")).toBeDefined();
    expect(getFormControl("never-registered")).toBeUndefined();

    const m = mountForm(
      { properties: { field: { type: "string" } } },
      { field: "v" },
      { ui: { field: { control: "stub-control" } } },
    );
    const stub = m.container.querySelector(".stub-control");
    expect(stub).not.toBeNull();
    pointer(stub!, "click");
    expect(m.patches).toEqual([{ field: "v!" }]);
  });

  test("unknown ui overrides fall through to the default control", () => {
    const m = mountForm(
      { properties: { field: { type: "boolean" } } },
      {},
      { ui: { field: { control: "never-registered" } } },
    );
    expect(m.container.querySelector('[data-prop="field"] sp-checkbox')).not.toBeNull();
  });

  test("ui enum overrides layer dynamic $context choices over a plain string field", () => {
    // The connector's Data section declares `connection: { type: "string" }` in its fragment
    // (valid JSON Schema) and adds choices via $studio.settings.entry.ui — the descriptor path.
    const m = mountForm(
      { properties: { connection: { type: "string" } } },
      {},
      {
        context: ctxOver({
          connections: { main: { provider: "d1" }, replica: { provider: "sqlite" } },
        }),
        ui: { connection: { enum: { $ref: "#/$context/connections" } } },
      },
    );
    const picker = m.container.querySelector('[data-prop="connection"] sp-picker');
    expect(picker).not.toBeNull();
    const items = [...picker!.querySelectorAll("sp-menu-item")].map((i) => i.getAttribute("value"));
    expect(items).toEqual(["__none__", "main", "replica"]);
    commitValue(picker!, "replica");
    expect(m.patches).toEqual([{ connection: "replica" }]);
  });
});

// ─── Array-of-objects rows ───────────────────────────────────────────────────

describe("array-of-objects fields", () => {
  const columnsSchema: JsonSchema = {
    properties: {
      columns: {
        items: {
          properties: {
            align: { enum: ["left", "right"] },
            label: { default: "col", type: "string" },
            visible: { type: "boolean" },
            width: { type: "integer" },
          },
          type: "object",
        },
        type: "array",
      },
    },
  };

  test("renders typed inline controls per row and edits update in place", () => {
    const m = mountForm(columnsSchema, {
      columns: [{ align: "left", label: "a", visible: true, width: 2 }],
    });
    const row = m.container.querySelector(".array-object-row") as HTMLElement;
    expect(row.querySelector("sp-picker")).not.toBeNull();
    expect(row.querySelector("sp-switch")).not.toBeNull();
    expect(row.querySelector("sp-number-field")).not.toBeNull();

    inputValue(row.querySelector("sp-textfield")!, "renamed");
    expect(m.patches).toEqual([
      { columns: [{ align: "left", label: "renamed", visible: true, width: 2 }] },
    ]);
  });

  test("add seeds item defaults; delete removes rows and clears the last one", () => {
    const m = mountForm(columnsSchema, {}, { withRerender: true });
    const add = [...m.container.querySelectorAll("sp-action-button")].find(
      (el) => el.textContent?.trim() === "+ Add",
    );
    pointer(add!, "click");
    expect(m.patches).toEqual([{ columns: [{ label: "col" }] }]);
    expect(m.renders.count).toBe(1);

    const two = mountForm(columnsSchema, { columns: [{ label: "a" }, { label: "b" }] });
    pointer(two.container.querySelector(".array-object-row sp-action-button")!, "click");
    expect(two.patches).toEqual([{ columns: [{ label: "b" }] }]);

    const one = mountForm(columnsSchema, { columns: [{ label: "only" }] });
    pointer(one.container.querySelector(".array-object-row sp-action-button")!, "click");
    expect(one.patches).toEqual([{ columns: undefined }]);
  });

  test("inline $ref cells edit the ref string directly", () => {
    const m = mountForm(
      {
        properties: {
          columns: {
            items: { properties: { source: { type: "string" } }, type: "object" },
            type: "array",
          },
        },
      },
      { columns: [{ source: { $ref: "#/$params/sku" } }] },
    );
    const tf = m.container.querySelector(".array-object-row sp-textfield") as ValueEl;
    expect(tf.value).toBe("#/$params/sku");
    commitValue(tf, "#/$params/other");
    expect(m.patches).toEqual([{ columns: [{ source: { $ref: "#/$params/other" } }] }]);
  });

  test("inline enums resolve dependent refs against the whole form value", () => {
    const ctx = ctxOver({
      content: { post: { schema: { properties: { slug: {}, title: {} } } } },
    });
    const m = mountForm(
      {
        properties: {
          fields: {
            items: {
              properties: {
                name: { enum: { $ref: "#/$context/content/{@type}/schema/properties" } },
              },
              type: "object",
            },
            type: "array",
          },
        },
      },
      { fields: [{}], type: "post" },
      { context: ctx },
    );
    const values = [...m.container.querySelectorAll(".array-object-row sp-menu-item")].map((el) =>
      el.getAttribute("value"),
    );
    expect(values).toEqual(["__none__", "slug", "title"]);
  });
});

// ─── renderInlineField direct coverage ───────────────────────────────────────

describe("renderInlineField", () => {
  function mountInline(schema: JsonSchema, value: unknown, ctx?: SchemaFormContext) {
    const container = document.createElement("div");
    const changes: unknown[] = [];
    render(
      html`${renderInlineField("cell", schema, value, (v) => changes.push(v), ctx)}`,
      container,
    );
    return { changes, container };
  }

  test("enum cells commit values and clear via —", () => {
    const m = mountInline({ enum: ["a", "b"] }, "a");
    commitValue(m.container.querySelector("sp-picker")!, "b");
    commitValue(m.container.querySelector("sp-picker")!, "__none__");
    expect(m.changes).toEqual(["b", undefined]);
  });

  test("boolean cells toggle; numeric cells parse and clear on blank", () => {
    const b = mountInline({ type: "boolean" }, false);
    const sw = b.container.querySelector("sp-switch") as HTMLElement & { checked: boolean };
    sw.checked = true;
    sw.dispatchEvent(new Event("change", { bubbles: true }));
    expect(b.changes).toEqual([true]);

    const n = mountInline({ type: "number" }, 1);
    commitValue(n.container.querySelector("sp-number-field")!, "2.5");
    commitValue(n.container.querySelector("sp-number-field")!, "");
    expect(n.changes).toEqual([2.5, undefined]);
  });

  test("string cells commit on input, clearing empty strings", () => {
    const m = mountInline({ type: "string" }, "x");
    inputValue(m.container.querySelector("sp-textfield")!, "y");
    inputValue(m.container.querySelector("sp-textfield")!, "");
    expect(m.changes).toEqual(["y", undefined]);
  });
});

// ─── ContentCollection.class.json regression through the full form ───────────

describe("ContentCollection enum refs render the same choices as before", () => {
  const projectConfig = {
    content: {
      page: { schema: { properties: { body: {}, title: {} } } },
      post: { schema: { properties: { date: {}, slug: {}, title: {} } } },
    },
  };

  interface ClassParameter {
    type: {
      enum?: unknown;
      items?: { properties: Record<string, { enum?: unknown }> };
    };
  }
  const classParams = (contentCollectionClass as unknown as { $defs: Record<string, unknown> })
    .$defs.parameters as Record<string, ClassParameter>;

  test("contentType picker lists the project content types", () => {
    const m = mountForm(
      { properties: { contentType: { enum: classParams.contentType!.type.enum } } },
      {},
      { context: ctxOver(projectConfig) },
    );
    const values = [...m.container.querySelectorAll('[data-prop="contentType"] sp-menu-item')].map(
      (el) => el.getAttribute("value"),
    );
    expect(values).toEqual(["__none__", "page", "post"]);
  });

  test("filter field enum lists the selected content type's properties", () => {
    const filterItems = classParams.filter!.type.items!;
    const m = mountForm(
      {
        properties: {
          filter: {
            items: { properties: filterItems.properties, type: "object" } as JsonSchema,
            type: "array",
          },
        },
      },
      { contentType: "post", filter: [{}] },
      { context: ctxOver(projectConfig) },
    );
    const fieldPicker = m.container.querySelector(".array-object-row sp-picker");
    const values = [...fieldPicker!.querySelectorAll("sp-menu-item")].map((el) =>
      el.getAttribute("value"),
    );
    expect(values).toEqual(["__none__", "date", "slug", "title"]);
  });
});
