/**
 * Tests for src/settings/defs-editor.ts — visual editor for project-level $defs.
 *
 * The editor keeps module-level selection state, so each test installs a fresh mock platform +
 * project config and drives selection through the rendered list buttons (same approach as
 * contributed-content-types.test.ts).
 */
import { flush, installMockPlatform, key, pointer, resetStudioState } from "./harness";
import { describe, expect, test } from "bun:test";
import { renderDefsEditor } from "../src/settings/defs-editor";
import { projectState } from "../src/store";

import type { MockPlatformState } from "./harness";

type AnyConfig = Record<string, any>;

function setup(defs: AnyConfig | null): { container: HTMLElement; state: MockPlatformState } {
  const { state } = installMockPlatform();
  resetStudioState({
    projectConfig: defs === null ? null : ({ $defs: defs } as unknown),
  });
  const container = document.createElement("div");
  renderDefsEditor(container);
  return { container, state };
}

function config(): AnyConfig {
  return (projectState as AnyConfig).projectConfig;
}

function buttonByText(root: HTMLElement, text: string): HTMLElement {
  const match = [...root.querySelectorAll("sp-action-button")].find((b) =>
    b.textContent?.includes(text),
  );
  if (!match) {
    throw new Error(`no sp-action-button containing "${text}"`);
  }
  return match as HTMLElement;
}

function selectDef(container: HTMLElement, name: string): void {
  const button = [...container.querySelectorAll(".settings-list-panel sp-action-button")].find(
    (b) => b.textContent?.trim() === name,
  );
  if (!button) {
    throw new Error(`no list button for definition "${name}"`);
  }
  pointer(button, "click");
}

function fieldCard(container: HTMLElement, fieldName: string): HTMLElement {
  const card = [...container.querySelectorAll(".schema-field-card")].find(
    (c) =>
      !c.classList.contains("schema-field-card--nested") &&
      c.querySelector(".schema-field-name-input")?.getAttribute("value") === fieldName,
  );
  if (!card) {
    throw new Error(`no field card for "${fieldName}"`);
  }
  return card as HTMLElement;
}

function setAndFire(el: Element, value: string, type = "change"): void {
  (el as HTMLInputElement).value = value;
  el.dispatchEvent(new Event(type, { bubbles: true }));
}

function postDefs(): AnyConfig {
  return {
    Author: {
      properties: { name: { type: "string" } },
      required: [],
      type: "object",
    },
    Post: {
      properties: {
        cover: { format: "image", type: "string" },
        meta: {
          properties: { author: { type: "string" } },
          required: ["author"],
          type: "object",
        },
        tags: { items: { format: "image", type: "string" }, type: "array" },
        title: { type: "string" },
      },
      required: ["title"],
      type: "object",
    },
  };
}

// ─── List panel ──────────────────────────────────────────────────────────────

describe("defs list panel", () => {
  test("renders empty state when nothing is selected", () => {
    const { container } = setup({});
    expect(container.querySelector(".settings-empty-state")?.textContent).toContain(
      "Select or create a type definition",
    );
    expect(container.querySelectorAll(".settings-list-panel sp-action-button").length).toBe(1); // Only "New Definition"
  });

  test("lists existing definition names and selecting one shows its editor", () => {
    const { container } = setup(postDefs());
    const labels = [...container.querySelectorAll(".settings-list-panel sp-action-button")].map(
      (b) => b.textContent?.trim(),
    );
    expect(labels).toContain("Post");
    expect(labels).toContain("Author");

    selectDef(container, "Post");
    expect(container.querySelector(".settings-editor-header h3")?.textContent).toBe("Post");
    expect(container.querySelectorAll(".schema-field-card").length).toBeGreaterThanOrEqual(4);
  });
});

// ─── New definition flow ─────────────────────────────────────────────────────

