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
import { fieldCardTpl, addFieldFormTpl, schemaForType, detectFieldFormat } from "./schema-field-ui";
import { toCamelCase } from "../utils/studio-utils";

import type { ProjectConfig, ContentTypeSchema } from "@jxsuite/schema/types";

// ─── Module state ─────────────────────────────────────────────────────────────

let selectedContentType: string | null = null;
let showAddField = false;
let newFieldState = { name: "", type: "string", format: "", required: false };
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
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
  if (!slug) return;

  const config = projectState?.projectConfig;
  if (!config) return;
  if (!config.contentTypes) config.contentTypes = {};
  if (config.contentTypes[slug]) return; // already exists

  config.contentTypes[slug] = {
    source: `./content/${slug}/`,
    schema: { type: "object", properties: {}, required: [] },
  };

  selectedContentType = slug;
  showNewContentType = false;
  newContentTypeName = "";
  rerender();

  // Persist in background
  saveProjectConfig().then(async () => {
    const platform = getPlatform();
    await platform.writeFile(`content/${slug}/.gitkeep`, "");
  });
}

/** @param {() => void} rerender */
function handleAddField(rerender: () => void) {
  const raw = newFieldState.name.trim();
  if (!raw || !selectedContentType) return;
  const name = toCamelCase(raw);

  const schema = getSelectedSchema();
  if (!schema) return;

  if (!schema.properties) schema.properties = {};
  schema.properties[name] = schemaForType(newFieldState.type, newFieldState.format || undefined);

  if (newFieldState.required) {
    if (!schema.required) schema.required = [];
    if (!schema.required.includes(name)) schema.required.push(name);
  }

  showAddField = false;
  newFieldState = { name: "", type: "string", format: "", required: false };
  rerender();
  saveProjectConfig();
}

/**
 * @param {string} fieldName
 * @param {() => void} rerender
 */
function handleDeleteField(fieldName: string, rerender: () => void) {
  const schema = getSelectedSchema();
  if (!schema?.properties) return;

  delete schema.properties[fieldName];
  if (schema.required) {
    schema.required = schema.required.filter((r: string) => r !== fieldName);
  }

  rerender();
  saveProjectConfig();
}

/**
 * @param {string} fieldName
 * @param {() => void} rerender
 */
function handleToggleRequired(fieldName: string, rerender: () => void) {
  const schema = getSelectedSchema();
  if (!schema) return;
  if (!schema.required) schema.required = [];

  const idx = schema.required.indexOf(fieldName);
  if (idx >= 0) schema.required.splice(idx, 1);
  else schema.required.push(fieldName);

  rerender();
  saveProjectConfig();
}

/**
 * @param {string} oldName
 * @param {string} newName
 * @param {() => void} rerender
 */
function handleRenameField(oldName: string, newName: string, rerender: () => void) {
  const schema = getSelectedSchema();
  const normalized = toCamelCase(newName);
  if (!schema?.properties || !normalized || schema.properties[normalized]) return;

  const newProps: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(schema.properties)) {
    newProps[key === oldName ? normalized : key] = val;
  }
  schema.properties = newProps;

  if (schema.required) {
    schema.required = schema.required.map((r: string) => (r === oldName ? normalized : r));
  }

  rerender();
  saveProjectConfig();
}

/**
 * @param {string} fieldName
 * @param {string} newType
 * @param {() => void} rerender
 */
function handleChangeType(fieldName: string, newType: string, rerender: () => void) {
  const schema = getSelectedSchema();
  if (!schema?.properties?.[fieldName]) return;

  const oldFormat =
    newType === "string" || newType === "array"
      ? detectFieldFormat(schema.properties[fieldName])
      : undefined;
  schema.properties[fieldName] = schemaForType(newType, oldFormat || undefined);
  rerender();
  saveProjectConfig();
}

/**
 * @param {string} fieldName
 * @param {string} format
 * @param {() => void} rerender
 */
function handleChangeFormat(fieldName: string, format: string, rerender: () => void) {
  const schema = getSelectedSchema();
  if (!schema?.properties?.[fieldName]) return;

  const prop = schema.properties[fieldName];
  const type = prop.type || "string";
  schema.properties[fieldName] = schemaForType(type, format || undefined);
  rerender();
  saveProjectConfig();
}

/**
 * @param {string} fieldName
 * @param {string} target
 * @param {() => void} rerender
 */
function handleChangeRefTarget(fieldName: string, target: string, rerender: () => void) {
  const schema = getSelectedSchema();
  if (!schema?.properties) return;

  schema.properties[fieldName] = { $ref: `#/contentTypes/${target}` };
  rerender();
  saveProjectConfig();
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
  if (!parent) return;

  const name = toCamelCase(fieldState.name);
  if (!name) return;

  if (!parent.properties) parent.properties = {};
  parent.properties[name] = schemaForType(fieldState.type);

  if (fieldState.required) {
    if (!parent.required) parent.required = [];
    if (!parent.required.includes(name)) parent.required.push(name);
  }

  rerender();
  saveProjectConfig();
}

