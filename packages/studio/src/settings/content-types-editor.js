/**
 * Content Types Editor — visual schema builder for project content types.
 *
 * Renders inside the Settings view "Content Types" tab. Two-column layout: left column lists
 * content type names, right column edits the selected content type's schema.
 */

import { html, render as litRender } from "lit-html";
import { repeat } from "lit-html/directives/repeat.js";
import { getPlatform } from "../platform.js";
import { projectState } from "../store.js";
import {
  fieldCardTpl,
  addFieldFormTpl,
  schemaForType,
  detectFieldFormat,
} from "./schema-field-ui.js";

// ─── Module state ─────────────────────────────────────────────────────────────

/** @type {string | null} */
let selectedContentType = null;
let showAddField = false;
let newFieldState = { name: "", type: "string", format: "", required: false };
let showNewContentType = false;
let newContentTypeName = "";

// ─── Persistence ──────────────────────────────────────────────────────────────

async function saveProjectConfig() {
  const platform = getPlatform();
  const config = /** @type {any} */ (projectState).projectConfig;
  await platform.writeFile("project.json", JSON.stringify(config, null, "\t"));
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Get the schema object for the selected content type. */
function getSelectedSchema() {
  const config = projectState?.projectConfig;
  return config?.contentTypes?.[/** @type {string} */ (selectedContentType)]?.schema;
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

/** @param {() => void} rerender */
function handleNewContentType(rerender) {
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
    source: `./content/${slug}/**/*.md`,
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
function handleAddField(rerender) {
  const name = newFieldState.name.trim();
  if (!name || !selectedContentType) return;

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
function handleDeleteField(fieldName, rerender) {
  const schema = getSelectedSchema();
  if (!schema?.properties) return;

  delete schema.properties[fieldName];
  if (schema.required) {
    schema.required = schema.required.filter((/** @type {string} */ r) => r !== fieldName);
  }

  rerender();
  saveProjectConfig();
}

/**
 * @param {string} fieldName
 * @param {() => void} rerender
 */
function handleToggleRequired(fieldName, rerender) {
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
function handleRenameField(oldName, newName, rerender) {
  const schema = getSelectedSchema();
  if (!schema?.properties || !newName || schema.properties[newName]) return;

  /** @type {Record<string, any>} */
  const newProps = {};
  for (const [key, val] of Object.entries(schema.properties)) {
    newProps[key === oldName ? newName : key] = val;
  }
  schema.properties = newProps;

  if (schema.required) {
    schema.required = schema.required.map((/** @type {string} */ r) =>
      r === oldName ? newName : r,
    );
  }

  rerender();
  saveProjectConfig();
}

/**
 * @param {string} fieldName
 * @param {string} newType
 * @param {() => void} rerender
 */
function handleChangeType(fieldName, newType, rerender) {
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
function handleChangeFormat(fieldName, format, rerender) {
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
function handleChangeRefTarget(fieldName, target, rerender) {
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
function handleAddNestedField(parentName, fieldState, rerender) {
  const schema = getSelectedSchema();
  const parent = schema?.properties?.[parentName];
  if (!parent) return;

  if (!parent.properties) parent.properties = {};
  parent.properties[fieldState.name] = schemaForType(fieldState.type);

  if (fieldState.required) {
    if (!parent.required) parent.required = [];
    if (!parent.required.includes(fieldState.name)) parent.required.push(fieldState.name);
  }

  rerender();
  saveProjectConfig();
}

/**
 * @param {string} parentName
 * @param {string} childName
 * @param {() => void} rerender
 */
function handleDeleteNested(parentName, childName, rerender) {
  const schema = getSelectedSchema();
  const parent = schema?.properties?.[parentName];
  if (!parent?.properties) return;

  delete parent.properties[childName];
  if (parent.required) {
    parent.required = parent.required.filter((/** @type {string} */ r) => r !== childName);
  }

  rerender();
  saveProjectConfig();
}

/**
 * @param {string} parentName
 * @param {string} childName
 * @param {() => void} rerender
 */
function handleToggleNestedRequired(parentName, childName, rerender) {
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
function handleRenameNested(parentName, oldChild, newChild, rerender) {
  const schema = getSelectedSchema();
  const parent = schema?.properties?.[parentName];
  if (!parent?.properties || !newChild || parent.properties[newChild]) return;

  /** @type {Record<string, any>} */
  const newProps = {};
  for (const [key, val] of Object.entries(parent.properties)) {
    newProps[key === oldChild ? newChild : key] = val;
  }
  parent.properties = newProps;

  if (parent.required) {
    parent.required = parent.required.map((/** @type {string} */ r) =>
      r === oldChild ? newChild : r,
    );
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
function handleChangeNestedType(parentName, childName, newType, rerender) {
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
function handleChangeNestedFormat(parentName, childName, format, rerender) {
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
function handleDeleteContentType(rerender) {
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
export function renderContentTypesEditor(container) {
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
                @input=${(/** @type {any} */ e) => {
                  newContentTypeName = e.target.value;
                }}
                @keydown=${(/** @type {any} */ e) => {
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
    const schema = col.schema || {};
    const properties = schema.properties || {};
    const required = schema.required || [];

    /** @type {import("./schema-field-ui.js").FieldHandlers} */
    const handlers = {
      onDelete: (n) => handleDeleteField(n, rerender),
      onToggleRequired: (n) => handleToggleRequired(n, rerender),
      onRename: (oldN, newN) => handleRenameField(oldN, newN, rerender),
      onChangeType: (n, t) => handleChangeType(n, t, rerender),
      onChangeFormat: (n, f) => handleChangeFormat(n, f, rerender),
      onChangeRefTarget: (n, target) => handleChangeRefTarget(n, target, rerender),
      onAddNestedField: (p, s) => handleAddNestedField(p, s, rerender),
      onDeleteNested: (p, c) => handleDeleteNested(p, c, rerender),
      onToggleNestedRequired: (p, c) => handleToggleNestedRequired(p, c, rerender),
      onRenameNested: (p, o, n) => handleRenameNested(p, o, n, rerender),
      onChangeNestedType: (p, c, t) => handleChangeNestedType(p, c, t, rerender),
      onChangeNestedFormat: (p, c, f) => handleChangeNestedFormat(p, c, f, rerender),
    };

    const fieldCards = repeat(
      Object.entries(properties),
      ([name]) => name,
      ([name, def]) =>
        fieldCardTpl(
          name,
          /** @type {any} */ (def),
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
                newFieldState = { name: "", type: "string", format: "", required: false };
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
