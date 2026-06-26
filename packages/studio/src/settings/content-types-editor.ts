/// <reference lib="dom" />
/**
 * Content Types Editor — visual schema builder for project content types.
 *
 * Renders inside the Settings view "Content Types" tab. Two-column layout: left column lists
 * content type names, right column edits the selected content type's schema.
 */

import { html, render as litRender } from "lit-html";
import { repeat } from "lit-html/directives/repeat.js";
import { getPlatform } from "../platform";
import { projectState } from "../store";
import { addFieldFormTpl, detectFieldFormat, fieldCardTpl, schemaForType } from "./schema-field-ui";
import { toCamelCase } from "../utils/studio-utils";

import type { FieldHandlers, SchemaProperty } from "./schema-field-ui.js";
import type {
  ContentTypeSchema,
  ContentTypeSchemaField,
  ProjectConfig,
} from "@jxsuite/schema/types";

// ─── Module state ─────────────────────────────────────────────────────────────

let selectedContentType: string | null = null;
let showAddField = false;
let newFieldState = { format: "", name: "", required: false, type: "string" };
let showNewContentType = false;
let newContentTypeName = "";

// ─── Persistence ──────────────────────────────────────────────────────────────

async function saveProjectConfig() {
  const platform = getPlatform();
  const config = (projectState as { projectConfig: ProjectConfig }).projectConfig;
  await platform.writeFile("project.json", JSON.stringify(config, null, "\t"));
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Get the schema object for the selected content type. */
function getSelectedSchema(): ContentTypeSchema | undefined {
  const config = projectState?.projectConfig;
  return config?.contentTypes?.[selectedContentType as string]?.schema as
    | ContentTypeSchema
    | undefined;
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

/** @param {() => void} rerender */
function handleNewContentType(rerender: () => void) {
  const slug = newContentTypeName
    .toLowerCase()
    .replaceAll(/\s+/g, "-")
    .replaceAll(/[^a-z0-9-]/g, "");
  if (!slug) {
    return;
  }

  const config = projectState?.projectConfig;
  if (!config) {
    return;
  }
  if (!config.contentTypes) {
    config.contentTypes = {};
  }
  if (config.contentTypes[slug]) {
    return;
  } // Already exists

  config.contentTypes[slug] = {
    schema: { properties: {}, required: [], type: "object" },
    source: `./content/${slug}/`,
  };

  selectedContentType = slug;
  showNewContentType = false;
  newContentTypeName = "";
  rerender();

  // Persist in background
  void saveProjectConfig().then(async () => {
    const platform = getPlatform();
    await platform.writeFile(`content/${slug}/.gitkeep`, "");
  });
}

/** @param {() => void} rerender */
function handleAddField(rerender: () => void) {
  const raw = newFieldState.name.trim();
  if (!raw || !selectedContentType) {
    return;
  }
  const name = toCamelCase(raw);

  const schema = getSelectedSchema();
  if (!schema) {
    return;
  }

  if (!schema.properties) {
    schema.properties = {};
  }
  schema.properties[name] = schemaForType(newFieldState.type, newFieldState.format || undefined);

  if (newFieldState.required) {
    if (!schema.required) {
      schema.required = [];
    }
    if (!schema.required.includes(name)) {
      schema.required.push(name);
    }
  }

  showAddField = false;
  newFieldState = { format: "", name: "", required: false, type: "string" };
  rerender();
  void saveProjectConfig();
}

/**
 * @param {string} fieldName
 * @param {() => void} rerender
 */
function handleDeleteField(fieldName: string, rerender: () => void) {
  const schema = getSelectedSchema();
  if (!schema?.properties) {
    return;
  }

  delete schema.properties[fieldName];
  if (schema.required) {
    schema.required = schema.required.filter((r: string) => r !== fieldName);
  }

  rerender();
  void saveProjectConfig();
}

/**
 * @param {string} fieldName
 * @param {() => void} rerender
 */
function handleToggleRequired(fieldName: string, rerender: () => void) {
  const schema = getSelectedSchema();
  if (!schema) {
    return;
  }
  if (!schema.required) {
    schema.required = [];
  }

  const idx = schema.required.indexOf(fieldName);
  if (idx !== -1) {
    schema.required.splice(idx, 1);
  } else {
    schema.required.push(fieldName);
  }

  rerender();
  void saveProjectConfig();
}

/**
 * @param {string} oldName
 * @param {string} newName
 * @param {() => void} rerender
 */
function handleRenameField(oldName: string, newName: string, rerender: () => void) {
  const schema = getSelectedSchema();
  const normalized = toCamelCase(newName);
  if (!schema?.properties || !normalized || schema.properties[normalized]) {
    return;
  }

  const newProps: Record<string, ContentTypeSchemaField> = {};
  for (const [key, val] of Object.entries(schema.properties)) {
    newProps[key === oldName ? normalized : key] = val;
  }
  schema.properties = newProps;

  if (schema.required) {
    schema.required = schema.required.map((r: string) => (r === oldName ? normalized : r));
  }

  rerender();
  void saveProjectConfig();
}

/**
 * @param {string} fieldName
 * @param {string} newType
 * @param {() => void} rerender
 */
function handleChangeType(fieldName: string, newType: string, rerender: () => void) {
  const schema = getSelectedSchema();
  if (!schema?.properties?.[fieldName]) {
    return;
  }

  const oldFormat =
    newType === "string" || newType === "array"
      ? detectFieldFormat(schema.properties[fieldName])
      : undefined;
  schema.properties[fieldName] = schemaForType(newType, oldFormat || undefined);
  rerender();
  void saveProjectConfig();
}

/**
 * @param {string} fieldName
 * @param {string} format
 * @param {() => void} rerender
 */
function handleChangeFormat(fieldName: string, format: string, rerender: () => void) {
  const schema = getSelectedSchema();
  if (!schema?.properties?.[fieldName]) {
    return;
  }

  const prop = schema.properties[fieldName];
  const type = prop.type || "string";
  schema.properties[fieldName] = schemaForType(type, format || undefined);
  rerender();
  void saveProjectConfig();
}

/**
 * @param {string} fieldName
 * @param {string} target
 * @param {() => void} rerender
 */
function handleChangeRefTarget(fieldName: string, target: string, rerender: () => void) {
  const schema = getSelectedSchema();
  if (!schema?.properties) {
    return;
  }

  schema.properties[fieldName] = { $ref: `#/contentTypes/${target}` };
  rerender();
  void saveProjectConfig();
}

// ─── Nested field handlers ───────────────────────────────────────────────────

/**
 * @param {string} parentName
 * @param {{ name: string; type: string; required: boolean }} fieldState
 * @param {() => void} rerender
 */
function handleAddNestedField(
  parentName: string,
  fieldState: { name: string; type: string; required: boolean },
  rerender: () => void,
) {
  const schema = getSelectedSchema();
  const parent = schema?.properties?.[parentName];
  if (!parent) {
    return;
  }

  const name = toCamelCase(fieldState.name);
  if (!name) {
    return;
  }

  if (!parent.properties) {
    parent.properties = {};
  }
  parent.properties[name] = schemaForType(fieldState.type);

  if (fieldState.required) {
    if (!parent.required) {
      parent.required = [];
    }
    if (!parent.required.includes(name)) {
      parent.required.push(name);
    }
  }

  rerender();
  void saveProjectConfig();
}

/**
 * @param {string} parentName
 * @param {string} childName
 * @param {() => void} rerender
 */
function handleDeleteNested(parentName: string, childName: string, rerender: () => void) {
  const schema = getSelectedSchema();
  const parent = schema?.properties?.[parentName];
  if (!parent?.properties) {
    return;
  }

  delete parent.properties[childName];
  if (parent.required) {
    parent.required = parent.required.filter((r: string) => r !== childName);
  }

  rerender();
  void saveProjectConfig();
}

/**
 * @param {string} parentName
 * @param {string} childName
 * @param {() => void} rerender
 */
function handleToggleNestedRequired(parentName: string, childName: string, rerender: () => void) {
  const schema = getSelectedSchema();
  const parent = schema?.properties?.[parentName];
  if (!parent) {
    return;
  }
  if (!parent.required) {
    parent.required = [];
  }

  const idx = parent.required.indexOf(childName);
  if (idx !== -1) {
    parent.required.splice(idx, 1);
  } else {
    parent.required.push(childName);
  }

  rerender();
  void saveProjectConfig();
}

/**
 * @param {string} parentName
 * @param {string} oldChild
 * @param {string} newChild
 * @param {() => void} rerender
 */
function handleRenameNested(
  parentName: string,
  oldChild: string,
  newChild: string,
  rerender: () => void,
) {
  const schema = getSelectedSchema();
  const parent = schema?.properties?.[parentName];
  const normalized = toCamelCase(newChild);
  if (!parent?.properties || !normalized || parent.properties[normalized]) {
    return;
  }

  const newProps: Record<string, ContentTypeSchemaField> = {};
  for (const [key, val] of Object.entries(parent.properties)) {
    newProps[key === oldChild ? normalized : key] = val;
  }
  parent.properties = newProps;

  if (parent.required) {
    parent.required = parent.required.map((r: string) => (r === oldChild ? normalized : r));
  }

  rerender();
  void saveProjectConfig();
}

/**
 * @param {string} parentName
 * @param {string} childName
 * @param {string} newType
 * @param {() => void} rerender
 */
function handleChangeNestedType(
  parentName: string,
  childName: string,
  newType: string,
  rerender: () => void,
) {
  const schema = getSelectedSchema();
  const parent = schema?.properties?.[parentName];
  if (!parent?.properties?.[childName]) {
    return;
  }

  const oldFormat =
    newType === "string" || newType === "array"
      ? detectFieldFormat(parent.properties[childName])
      : undefined;
  parent.properties[childName] = schemaForType(newType, oldFormat || undefined);
  rerender();
  void saveProjectConfig();
}

/**
 * @param {string} parentName
 * @param {string} childName
 * @param {string} format
 * @param {() => void} rerender
 */
function handleChangeNestedFormat(
  parentName: string,
  childName: string,
  format: string,
  rerender: () => void,
) {
  const schema = getSelectedSchema();
  const parent = schema?.properties?.[parentName];
  if (!parent?.properties?.[childName]) {
    return;
  }

  const prop = parent.properties[childName];
  const type = prop.type || "string";
  parent.properties[childName] = schemaForType(type, format || undefined);
  rerender();
  void saveProjectConfig();
}

/** @param {() => void} rerender */
function handleDeleteContentType(rerender: () => void) {
  if (!selectedContentType) {
    return;
  }
  const config = projectState?.projectConfig;
  if (!config?.contentTypes?.[selectedContentType]) {
    return;
  }

  delete config.contentTypes[selectedContentType];
  selectedContentType = null;

  rerender();
  void saveProjectConfig();
}

// ─── Render ───────────────────────────────────────────────────────────────────

/**
 * Render the content types editor.
 *
 * @param {HTMLElement} container
 */
export function renderContentTypesEditor(container: HTMLElement) {
  const rerender = () => renderContentTypesEditor(container);
  const config = projectState?.projectConfig;
  const contentTypes = config?.contentTypes || {};
  const contentTypeNames = Object.keys(contentTypes);

  // Left column — content type list
  const listTpl = html`
    <div class="settings-list-panel">
      ${contentTypeNames.map(
        (name) => html`
          <sp-action-button
            size="s"
            ?selected=${selectedContentType === name}
            @click=${() => {
              selectedContentType = name;
              showAddField = false;
              rerender();
            }}
          >
            ${name}
          </sp-action-button>
        `,
      )}
      ${showNewContentType
        ? html`
            <div class="settings-inline-form">
              <sp-textfield
                size="s"
                placeholder="content-type-name"
                .value=${newContentTypeName}
                @input=${(e: Event) => {
                  newContentTypeName = (e.target as HTMLInputElement).value;
                }}
                @keydown=${(e: KeyboardEvent) => {
                  if (e.key === "Enter") {
                    handleNewContentType(rerender);
                  }
                  if (e.key === "Escape") {
                    showNewContentType = false;
                    rerender();
                  }
                }}
              ></sp-textfield>
              <sp-action-button size="s" @click=${() => handleNewContentType(rerender)}>
                Create
              </sp-action-button>
            </div>
          `
        : html`
            <sp-action-button
              size="s"
              quiet
              @click=${() => {
                showNewContentType = true;
                rerender();
              }}
            >
              <sp-icon-add slot="icon"></sp-icon-add> New Content Type
            </sp-action-button>
          `}
    </div>
  `;

  // Right column — schema editor
  let editorTpl;
  if (!selectedContentType || !contentTypes[selectedContentType]) {
    editorTpl = html`<div class="settings-empty-state">Select or create a content type</div>`;
  } else {
    const col = contentTypes[selectedContentType]!;
    const schema = (col.schema || {}) as ContentTypeSchema;
    const properties = schema.properties || {};
    const required = schema.required || [];

    const handlers: FieldHandlers = {
      onAddNestedField: (p: string, s: { name: string; type: string; required: boolean }) =>
        handleAddNestedField(p, s, rerender),
      onChangeFormat: (n: string, f: string) => handleChangeFormat(n, f, rerender),
      onChangeNestedFormat: (p: string, c: string, f: string) =>
        handleChangeNestedFormat(p, c, f, rerender),
      onChangeNestedType: (p: string, c: string, t: string) =>
        handleChangeNestedType(p, c, t, rerender),
      onChangeRefTarget: (n: string, target: string) => handleChangeRefTarget(n, target, rerender),
      onChangeType: (n: string, t: string) => handleChangeType(n, t, rerender),
      onDelete: (n: string) => handleDeleteField(n, rerender),
      onDeleteNested: (p: string, c: string) => handleDeleteNested(p, c, rerender),
      onRename: (oldN: string, newN: string) => handleRenameField(oldN, newN, rerender),
      onRenameNested: (p: string, o: string, n: string) => handleRenameNested(p, o, n, rerender),
      onToggleNestedRequired: (p: string, c: string) => handleToggleNestedRequired(p, c, rerender),
      onToggleRequired: (n: string) => handleToggleRequired(n, rerender),
    };

    const fieldCards = repeat(
      Object.entries(properties),
      ([name]) => name,
      ([name, def]) =>
        fieldCardTpl(
          name,
          def as SchemaProperty,
          required.includes(name),
          handlers,
          contentTypeNames,
        ),
    );

    editorTpl = html`
      <div class="settings-editor-panel">
        <div class="settings-editor-header">
          <h3>${selectedContentType}</h3>
          <sp-field-label size="s">Source: ${col.source || "—"}</sp-field-label>
          <sp-action-button
            size="xs"
            quiet
            title="Delete content type"
            @click=${() => handleDeleteContentType(rerender)}
          >
            <sp-icon-delete slot="icon"></sp-icon-delete>
          </sp-action-button>
        </div>
        <div class="schema-field-list">${fieldCards}</div>
        ${showAddField
          ? addFieldFormTpl(newFieldState, {
              onCancel: () => {
                showAddField = false;
                newFieldState = {
                  format: "",
                  name: "",
                  required: false,
                  type: "string",
                };
                rerender();
              },
              onConfirm: () => handleAddField(rerender),
              onInput: (field, value) => {
                newFieldState = { ...newFieldState, [field]: value };
                rerender();
              },
            })
          : html`
              <sp-action-button
                size="s"
                quiet
                @click=${() => {
                  showAddField = true;
                  rerender();
                }}
              >
                <sp-icon-add slot="icon"></sp-icon-add> Add Field
              </sp-action-button>
            `}
      </div>
    `;
  }

  const tpl = html` <div class="settings-two-col">${listTpl} ${editorTpl}</div> `;

  litRender(tpl, container);
}
