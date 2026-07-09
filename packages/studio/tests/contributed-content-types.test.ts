/**
 * End-to-end parity suite for the descriptor-contributed Content Types section — the replacement
 * for the deleted bespoke content-types editor. The fixture is the REAL @jxsuite/parser
 * contribution: Content.class.json's `project` + `$studio.settings` blocks paired with the shipped
 * project fragment's `properties.content` section schema, exactly the wire shape the backend
 * serves. It drives the full old-editor surface through renderContributedSection: content-type
 * create (newEntry template with ${key} substitution), rename/delete, and field add/rename/
 * delete/require/type/format/reference/nested edits via the schema-builder control — all persisting
 * through projectState.projectConfig + platform.writeFile("project.json", …).
 *
 * Parity note: the parser fragment declares the content-type `format` as a plain string, so it
 * renders as a textfield (a `#/$context/$formats` enum would render a picker) — same as the old
 * editor, which surfaced no format control at all.
 */
import { flush, installMockPlatform, key, pointer, resetStudioState } from "./harness";
import { beforeEach, describe, expect, test } from "bun:test";
import contentClass from "@jxsuite/parser/Content.class.json";
import parserFragment from "@jxsuite/parser/schemas/project.fragment.schema.json";
import { deriveSettingsSection } from "../src/settings/extension-sections";
import {
  renderContributedSection,
  resetContributedSectionState,
} from "../src/settings/contributed-section";
import { resetFormControlUiState } from "../src/ui/form-controls";
import { projectState } from "../src/store";
import type { ExtensionContributionInfo } from "../src/types";
import type { MockPlatformState } from "./harness";
import type { SettingsContribution } from "../src/settings/contributed-section";

type ValueEl = HTMLElement & { value: string };
type AnyRecord = Record<string, any>;

// ─── The real parser contribution, exactly as the backend wires it ──────────

const parserClass = contentClass as AnyRecord;
const fragment = parserFragment as AnyRecord;

const wireContribution: ExtensionContributionInfo = {
  className: "Content",
  entrySchema: fragment.properties.content,
  project: parserClass.project,
  studio: parserClass.$studio,
};

