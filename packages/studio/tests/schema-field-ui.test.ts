import { key, pointer, renderInto } from "./harness";
import { describe, expect, test } from "bun:test";
import {
  addFieldFormTpl,
  detectFieldFormat,
  detectFieldType,
  FIELD_TYPES,
  fieldCardTpl,
  FORMAT_OPTIONS,
  formatPickerTpl,
  schemaForType,
  typePickerTpl,
  yamlDefault,
} from "../src/settings/schema-field-ui";
import type { FieldHandlers, SchemaProperty } from "../src/settings/schema-field-ui";

// ─── Local helpers ────────────────────────────────────────────────────────────

/** Build a FieldHandlers object that records every invocation. */
function makeHandlers(opts: { includeOptional?: boolean } = {}) {
  const calls: unknown[][] = [];
  const log =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([name, ...args]);
    };
  const handlers: FieldHandlers = {
    onChangeType: log("onChangeType"),
    onDelete: log("onDelete"),
    onRename: log("onRename"),
    onToggleRequired: log("onToggleRequired"),
    ...(opts.includeOptional === false
      ? {}
      : {
          onAddNestedField: log("onAddNestedField"),
          onChangeFormat: log("onChangeFormat"),
          onChangeNestedFormat: log("onChangeNestedFormat"),
          onChangeNestedType: log("onChangeNestedType"),
          onChangeRefTarget: log("onChangeRefTarget"),
          onDeleteNested: log("onDeleteNested"),
          onRenameNested: log("onRenameNested"),
          onToggleNestedRequired: log("onToggleNestedRequired"),
        }),
  };
  return { calls, handlers };
}

/** Set a value property on a (possibly custom) element and dispatch the given event. */
function setAndFire(el: Element, value: string, type = "change") {
  (el as HTMLInputElement).value = value;
  el.dispatchEvent(new Event(type, { bubbles: true }));
}

// ─── detectFieldType / detectFieldFormat ─────────────────────────────────────

describe("detectFieldType", () => {
  test("returns reference for $ref schemas", () => {
    expect(detectFieldType({ $ref: "#/content/posts" })).toBe("reference");
  });

  test("returns explicit type", () => {
    expect(detectFieldType({ type: "number" })).toBe("number");
    expect(detectFieldType({ type: "object" })).toBe("object");
  });

  test("defaults to string when no type", () => {
    expect(detectFieldType({})).toBe("string");
  });
});

describe("detectFieldFormat", () => {
  test("array reads format off items", () => {
    expect(detectFieldFormat({ items: { format: "image", type: "string" }, type: "array" })).toBe(
      "image",
    );
  });

  test("array without items format falls through to own format", () => {
    expect(detectFieldFormat({ items: { type: "string" }, type: "array" })).toBe("");
  });

  test("string format returned directly", () => {
    expect(detectFieldFormat({ format: "date", type: "string" })).toBe("date");
  });

  test("no format yields empty string", () => {
    expect(detectFieldFormat({ type: "string" })).toBe("");
  });
});

// ─── schemaForType ───────────────────────────────────────────────────────────

describe("schemaForType", () => {
  test("number", () => {
    expect(schemaForType("number")).toEqual({ type: "number" });
  });

  test("boolean", () => {
    expect(schemaForType("boolean")).toEqual({ type: "boolean" });
  });

  test("array without format", () => {
    expect(schemaForType("array")).toEqual({ items: { type: "string" }, type: "array" });
  });

  test("array with format puts format on items", () => {
    expect(schemaForType("array", "image")).toEqual({
      items: { format: "image", type: "string" },
      type: "array",
    });
  });

  test("object skeleton", () => {
    expect(schemaForType("object")).toEqual({ properties: {}, required: [], type: "object" });
  });

  test("reference produces empty $ref target", () => {
    expect(schemaForType("reference")).toEqual({ $ref: "#/content/" });
  });

  test("string default with and without format", () => {
    expect(schemaForType("string")).toEqual({ type: "string" });
    expect(schemaForType("string", "color")).toEqual({ format: "color", type: "string" });
  });
});

// ─── yamlDefault ─────────────────────────────────────────────────────────────