describe("new definition flow", () => {
  test("create via Enter trims the name, selects it, and persists with tab indent", async () => {
    const { container, state } = setup({});
    pointer(buttonByText(container, "New Definition"), "click");
    const input = container.querySelector(".settings-inline-form sp-textfield")!;
    setAndFire(input, "  ApiResponse  ", "input");
    key(input, "Enter");

    expect(config().$defs.ApiResponse).toEqual({ properties: {}, required: [], type: "object" });
    expect(container.querySelector(".settings-editor-header h3")?.textContent).toBe("ApiResponse");
    await flush();
    const written = state.files.get("project.json");
    expect(written).toBeDefined();
    expect(written).toContain("\t");
    expect(JSON.parse(written!).$defs.ApiResponse).toBeDefined();
  });

  test("create via the Create button", async () => {
    const { container, state } = setup({});
    pointer(buttonByText(container, "New Definition"), "click");
    setAndFire(container.querySelector(".settings-inline-form sp-textfield")!, "Product", "input");
    pointer(buttonByText(container, "Create"), "click");
    expect(config().$defs.Product).toBeDefined();
    await flush();
    expect(state.files.has("project.json")).toBe(true);
  });

  test("blank name is rejected and the form stays open", async () => {
    const { container, state } = setup({});
    pointer(buttonByText(container, "New Definition"), "click");
    const input = container.querySelector(".settings-inline-form sp-textfield")!;
    setAndFire(input, "   ", "input");
    key(input, "Enter");
    expect(Object.keys(config().$defs)).toEqual([]);
    expect(container.querySelector(".settings-inline-form")).not.toBeNull();
    await flush();
    expect(state.files.size).toBe(0);
    key(input, "Escape");
    expect(container.querySelector(".settings-inline-form")).toBeNull();
  });

  test("duplicate name does not overwrite the existing definition", async () => {
    const { container, state } = setup(postDefs());
    pointer(buttonByText(container, "New Definition"), "click");
    const input = container.querySelector(".settings-inline-form sp-textfield")!;
    setAndFire(input, "Post", "input");
    key(input, "Enter");
    expect(config().$defs.Post.properties.title).toEqual({ type: "string" });
    await flush();
    expect(state.files.size).toBe(0);
    key(input, "Escape");
  });

  test("missing project config is a safe no-op", () => {
    const { container } = setup(null);
    pointer(buttonByText(container, "New Definition"), "click");
    const input = container.querySelector(".settings-inline-form sp-textfield")!;
    setAndFire(input, "Whatever", "input");
    expect(() => key(input, "Enter")).not.toThrow();
    key(input, "Escape");
  });

  test("creates the $defs map when the config lacks one", () => {
    installMockPlatform();
    resetStudioState({ projectConfig: {} as unknown });
    const container = document.createElement("div");
    renderDefsEditor(container);
    pointer(buttonByText(container, "New Definition"), "click");
    const input = container.querySelector(".settings-inline-form sp-textfield")!;
    setAndFire(input, "Fresh", "input");
    key(input, "Enter");
    expect(config().$defs.Fresh).toBeDefined();
  });
});

// ─── Add field flow ──────────────────────────────────────────────────────────

