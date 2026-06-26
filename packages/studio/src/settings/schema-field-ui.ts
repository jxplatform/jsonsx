/// <reference lib="dom" />
/**
 * Schema field UI — shared field-card and add-field-dialog templates for the content types and
 * definitions editors.
 */

import { html, nothing } from "lit-html";
import { camelToLabel } from "../utils/studio-utils";

export interface SchemaProperty {
  type?: string;
  properties?: Record<string, SchemaProperty>;
  required?: string[];
  items?: SchemaProperty;
  format?: string;
  $ref?: string;
}

export interface FieldHandlers {
  onDelete: (name: string) => void;
  onToggleRequired: (name: string) => void;
  onRename: (oldName: string, newName: string) => void;
  onChangeType: (name: string, newType: string) => void;
  onChangeFormat?: (name: string, format: string) => void;
  onChangeRefTarget?: (name: string, target: string) => void;
  onAddNestedField?: (
    parentName: string,
    state: { name: string; type: string; required: boolean },
  ) => void;
  onDeleteNested?: (parentName: string, childName: string) => void;
  onToggleNestedRequired?: (parentName: string, childName: string) => void;
  onRenameNested?: (parentName: string, oldChild: string, newChild: string) => void;
  onChangeNestedType?: (parentName: string, childName: string, newType: string) => void;
  onChangeNestedFormat?: (parentName: string, childName: string, format: string) => void;
}

export const FIELD_TYPES = ["string", "number", "boolean", "array", "object", "reference"];

export const FORMAT_OPTIONS = ["", "image", "date", "color"];

/**
 * Detect the studio field type from a JSON Schema property definition.
 *
 * @param {SchemaProperty} schema
 * @returns {string}
 */
export function detectFieldType(schema: SchemaProperty) {
  if (schema.$ref) {
    return "reference";
  }
  return schema.type || "string";
}

/**
 * Detect the format from a JSON Schema property definition.
 *
 * @param {SchemaProperty} schema
 * @returns {string}
 */
export function detectFieldFormat(schema: SchemaProperty) {
  if (schema.type === "array" && schema.items?.format) {
    return schema.items.format;
  }
  return schema.format || "";
}

/**
 * Render a single schema field as an inline-editable form row.
 *
 * @param {string} fieldName
 * @param {SchemaProperty} fieldSchema — JSON Schema property definition
 * @param {boolean} isRequired
 * @param {FieldHandlers} handlers
 * @param {string[]} [contentTypeNames] - Available content type names for reference target picker
 * @returns {import("lit-html").TemplateResult}
 */
export function fieldCardTpl(
  fieldName: string,
  fieldSchema: SchemaProperty,
  isRequired: boolean,
  handlers: FieldHandlers,
  contentTypeNames: string[] = [],
) {
  const type = detectFieldType(fieldSchema);
  const format = detectFieldFormat(fieldSchema);
  const isNested = type === "object";
  const isRef = type === "reference";
  const nestedProps = fieldSchema.properties || {};
  const nestedRequired = fieldSchema.required || [];
  const refTarget = fieldSchema.$ref ? fieldSchema.$ref.replace("#/contentTypes/", "") : "";

  return html`
    <div class="schema-field-card">
      <div class="schema-field-row">
        <sp-field-label size="s" class="schema-field-label"
          >${camelToLabel(fieldName)}</sp-field-label
        >
        <sp-textfield
          size="s"
          quiet
          value=${fieldName}
          class="schema-field-name-input"
          @change=${(e: Event) => {
            const target = e.target as HTMLInputElement;
            const newName = target.value.trim();
            if (newName && newName !== fieldName) {
              handlers.onRename(fieldName, newName);
            } else {
              target.value = fieldName;
            }
          }}
          @keydown=${(e: KeyboardEvent) => {
            const target = e.target as HTMLInputElement;
            if (e.key === "Enter") {
              target.blur();
            }
            if (e.key === "Escape") {
              target.value = fieldName;
              target.blur();
            }
          }}
        ></sp-textfield>
        ${typePickerTpl(type, (newType) => handlers.onChangeType(fieldName, newType))}
        ${type === "string" || type === "array"
          ? formatPickerTpl(format, (f) => {
              if (handlers.onChangeFormat) {
                handlers.onChangeFormat(fieldName, f);
              }
            })
          : nothing}
        <sp-switch
          size="s"
          ?checked=${isRequired}
          @change=${() => handlers.onToggleRequired(fieldName)}
        >
          Req
        </sp-switch>
        <sp-action-button
          size="xs"
          quiet
          title="Delete field"
          @click=${() => handlers.onDelete(fieldName)}
        >
          <sp-icon-delete slot="icon"></sp-icon-delete>
        </sp-action-button>
      </div>
      ${isRef && contentTypeNames.length > 0
        ? html`
            <div class="schema-field-ref-target">
              <sp-picker
                size="s"
                label="Target"
                value=${refTarget}
                @change=${(e: Event) => {
                  if (handlers.onChangeRefTarget) {
                    handlers.onChangeRefTarget(fieldName, (e.target as HTMLInputElement).value);
                  }
                }}
              >
                ${contentTypeNames.map((n) => html`<sp-menu-item value=${n}>${n}</sp-menu-item>`)}
              </sp-picker>
            </div>
          `
        : nothing}
      ${isNested
        ? html`
            <div class="schema-field-nested">
              ${Object.entries(nestedProps).map(([name, sub]) =>
                nestedFieldCardTpl(
                  fieldName,
                  name,
                  sub as SchemaProperty,
                  nestedRequired.includes(name),
                  handlers,
                ),
              )}
              ${nestedAddFieldTpl(fieldName, handlers)}
            </div>
          `
        : nothing}
    </div>
  `;
}

