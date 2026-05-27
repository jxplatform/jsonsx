/**
 * Definitions Editor — visual editor for project-level $defs (JSON Schema type definitions).
 *
 * Manages entries in project.json `$defs` — reusable type schemas for external datasets, API
 * responses, CMS payloads, etc. Same concept as component-level $defs but scoped to the entire
 * project.
 */

import { html, render as litRender } from "lit-html";
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
let selectedDef = null;
let showAddField = false;
let newFieldState = { name: "", type: "string", format: "", required: false };
let showNewDef = false;
let newDefName = "";

// ─── Persistence ──────────────────────────────────────────────────────────────

async function saveProjectConfig() {
  const platform = getPlatform();
  const config = /** @type {{ projectConfig: ProjectConfig }} */ (projectState).projectConfig;
  await platform.writeFile("project.json", JSON.stringify(config, null, "\t"));
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Get the selected $def schema object. */
function getSelectedDef() {
  const config = projectState?.projectConfig;
  return config?.$defs?.[/** @type {string} */ (selectedDef)];
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

/** @param {() => void} rerender */
function handleNewDef(rerender) {
  const name = newDefName.trim();
  if (!name) return;

  const config = projectState?.projectConfig;
  if (!config) return;
  if (!config.$defs) config.$defs = {};
  if (config.$defs[name]) return; // already exists

  config.$defs[name] = {
    type: "object",
    properties: {},
    required: [],
  };

  selectedDef = name;
  showNewDef = false;
  newDefName = "";
  rerender();
  saveProjectConfig();
}

/** @param {() => void} rerender */
function handleAddField(rerender) {
  const name = newFieldState.name.trim();
  if (!name || !selectedDef) return;

  const def = getSelectedDef();
  if (!def) return;

  if (!def.properties) def.properties = {};
  def.properties[name] = schemaForType(newFieldState.type, newFieldState.format || undefined);

  if (newFieldState.required) {
    if (!def.required) def.required = [];
    if (!def.required.includes(name)) def.required.push(name);
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
  const def = getSelectedDef();
  if (!def?.properties) return;

  delete def.properties[fieldName];
  if (def.required) {
    def.required = def.required.filter((/** @type {string} */ r) => r !== fieldName);
  }

  rerender();
  saveProjectConfig();
}

/**
 * @param {string} fieldName
 * @param {() => void} rerender
 */
function handleToggleRequired(fieldName, rerender) {
  const def = getSelectedDef();
  if (!def) return;
  if (!def.required) def.required = [];

  const idx = def.required.indexOf(fieldName);
  if (idx >= 0) def.required.splice(idx, 1);
  else def.required.push(fieldName);

  rerender();
  saveProjectConfig();
}

/**
 * @param {string} oldName
 * @param {string} newName
 * @param {() => void} rerender
 */
function handleRenameField(oldName, newName, rerender) {
  const def = getSelectedDef();
  if (!def?.properties || !newName || def.properties[newName]) return;

  /** @type {Record<string, unknown>} */
  const newProps = {};
  for (const [key, val] of Object.entries(def.properties)) {
    newProps[key === oldName ? newName : key] = val;
  }
  def.properties = newProps;

  if (def.required) {
    def.required = def.required.map((/** @type {string} */ r) => (r === oldName ? newName : r));
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
  const def = getSelectedDef();
  if (!def?.properties?.[fieldName]) return;

  const oldFormat =
    newType === "string" || newType === "array"
      ? detectFieldFormat(def.properties[fieldName])
      : undefined;
  def.properties[fieldName] = schemaForType(newType, oldFormat || undefined);
  rerender();
  saveProjectConfig();
}

/**
 * @param {string} fieldName
 * @param {string} format
 * @param {() => void} rerender
 */
function handleChangeFormat(fieldName, format, rerender) {
  const def = getSelectedDef();
  if (!def?.properties?.[fieldName]) return;

  const prop = def.properties[fieldName];
  const type = prop.type || "string";
  def.properties[fieldName] = schemaForType(type, format || undefined);
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
  const def = getSelectedDef();
  const parent = def?.properties?.[parentName];
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
  const def = getSelectedDef();
  const parent = def?.properties?.[parentName];
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
  const def = getSelectedDef();
  const parent = def?.properties?.[parentName];
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
  const def = getSelectedDef();
  const parent = def?.properties?.[parentName];
  if (!parent?.properties || !newChild || parent.properties[newChild]) return;

  /** @type {Record<string, unknown>} */
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
  const def = getSelectedDef();
  const parent = def?.properties?.[parentName];
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
  const def = getSelectedDef();
  const parent = def?.properties?.[parentName];
  if (!parent?.properties?.[childName]) return;

  const prop = parent.properties[childName];
  const type = prop.type || "string";
  parent.properties[childName] = schemaForType(type, format || undefined);
  rerender();
  saveProjectConfig();
}

/** @param {() => void} rerender */
function handleDeleteDef(rerender) {
  if (!selectedDef) return;
  const config = projectState?.projectConfig;
  if (!config?.$defs?.[selectedDef]) return;

  delete config.$defs[selectedDef];
  selectedDef = null;

  rerender();
  saveProjectConfig();
}

// ─── Render ───────────────────────────────────────────────────────────────────

/**
 * Render the definitions editor.
 *
 * @param {HTMLElement} container
 */
export function renderDefsEditor(container) {
  const rerender = () => renderDefsEditor(container);
  const config = projectState?.projectConfig;
  const defs = config?.$defs || {};
  const defNames = Object.keys(defs);

  // Left column — def list
  const listTpl = html`
    <div class="settings-list-panel">
      ${defNames.map(
        (name) => html`
          <sp-action-button
            size="s"
            ?selected=${selectedDef === name}
            @click=${() => {
              selectedDef = name;
              showAddField = false;
              rerender();
            }}
          >
            ${name}
          </sp-action-button>
        `,
      )}
      ${showNewDef
        ? html`
            <div class="settings-inline-form">
              <sp-textfield
                size="s"
                placeholder="TypeName"
                .value=${newDefName}
                @input=${(/** @type {Event} */ e) => {
                  newDefName = /** @type {HTMLInputElement} */ (e.target).value;
                }}
                @keydown=${(/** @type {KeyboardEvent} */ e) => {
                  if (e.key === "Enter") handleNewDef(rerender);
                  if (e.key === "Escape") {
                    showNewDef = false;
                    rerender();
                  }
                }}
              ></sp-textfield>
              <sp-action-button size="s" @click=${() => handleNewDef(rerender)}>
                Create
              </sp-action-button>
            </div>
          `
        : html`
            <sp-action-button
              size="s"
              quiet
              @click=${() => {
                showNewDef = true;
                rerender();
              }}
            >
              <sp-icon-add slot="icon"></sp-icon-add> New Definition
            </sp-action-button>
          `}
    </div>
  `;

  // Right column — schema editor
  let editorTpl;
  if (!selectedDef || !defs[selectedDef]) {
    editorTpl = html`<div class="settings-empty-state">Select or create a type definition</div>`;
  } else {
    const def = defs[selectedDef];
    const properties = def.properties || {};
    const required = def.required || [];

    /** @type {import("./schema-field-ui.js").FieldHandlers} */
    const handlers = {
      onDelete: (n) => handleDeleteField(n, rerender),
      onToggleRequired: (n) => handleToggleRequired(n, rerender),
      onRename: (oldN, newN) => handleRenameField(oldN, newN, rerender),
      onChangeType: (n, t) => handleChangeType(n, t, rerender),
      onChangeFormat: (n, f) => handleChangeFormat(n, f, rerender),
      onAddNestedField: (p, s) => handleAddNestedField(p, s, rerender),
      onDeleteNested: (p, c) => handleDeleteNested(p, c, rerender),
      onToggleNestedRequired: (p, c) => handleToggleNestedRequired(p, c, rerender),
      onRenameNested: (p, o, n) => handleRenameNested(p, o, n, rerender),
      onChangeNestedType: (p, c, t) => handleChangeNestedType(p, c, t, rerender),
      onChangeNestedFormat: (p, c, f) => handleChangeNestedFormat(p, c, f, rerender),
    };

    const fieldCards = Object.entries(properties).map(([name, fieldDef]) =>
      fieldCardTpl(
        name,
        /** @type {import("./schema-field-ui.js").SchemaProperty} */ (fieldDef),
        required.includes(name),
        handlers,
      ),
    );

    editorTpl = html`
      <div class="settings-editor-panel">
        <div class="settings-editor-header">
          <h3>${selectedDef}</h3>
          <sp-action-button
            size="xs"
            quiet
            title="Delete definition"
            @click=${() => handleDeleteDef(rerender)}
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