describe("add field flow", () => {
  test("add a formatted required field via the inline form", async () => {
    const { container, state } = setup(postDefs());
    selectDef(container, "Post");
    pointer(buttonByText(container, "Add Field"), "click");

    setAndFire(container.querySelector(".schema-add-field sp-textfield")!, "heroImage", "input");
    const sw = container.querySelector(".schema-add-field sp-switch") as HTMLInputElement;
    sw.checked = true;
    sw.dispatchEvent(new Event("change", { bubbles: true }));
    setAndFire(container.querySelectorAll(".schema-add-field sp-picker")[1]!, "image");
    pointer(buttonByText(container, "Add"), "click");

    const def = config().$defs.Post;
    expect(def.properties.heroImage).toEqual({ format: "image", type: "string" });
    expect(def.required).toContain("heroImage");
    expect(container.querySelector(".schema-add-field")).toBeNull();
    await flush();
    expect(state.files.has("project.json")).toBe(true);
  });

  test("changing type to object hides the format picker and adds an object skeleton", () => {
    const { container } = setup(postDefs());
    selectDef(container, "Post");
    pointer(buttonByText(container, "Add Field"), "click");
    setAndFire(container.querySelector(".schema-add-field sp-textfield")!, "extras", "input");
    setAndFire(container.querySelectorAll(".schema-add-field sp-picker")[0]!, "object");
    expect(container.querySelectorAll(".schema-add-field sp-picker").length).toBe(1);
    key(container.querySelector(".schema-add-field sp-textfield")!, "Enter");
    expect(config().$defs.Post.properties.extras).toEqual({
      properties: {},
      required: [],
      type: "object",
    });
  });

  test("empty name keeps the form open; Cancel resets it", () => {
    const { container } = setup(postDefs());
    selectDef(container, "Post");
    pointer(buttonByText(container, "Add Field"), "click");
    key(container.querySelector(".schema-add-field sp-textfield")!, "Enter");
    expect(container.querySelector(".schema-add-field")).not.toBeNull();

    setAndFire(container.querySelector(".schema-add-field sp-textfield")!, "draft", "input");
    pointer(buttonByText(container, "Cancel"), "click");
    expect(container.querySelector(".schema-add-field")).toBeNull();
    expect(config().$defs.Post.properties.draft).toBeUndefined();

    // Reopening shows a reset form
    pointer(buttonByText(container, "Add Field"), "click");
    const input = container.querySelector(".schema-add-field sp-textfield") as HTMLInputElement;
    expect(input.value ?? "").toBe("");
    key(input, "Escape");
  });

  test("creates properties and required maps when the def lacks them", () => {
    const { container } = setup({ Slim: { type: "object" } });
    selectDef(container, "Slim");
    pointer(buttonByText(container, "Add Field"), "click");
    setAndFire(container.querySelector(".schema-add-field sp-textfield")!, "title", "input");
    const sw = container.querySelector(".schema-add-field sp-switch") as HTMLInputElement;
    sw.checked = true;
    sw.dispatchEvent(new Event("change", { bubbles: true }));
    key(container.querySelector(".schema-add-field sp-textfield")!, "Enter");
    expect(config().$defs.Slim.properties.title).toEqual({ type: "string" });
    expect(config().$defs.Slim.required).toEqual(["title"]);
  });

  test("def removed underneath the form is a guarded no-op", async () => {
    const { container, state } = setup(postDefs());
    selectDef(container, "Post");
    pointer(buttonByText(container, "Add Field"), "click");
    setAndFire(container.querySelector(".schema-add-field sp-textfield")!, "ghost", "input");
    delete config().$defs.Post;
    expect(() =>
      key(container.querySelector(".schema-add-field sp-textfield")!, "Enter"),
    ).not.toThrow();
    await flush();
    expect(state.files.size).toBe(0);
    pointer(buttonByText(container, "Cancel"), "click");
  });
});

// ─── Field mutations ─────────────────────────────────────────────────────────