/**
 * Render a nested (child) field card — same inline-editable pattern but delegates to nested
 * handlers.
 *
 * @param {string} parentName
 * @param {string} childName
 * @param {SchemaProperty} childSchema
 * @param {boolean} isRequired
 * @param {FieldHandlers} handlers
 * @returns {import("lit-html").TemplateResult}
 */
function nestedFieldCardTpl(
  parentName: string,
  childName: string,
  childSchema: SchemaProperty,
  isRequired: boolean,
  handlers: FieldHandlers,
) {
  const type = detectFieldType(childSchema);
  const format = detectFieldFormat(childSchema);

  return html`
    <div class="schema-field-card schema-field-card--nested">
      <div class="schema-field-row">
        <sp-textfield
          size="s"
          quiet
          value=${childName}
          class="schema-field-name-input"
          @change=${(e: Event) => {
            const target = e.target as HTMLInputElement;
            const newName = target.value.trim();
            if (newName && newName !== childName && handlers.onRenameNested) {
              handlers.onRenameNested(parentName, childName, newName);
            } else {
              target.value = childName;
            }
          }}
          @keydown=${(e: KeyboardEvent) => {
            const target = e.target as HTMLInputElement;
            if (e.key === "Enter") {
              target.blur();
            }
            if (e.key === "Escape") {
              target.value = childName;
              target.blur();
            }
          }}
        ></sp-textfield>
        ${typePickerTpl(type, (newType) => {
          if (handlers.onChangeNestedType) {
            handlers.onChangeNestedType(parentName, childName, newType);
          }
        })}
        ${type === "string" || type === "array"
          ? formatPickerTpl(format, (f) => {
              if (handlers.onChangeNestedFormat) {
                handlers.onChangeNestedFormat(parentName, childName, f);
              }
            })
          : nothing}
        <sp-switch
          size="s"
          ?checked=${isRequired}
          @change=${() => {
            if (handlers.onToggleNestedRequired) {
              handlers.onToggleNestedRequired(parentName, childName);
            }
          }}
        >
          Req
        </sp-switch>
        <sp-action-button
          size="xs"
          quiet
          title="Delete field"
          @click=${() => {
            if (handlers.onDeleteNested) {
              handlers.onDeleteNested(parentName, childName);
            }
          }}
        >
          <sp-icon-delete slot="icon"></sp-icon-delete>
        </sp-action-button>
      </div>
    </div>
  `;
}

/**
 * Render an inline "Add Field" row for nested objects.
 *
 * @param {string} parentName
 * @param {FieldHandlers} handlers
 * @returns {import("lit-html").TemplateResult}
 */
function nestedAddFieldTpl(parentName: string, handlers: FieldHandlers) {
  return html`
    <div class="schema-nested-add">
      <sp-textfield
        size="s"
        placeholder="field name"
        class="schema-nested-add-name"
        @keydown=${(e: KeyboardEvent) => {
          if (e.key === "Enter") {
            const target = e.target as HTMLInputElement;
            const row = target.closest(".schema-nested-add");
            const name = target.value.trim();
            const typePicker = row?.querySelector("sp-picker") as HTMLInputElement | null;
            const type = typePicker?.value || "string";
            if (name && handlers.onAddNestedField) {
              handlers.onAddNestedField(parentName, {
                name,
                required: false,
                type,
              });
              target.value = "";
            }
          }
        }}
      ></sp-textfield>
      ${typePickerTpl("string", () => {})}
      <sp-action-button
        size="xs"
        quiet
        title="Add nested field"
        @click=${(e: Event) => {
          const target = e.target as HTMLElement;
          const row = target.closest(".schema-nested-add");
          const nameInput = row?.querySelector(
            ".schema-nested-add-name",
          ) as HTMLInputElement | null;
          const typePicker = row?.querySelector("sp-picker") as HTMLInputElement | null;
          const name = nameInput?.value?.trim();
          const type = typePicker?.value || "string";
          if (name && handlers.onAddNestedField) {
            handlers.onAddNestedField(parentName, {
              name,
              required: false,
              type,
            });
            if (nameInput) {
              nameInput.value = "";
            }
          }
        }}
      >
        <sp-icon-add slot="icon"></sp-icon-add>
      </sp-action-button>
    </div>
  `;
}