describe("yamlDefault", () => {
  test("date format yields ISO date (YYYY-MM-DD)", () => {
    expect(yamlDefault("string", "date")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("image format yields empty quoted string", () => {
    expect(yamlDefault("string", "image")).toBe('""');
  });

  test("per-type defaults", () => {
    expect(yamlDefault("boolean")).toBe("false");
    expect(yamlDefault("number")).toBe("0");
    expect(yamlDefault("array")).toBe("[]");
    expect(yamlDefault("object")).toBe("{}");
    expect(yamlDefault("string")).toBe('""');
  });
});

// ─── typePickerTpl / formatPickerTpl ─────────────────────────────────────────

describe("type and format pickers", () => {
  test("type picker lists all field types and propagates change", async () => {
    let picked = "";
    const container = await renderInto(typePickerTpl("string", (t) => (picked = t)));
    const picker = container.querySelector("sp-picker")!;
    const items = [...container.querySelectorAll("sp-menu-item")];
    expect(items.map((i) => i.getAttribute("value"))).toEqual(FIELD_TYPES);
    setAndFire(picker, "boolean");
    expect(picked).toBe("boolean");
  });

  test("format picker lists options with (none) label and propagates change", async () => {
    let picked = "unset";
    const container = await renderInto(formatPickerTpl("", (f) => (picked = f)));
    const items = [...container.querySelectorAll("sp-menu-item")];
    expect(items.map((i) => i.getAttribute("value"))).toEqual(FORMAT_OPTIONS);
    expect(items[0]?.textContent).toContain("(none)");
    expect(items[1]?.textContent).toContain("image");
    setAndFire(container.querySelector("sp-picker")!, "date");
    expect(picked).toBe("date");
  });
});

// ─── fieldCardTpl — top-level row ─────────────────────────────────────────────

describe("fieldCardTpl basic row", () => {
  test("renders label, name input, type + format pickers for a string field", async () => {
    const { handlers } = makeHandlers();
    const container = await renderInto(
      fieldCardTpl("heroImage", { format: "image", type: "string" }, true, handlers),
    );
    expect(container.querySelector(".schema-field-label")?.textContent).toContain("Hero Image");
    expect(container.querySelector(".schema-field-name-input")?.getAttribute("value")).toBe(
      "heroImage",
    );
    const pickers = container.querySelectorAll(".schema-field-row sp-picker");
    expect(pickers.length).toBe(2); // Type + format
    expect(pickers[0]?.getAttribute("value")).toBe("string");
    expect(pickers[1]?.getAttribute("value")).toBe("image");
    expect(container.querySelector("sp-switch")?.hasAttribute("checked")).toBe(true);
  });

  test("number field hides the format picker and unchecked switch", async () => {
    const { handlers } = makeHandlers();
    const container = await renderInto(fieldCardTpl("count", { type: "number" }, false, handlers));
    const pickers = container.querySelectorAll(".schema-field-row sp-picker");
    expect(pickers.length).toBe(1);
    expect(container.querySelector("sp-switch")?.hasAttribute("checked")).toBe(false);
  });

  test("delete button calls onDelete", async () => {
    const { calls, handlers } = makeHandlers();
    const container = await renderInto(fieldCardTpl("title", { type: "string" }, false, handlers));
    pointer(container.querySelector('sp-action-button[title="Delete field"]')!, "click");
    expect(calls).toContainEqual(["onDelete", "title"]);
  });

  test("required switch calls onToggleRequired", async () => {
    const { calls, handlers } = makeHandlers();
    const container = await renderInto(fieldCardTpl("title", { type: "string" }, false, handlers));
    container.querySelector("sp-switch")!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(calls).toContainEqual(["onToggleRequired", "title"]);
  });

  test("type picker change calls onChangeType; format change calls onChangeFormat", async () => {
    const { calls, handlers } = makeHandlers();
    const container = await renderInto(fieldCardTpl("title", { type: "string" }, false, handlers));
    const [typePicker, formatPicker] = container.querySelectorAll(".schema-field-row sp-picker");
    setAndFire(typePicker!, "array");
    setAndFire(formatPicker!, "date");
    expect(calls).toContainEqual(["onChangeType", "title", "array"]);
    expect(calls).toContainEqual(["onChangeFormat", "title", "date"]);
  });

  test("format change without onChangeFormat handler does not throw", async () => {
    const { handlers } = makeHandlers({ includeOptional: false });
    const container = await renderInto(fieldCardTpl("title", { type: "string" }, false, handlers));
    const formatPicker = container.querySelectorAll(".schema-field-row sp-picker")[1]!;
    expect(() => setAndFire(formatPicker, "date")).not.toThrow();
  });
});

describe("fieldCardTpl rename interactions", () => {
  test("change with a new trimmed name calls onRename", async () => {
    const { calls, handlers } = makeHandlers();
    const container = await renderInto(fieldCardTpl("title", { type: "string" }, false, handlers));
    setAndFire(container.querySelector(".schema-field-name-input")!, "  newTitle  ");
    expect(calls).toContainEqual(["onRename", "title", "newTitle"]);
  });

  test("change with same or empty name resets the input instead of renaming", async () => {
    const { calls, handlers } = makeHandlers();
    const container = await renderInto(fieldCardTpl("title", { type: "string" }, false, handlers));
    const input = container.querySelector(".schema-field-name-input") as HTMLInputElement;
    setAndFire(input, "title");
    expect(calls.filter(([n]) => n === "onRename")).toHaveLength(0);
    setAndFire(input, "   ");
    expect(calls.filter(([n]) => n === "onRename")).toHaveLength(0);
    expect(input.value).toBe("title");
  });

  test("Enter blurs, Escape restores value and blurs", async () => {
    const { handlers } = makeHandlers();
    const container = await renderInto(fieldCardTpl("title", { type: "string" }, false, handlers));
    const input = container.querySelector(".schema-field-name-input") as HTMLInputElement;
    input.value = "half-typed";
    key(input, "Escape");
    expect(input.value).toBe("title");
    expect(() => key(input, "Enter")).not.toThrow();
  });
});

// ─── fieldCardTpl — reference target ─────────────────────────────────────────

describe("fieldCardTpl reference fields", () => {
  const refSchema: SchemaProperty = { $ref: "#/content/posts" };

  test("shows target picker with current ref target and available types", async () => {
    const { calls, handlers } = makeHandlers();
    const container = await renderInto(
      fieldCardTpl("related", refSchema, false, handlers, ["posts", "pages"]),
    );
    const refPicker = container.querySelector(".schema-field-ref-target sp-picker")!;
    expect(refPicker.getAttribute("value")).toBe("posts");
    const items = [...container.querySelectorAll(".schema-field-ref-target sp-menu-item")];
    expect(items.map((i) => i.getAttribute("value"))).toEqual(["posts", "pages"]);
    setAndFire(refPicker, "pages");
    expect(calls).toContainEqual(["onChangeRefTarget", "related", "pages"]);
  });

  test("legacy #/contentTypes/ refs still yield their target (generic section-prefix strip)", async () => {
    const { handlers } = makeHandlers();
    const container = await renderInto(
      fieldCardTpl("related", { $ref: "#/contentTypes/posts" }, false, handlers, [
        "posts",
        "pages",
      ]),
    );
    const refPicker = container.querySelector(".schema-field-ref-target sp-picker")!;
    expect(refPicker.getAttribute("value")).toBe("posts");
  });

  test("no format picker for references; target picker hidden when no content types", async () => {
    const { handlers } = makeHandlers();
    const container = await renderInto(fieldCardTpl("related", refSchema, false, handlers, []));
    expect(container.querySelector(".schema-field-ref-target")).toBeNull();
    expect(container.querySelectorAll(".schema-field-row sp-picker").length).toBe(1);
  });

  test("ref target change without handler does not throw", async () => {
    const { handlers } = makeHandlers({ includeOptional: false });
    const container = await renderInto(
      fieldCardTpl("related", refSchema, false, handlers, ["posts"]),
    );
    const refPicker = container.querySelector(".schema-field-ref-target sp-picker")!;
    expect(() => setAndFire(refPicker, "posts")).not.toThrow();
  });
});

// ─── fieldCardTpl — nested object fields ─────────────────────────────────────

const nestedSchema: SchemaProperty = {
  properties: {
    avatar: { format: "image", type: "string" },
    name: { type: "string" },
  },
  required: ["name"],
  type: "object",
};

describe("fieldCardTpl nested fields", () => {
  test("renders nested cards with required state", async () => {
    const { handlers } = makeHandlers();
    const container = await renderInto(fieldCardTpl("author", nestedSchema, false, handlers));
    const nested = [...container.querySelectorAll(".schema-field-card--nested")];
    expect(nested.length).toBe(2);
    const nameCard = nested.find(
      (c) => c.querySelector(".schema-field-name-input")?.getAttribute("value") === "name",
    )!;
    expect(nameCard.querySelector("sp-switch")?.hasAttribute("checked")).toBe(true);
  });

  test("nested rename, delete, toggle required, type and format changes route to nested handlers", async () => {
    const { calls, handlers } = makeHandlers();
    const container = await renderInto(fieldCardTpl("author", nestedSchema, false, handlers));
    const nameCard = [...container.querySelectorAll(".schema-field-card--nested")].find(
      (c) => c.querySelector(".schema-field-name-input")?.getAttribute("value") === "name",
    )!;

    setAndFire(nameCard.querySelector(".schema-field-name-input")!, "fullName");
    pointer(nameCard.querySelector('sp-action-button[title="Delete field"]')!, "click");
    nameCard.querySelector("sp-switch")!.dispatchEvent(new Event("change", { bubbles: true }));
    const [typePicker, formatPicker] = nameCard.querySelectorAll("sp-picker");
    setAndFire(typePicker!, "number");
    setAndFire(formatPicker!, "color");

    expect(calls).toContainEqual(["onRenameNested", "author", "name", "fullName"]);
    expect(calls).toContainEqual(["onDeleteNested", "author", "name"]);
    expect(calls).toContainEqual(["onToggleNestedRequired", "author", "name"]);
    expect(calls).toContainEqual(["onChangeNestedType", "author", "name", "number"]);
    expect(calls).toContainEqual(["onChangeNestedFormat", "author", "name", "color"]);
  });

  test("nested rename with unchanged name resets input; Escape restores", async () => {
    const { calls, handlers } = makeHandlers();
    const container = await renderInto(fieldCardTpl("author", nestedSchema, false, handlers));
    const nameCard = [...container.querySelectorAll(".schema-field-card--nested")][0]!;
    const input = nameCard.querySelector(".schema-field-name-input") as HTMLInputElement;
    const child = input.getAttribute("value")!;
    setAndFire(input, child);
    expect(calls.filter(([n]) => n === "onRenameNested")).toHaveLength(0);
    input.value = "junk";
    key(input, "Escape");
    expect(input.value).toBe(child);
    expect(() => key(input, "Enter")).not.toThrow();
  });

  test("nested handlers are optional — events do not throw when absent", async () => {
    const { handlers } = makeHandlers({ includeOptional: false });
    const container = await renderInto(fieldCardTpl("author", nestedSchema, false, handlers));
    const nameCard = [...container.querySelectorAll(".schema-field-card--nested")][0]!;
    expect(() => {
      setAndFire(nameCard.querySelector(".schema-field-name-input")!, "renamed");
      pointer(nameCard.querySelector('sp-action-button[title="Delete field"]')!, "click");
      nameCard.querySelector("sp-switch")!.dispatchEvent(new Event("change", { bubbles: true }));
      const [typePicker, formatPicker] = nameCard.querySelectorAll("sp-picker");
      setAndFire(typePicker!, "number");
      setAndFire(formatPicker!, "color");
    }).not.toThrow();
  });
});

describe("fieldCardTpl nested add-field row", () => {
  test("Enter on the name input adds a nested field with picked type and clears input", async () => {
    const { calls, handlers } = makeHandlers();
    const container = await renderInto(fieldCardTpl("author", nestedSchema, false, handlers));
    const row = container.querySelector(".schema-nested-add")!;
    const input = row.querySelector(".schema-nested-add-name") as HTMLInputElement;
    input.value = "  bio  ";
    (row.querySelector("sp-picker") as HTMLInputElement).value = "number";
    key(input, "Enter");
    expect(calls).toContainEqual([
      "onAddNestedField",
      "author",
      { name: "bio", required: false, type: "number" },
    ]);
    expect(input.value).toBe("");
  });

  test("Enter with empty name is a no-op", async () => {
    const { calls, handlers } = makeHandlers();
    const container = await renderInto(fieldCardTpl("author", nestedSchema, false, handlers));
    const input = container.querySelector(".schema-nested-add-name") as HTMLInputElement;
    input.value = "   ";
    key(input, "Enter");
    expect(calls.filter(([n]) => n === "onAddNestedField")).toHaveLength(0);
  });

  test("add button adds a nested field with default string type", async () => {
    const { calls, handlers } = makeHandlers();
    const container = await renderInto(fieldCardTpl("author", nestedSchema, false, handlers));
    const row = container.querySelector(".schema-nested-add")!;
    const input = row.querySelector(".schema-nested-add-name") as HTMLInputElement;
    input.value = "website";
    pointer(row.querySelector('sp-action-button[title="Add nested field"]')!, "click");
    expect(calls).toContainEqual([
      "onAddNestedField",
      "author",
      { name: "website", required: false, type: "string" },
    ]);
    expect(input.value).toBe("");
  });

  test("add button with empty name is a no-op", async () => {
    const { calls, handlers } = makeHandlers();
    const container = await renderInto(fieldCardTpl("author", nestedSchema, false, handlers));
    const row = container.querySelector(".schema-nested-add")!;
    pointer(row.querySelector('sp-action-button[title="Add nested field"]')!, "click");
    expect(calls.filter(([n]) => n === "onAddNestedField")).toHaveLength(0);
  });
});

// ─── addFieldFormTpl ─────────────────────────────────────────────────────────

function makeFormHandlers() {
  const calls: unknown[][] = [];
  return {
    calls,
    handlers: {
      onCancel: () => calls.push(["onCancel"]),
      onConfirm: () => calls.push(["onConfirm"]),
      onInput: (field: string, value: string | boolean) => calls.push(["onInput", field, value]),
    },
  };
}

describe("addFieldFormTpl", () => {
  const baseState = { format: "", name: "", required: false, type: "string" };

  test("name input forwards onInput; Enter confirms; Escape cancels", async () => {
    const { calls, handlers } = makeFormHandlers();
    const container = await renderInto(addFieldFormTpl(baseState, handlers));
    const input = container.querySelector("sp-textfield")!;
    setAndFire(input, "subtitle", "input");
    key(input, "Enter");
    key(input, "Escape");
    expect(calls).toContainEqual(["onInput", "name", "subtitle"]);
    expect(calls).toContainEqual(["onConfirm"]);
    expect(calls).toContainEqual(["onCancel"]);
  });

  test("type picker forwards onInput(type); format picker shown for string", async () => {
    const { calls, handlers } = makeFormHandlers();
    const container = await renderInto(addFieldFormTpl(baseState, handlers));
    const pickers = container.querySelectorAll("sp-picker");
    expect(pickers.length).toBe(2);
    setAndFire(pickers[0]!, "array");
    setAndFire(pickers[1]!, "image");
    expect(calls).toContainEqual(["onInput", "type", "array"]);
    expect(calls).toContainEqual(["onInput", "format", "image"]);
  });

  test("format picker hidden for non-string/array types", async () => {
    const { handlers } = makeFormHandlers();
    const container = await renderInto(addFieldFormTpl({ ...baseState, type: "object" }, handlers));
    expect(container.querySelectorAll("sp-picker").length).toBe(1);
  });

  test("required switch forwards checked state", async () => {
    const { calls, handlers } = makeFormHandlers();
    const container = await renderInto(addFieldFormTpl(baseState, handlers));
    const sw = container.querySelector("sp-switch") as HTMLInputElement;
    sw.checked = true;
    sw.dispatchEvent(new Event("change", { bubbles: true }));
    expect(calls).toContainEqual(["onInput", "required", true]);
  });

  test("Add and Cancel buttons fire confirm/cancel", async () => {
    const { calls, handlers } = makeFormHandlers();
    const container = await renderInto(addFieldFormTpl(baseState, handlers));
    const buttons = [...container.querySelectorAll("sp-action-button")];
    pointer(
      buttons.find((b) => b.textContent?.includes("Add"))!,
      "click",
    );
    pointer(
      buttons.find((b) => b.textContent?.includes("Cancel"))!,
      "click",
    );
    expect(calls).toContainEqual(["onConfirm"]);
    expect(calls).toContainEqual(["onCancel"]);
  });
});