describe("field mutations", () => {
  test("delete removes the property and its required entry", async () => {
    const { container, state } = setup(postDefs());
    selectDef(container, "Post");
    pointer(fieldCard(container, "title").querySelector('[title="Delete field"]')!, "click");
    const def = config().$defs.Post;
    expect(def.properties.title).toBeUndefined();
    expect(def.required).not.toContain("title");
    expect(() => fieldCard(container, "title")).toThrow();
    await flush();
    expect(state.files.has("project.json")).toBe(true);
  });

  test("toggle required adds then removes the field", () => {
    const { container } = setup(postDefs());
    selectDef(container, "Post");
    const fire = () =>
      fieldCard(container, "cover")
        .querySelector("sp-switch")!
        .dispatchEvent(new Event("change", { bubbles: true }));
    fire();
    expect(config().$defs.Post.required).toContain("cover");
    fire();
    expect(config().$defs.Post.required).not.toContain("cover");
  });

  test("toggle required initializes a missing required array", () => {
    const { container } = setup({
      Slim: { properties: { a: { type: "string" } }, type: "object" },
    });
    selectDef(container, "Slim");
    fieldCard(container, "a")
      .querySelector("sp-switch")!
      .dispatchEvent(new Event("change", { bubbles: true }));
    expect(config().$defs.Slim.required).toEqual(["a"]);
  });

  test("rename keeps the literal name, remaps required, and preserves order", () => {
    const { container } = setup(postDefs());
    selectDef(container, "Post");
    const before = Object.keys(config().$defs.Post.properties);
    setAndFire(fieldCard(container, "title").querySelector(".schema-field-name-input")!, "header");
    const def = config().$defs.Post;
    expect(def.properties.header).toEqual({ type: "string" });
    expect(def.properties.title).toBeUndefined();
    expect(def.required).toContain("header");
    expect(Object.keys(def.properties)).toEqual(before.map((k) => (k === "title" ? "header" : k)));
  });

  test("rename to an existing field name is rejected", () => {
    const { container } = setup(postDefs());
    selectDef(container, "Post");
    setAndFire(fieldCard(container, "title").querySelector(".schema-field-name-input")!, "cover");
    const def = config().$defs.Post;
    expect(def.properties.title).toEqual({ type: "string" });
    expect(def.properties.cover).toEqual({ format: "image", type: "string" });
  });

  test("change type string→array preserves the format on items", () => {
    const { container } = setup(postDefs());
    selectDef(container, "Post");
    setAndFire(fieldCard(container, "cover").querySelectorAll("sp-picker")[0]!, "array");
    expect(config().$defs.Post.properties.cover).toEqual({
      items: { format: "image", type: "string" },
      type: "array",
    });
  });

  test("change type to number drops the format", () => {
    const { container } = setup(postDefs());
    selectDef(container, "Post");
    setAndFire(fieldCard(container, "cover").querySelectorAll("sp-picker")[0]!, "number");
    expect(config().$defs.Post.properties.cover).toEqual({ type: "number" });
  });

  test("change format keeps the field type; array format lands on items", () => {
    const { container } = setup(postDefs());
    selectDef(container, "Post");
    setAndFire(fieldCard(container, "title").querySelectorAll("sp-picker")[1]!, "date");
    expect(config().$defs.Post.properties.title).toEqual({ format: "date", type: "string" });

    setAndFire(fieldCard(container, "tags").querySelectorAll("sp-picker")[1]!, "color");
    expect(config().$defs.Post.properties.tags).toEqual({
      items: { format: "color", type: "string" },
      type: "array",
    });
  });

  test("change format falls back to string when the property has no type", () => {
    const { container } = setup({
      Slim: { properties: { odd: { format: "date" } }, type: "object" },
    });
    selectDef(container, "Slim");
    setAndFire(fieldCard(container, "odd").querySelectorAll("sp-picker")[1]!, "color");
    expect(config().$defs.Slim.properties.odd).toEqual({ format: "color", type: "string" });
  });
});

// ─── Nested field mutations ──────────────────────────────────────────────────

