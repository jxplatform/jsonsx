/**
 * Definitions Editor — visual editor for project-level $defs (JSON Schema type definitions).
 *
 * Manages entries in project.json `$defs` — reusable type schemas for external datasets, API
 * responses, CMS payloads, etc. Same concept as component-level $defs but scoped to the entire
 * project.
 */

import { html, render as litRender } from "lit-html";
import { getPlatform } from "../platform";
import { projectState } from "../store";
import { fieldCardTpl, addFieldFormTpl, schemaForType, detectFieldFormat } from "./schema-field-ui";

// ─── Module state ─────────────────────────────────────────────────────────────

let selectedDef: string | null = null;
let showAddField = false;
let newFieldState = { name: "", type: "string", format: "", required: false };
let showNewDef = false;
let newDefName = "";

// ─── Persistence ──────────────────────────────────────────────────────────────

async function saveProjectConfig() {
  const platform = getPlatform();
  const config = (projectState as { projectConfig: ProjectConfig }).projectConfig;
  await platform.writeFile("project.json", JSON.stringify(config, null, "\t"));
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Get the selected $def schema object. */
function getSelectedDef() {
  const config = projectState?.projectConfig;
  return config?.$defs?.[selectedDef as string];
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

/** @param {() => void} rerender */
function handleNewDef(rerender: () => void) {
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
function handleAddField(rerender: () => void) {
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
function handleDeleteField(fieldName: string, rerender: () => void) {
  const def = getSelectedDef();
  if (!def?.properties) return;

  delete def.properties[fieldName];
  if (def.required) {
    def.required = def.required.filter((r: string) => r !== fieldName);
  }

  rerender();
  saveProjectConfig();
}

/**
 * @param {string} fieldName
 * @param {() => void} rerender
 */
function handleToggleRequired(fieldName: string, rerender: () => void) {
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
function handleRenameField(oldName: string, newName: string, rerender: () => void) {
  const def = getSelectedDef();
  if (!def?.properties || !newName || def.properties[newName]) return;

  const newProps: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(def.properties)) {
    newProps[key === oldName ? newName : key] = val;
  }
  def.properties = newProps;

  if (def.required) {
    def.required = def.required.map((r: string) => (r === oldName ? newName : r));
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
function handleChangeFormat(fieldName: string, format: string, rerender: () => void) {
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
function handleAddNestedField(
  parentName: string,
  fieldState: { name: string; type: string; required: boolean },
  rerender: () => void,
) {
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
function handleDeleteNested(parentName: string, childName: string, rerender: () => void) {
  const def = getSelectedDef();
  const parent = def?.properties?.[parentName];
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
function handleRenameNested(
  parentName: string,
  oldChild: string,
  newChild: string,
  rerender: () => void,
) {
  const def = getSelectedDef();
  const parent = def?.properties?.[parentName];
  if (!parent?.properties || !newChild || parent.properties[newChild]) return;

  const newProps: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(parent.properties)) {
    newProps[key === oldChild ? newChild : key] = val;
  }
  parent.properties = newProps;

  if (parent.required) {
    parent.required = parent.required.map((r: string) => (r === oldChild ? newChild : r));
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
function handleChangeNestedFormat(
  parentName: string,
  childName: string,
  format: string,
  rerender: () => void,
) {
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
function handleDeleteDef(rerender: () => void) {
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
export function renderDefsEditor(container: HTMLElement) {
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
                @input=${(e: Event) => {
                  newDefName = (e.target as HTMLInputElement).value;
                }}
                @keydown=${(e: KeyboardEvent) => {
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

    const handlers: import("./schema-field-ui.js").FieldHandlers = {
      onDelete: (n: string) => handleDeleteField(n, rerender),
      onToggleRequired: (n: string) => handleToggleRequired(n, rerender),
      onRename: (oldN: string, newN: string) => handleRenameField(oldN, newN, rerender),
      onChangeType: (n: string, t: string) => handleChangeType(n, t, rerender),
      onChangeFormat: (n: string, f: string) => handleChangeFormat(n, f, rerender),
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

    const fieldCards = Object.entries(properties).map(([name, fieldDef]) =>
      fieldCardTpl(
        name,
        fieldDef as import("./schema-field-ui.js").SchemaProperty,
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
