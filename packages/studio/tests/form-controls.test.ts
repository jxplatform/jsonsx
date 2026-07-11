/**
 * Tests for src/ui/form-controls.ts — the built-in "schema-builder" and "secret" form controls
 * registered for descriptor-contributed settings forms.
 */
import { flush, pointer } from "./harness";
import { beforeEach, describe, expect, test } from "bun:test";
import { html, render } from "lit-html";
import { builtinFormControls, resetFormControlUiState } from "../src/ui/form-controls";
import { getFormControl, renderForm } from "../src/ui/schema-form";
import type { SchemaFormContext } from "../src/ui/schema-form";

type ValueEl = HTMLElement & { value: string };

function commitValue(el: Element, value: string): void {
  (el as ValueEl).value = value;
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function inputValue(el: Element, value: string): void {
  (el as ValueEl).value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

const inertCtx: SchemaFormContext = {
  resolvePointer: () => {
    // No context data
  },
};

const contentTypesCtx: SchemaFormContext = {
  resolvePointer: (ptr) => (ptr === "#/$context/content" ? { page: {}, post: {} } : undefined),
};

interface BuilderMount {
  container: HTMLElement;
  state: { value: unknown };
}

/** Mount a schema-builder-controlled field over a live value that tracks onChange patches. */
function mountBuilder(initial: unknown, ctx: SchemaFormContext = inertCtx): BuilderMount {
  const container = document.createElement("div");
  const state = { value: initial };
  const doRender = () => {
    render(
      html`${renderForm(
        { properties: { schema: { format: "json-schema", type: "object" } } },
        { schema: state.value },
        {
          context: ctx,
          onChange: (patch) => {
            state.value = patch.schema;
            doRender();
          },
          rerender: doRender,
          ui: { schema: { control: "schema-builder" } },
        },
      )}`,
      container,
    );
  };
  doRender();
  return { container, state };
}

/** The field card element whose name input carries the given field name. */
function card(container: HTMLElement, fieldName: string): HTMLElement {
  const input = container.querySelector(`.schema-field-name-input[value="${fieldName}"]`);
  const el = input?.closest(".schema-field-card");
  if (!el) {
    throw new Error(`no field card for ${fieldName}`);
  }
  return el as HTMLElement;
}

function pickerIn(scope: HTMLElement, label: string): ValueEl {
  const el = scope.querySelector(`sp-picker[label="${label}"]`);
  if (!el) {
    throw new Error(`no ${label} picker`);
  }
  return el as ValueEl;
}

function buttonByText(scope: HTMLElement, text: string): Element {
  const el = [...scope.querySelectorAll("sp-action-button")].find(
    (b) => b.textContent?.trim() === text,
  );
  if (!el) {
    throw new Error(`no button "${text}"`);
  }
  return el;
}

function schemaOf(m: BuilderMount): {
  properties: Record<string, Record<string, unknown>>;
  required: string[];
} {
  return m.state.value as never;
}

beforeEach(() => {
  resetFormControlUiState();
});

// ─── Registration ─────────────────────────────────────────────────────────────

describe("registration", () => {
  test("both built-ins are registered on import", () => {
    expect(builtinFormControls).toEqual(["schema-builder", "secret"]);
    expect(getFormControl("schema-builder")).toBeDefined();
    expect(getFormControl("secret")).toBeDefined();
  });
});

// ─── Schema-builder: add-field flow ──────────────────────────────────────────

describe("schema-builder add field", () => {
  test("adds a formatted required field through the add form", () => {
    const m = mountBuilder({ properties: {}, required: [], type: "object" });
    pointer(buttonByText(m.container, "Add Field"), "click");

    const addForm = m.container.querySelector(".schema-add-field") as HTMLElement;
    expect(addForm).not.toBeNull();

    inputValue(addForm.querySelector("sp-textfield")!, "Publish Date");
    const form = m.container.querySelector(".schema-add-field") as HTMLElement;
    commitValue(pickerIn(form, "Format"), "date");
    const sw = m.container.querySelector(".schema-add-field sp-switch") as HTMLElement & {
      checked: boolean;
    };
    sw.checked = true;
    sw.dispatchEvent(new Event("change", { bubbles: true }));

    pointer(
      buttonByText(m.container.querySelector(".schema-add-field") as HTMLElement, "Add"),
      "click",
    );

    expect(schemaOf(m).properties.publishDate).toEqual({ format: "date", type: "string" });
    expect(schemaOf(m).required).toEqual(["publishDate"]);
    // Form closes after confirming
    expect(m.container.querySelector(".schema-add-field")).toBeNull();
  });

  test("blank names are ignored; cancel clears the pending state", () => {
    const m = mountBuilder({ properties: {}, required: [], type: "object" });
    pointer(buttonByText(m.container, "Add Field"), "click");
    pointer(
      buttonByText(m.container.querySelector(".schema-add-field") as HTMLElement, "Add"),
      "click",
    );
    expect(Object.keys(schemaOf(m).properties)).toEqual([]);

    inputValue(m.container.querySelector(".schema-add-field sp-textfield")!, "draft");
    pointer(
      buttonByText(m.container.querySelector(".schema-add-field") as HTMLElement, "Cancel"),
      "click",
    );
    expect(m.container.querySelector(".schema-add-field")).toBeNull();

    // Reopening starts from a blank name
    pointer(buttonByText(m.container, "Add Field"), "click");
    const nameField = m.container.querySelector(".schema-add-field sp-textfield") as ValueEl;
    expect(nameField.value || nameField.getAttribute("value") || "").toBe("");
  });

  test("builds a fresh object schema when the value is not an object", () => {
    const m = mountBuilder(null);
    pointer(buttonByText(m.container, "Add Field"), "click");
    inputValue(m.container.querySelector(".schema-add-field sp-textfield")!, "title");
    pointer(
      buttonByText(m.container.querySelector(".schema-add-field") as HTMLElement, "Add"),
      "click",
    );
    expect(m.state.value).toEqual({
      properties: { title: { type: "string" } },
      required: [],
      type: "object",
    });
  });
});

// ─── Schema-builder: field card operations ───────────────────────────────────

describe("schema-builder field operations", () => {
  const initial = () => ({
    properties: {
      meta: {
        properties: { author: { type: "string" } },
        required: ["author"],
        type: "object",
      },
      summary: { type: "string" },
      title: { type: "string" },
    },
    required: ["title"],
    type: "object",
  });

  test("rename preserves the schema and rewrites required entries", () => {
    const m = mountBuilder(initial());
    commitValue(card(m.container, "title").querySelector(".schema-field-name-input")!, "headline");
    expect(schemaOf(m).properties.headline).toEqual({ type: "string" });
    expect(schemaOf(m).properties.title).toBeUndefined();
    expect(schemaOf(m).required).toEqual(["headline"]);
  });

  test("type and format changes rebuild the property definition", () => {
    const m = mountBuilder(initial());
    commitValue(pickerIn(card(m.container, "summary"), "Type"), "number");
    expect(schemaOf(m).properties.summary).toEqual({ type: "number" });

    commitValue(pickerIn(card(m.container, "title"), "Format"), "image");
    expect(schemaOf(m).properties.title).toEqual({ format: "image", type: "string" });
  });

  test("required toggles on and off; delete drops the field and its required entry", () => {
    const m = mountBuilder(initial());
    const summarySwitch = () =>
      card(m.container, "summary").querySelector(".schema-field-row sp-switch")!;
    summarySwitch().dispatchEvent(new Event("change", { bubbles: true }));
    expect(schemaOf(m).required).toEqual(["title", "summary"]);
    summarySwitch().dispatchEvent(new Event("change", { bubbles: true }));
    expect(schemaOf(m).required).toEqual(["title"]);

    pointer(card(m.container, "title").querySelector('[title="Delete field"]')!, "click");
    expect(schemaOf(m).properties.title).toBeUndefined();
    expect(schemaOf(m).required).toEqual([]);
  });

  test("reference fields pick targets from the context's content types", () => {
    const m = mountBuilder(initial(), contentTypesCtx);
    commitValue(pickerIn(card(m.container, "summary"), "Type"), "reference");
    expect(schemaOf(m).properties.summary).toEqual({ $ref: "#/content/" });

    const targetPicker = pickerIn(card(m.container, "summary"), "Target");
    const options = [...targetPicker.querySelectorAll("sp-menu-item")].map((el) =>
      el.getAttribute("value"),
    );
    expect(options).toEqual(["page", "post"]);
    commitValue(targetPicker, "post");
    expect(schemaOf(m).properties.summary).toEqual({ $ref: "#/content/post" });
  });

  test("nested fields support add, rename, type, format, required, and delete", () => {
    const m = mountBuilder(initial());
    const nested = () => card(m.container, "meta").querySelector(".schema-field-nested")!;
    const meta = () =>
      schemaOf(m).properties.meta as never as {
        properties: Record<string, Record<string, unknown>>;
        required: string[];
      };

    // Add through the nested add row (Enter in the name field)
    const addName = nested().querySelector(".schema-nested-add-name") as ValueEl;
    addName.value = "Published At";
    addName.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }),
    );
    expect(meta().properties.publishedAt).toEqual({ type: "string" });

    // Rename
    commitValue(nested().querySelector('.schema-field-name-input[value="author"]')!, "writer");
    expect(meta().properties.writer).toEqual({ type: "string" });
    expect(meta().required).toEqual(["writer"]);

    // Type + format
    const writerCard = nested()
      .querySelector('.schema-field-name-input[value="writer"]')!
      .closest(".schema-field-card") as HTMLElement;
    commitValue(pickerIn(writerCard, "Type"), "array");
    expect(meta().properties.writer).toEqual({ items: { type: "string" }, type: "array" });
    const writerCard2 = nested()
      .querySelector('.schema-field-name-input[value="writer"]')!
      .closest(".schema-field-card") as HTMLElement;
    commitValue(pickerIn(writerCard2, "Format"), "image");
    expect(meta().properties.writer).toEqual({
      items: { format: "image", type: "string" },
      type: "array",
    });

    // Required toggle (writer left required set on rename; toggle removes it)
    const writerCard3 = nested()
      .querySelector('.schema-field-name-input[value="writer"]')!
      .closest(".schema-field-card") as HTMLElement;
    writerCard3.querySelector("sp-switch")!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(meta().required).toEqual([]);

    // Delete
    const writerCard4 = nested()
      .querySelector('.schema-field-name-input[value="writer"]')!
      .closest(".schema-field-card") as HTMLElement;
    pointer(writerCard4.querySelector('[title="Delete field"]')!, "click");
    expect(meta().properties.writer).toBeUndefined();
  });
});

