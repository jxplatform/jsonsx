/// <reference lib="dom" />
/**
 * Definitions — the visual editor for project-level `$defs` (JSON Schema type definitions).
 *
 * Manages entries in project.json `$defs` — reusable type schemas for external datasets, API
 * responses, CMS payloads, etc. Same concept as component-level `$defs` but scoped to the entire
 * project. The on-disk key stays `$defs` and the section key stays `definitions`.
 *
 * **The reference field type is complete here for the first time.** `schema-field-ui.ts` has always
 * been able to draw the target picker, and `ui/form-controls.ts` (the content-types builder) has
 * always passed it the available content types — this editor never did, so choosing "reference"
 * emitted a bare `#/content/` that pointed at nothing and offered no way to say what it pointed at.
 * The list is read straight off the live config's `content` map, which is where a
 * `#/content/<type>` pointer resolves.
 */

import { html, render as litRender } from "lit-html";
import { projectState } from "../store";
import { commitProjectConfig } from "../tabs/project-config";
import { addFieldFormTpl, detectFieldFormat, fieldCardTpl, schemaForType } from "./schema-field-ui";

import type { FieldHandlers, SchemaProperty } from "./schema-field-ui.js";
import type { ContentTypeSchema, ContentTypeSchemaField } from "@jxsuite/schema/types";

// ─── Module state ─────────────────────────────────────────────────────────────

let selectedDef: string | null = null;
let showAddField = false;
let newFieldState = { format: "", name: "", required: false, type: "string" };
let showNewDef = false;
let newDefName = "";

// ─── Persistence ──────────────────────────────────────────────────────────────

/**
 * Commit the configuration this editor has just mutated in place.
 *
 * Every handler below edits `projectState.projectConfig.$defs` directly and then says so here. The
 * predecessor was this module's own writer — `JSON.stringify(config, null, "\t")` straight to
 * `platform.writeFile`, called as `void saveProjectConfig()` at fourteen sites. It re-indented the
 * whole file (every `project.json` on disk uses two spaces), it recorded nothing an undo could
 * reach, and a rejected write became an unhandled rejection while the form went on showing a data
 * shape that was never saved.
 *
 * `commitProjectConfig` transacts the mutation onto the configuration document and reports its own
 * failures as Problems, so there is nothing left here to await or to swallow.
 */