describe("nested field mutations", () => {
  function metaCard(container: HTMLElement) {
    return fieldCard(container, "meta");
  }
  function nestedCard(container: HTMLElement, child: string) {
    const card = [...metaCard(container).querySelectorAll(".schema-field-card--nested")].find(
      (c) => c.querySelector(".schema-field-name-input")?.getAttribute("value") === child,
    );
    if (!card) {
      throw new Error(`no nested card "${child}"`);
    }
    return card as HTMLElement;
  }
  function metaSchema() {
    return config().$defs.Post.properties.meta;
  }

  test("add nested field via Enter and via the add button", async () => {
    const { container, state } = setup(postDefs());
    selectDef(container, "Post");

    const row = metaCard(container).querySelector(".schema-nested-add")!;
    const input = row.querySelector(".schema-nested-add-name") as HTMLInputElement;
    input.value = "birthYear";
    (row.querySelector("sp-picker") as HTMLInputElement).value = "number";
    key(input, "Enter");
    expect(metaSchema().properties.birthYear).toEqual({ type: "number" });

    const row2 = metaCard(container).querySelector(".schema-nested-add")!;
    (row2.querySelector(".schema-nested-add-name") as HTMLInputElement).value = "homepage";
    (row2.querySelector("sp-picker") as HTMLInputElement).value = "";
    pointer(row2.querySelector('[title="Add nested field"]')!, "click");
    expect(metaSchema().properties.homepage).toEqual({ type: "string" });
    await flush();
    expect(state.files.has("project.json")).toBe(true);
  });

  test("add nested field creates a missing parent properties map", () => {
    const { container } = setup({
      Post: { properties: { meta: { type: "object" } }, type: "object" },
    });
    selectDef(container, "Post");
    const row = metaCard(container).querySelector(".schema-nested-add")!;
    const input = row.querySelector(".schema-nested-add-name") as HTMLInputElement;
    input.value = "slug";
    key(input, "Enter");
    expect(metaSchema().properties.slug).toEqual({ type: "string" });
  });

  test("delete nested removes the property and its required entry", () => {
    const { container } = setup(postDefs());
    selectDef(container, "Post");
    pointer(nestedCard(container, "author").querySelector('[title="Delete field"]')!, "click");
    expect(metaSchema().properties.author).toBeUndefined();
    expect(metaSchema().required).not.toContain("author");
  });

  test("toggle nested required removes then re-adds", () => {
    const { container } = setup(postDefs());
    selectDef(container, "Post");
    const fire = () =>
      nestedCard(container, "author")
        .querySelector("sp-switch")!
        .dispatchEvent(new Event("change", { bubbles: true }));
    fire();
    expect(metaSchema().required).not.toContain("author");
    fire();
    expect(metaSchema().required).toContain("author");
  });

  test("toggle nested required initializes a missing required array", () => {
    const { container } = setup({
      Post: {
        properties: { meta: { properties: { a: { type: "string" } }, type: "object" } },
        type: "object",
      },
    });
    selectDef(container, "Post");
    nestedCard(container, "a")
      .querySelector("sp-switch")!
      .dispatchEvent(new Event("change", { bubbles: true }));
    expect(metaSchema().required).toEqual(["a"]);
  });

  test("rename nested remaps required; conflicting rename is rejected", () => {
    const { container } = setup(postDefs());
    selectDef(container, "Post");
    setAndFire(
      nestedCard(container, "author").querySelector(".schema-field-name-input")!,
      "writer",
    );
    expect(metaSchema().properties.writer).toEqual({ type: "string" });
    expect(metaSchema().required).toContain("writer");

    // Add a second child, then attempt a conflicting rename
    const row = metaCard(container).querySelector(".schema-nested-add")!;
    (row.querySelector(".schema-nested-add-name") as HTMLInputElement).value = "city";
    key(row.querySelector(".schema-nested-add-name")!, "Enter");
    setAndFire(nestedCard(container, "city").querySelector(".schema-field-name-input")!, "writer");
    expect(metaSchema().properties.city).toEqual({ type: "string" });
  });

  test("change nested type preserves format string→array, drops it for boolean", () => {
    const { container } = setup({
      Post: {
        properties: {
          meta: { properties: { avatar: { format: "image", type: "string" } }, type: "object" },
        },
        type: "object",
      },
    });
    selectDef(container, "Post");
    setAndFire(nestedCard(container, "avatar").querySelectorAll("sp-picker")[0]!, "array");
    expect(metaSchema().properties.avatar).toEqual({
      items: { format: "image", type: "string" },
      type: "array",
    });
    setAndFire(nestedCard(container, "avatar").querySelectorAll("sp-picker")[0]!, "boolean");
    expect(metaSchema().properties.avatar).toEqual({ type: "boolean" });
  });

  test("change nested format keeps the type and falls back to string when untyped", () => {
    const { container } = setup({
      Post: {
        properties: {
          meta: {
            properties: { author: { type: "string" }, odd: { format: "date" } },
            type: "object",
          },
        },
        type: "object",
      },
    });
    selectDef(container, "Post");
    setAndFire(nestedCard(container, "author").querySelectorAll("sp-picker")[1]!, "color");
    expect(metaSchema().properties.author).toEqual({ format: "color", type: "string" });
    setAndFire(nestedCard(container, "odd").querySelectorAll("sp-picker")[1]!, "image");
    expect(metaSchema().properties.odd).toEqual({ format: "image", type: "string" });
  });
});

