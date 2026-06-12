/**
 * Gap coverage for src/settings/content-types-editor.ts.
 *
 * The `required: true` branch of handleAddNestedField (the editor's onAddNestedField handler) is
 * unreachable through the rendered DOM: both nested-add call sites in schema-field-ui.ts hard-code
 * `required: false`. The handler contract (FieldHandlers) still allows required nested adds, so we
 * stub the field-card template module to capture the handlers object the editor wires up, then
 * drive that path directly.
 */
import { flush, installMockPlatform, pointer, resetStudioState } from "./harness";
import { expect, mock, test } from "bun:test";
import { html } from "lit-html";
import { projectState } from "../src/store";

let capturedHandlers: Record<string, (...args: never[]) => void> | null = null;

// Minimal stand-ins for the schema-field-ui templates; schemaForType mirrors the real module's
// String/number cases, which is all these tests add.
mock.module("../src/settings/schema-field-ui", () => ({
  addFieldFormTpl: () => html``,
  detectFieldFormat: () => "",
  fieldCardTpl: (
    _name: string,
    _def: unknown,
    _isRequired: boolean,
    handlers: Record<string, (...args: never[]) => void>,
  ) => {
    capturedHandlers = handlers;
    return html``;
  },
  schemaForType: (type: string) => (type === "number" ? { type: "number" } : { type: "string" }),
}));

const { renderContentTypesEditor } = await import("../src/settings/content-types-editor");

function setup() {
  capturedHandlers = null;
  const { state } = installMockPlatform();
  resetStudioState({
    projectConfig: {
      contentTypes: {
        posts: {
          schema: {
            properties: { meta: { properties: {}, type: "object" } },
            required: [],
            type: "object",
          },
          source: "./content/posts/",
        },
      },
    },
  });
  const container = document.createElement("div");
  renderContentTypesEditor(container);
  const button = [...container.querySelectorAll(".settings-list-panel sp-action-button")].find(
    (b) => b.textContent?.trim() === "posts",
  );
  if (!button) {
    throw new Error("no list button for posts");
  }
  pointer(button, "click");
  return { container, state };
}

function metaSchema(): Record<string, any> {
  return (projectState as Record<string, any>).projectConfig.contentTypes.posts.schema.properties
    .meta;
}

test("add nested field with required: true initializes and appends to parent.required", async () => {
  const { state } = setup();
  expect(capturedHandlers).not.toBeNull();

  // Parent has no required array yet — the handler must create it.
  delete metaSchema().required;
  capturedHandlers!.onAddNestedField!(
    "meta" as never,
    { name: "slug name", required: true, type: "string" } as never,
  );
  expect(metaSchema().properties.slugName).toEqual({ type: "string" });
  expect(metaSchema().required).toEqual(["slugName"]);

  await flush();
  expect(state.files.has("project.json")).toBe(true);
});

test("re-adding an already-required nested field does not duplicate the required entry", () => {
  setup();
  capturedHandlers!.onAddNestedField!(
    "meta" as never,
    { name: "slug", required: true, type: "string" } as never,
  );
  capturedHandlers!.onAddNestedField!(
    "meta" as never,
    { name: "slug", required: true, type: "number" } as never,
  );
  expect(metaSchema().properties.slug).toEqual({ type: "number" });
  expect(metaSchema().required).toEqual(["slug"]);
});