function persist(): void {
  void commitProjectConfig();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Get the selected $def schema object. */
function getSelectedDef(): ContentTypeSchema | undefined {
  const config = projectState?.projectConfig;
  return config?.$defs?.[selectedDef as string] as ContentTypeSchema | undefined;
}

/**
 * The content types a `reference` field can point at — the same list the content-types builder
 * resolves through `#/$context/content`, read here without a schema-form context to go through.
 *
 * @returns {string[]}
 */
function contentTypeNames(): string[] {
  const content = (projectState?.projectConfig as Record<string, unknown> | null | undefined)
    ?.content;
  return content && typeof content === "object" && !Array.isArray(content)
    ? Object.keys(content)
    : [];
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

/** @param {() => void} rerender */
function handleNewDef(rerender: () => void) {
  const name = newDefName.trim();
  if (!name) {
    return;
  }

  const config = projectState?.projectConfig;
  if (!config) {
    return;
  }
  if (!config.$defs) {
    config.$defs = {};
  }
  if (config.$defs[name]) {
    return;
  } // Already exists

  config.$defs[name] = {
    properties: {},
    required: [],
    type: "object",
  };

  selectedDef = name;
  showNewDef = false;
  newDefName = "";
  rerender();
  persist();
}

/** @param {() => void} rerender */
function handleAddField(rerender: () => void) {
  const name = newFieldState.name.trim();
  if (!name || !selectedDef) {
    return;
  }

  const def = getSelectedDef();
  if (!def) {
    return;
  }

  if (!def.properties) {
    def.properties = {};
  }
  def.properties[name] = schemaForType(newFieldState.type, newFieldState.format || undefined);

  if (newFieldState.required) {
    if (!def.required) {
      def.required = [];
    }
    if (!def.required.includes(name)) {
      def.required.push(name);
    }
  }

  showAddField = false;
  newFieldState = { format: "", name: "", required: false, type: "string" };
  rerender();
  persist();
}

/**
 * @param {string} fieldName
 * @param {() => void} rerender
 */
function handleDeleteField(fieldName: string, rerender: () => void) {
  const def = getSelectedDef();
  if (!def?.properties) {
    return;
  }

  delete def.properties[fieldName];
  if (def.required) {
    def.required = def.required.filter((r: string) => r !== fieldName);
  }

  rerender();
  persist();
}

/**
 * @param {string} fieldName
 * @param {() => void} rerender
 */
function handleToggleRequired(fieldName: string, rerender: () => void) {
  const def = getSelectedDef();
  if (!def) {
    return;
  }
  if (!def.required) {
    def.required = [];
  }

  const idx = def.required.indexOf(fieldName);
  if (idx !== -1) {
    def.required.splice(idx, 1);
  } else {
    def.required.push(fieldName);
  }

  rerender();
  persist();
}

/**
 * @param {string} oldName
 * @param {string} newName
 * @param {() => void} rerender
 */
function handleRenameField(oldName: string, newName: string, rerender: () => void) {
  const def = getSelectedDef();
  if (!def?.properties || !newName || def.properties[newName]) {
    return;
  }

  const newProps: Record<string, ContentTypeSchemaField> = {};
  for (const [key, val] of Object.entries(def.properties)) {
    newProps[key === oldName ? newName : key] = val;
  }
  def.properties = newProps;

  if (def.required) {
    def.required = def.required.map((r: string) => (r === oldName ? newName : r));
  }

  rerender();
  persist();
}

/**
 * @param {string} fieldName
 * @param {string} newType
 * @param {() => void} rerender
 */
function handleChangeType(fieldName: string, newType: string, rerender: () => void) {
  const def = getSelectedDef();
  if (!def?.properties?.[fieldName]) {
    return;
  }

  const oldFormat =
    newType === "string" || newType === "array"
      ? detectFieldFormat(def.properties[fieldName])
      : undefined;
  def.properties[fieldName] = schemaForType(newType, oldFormat || undefined);
  rerender();
  persist();
}

/**
 * Point a reference field at a content type. The pointer form is `#/content/<type>` — the same one
 * `ui/form-controls.ts` writes, so a reference authored here and one authored in the content-types
 * builder are the same value.
 *
 * @param {string} fieldName
 * @param {string} target
 * @param {() => void} rerender
 */
function handleChangeRefTarget(fieldName: string, target: string, rerender: () => void) {
  const def = getSelectedDef();
  if (!def?.properties?.[fieldName]) {
    return;
  }
  def.properties[fieldName] = { $ref: `#/content/${target}` } as ContentTypeSchemaField;
  rerender();
  persist();
}

/**
 * @param {string} fieldName
 * @param {string} format
 * @param {() => void} rerender
 */
function handleChangeFormat(fieldName: string, format: string, rerender: () => void) {
  const def = getSelectedDef();
  if (!def?.properties?.[fieldName]) {
    return;
  }

  const prop = def.properties[fieldName];
  const type = prop.type || "string";
  def.properties[fieldName] = schemaForType(type, format || undefined);
  rerender();
  persist();
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
  if (!parent) {
    return;
  }

  if (!parent.properties) {
    parent.properties = {};
  }
  parent.properties[fieldState.name] = schemaForType(fieldState.type);

  if (fieldState.required) {
    if (!parent.required) {
      parent.required = [];
    }
    if (!parent.required.includes(fieldState.name)) {
      parent.required.push(fieldState.name);
    }
  }

  rerender();
  persist();
}

/**
 * @param {string} parentName
 * @param {string} childName
 * @param {() => void} rerender
 */
function handleDeleteNested(parentName: string, childName: string, rerender: () => void) {
  const def = getSelectedDef();
  const parent = def?.properties?.[parentName];
  if (!parent?.properties) {
    return;
  }

  delete parent.properties[childName];
  if (parent.required) {
    parent.required = parent.required.filter((r: string) => r !== childName);
  }

  rerender();
  persist();
}

/**
 * @param {string} parentName
 * @param {string} childName
 * @param {() => void} rerender
 */
function handleToggleNestedRequired(parentName: string, childName: string, rerender: () => void) {
  const def = getSelectedDef();
  const parent = def?.properties?.[parentName];
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
  persist();
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
  if (!parent?.properties || !newChild || parent.properties[newChild]) {
    return;
  }

  const newProps: Record<string, ContentTypeSchemaField> = {};
  for (const [key, val] of Object.entries(parent.properties)) {
    newProps[key === oldChild ? newChild : key] = val;
  }
  parent.properties = newProps;

  if (parent.required) {
    parent.required = parent.required.map((r: string) => (r === oldChild ? newChild : r));
  }

  rerender();
  persist();
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
  if (!parent?.properties?.[childName]) {
    return;
  }

  const oldFormat =
    newType === "string" || newType === "array"
      ? detectFieldFormat(parent.properties[childName])
      : undefined;
  parent.properties[childName] = schemaForType(newType, oldFormat || undefined);
  rerender();
  persist();
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
  if (!parent?.properties?.[childName]) {
    return;
  }

  const prop = parent.properties[childName];
  const type = prop.type || "string";
  parent.properties[childName] = schemaForType(type, format || undefined);
  rerender();
  persist();
}

/** @param {() => void} rerender */
function handleDeleteDef(rerender: () => void) {
  if (!selectedDef) {
    return;
  }
  const config = projectState?.projectConfig;
  if (!config?.$defs?.[selectedDef]) {
    return;
  }

  delete config.$defs[selectedDef];
  selectedDef = null;

  rerender();
  persist();
}

// ─── Render ───────────────────────────────────────────────────────────────────

/**
 * Render the Data Shapes editor.
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
      ${
        showNewDef
          ? html`
              <div class="settings-inline-form">
                <sp-textfield
                  size="s"
                  placeholder="ProductReview"
                  .value=${newDefName}
                  @input=${(e: Event) => {
                    newDefName = (e.target as HTMLInputElement).value;
                  }}
                  @keydown=${(e: KeyboardEvent) => {
                    if (e.key === "Enter") {
                      handleNewDef(rerender);
                    }
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
                <sp-icon-add slot="icon"></sp-icon-add> New Data Shape
              </sp-action-button>
            `
      }
    </div>
  `;

  // Right column — schema editor
  let editorTpl;
  if (!selectedDef || !defs[selectedDef]) {
    editorTpl = html`<div class="settings-empty-state">
      Pick a data shape on the left, or create one.
    </div>`;
  } else {
    const def = defs[selectedDef] as ContentTypeSchema;
    const properties = def.properties || {};
    const required = def.required || [];

    const handlers: FieldHandlers = {
      onAddNestedField: (p: string, s: { name: string; type: string; required: boolean }) =>
        handleAddNestedField(p, s, rerender),
      onChangeFormat: (n: string, f: string) => handleChangeFormat(n, f, rerender),
      onChangeNestedFormat: (p: string, c: string, f: string) =>
        handleChangeNestedFormat(p, c, f, rerender),
      onChangeNestedType: (p: string, c: string, t: string) =>
        handleChangeNestedType(p, c, t, rerender),
      onChangeRefTarget: (n: string, t: string) => handleChangeRefTarget(n, t, rerender),
      onChangeType: (n: string, t: string) => handleChangeType(n, t, rerender),
      onDelete: (n: string) => handleDeleteField(n, rerender),
      onDeleteNested: (p: string, c: string) => handleDeleteNested(p, c, rerender),
      onRename: (oldN: string, newN: string) => handleRenameField(oldN, newN, rerender),
      onRenameNested: (p: string, o: string, n: string) => handleRenameNested(p, o, n, rerender),
      onToggleNestedRequired: (p: string, c: string) => handleToggleNestedRequired(p, c, rerender),
      onToggleRequired: (n: string) => handleToggleRequired(n, rerender),
    };

    const targets = contentTypeNames();
    const fieldCards = Object.entries(properties).map(([name, fieldDef]) =>
      fieldCardTpl(name, fieldDef as SchemaProperty, required.includes(name), handlers, targets),
    );

    editorTpl = html`
      <div class="settings-editor-panel">
        <div class="settings-editor-header">
          <h3>${selectedDef}</h3>
          <sp-action-button
            size="xs"
            quiet
            title="Delete data shape"
            @click=${() => handleDeleteDef(rerender)}
          >
            <sp-icon-delete slot="icon"></sp-icon-delete>
          </sp-action-button>
        </div>
        <div class="schema-field-list">${fieldCards}</div>
        ${
          showAddField
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
              `
        }
      </div>
    `;
  }

  // Every section names itself in an <h3> matching its nav entry (Overview, Contexts, Head,
  // Packages, Extensions, Deploy, Raw JSON). This one did not, so it was the only section whose
  // Body never said what the reader had clicked.
  const tpl = html`
    <div class="settings-section">
      <h3 class="settings-section-title">Data Shapes</h3>
      <div class="settings-two-col">${listTpl} ${editorTpl}</div>
    </div>
  `;

  litRender(tpl, container);
}