// ─── Stale-DOM guards ────────────────────────────────────────────────────────

describe("stale DOM guards", () => {
  test("field events after schema parts are removed are no-ops without persisting", () => {
    const { container, state } = setup(postDefs());
    selectDef(container, "Post");
    const title = fieldCard(container, "title");
    const meta = fieldCard(container, "meta");
    const author = meta.querySelector(".schema-field-card--nested")!;
    const addRow = meta.querySelector(".schema-nested-add")!;
    const change = () => new Event("change", { bubbles: true });

    expect(() => {
      // Parent object removed → nested handlers bail
      delete config().$defs.Post.properties.meta;
      pointer(author.querySelector('[title="Delete field"]')!, "click");
      author.querySelector("sp-switch")!.dispatchEvent(change());
      setAndFire(author.querySelectorAll("sp-picker")[0]!, "number");
      setAndFire(author.querySelectorAll("sp-picker")[1]!, "color");
      setAndFire(author.querySelector(".schema-field-name-input")!, "orphanName");
      const input = addRow.querySelector(".schema-nested-add-name") as HTMLInputElement;
      input.value = "orphan";
      key(input, "Enter");

      // Properties map removed → top-level handlers bail
      delete config().$defs.Post.properties;
      pointer(title.querySelector('[title="Delete field"]')!, "click");
      setAndFire(title.querySelectorAll("sp-picker")[0]!, "number");
      setAndFire(title.querySelectorAll("sp-picker")[1]!, "date");
      setAndFire(title.querySelector(".schema-field-name-input")!, "newName");

      // Def removed entirely → toggle-required bails
      delete config().$defs.Post;
      title.querySelector("sp-switch")!.dispatchEvent(change());
    }).not.toThrow();

    expect(state.calls.filter(([name]) => name === "writeFile")).toHaveLength(0);
  });
});

// ─── Delete definition ───────────────────────────────────────────────────────

describe("delete definition", () => {
  test("removes the entry, clears selection, and persists", async () => {
    const { container, state } = setup(postDefs());
    selectDef(container, "Post");
    pointer(
      container.querySelector('.settings-editor-header [title="Delete definition"]')!,
      "click",
    );
    expect(config().$defs.Post).toBeUndefined();
    expect(config().$defs.Author).toBeDefined();
    expect(container.querySelector(".settings-empty-state")).not.toBeNull();
    await flush();
    expect(JSON.parse(state.files.get("project.json")!).$defs.Post).toBeUndefined();
  });

  test("selected def missing from config shows empty state without crashing", () => {
    const { container, state } = setup(postDefs());
    selectDef(container, "Post");
    // Re-render against a config that no longer contains the selected def
    resetStudioState({ projectConfig: { $defs: {} } as unknown });
    const fresh = document.createElement("div");
    expect(() => renderDefsEditor(fresh)).not.toThrow();
    expect(fresh.querySelector(".settings-empty-state")).not.toBeNull();
    // Delete on the stale container's header is a guarded no-op
    pointer(
      container.querySelector('.settings-editor-header [title="Delete definition"]')!,
      "click",
    );
    expect(config().$defs).toEqual({});
    expect(state.calls.filter(([name]) => name === "writeFile")).toHaveLength(0);
  });
});