/**
 * @param {string} parentName
 * @param {string} childName
 * @param {() => void} rerender
 */
function handleDeleteNested(parentName: string, childName: string, rerender: () => void) {
  const schema = getSelectedSchema();
  const parent = schema?.properties?.[parentName];
  if (!parent?.properties) return;

  delete parent.properties[childName];
  if (parent.required) {
    parent.required = parent.required.filter((r: string) => r !== childName);
  }

  rerender();
  saveProjectConfig();
}

/**
 * @param {string} parentName
 * @param {string} childName
 * @param {() => void} rerender
 */
function handleToggleNestedRequired(parentName: string, childName: string, rerender: () => void) {
  const schema = getSelectedSchema();
  const parent = schema?.properties?.[parentName];
  if (!parent) return;
  if (!parent.required) parent.required = [];

  const idx = parent.required.indexOf(childName);
  if (idx >= 0) parent.required.splice(idx, 1);
  else parent.required.push(childName);

  rerender();
  saveProjectConfig();
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
  if (!parent?.properties || !normalized || parent.properties[normalized]) return;

  const newProps: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(parent.properties)) {
    newProps[key === oldChild ? normalized : key] = val;
  }
  parent.properties = newProps;

  if (parent.required) {
    parent.required = parent.required.map((r: string) => (r === oldChild ? normalized : r));
  }

  rerender();
  saveProjectConfig();
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
  if (!parent?.properties?.[childName]) return;

  const oldFormat =
    newType === "string" || newType === "array"
      ? detectFieldFormat(parent.properties[childName])
      : undefined;
  parent.properties[childName] = schemaForType(newType, oldFormat || undefined);
  rerender();
  saveProjectConfig();
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
  if (!parent?.properties?.[childName]) return;

  const prop = parent.properties[childName];
  const type = prop.type || "string";
  parent.properties[childName] = schemaForType(type, format || undefined);
  rerender();
  saveProjectConfig();
}

/** @param {() => void} rerender */
function handleDeleteContentType(rerender: () => void) {
  if (!selectedContentType) return;
  const config = projectState?.projectConfig;
  if (!config?.contentTypes?.[selectedContentType]) return;

  delete config.contentTypes[selectedContentType];
  selectedContentType = null;

  rerender();
  saveProjectConfig();
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
                  if (e.key === "Enter") handleNewContentType(rerender);
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
    const col = contentTypes[selectedContentType];
    const schema = (col.schema || {}) as ContentTypeSchema;
    const properties = schema.properties || {};
    const required = schema.required || [];

    const handlers: import("./schema-field-ui.js").FieldHandlers = {
      onDelete: (n: string) => handleDeleteField(n, rerender),
      onToggleRequired: (n: string) => handleToggleRequired(n, rerender),
      onRename: (oldN: string, newN: string) => handleRenameField(oldN, newN, rerender),
      onChangeType: (n: string, t: string) => handleChangeType(n, t, rerender),
      onChangeFormat: (n: string, f: string) => handleChangeFormat(n, f, rerender),
      onChangeRefTarget: (n: string, target: string) => handleChangeRefTarget(n, target, rerender),
      onAddNestedField: (p: string, s: { name: string; type: string; required: boolean }) =>
        handleAddNestedField(p, s, rerender),
      onDeleteNested: (p: string, c: string) => handleDeleteNested(p, c, rerender),
      onToggleNestedRequired: (p: string, c: string) => handleToggleNestedRequired(p, c, rerender),
      onRenameNested: (p: string, o: string, n: string) => handleRenameNested(p, o, n, rerender),
      onChangeNestedType: (p: string, c: string, t: string) =>
        handleChangeNestedType(p, c, t, rerender),
      onChangeNestedFormat: (p: string, c: string, f: string) =>
        handleChangeNestedFormat(p, c, f, rerender),
    };

    const fieldCards = repeat(
      Object.entries(properties),
      ([name]) => name,
      ([name, def]) =>
        fieldCardTpl(
          name,
          /** @type {import("./schema-field-ui.js").SchemaProperty} */ def,
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
              onInput: (field, value) => {
                newFieldState = { ...newFieldState, [field]: value };
                rerender();
              },
              onConfirm: () => handleAddField(rerender),
              onCancel: () => {
                showAddField = false;
                newFieldState = {
                  name: "",
                  type: "string",
                  format: "",
                  required: false,
                };
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
