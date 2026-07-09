import { flush, installMockPlatform, key, pointer, resetStudioState } from "./harness";
import { describe, expect, test } from "bun:test";
import { renderContentTypesEditor } from "../src/settings/content-types-editor";
import { projectState } from "../src/store";

import type { MockPlatformState } from "./harness";

// ─── Local helpers ────────────────────────────────────────────────────────────
//
// The editor keeps module-level selection state, so each test installs a fresh mock platform +
// Project config and drives selection through the rendered list buttons.

type AnyConfig = Record<string, any>;

function setup(content: AnyConfig | null): {
  container: HTMLElement;
  state: MockPlatformState;
} {
  const { state } = installMockPlatform();
  resetStudioState({
    projectConfig: content === null ? null : ({ content } as unknown),
  });
  const container = document.createElement("div");
  renderContentTypesEditor(container);
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

function selectType(container: HTMLElement, name: string): void {
  const button = [...container.querySelectorAll(".settings-list-panel sp-action-button")].find(
    (b) => b.textContent?.trim() === name,
  );
  if (!button) {
    throw new Error(`no list button for content type "${name}"`);
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

function postsConfig(): AnyConfig {
  return {
    pages: {
      schema: { properties: { title: { type: "string" } }, required: [], type: "object" },
      source: "./content/pages/",
    },
    posts: {
      schema: {
        properties: {
          cover: { format: "image", type: "string" },
          meta: {
            properties: { author: { type: "string" } },
            required: ["author"],
            type: "object",
          },
          related: { $ref: "#/content/pages" },
          tags: { items: { format: "image", type: "string" }, type: "array" },
          title: { type: "string" },
        },
        required: ["title"],
        type: "object",
      },
      source: "./content/posts/",
    },
  };
}

// ─── Empty / list panel ──────────────────────────────────────────────────────

describe("content types list panel", () => {
  test("renders empty state when nothing is selected", () => {
    const { container } = setup({});
    expect(container.querySelector(".settings-empty-state")?.textContent).toContain(
      "Select or create a content type",
    );
    expect(container.querySelectorAll(".settings-list-panel sp-action-button").length).toBe(1); // Only "New Content Type"
  });

  test("lists existing content type names", () => {
    const { container } = setup(postsConfig());
    const labels = [...container.querySelectorAll(".settings-list-panel sp-action-button")].map(
      (b) => b.textContent?.trim(),
    );
    expect(labels).toContain("posts");
    expect(labels).toContain("pages");
  });

  test("selecting a content type shows its editor panel", () => {
    const { container } = setup(postsConfig());
    selectType(container, "posts");
    expect(container.querySelector(".settings-editor-header h3")?.textContent).toBe("posts");
    expect(
      container.querySelector(".settings-editor-header sp-field-label")?.textContent,
    ).toContain("./content/posts/");
    expect(container.querySelectorAll(".schema-field-card").length).toBeGreaterThanOrEqual(5);
  });

  test("source falls back to em dash when missing", () => {
    const { container } = setup({ bare: { schema: { properties: {}, type: "object" } } });
    selectType(container, "bare");
    expect(
      container.querySelector(".settings-editor-header sp-field-label")?.textContent,
    ).toContain("—");
  });
});

// ─── New content type ────────────────────────────────────────────────────────

describe("new content type flow", () => {
  test("create via Enter slugifies name, selects it, and persists files", async () => {
    const { container, state } = setup({});
    pointer(buttonByText(container, "New Content Type"), "click");
    const input = container.querySelector(".settings-inline-form sp-textfield")!;
    setAndFire(input, "My Blog Posts!", "input");
    key(input, "Enter");

    expect(config().content["my-blog-posts"]).toEqual({
      schema: { properties: {}, required: [], type: "object" },
      source: "./content/my-blog-posts/",
    });
    expect(container.querySelector(".settings-editor-header h3")?.textContent).toBe(
      "my-blog-posts",
    );
    await flush();
    expect(state.files.has("project.json")).toBe(true);
    expect(JSON.parse(state.files.get("project.json")!).content["my-blog-posts"]).toBeDefined();
    expect(state.files.get("content/my-blog-posts/.gitkeep")).toBe("");
  });

  test("create via the Create button", async () => {
    const { container, state } = setup({});
    pointer(buttonByText(container, "New Content Type"), "click");
    setAndFire(container.querySelector(".settings-inline-form sp-textfield")!, "Recipes", "input");
    pointer(buttonByText(container, "Create"), "click");
    expect(config().content.recipes).toBeDefined();
    await flush();
    expect(state.files.has("content/recipes/.gitkeep")).toBe(true);
  });

  test("name with no valid characters is rejected", async () => {
    const { container, state } = setup({});
    pointer(buttonByText(container, "New Content Type"), "click");
    const input = container.querySelector(".settings-inline-form sp-textfield")!;
    setAndFire(input, "$$$", "input");
    key(input, "Enter");
    expect(Object.keys(config().content)).toEqual([]);
    await flush();
    expect(state.files.size).toBe(0);
    key(input, "Escape"); // Reset module state
    expect(container.querySelector(".settings-inline-form")).toBeNull();
  });

  test("duplicate slug does not overwrite the existing schema", async () => {
    const existing = postsConfig();
    const { container, state } = setup(existing);
    pointer(buttonByText(container, "New Content Type"), "click");
    const input = container.querySelector(".settings-inline-form sp-textfield")!;
    setAndFire(input, "Posts", "input");
    key(input, "Enter");
    expect(config().content.posts.schema.properties.title).toEqual({ type: "string" });
    await flush();
    expect(state.files.size).toBe(0);
    key(input, "Escape");
  });

  test("Escape hides the inline form", () => {
    const { container } = setup({});
    pointer(buttonByText(container, "New Content Type"), "click");
    expect(container.querySelector(".settings-inline-form")).not.toBeNull();
    key(container.querySelector(".settings-inline-form sp-textfield")!, "Escape");
    expect(container.querySelector(".settings-inline-form")).toBeNull();
  });

  test("missing project config is a safe no-op", () => {
    const { container } = setup(null);
    pointer(buttonByText(container, "New Content Type"), "click");
    const input = container.querySelector(".settings-inline-form sp-textfield")!;
    setAndFire(input, "Whatever", "input");
    expect(() => key(input, "Enter")).not.toThrow();
    key(input, "Escape");
  });

  test("creates content map when config lacks one", () => {
    installMockPlatform();
    resetStudioState({ projectConfig: {} as unknown });
    const container = document.createElement("div");
    renderContentTypesEditor(container);
    pointer(buttonByText(container, "New Content Type"), "click");
    const input = container.querySelector(".settings-inline-form sp-textfield")!;
    setAndFire(input, "fresh", "input");
    key(input, "Enter");
    expect(config().content.fresh).toBeDefined();
  });
});

// ─── Field CRUD ──────────────────────────────────────────────────────────────

describe("add field flow", () => {
  test("add a formatted required field via the inline form", async () => {
    const { container, state } = setup(postsConfig());
    selectType(container, "posts");
    pointer(buttonByText(container, "Add Field"), "click");

    setAndFire(container.querySelector(".schema-add-field sp-textfield")!, "hero image", "input");
    const sw = container.querySelector(".schema-add-field sp-switch") as HTMLInputElement;
    sw.checked = true;
    sw.dispatchEvent(new Event("change", { bubbles: true }));
    setAndFire(container.querySelectorAll(".schema-add-field sp-picker")[1]!, "image");
    pointer(buttonByText(container, "Add"), "click");

    const { schema } = config().content.posts;
    expect(schema.properties.heroImage).toEqual({ format: "image", type: "string" });
    expect(schema.required).toContain("heroImage");
    expect(container.querySelector(".schema-add-field")).toBeNull();
    await flush();
    expect(state.files.has("project.json")).toBe(true);
  });

  test("changing the type to object hides the format picker and adds an object skeleton", () => {
    const { container } = setup(postsConfig());
    selectType(container, "posts");
    pointer(buttonByText(container, "Add Field"), "click");
    setAndFire(container.querySelector(".schema-add-field sp-textfield")!, "extras", "input");
    setAndFire(container.querySelectorAll(".schema-add-field sp-picker")[0]!, "object");
    expect(container.querySelectorAll(".schema-add-field sp-picker").length).toBe(1);
    key(container.querySelector(".schema-add-field sp-textfield")!, "Enter");
    expect(config().content.posts.schema.properties.extras).toEqual({
      properties: {},
      required: [],
      type: "object",
    });
  });

  test("empty name keeps the form open; Cancel resets it", () => {
    const { container } = setup(postsConfig());
    selectType(container, "posts");
    pointer(buttonByText(container, "Add Field"), "click");
    key(container.querySelector(".schema-add-field sp-textfield")!, "Enter");
    expect(container.querySelector(".schema-add-field")).not.toBeNull();

    setAndFire(container.querySelector(".schema-add-field sp-textfield")!, "draft", "input");
    pointer(buttonByText(container, "Cancel"), "click");
    expect(container.querySelector(".schema-add-field")).toBeNull();
    expect(config().content.posts.schema.properties.draft).toBeUndefined();

    // Reopening shows a reset form
    pointer(buttonByText(container, "Add Field"), "click");
    const input = container.querySelector(".schema-add-field sp-textfield") as HTMLInputElement;
    expect(input.value ?? "").toBe("");
    key(input, "Escape");
  });

  test("content type without a schema is a safe no-op (no persist)", async () => {
    const { container, state } = setup({ broken: { source: "./content/broken/" } });
    selectType(container, "broken");
    pointer(buttonByText(container, "Add Field"), "click");
    setAndFire(container.querySelector(".schema-add-field sp-textfield")!, "x", "input");
    key(container.querySelector(".schema-add-field sp-textfield")!, "Enter");
    await flush();
    expect(state.files.size).toBe(0);
    pointer(buttonByText(container, "Cancel"), "click");
  });

  test("creates properties and required maps when schema lacks them", () => {
    const { container } = setup({ slim: { schema: { type: "object" }, source: "./x/" } });
    selectType(container, "slim");
    pointer(buttonByText(container, "Add Field"), "click");
    setAndFire(container.querySelector(".schema-add-field sp-textfield")!, "title", "input");
    const sw = container.querySelector(".schema-add-field sp-switch") as HTMLInputElement;
    sw.checked = true;
    sw.dispatchEvent(new Event("change", { bubbles: true }));
    key(container.querySelector(".schema-add-field sp-textfield")!, "Enter");
    expect(config().content.slim.schema.properties.title).toEqual({ type: "string" });
    expect(config().content.slim.schema.required).toEqual(["title"]);
  });
});

describe("field mutations", () => {
  test("delete removes the property and its required entry", async () => {
    const { container, state } = setup(postsConfig());
    selectType(container, "posts");
    pointer(fieldCard(container, "title").querySelector('[title="Delete field"]')!, "click");
    const { schema } = config().content.posts;
    expect(schema.properties.title).toBeUndefined();
    expect(schema.required).not.toContain("title");
    expect(() => fieldCard(container, "title")).toThrow();
    await flush();
    expect(state.files.has("project.json")).toBe(true);
  });

  test("toggle required adds then removes the field", () => {
    const { container } = setup(postsConfig());
    selectType(container, "posts");
    const fire = () =>
      fieldCard(container, "cover")
        .querySelector("sp-switch")!
        .dispatchEvent(new Event("change", { bubbles: true }));
    fire();
    expect(config().content.posts.schema.required).toContain("cover");
    fire();
    expect(config().content.posts.schema.required).not.toContain("cover");
  });

  test("toggle required initializes a missing required array", () => {
    const { container } = setup({
      slim: { schema: { properties: { a: { type: "string" } }, type: "object" }, source: "./x/" },
    });
    selectType(container, "slim");
    fieldCard(container, "a")
      .querySelector("sp-switch")!
      .dispatchEvent(new Event("change", { bubbles: true }));
    expect(config().content.slim.schema.required).toEqual(["a"]);
  });

  test("rename camelCases the new name, remaps required, and preserves order", () => {
    const { container } = setup(postsConfig());
    selectType(container, "posts");
    const before = Object.keys(config().content.posts.schema.properties);
    setAndFire(
      fieldCard(container, "title").querySelector(".schema-field-name-input")!,
      "post title",
    );
    const { schema } = config().content.posts;
    expect(schema.properties.postTitle).toEqual({ type: "string" });
    expect(schema.properties.title).toBeUndefined();
    expect(schema.required).toContain("postTitle");
    expect(Object.keys(schema.properties)).toEqual(
      before.map((k) => (k === "title" ? "postTitle" : k)),
    );
  });

  test("rename to an existing field name is rejected", () => {
    const { container } = setup(postsConfig());
    selectType(container, "posts");
    setAndFire(fieldCard(container, "title").querySelector(".schema-field-name-input")!, "cover");
    const { schema } = config().content.posts;
    expect(schema.properties.title).toEqual({ type: "string" });
    expect(schema.properties.cover).toEqual({ format: "image", type: "string" });
  });

  test("change type string→array preserves the format on items", () => {
    const { container } = setup(postsConfig());
    selectType(container, "posts");
    setAndFire(fieldCard(container, "cover").querySelectorAll("sp-picker")[0]!, "array");
    expect(config().content.posts.schema.properties.cover).toEqual({
      items: { format: "image", type: "string" },
      type: "array",
    });
  });

  test("change type to number drops the format", () => {
    const { container } = setup(postsConfig());
    selectType(container, "posts");
    setAndFire(fieldCard(container, "cover").querySelectorAll("sp-picker")[0]!, "number");
    expect(config().content.posts.schema.properties.cover).toEqual({ type: "number" });
  });

  test("change format keeps the field type", () => {
    const { container } = setup(postsConfig());
    selectType(container, "posts");
    setAndFire(fieldCard(container, "title").querySelectorAll("sp-picker")[1]!, "date");
    expect(config().content.posts.schema.properties.title).toEqual({
      format: "date",
      type: "string",
    });
    // Array field: format lands on items
    setAndFire(fieldCard(container, "tags").querySelectorAll("sp-picker")[1]!, "color");
    expect(config().content.posts.schema.properties.tags).toEqual({
      items: { format: "color", type: "string" },
      type: "array",
    });
  });

  test("change reference target rewrites the $ref", () => {
    const { container } = setup(postsConfig());
    selectType(container, "posts");
    const refPicker = fieldCard(container, "related").querySelector(
      ".schema-field-ref-target sp-picker",
    )!;
    expect(refPicker.getAttribute("value")).toBe("pages");
    setAndFire(refPicker, "posts");
    expect(config().content.posts.schema.properties.related).toEqual({
      $ref: "#/content/posts",
    });
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
    return config().content.posts.schema.properties.meta;
  }

  test("add nested field via Enter (with picked type) and via button", async () => {
    const { container, state } = setup(postsConfig());
    selectType(container, "posts");

    const row = metaCard(container).querySelector(".schema-nested-add")!;
    const input = row.querySelector(".schema-nested-add-name") as HTMLInputElement;
    input.value = "birth year";
    (row.querySelector("sp-picker") as HTMLInputElement).value = "number";
    key(input, "Enter");
    expect(metaSchema().properties.birthYear).toEqual({ type: "number" });

    const row2 = metaCard(container).querySelector(".schema-nested-add")!;
    (row2.querySelector(".schema-nested-add-name") as HTMLInputElement).value = "homepage";
    // Empty picker value exercises the "string" fallback in the add-button handler
    (row2.querySelector("sp-picker") as HTMLInputElement).value = "";
    pointer(row2.querySelector('[title="Add nested field"]')!, "click");
    expect(metaSchema().properties.homepage).toEqual({ type: "string" });
    await flush();
    expect(state.files.has("project.json")).toBe(true);
  });

  test("add nested field with required flag and missing parent maps", () => {
    const { container } = setup({
      posts: {
        schema: { properties: { meta: { type: "object" } }, type: "object" },
        source: "./x/",
      },
    });
    selectType(container, "posts");
    const row = metaCard(container).querySelector(".schema-nested-add")!;
    const input = row.querySelector(".schema-nested-add-name") as HTMLInputElement;
    input.value = "slug";
    key(input, "Enter"); // Parent had no properties map — created on demand
    expect(metaSchema().properties.slug).toEqual({ type: "string" });
  });

  test("nested name that normalizes to empty is rejected", () => {
    const { container } = setup(postsConfig());
    selectType(container, "posts");
    const before = Object.keys(metaSchema().properties);
    const row = metaCard(container).querySelector(".schema-nested-add")!;
    const input = row.querySelector(".schema-nested-add-name") as HTMLInputElement;
    input.value = "$$$"; // Trimmed name is truthy but camelCases to ""
    key(input, "Enter");
    expect(Object.keys(metaSchema().properties)).toEqual(before);
  });

  test("delete nested removes property and required entry", () => {
    const { container } = setup(postsConfig());
    selectType(container, "posts");
    pointer(nestedCard(container, "author").querySelector('[title="Delete field"]')!, "click");
    expect(metaSchema().properties.author).toBeUndefined();
    expect(metaSchema().required).not.toContain("author");
  });

  test("toggle nested required removes then re-adds", () => {
    const { container } = setup(postsConfig());
    selectType(container, "posts");
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
      posts: {
        schema: {
          properties: { meta: { properties: { a: { type: "string" } }, type: "object" } },
          type: "object",
        },
        source: "./x/",
      },
    });
    selectType(container, "posts");
    nestedCard(container, "a")
      .querySelector("sp-switch")!
      .dispatchEvent(new Event("change", { bubbles: true }));
    expect(metaSchema().required).toEqual(["a"]);
  });

  test("rename nested remaps required; conflicting rename is rejected", () => {
    const { container } = setup(postsConfig());
    selectType(container, "posts");
    setAndFire(
      nestedCard(container, "author").querySelector(".schema-field-name-input")!,
      "author name",
    );
    expect(metaSchema().properties.authorName).toEqual({ type: "string" });
    expect(metaSchema().required).toContain("authorName");

    // Add a second child, then attempt a conflicting rename
    const row = metaCard(container).querySelector(".schema-nested-add")!;
    (row.querySelector(".schema-nested-add-name") as HTMLInputElement).value = "city";
    key(row.querySelector(".schema-nested-add-name")!, "Enter");
    setAndFire(
      nestedCard(container, "city").querySelector(".schema-field-name-input")!,
      "authorName",
    );
    expect(metaSchema().properties.city).toEqual({ type: "string" });
  });

  test("change nested type preserves format when switching string→array", () => {
    const { container } = setup({
      posts: {
        schema: {
          properties: {
            meta: {
              properties: { avatar: { format: "image", type: "string" } },
              type: "object",
            },
          },
          type: "object",
        },
        source: "./x/",
      },
    });
    selectType(container, "posts");
    setAndFire(nestedCard(container, "avatar").querySelectorAll("sp-picker")[0]!, "array");
    expect(metaSchema().properties.avatar).toEqual({
      items: { format: "image", type: "string" },
      type: "array",
    });
    // And to boolean drops the format
    setAndFire(nestedCard(container, "avatar").querySelectorAll("sp-picker")[0]!, "boolean");
    expect(metaSchema().properties.avatar).toEqual({ type: "boolean" });
  });

  test("change nested format keeps the type", () => {
    const { container } = setup(postsConfig());
    selectType(container, "posts");
    setAndFire(nestedCard(container, "author").querySelectorAll("sp-picker")[1]!, "color");
    expect(metaSchema().properties.author).toEqual({ format: "color", type: "string" });
  });
});

// ─── Stale-DOM guards ────────────────────────────────────────────────────────
//
// Events can fire from DOM rendered before the schema changed underneath it (e.g. an external
// Config reload). Every handler guards against the missing schema/field and must not persist.

describe("stale DOM guards", () => {
  test("field events after schema parts are removed are no-ops without persisting", () => {
    const { container, state } = setup(postsConfig());
    selectType(container, "posts");
    const title = fieldCard(container, "title");
    const related = fieldCard(container, "related");
    const meta = fieldCard(container, "meta");
    const author = meta.querySelector(".schema-field-card--nested")!;
    const addRow = meta.querySelector(".schema-nested-add")!;
    const change = () => new Event("change", { bubbles: true });

    expect(() => {
      // Parent object removed → nested handlers bail
      delete config().content.posts.schema.properties.meta;
      pointer(author.querySelector('[title="Delete field"]')!, "click");
      author.querySelector("sp-switch")!.dispatchEvent(change());
      setAndFire(author.querySelectorAll("sp-picker")[0]!, "number");
      setAndFire(author.querySelectorAll("sp-picker")[1]!, "color");
      const input = addRow.querySelector(".schema-nested-add-name") as HTMLInputElement;
      input.value = "orphan";
      key(input, "Enter");

      // Properties map removed → top-level handlers bail
      delete config().content.posts.schema.properties;
      pointer(title.querySelector('[title="Delete field"]')!, "click");
      setAndFire(title.querySelectorAll("sp-picker")[0]!, "number");
      setAndFire(title.querySelectorAll("sp-picker")[1]!, "date");
      setAndFire(related.querySelector(".schema-field-ref-target sp-picker")!, "posts");

      // Schema removed entirely → toggle-required bails
      delete config().content.posts.schema;
      title.querySelector("sp-switch")!.dispatchEvent(change());
    }).not.toThrow();

    expect(state.calls.filter(([name]) => name === "writeFile")).toHaveLength(0);
  });
});

// ─── Delete content type ─────────────────────────────────────────────────────

describe("delete content type", () => {
  test("removes the entry, clears selection, and persists", async () => {
    const { container, state } = setup(postsConfig());
    selectType(container, "posts");
    pointer(
      container.querySelector('.settings-editor-header [title="Delete content type"]')!,
      "click",
    );
    expect(config().content.posts).toBeUndefined();
    expect(config().content.pages).toBeDefined();
    expect(container.querySelector(".settings-empty-state")).not.toBeNull();
    await flush();
    expect(JSON.parse(state.files.get("project.json")!).content.posts).toBeUndefined();
  });

  test("selected type missing from config shows empty state without crashing", () => {
    const { container } = setup(postsConfig());
    selectType(container, "posts");
    // Re-render against a config that no longer contains the selected type
    resetStudioState({ projectConfig: { content: {} } as unknown });
    const fresh = document.createElement("div");
    expect(() => renderContentTypesEditor(fresh)).not.toThrow();
    expect(fresh.querySelector(".settings-empty-state")).not.toBeNull();
    // Delete on the stale container's header is a guarded no-op
    pointer(
      container.querySelector('.settings-editor-header [title="Delete content type"]')!,
      "click",
    );
    expect(config().content).toEqual({});
  });
});