// ─── Secret control ──────────────────────────────────────────────────────────

describe("secret control", () => {
  function mountSecret(
    ctx: SchemaFormContext,
    value?: unknown,
    onChange: (next: unknown) => void = () => {
      // Default: ignore the committed env name
    },
  ) {
    const secret = getFormControl("secret")!;
    const container = document.createElement("div");
    render(
      html`${secret({
        ctx,
        key: "urlEnv",
        onChange,
        schema: { format: "secret", type: "string" },
        value,
      })}`,
      container,
    );
    return container;
  }

  test("renders disabled without a commitSecret hook (backend has no secrets surface)", () => {
    const container = mountSecret(inertCtx);
    const field = container.querySelector("sp-textfield")!;
    expect(field.hasAttribute("disabled")).toBe(true);
    expect(field.getAttribute("placeholder")).toBe("Not set");
    expect(field.getAttribute("type")).toBe("password");
    // Change events are inert while disabled
    commitValue(field, "ignored");
  });

  test("stores the VALUE via commitSecret and persists only the returned env NAME", async () => {
    const commits: [string, string][] = [];
    const changes: unknown[] = [];
    const container = mountSecret(
      {
        commitSecret: (key, value) => {
          commits.push([key, value]);
          return "MAIN_URL";
        },
        resolvePointer: () => {
          // No context data
        },
      },
      undefined,
      (next) => changes.push(next),
    );
    const field = container.querySelector("sp-textfield")!;
    expect(field.hasAttribute("disabled")).toBe(false);
    commitValue(field, "postgres://secret");
    await flush();
    expect(commits).toEqual([["urlEnv", "postgres://secret"]]);
    expect(changes).toEqual(["MAIN_URL"]);
    // The entered secret never lingers in the field
    expect((field as ValueEl).value).toBe("");
  });

  test("shows the stored env NAME as placeholder and rerenders on a same-name recommit", async () => {
    let rerenders = 0;
    const secret = getFormControl("secret")!;
    const container = document.createElement("div");
    render(
      html`${secret({
        ctx: {
          commitSecret: () => "MAIN_URL",
          resolvePointer: () => {
            // No context data
          },
        },
        key: "urlEnv",
        onChange: () => {
          throw new Error("unchanged env names must not patch project.json");
        },
        rerender: () => {
          rerenders += 1;
        },
        schema: { format: "secret", type: "string" },
        value: "MAIN_URL",
      })}`,
      container,
    );
    const field = container.querySelector("sp-textfield")!;
    expect(field.getAttribute("placeholder")).toBe("Stored as MAIN_URL");
    commitValue(field, "rotated-value");
    await flush();
    expect(rerenders).toBe(1);
  });

  test("blank input never commits", async () => {
    const commits: unknown[] = [];
    const container = mountSecret({
      commitSecret: (key, value) => {
        commits.push([key, value]);
        return "X";
      },
      resolvePointer: () => {
        // No context data
      },
    });
    commitValue(container.querySelector("sp-textfield")!, "");
    await flush();
    expect(commits).toEqual([]);
  });
});