/**
 * Render the type picker as an sp-picker dropdown.
 *
 * @param {string} value
 * @param {(type: string) => void} onChange
 * @returns {import("lit-html").TemplateResult}
 */
export function typePickerTpl(value: string, onChange: (type: string) => void) {
  return html`
    <sp-picker
      size="s"
      label="Type"
      value=${value}
      @change=${(e: Event) => onChange((e.target as HTMLInputElement).value)}
    >
      ${FIELD_TYPES.map((t) => html`<sp-menu-item value=${t}>${t}</sp-menu-item>`)}
    </sp-picker>
  `;
}

/**
 * Render the format picker as an sp-picker dropdown.
 *
 * @param {string} value
 * @param {(format: string) => void} onChange
 * @returns {import("lit-html").TemplateResult}
 */
export function formatPickerTpl(value: string, onChange: (format: string) => void) {
  return html`
    <sp-picker
      size="s"
      label="Format"
      value=${value}
      @change=${(e: Event) => onChange((e.target as HTMLInputElement).value)}
    >
      ${FORMAT_OPTIONS.map((f) => html`<sp-menu-item value=${f}>${f || "(none)"}</sp-menu-item>`)}
    </sp-picker>
  `;
}

/**
 * Render the add-field form (inline, not a dialog).
 *
 * @param {{ name: string; type: string; format: string; required: boolean }} state
 * @param {{
 *   onInput: (field: string, value: string | boolean) => void;
 *   onConfirm: () => void;
 *   onCancel: () => void;
 * }} handlers
 * @returns {import("lit-html").TemplateResult}
 */
export function addFieldFormTpl(
  state: { name: string; type: string; format: string; required: boolean },
  handlers: {
    onInput: (field: string, value: string | boolean) => void;
    onConfirm: () => void;
    onCancel: () => void;
  },
) {
  return html`
    <div class="schema-add-field">
      <sp-textfield
        size="s"
        placeholder="Field name"
        .value=${state.name}
        @input=${(e: Event) => handlers.onInput("name", (e.target as HTMLInputElement).value)}
        @keydown=${(e: KeyboardEvent) => {
          if (e.key === "Enter") {
            handlers.onConfirm();
          }
          if (e.key === "Escape") {
            handlers.onCancel();
          }
        }}
      ></sp-textfield>
      ${typePickerTpl(state.type, (t) => handlers.onInput("type", t))}
      ${state.type === "string" || state.type === "array"
        ? formatPickerTpl(state.format || "", (f) => handlers.onInput("format", f))
        : nothing}
      <sp-switch
        size="s"
        ?checked=${state.required}
        @change=${(e: Event) =>
          handlers.onInput("required", (e.target as HTMLInputElement).checked)}
      >
        Required
      </sp-switch>
      <sp-action-button size="s" @click=${handlers.onConfirm}>Add</sp-action-button>
      <sp-action-button size="s" quiet @click=${handlers.onCancel}>Cancel</sp-action-button>
    </div>
  `;
}

/**
 * Build a JSON Schema property definition from a type and optional format.
 *
 * @param {string} type
 * @param {string} [format]
 * @returns {object}
 */
export function schemaForType(type: string, format?: string) {
  switch (type) {
    case "number": {
      return { type: "number" };
    }
    case "boolean": {
      return { type: "boolean" };
    }
    case "array": {
      return format
        ? { items: { format, type: "string" }, type: "array" }
        : { items: { type: "string" }, type: "array" };
    }
    case "object": {
      return { properties: {}, required: [], type: "object" };
    }
    case "reference": {
      return { $ref: "#/contentTypes/" };
    }
    default: {
      return format ? { format, type: "string" } : { type: "string" };
    }
  }
}

/**
 * Generate a YAML frontmatter default value for a given schema type.
 *
 * @param {string} type
 * @param {string} [format]
 * @returns {string}
 */
export function yamlDefault(type: string, format?: string) {
  if (format === "date") {
    return new Date().toISOString().split("T")[0];
  }
  if (format === "image") {
    return '""';
  }
  switch (type) {
    case "boolean": {
      return "false";
    }
    case "number": {
      return "0";
    }
    case "array": {
      return "[]";
    }
    case "object": {
      return "{}";
    }
    default: {
      return '""';
    }
  }
}