function derivedContribution(): SettingsContribution {
  const derived = deriveSettingsSection(wireContribution);
  if (!derived) {
    throw new Error("parser's Content class must derive a settings section");
  }
  return derived.contribution;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function commitValue(el: Element, value: string): void {
  (el as ValueEl).value = value;
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function inputValue(el: Element, value: string): void {
  (el as ValueEl).value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
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

function pickerIn(scope: HTMLElement, label: string): ValueEl {
  const el = scope.querySelector(`sp-picker[label="${label}"]`);
  if (!el) {
    throw new Error(`no ${label} picker`);
  }
  return el as ValueEl;
}

/** The (top-level) field card whose name input carries the given field name. */
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

function selectType(container: HTMLElement, name: string): void {
  const button = [...container.querySelectorAll(".settings-list-panel sp-action-button")].find(
    (b) => b.textContent?.trim() === name,
  );
  if (!button) {
    throw new Error(`no list button for content type "${name}"`);
  }
  pointer(button, "click");
}

function config(): AnyRecord {
  return (projectState as AnyRecord).projectConfig;
}

function projectWrites(state: MockPlatformState): string[] {
  return state.calls
    .filter((c) => c[0] === "writeFile" && c[1] === "project.json")
    .map((c) => c[2] as string);
}

function postsConfig(): AnyRecord {
  return {
    pages: {
      schema: { properties: { title: { type: "string" } }, required: [], type: "object" },
      source: "./content/pages/",
    },
    posts: {
      format: "Markdown",
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

let platformState: MockPlatformState;
let container: HTMLElement;

function setup(content: AnyRecord | null): void {
  ({ state: platformState } = installMockPlatform());
  resetStudioState({
    projectConfig: content === null ? null : ({ content } as unknown),
  });
  container = document.createElement("div");
  renderContributedSection(container, derivedContribution());
}

beforeEach(() => {
  resetContributedSectionState();
  resetFormControlUiState();
});

// ─── Fixture sanity: the real descriptor drives the section ─────────────────

describe("parser contribution fixture", () => {
  test("Content.class.json declares the map-layout settings block the section runs on", () => {
    const contribution = derivedContribution();
    expect(contribution.key).toBe("content");
    expect(contribution.title).toBe("Content Types");
    expect(contribution.settings.layout).toBe("map");
    expect(contribution.settings.entry?.ui).toEqual({ schema: { control: "schema-builder" } });
    expect(contribution.settings.entry?.newEntry).toEqual({
      schema: { properties: {}, required: [], type: "object" },
      source: "./content/${key}/",
    });
    // The per-entry form schema comes from the fragment's additionalProperties.
    expect(Object.keys(contribution.entrySchema.properties ?? {})).toEqual([
      "$elements",
      "format",
      "schema",
      "source",
    ]);
  });
});

// ─── List panel / entry form ─────────────────────────────────────────────────

describe("content types list panel", () => {
  test("renders empty state when nothing is selected", () => {
    setup({});
    expect(container.querySelector(".settings-empty-state")?.textContent).toContain(
      "Select or create an entry",
    );
    expect(container.querySelectorAll(".settings-list-panel sp-action-button").length).toBe(1); // Only "New Entry"
  });

  test("lists existing content type names and opens the entry form on select", () => {
    setup(postsConfig());
    const labels = [...container.querySelectorAll(".settings-list-panel sp-action-button")].map(
      (b) => b.textContent?.trim(),
    );
    expect(labels).toContain("posts");
    expect(labels).toContain("pages");

    selectType(container, "posts");
    expect(container.querySelector(".settings-editor-panel")).not.toBeNull();
    expect((container.querySelector(".entry-name-input") as ValueEl).getAttribute("value")).toBe(
      "posts",
    );
    // Source and format are editable form fields fed by the fragment schema.
    const source = container.querySelector('[data-prop="source"] sp-textfield') as ValueEl;
    expect(source.value).toBe("./content/posts/");
    // The fragment declares `format` as a plain string → a textfield, not a picker.
    expect(container.querySelector('[data-prop="format"] sp-textfield')).not.toBeNull();
    expect(container.querySelector('[data-prop="format"] sp-picker')).toBeNull();
    // The schema field renders through the schema-builder control with one card per field.
    expect(container.querySelector('[data-prop="schema"] .schema-builder')).not.toBeNull();
    expect(container.querySelectorAll(".schema-field-card").length).toBeGreaterThanOrEqual(5);
  });
});

// ─── New content type ────────────────────────────────────────────────────────

describe("new content type flow", () => {
  test("create via Enter slugifies the name and instantiates the newEntry template", async () => {
    setup({});
    pointer(buttonByText(container, "New Entry"), "click");
    const input = container.querySelector(".settings-inline-form sp-textfield")!;
    inputValue(input, "My Blog Posts!");
    key(input, "Enter");
    await flush();

    // Full old-editor parity: source from ${key} substitution + the empty object schema.
    expect(config().content["my-blog-posts"]).toEqual({
      schema: { properties: {}, required: [], type: "object" },
      source: "./content/my-blog-posts/",
    });
    expect((container.querySelector(".entry-name-input") as ValueEl).getAttribute("value")).toBe(
      "my-blog-posts",
    );
    expect(projectWrites(platformState)).toHaveLength(1);
    expect(JSON.parse(platformState.files.get("project.json")!).content["my-blog-posts"]).toEqual(
      config().content["my-blog-posts"],
    );
  });

  test("blank and duplicate names are rejected; Escape closes the inline form", async () => {
    setup(postsConfig());
    pointer(buttonByText(container, "New Entry"), "click");
    const input = () => container.querySelector(".settings-inline-form sp-textfield")!;

    inputValue(input(), "$$$");
    key(input(), "Enter");
    expect(Object.keys(config().content)).toEqual(["pages", "posts"]);

    inputValue(input(), "Posts");
    key(input(), "Enter");
    expect(config().content.posts.schema.properties.title).toEqual({ type: "string" });

    key(input(), "Escape");
    expect(container.querySelector(".settings-inline-form")).toBeNull();
    await flush();
    expect(projectWrites(platformState)).toHaveLength(0);
  });

  test("missing project config drops the create silently", () => {
    setup(null);
    pointer(buttonByText(container, "New Entry"), "click");
    const input = container.querySelector(".settings-inline-form sp-textfield")!;
    inputValue(input, "whatever");
    expect(() => key(input, "Enter")).not.toThrow();
    expect(projectWrites(platformState)).toHaveLength(0);
  });
});

// ─── Rename / delete content type ────────────────────────────────────────────

describe("content type rename and delete", () => {
  test("rename slugifies, preserves order, and skips collisions", async () => {
    setup(postsConfig());
    selectType(container, "posts");
    commitValue(container.querySelector(".entry-name-input")!, "Blog Posts");
    await flush();
    expect(Object.keys(config().content)).toEqual(["pages", "blog-posts"]);
    expect(config().content["blog-posts"].source).toBe("./content/posts/");

    commitValue(container.querySelector(".entry-name-input")!, "pages");
    expect(Object.keys(config().content)).toEqual(["pages", "blog-posts"]);
    expect(projectWrites(platformState)).toHaveLength(1);
  });

  test("delete removes the entry and returns to the empty state", async () => {
    setup(postsConfig());
    selectType(container, "posts");
    pointer(container.querySelector('[title="Delete entry"]')!, "click");
    await flush();
    expect(config().content.posts).toBeUndefined();
    expect(config().content.pages).toBeDefined();
    expect(container.querySelector(".settings-empty-state")).not.toBeNull();
    expect(JSON.parse(platformState.files.get("project.json")!).content.posts).toBeUndefined();
  });
});

// ─── Schema-builder field CRUD (the old editor's core surface) ───────────────

describe("schema fields through the schema-builder control", () => {
  function postsSchema(): AnyRecord {
    return config().content.posts.schema;
  }

  test("add a formatted required field via the inline add form", async () => {
    setup(postsConfig());
    selectType(container, "posts");
    pointer(buttonByText(container, "Add Field"), "click");

    const addForm = () => container.querySelector(".schema-add-field") as HTMLElement;
    inputValue(addForm().querySelector("sp-textfield")!, "hero image");
    commitValue(pickerIn(addForm(), "Format"), "image");
    const sw = addForm().querySelector("sp-switch") as HTMLElement & { checked: boolean };
    sw.checked = true;
    sw.dispatchEvent(new Event("change", { bubbles: true }));
    pointer(buttonByText(addForm(), "Add"), "click");
    await flush();

    expect(postsSchema().properties.heroImage).toEqual({ format: "image", type: "string" });
    expect(postsSchema().required).toContain("heroImage");
    expect(container.querySelector(".schema-add-field")).toBeNull();
    expect(projectWrites(platformState).length).toBeGreaterThanOrEqual(1);
  });

  test("rename camelCases, remaps required, preserves order, and rejects collisions", async () => {
    setup(postsConfig());
    selectType(container, "posts");
    const before = Object.keys(postsSchema().properties);
    commitValue(
      fieldCard(container, "title").querySelector(".schema-field-name-input")!,
      "post title",
    );
    await flush();
    expect(postsSchema().properties.postTitle).toEqual({ type: "string" });
    expect(postsSchema().properties.title).toBeUndefined();
    expect(postsSchema().required).toContain("postTitle");
    expect(Object.keys(postsSchema().properties)).toEqual(
      before.map((k) => (k === "title" ? "postTitle" : k)),
    );

    commitValue(fieldCard(container, "cover").querySelector(".schema-field-name-input")!, "tags");
    expect(postsSchema().properties.cover).toEqual({ format: "image", type: "string" });
  });

  test("delete removes the property and its required entry", async () => {
    setup(postsConfig());
    selectType(container, "posts");
    pointer(fieldCard(container, "title").querySelector('[title="Delete field"]')!, "click");
    await flush();
    expect(postsSchema().properties.title).toBeUndefined();
    expect(postsSchema().required).not.toContain("title");
    expect(() => fieldCard(container, "title")).toThrow();
    expect(projectWrites(platformState).length).toBeGreaterThanOrEqual(1);
  });

  test("required toggles on and off through the field switch", () => {
    setup(postsConfig());
    selectType(container, "posts");
    const fire = () =>
      fieldCard(container, "cover")
        .querySelector("sp-switch")!
        .dispatchEvent(new Event("change", { bubbles: true }));
    fire();
    expect(postsSchema().required).toContain("cover");
    fire();
    expect(postsSchema().required).not.toContain("cover");
  });

  test("type change string→array preserves the format on items; number drops it", () => {
    setup(postsConfig());
    selectType(container, "posts");
    commitValue(pickerIn(fieldCard(container, "cover"), "Type"), "array");
    expect(postsSchema().properties.cover).toEqual({
      items: { format: "image", type: "string" },
      type: "array",
    });
    commitValue(pickerIn(fieldCard(container, "cover"), "Type"), "number");
    expect(postsSchema().properties.cover).toEqual({ type: "number" });
  });

  test("format change keeps the type, landing on items for arrays", () => {
    setup(postsConfig());
    selectType(container, "posts");
    commitValue(pickerIn(fieldCard(container, "title"), "Format"), "date");
    expect(postsSchema().properties.title).toEqual({ format: "date", type: "string" });
    commitValue(pickerIn(fieldCard(container, "tags"), "Format"), "color");
    expect(postsSchema().properties.tags).toEqual({
      items: { format: "color", type: "string" },
      type: "array",
    });
  });

  test("reference fields pick targets from the live content map", () => {
    setup(postsConfig());
    selectType(container, "posts");
    const refPicker = fieldCard(container, "related").querySelector(
      ".schema-field-ref-target sp-picker",
    )!;
    expect(refPicker.getAttribute("value")).toBe("pages");
    const options = [...refPicker.querySelectorAll("sp-menu-item")].map((el) =>
      el.getAttribute("value"),
    );
    // Targets resolve through #/$context/content over the real project config.
    expect(options).toEqual(["pages", "posts"]);
    commitValue(refPicker, "posts");
    expect(postsSchema().properties.related).toEqual({ $ref: "#/content/posts" });
  });

  test("nested fields add, rename, toggle required, and delete under an object field", async () => {
    setup(postsConfig());
    selectType(container, "posts");
    const metaCard = () => fieldCard(container, "meta");
    const metaSchema = () => postsSchema().properties.meta;

    const addRow = metaCard().querySelector(".schema-nested-add")!;
    const nameInput = addRow.querySelector(".schema-nested-add-name") as HTMLInputElement;
    nameInput.value = "birth year";
    (addRow.querySelector("sp-picker") as ValueEl).value = "number";
    key(nameInput, "Enter");
    expect(metaSchema().properties.birthYear).toEqual({ type: "number" });

    const nestedCard = (child: string) => {
      const card = [...metaCard().querySelectorAll(".schema-field-card--nested")].find(
        (c) => c.querySelector(".schema-field-name-input")?.getAttribute("value") === child,
      );
      if (!card) {
        throw new Error(`no nested card "${child}"`);
      }
      return card as HTMLElement;
    };

    commitValue(nestedCard("author").querySelector(".schema-field-name-input")!, "author name");
    expect(metaSchema().properties.authorName).toEqual({ type: "string" });
    expect(metaSchema().required).toContain("authorName");

    nestedCard("authorName")
      .querySelector("sp-switch")!
      .dispatchEvent(new Event("change", { bubbles: true }));
    expect(metaSchema().required).not.toContain("authorName");

    pointer(nestedCard("birthYear").querySelector('[title="Delete field"]')!, "click");
    expect(metaSchema().properties.birthYear).toBeUndefined();
    await flush();
    expect(projectWrites(platformState).length).toBeGreaterThanOrEqual(3);
  });

  test("every schema edit persists the whole project config to project.json", async () => {
    setup(postsConfig());
    selectType(container, "posts");
    pointer(fieldCard(container, "cover").querySelector('[title="Delete field"]')!, "click");
    await flush();
    const persisted = JSON.parse(platformState.files.get("project.json")!);
    expect(persisted.content.posts.schema.properties.cover).toBeUndefined();
    expect(persisted.content.posts.format).toBe("Markdown");
    expect(persisted.content.pages).toBeDefined();
  });
});
