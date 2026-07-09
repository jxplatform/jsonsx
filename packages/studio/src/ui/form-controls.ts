/// <reference lib="dom" />
/**
 * Built-in schema-form controls (specs/extensions.md §9.1): "schema-builder" (visual JSON-Schema
 * field editor wrapping settings/schema-field-ui) and "secret" (value committed via the host's
 * secret store, never project.json). The third built-in, "binding", registers from
 * panels/signals-panel.ts because it owns panel-local ephemeral UI state (custom-ref mode) and the
 * route-param picker semantics.
 *
 * Imported once for side effects from studio startup.
 */

import { html } from "lit-html";
import { repeat } from "lit-html/directives/repeat.js";
import { registerFormControl } from "./schema-form";
import {
  addFieldFormTpl,
  detectFieldFormat,
  fieldCardTpl,
  schemaForType,
} from "../settings/schema-field-ui";
import { toCamelCase } from "../utils/studio-utils";

import type { FieldHandlers, SchemaProperty } from "../settings/schema-field-ui";
import type { SchemaFormControlArgs } from "./schema-form";

// ─── Schema-builder control ──────────────────────────────────────────────────

/** The JSON-Schema object shape the schema-builder edits. */
interface BuilderSchema {
  type?: string;
  properties?: Record<string, SchemaProperty>;
  required?: string[];
}

interface AddFieldState {
  format: string;
  name: string;
  required: boolean;
  type: string;
}

const blankAddFieldState = (): AddFieldState => ({
  format: "",
  name: "",
  required: false,
  type: "string",
});

/** Per-field add-field form state, keyed by `${fieldKeyPrefix}.${key}`. */
const addFieldOpen = new Set<string>();
const addFieldStates = new Map<string, AddFieldState>();

/** Reset schema-builder ephemeral UI state (test hook). */
export function resetFormControlUiState(): void {
  addFieldOpen.clear();
  addFieldStates.clear();
}

/** Working clone of the schema value — JSON round-trip, as values may be reactive proxies. */
function cloneSchema(value: unknown): BuilderSchema {
  const base =
    value && typeof value === "object" && !Array.isArray(value)
      ? value
      : { properties: {}, required: [], type: "object" };
  // oxlint-disable-next-line unicorn/prefer-structured-clone
  return JSON.parse(JSON.stringify(base)) as BuilderSchema;
}

/** Visual JSON-Schema field editor wrapping the shared schema-field-ui templates. */
function schemaBuilderControl({ key, value, onChange, ctx, rerender }: SchemaFormControlArgs) {
  const schema =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as BuilderSchema)
      : ({ properties: {}, required: [], type: "object" } as BuilderSchema);
  const properties = schema.properties ?? {};
  const required = schema.required ?? [];
  const stateKey = `${ctx.fieldKeyPrefix ?? ""}.${key}`;

  const update = (mutate: (draft: BuilderSchema) => void) => {
    const draft = cloneSchema(value);
    draft.type ??= "object";
    draft.properties ??= {};
    draft.required ??= [];
    mutate(draft);
    onChange(draft);
    rerender?.();
  };

  // Content types available as reference targets, resolved through the host context
  const contentTypesValue = ctx.resolvePointer("#/$context/contentTypes");
  const contentTypeNames =
    contentTypesValue && typeof contentTypesValue === "object"
      ? Object.keys(contentTypesValue)
      : [];

  const handlers: FieldHandlers = {
    onAddNestedField: (parentName, fieldState) =>
      update((draft) => {
        const parent = draft.properties?.[parentName];
        const name = toCamelCase(fieldState.name);
        if (!parent || !name) {
          return;
        }
        parent.properties ??= {};
        parent.properties[name] = schemaForType(fieldState.type);
        if (fieldState.required) {
          parent.required ??= [];
          if (!parent.required.includes(name)) {
            parent.required.push(name);
          }
        }
      }),
    onChangeFormat: (name, format) =>
      update((draft) => {
        const prop = draft.properties?.[name];
        if (!prop) {
          return;
        }
        draft.properties![name] = schemaForType(prop.type || "string", format || undefined);
      }),
    onChangeNestedFormat: (parentName, childName, format) =>
      update((draft) => {
        const parent = draft.properties?.[parentName];
        const prop = parent?.properties?.[childName];
        if (!prop) {
          return;
        }
        parent!.properties![childName] = schemaForType(prop.type || "string", format || undefined);
      }),
    onChangeNestedType: (parentName, childName, newType) =>
      update((draft) => {
        const parent = draft.properties?.[parentName];
        const prop = parent?.properties?.[childName];
        if (!prop) {
          return;
        }
        const oldFormat =
          newType === "string" || newType === "array" ? detectFieldFormat(prop) : undefined;
        parent!.properties![childName] = schemaForType(newType, oldFormat || undefined);
      }),
    onChangeRefTarget: (name, target) =>
      update((draft) => {
        if (!draft.properties?.[name]) {
          return;
        }
        draft.properties[name] = { $ref: `#/contentTypes/${target}` };
      }),
    onChangeType: (name, newType) =>
      update((draft) => {
        const prop = draft.properties?.[name];
        if (!prop) {
          return;
        }
        const oldFormat =
          newType === "string" || newType === "array" ? detectFieldFormat(prop) : undefined;
        draft.properties![name] = schemaForType(newType, oldFormat || undefined);
      }),
    onDelete: (name) =>
      update((draft) => {
        delete draft.properties?.[name];
        draft.required = (draft.required ?? []).filter((r) => r !== name);
      }),
    onDeleteNested: (parentName, childName) =>
      update((draft) => {
        const parent = draft.properties?.[parentName];
        if (!parent?.properties) {
          return;
        }
        delete parent.properties[childName];
        if (parent.required) {
          parent.required = parent.required.filter((r) => r !== childName);
        }
      }),
    onRename: (oldName, newName) =>
      update((draft) => {
        const normalized = toCamelCase(newName);
        if (!draft.properties || !normalized || draft.properties[normalized]) {
          return;
        }
        const next: Record<string, SchemaProperty> = {};
        for (const [k, v] of Object.entries(draft.properties)) {
          next[k === oldName ? normalized : k] = v;
        }
        draft.properties = next;
        draft.required = (draft.required ?? []).map((r) => (r === oldName ? normalized : r));
      }),
    onRenameNested: (parentName, oldChild, newChild) =>
      update((draft) => {
        const parent = draft.properties?.[parentName];
        const normalized = toCamelCase(newChild);
        if (!parent?.properties || !normalized || parent.properties[normalized]) {
          return;
        }
        const next: Record<string, SchemaProperty> = {};
        for (const [k, v] of Object.entries(parent.properties)) {
          next[k === oldChild ? normalized : k] = v;
        }
        parent.properties = next;
        if (parent.required) {
          parent.required = parent.required.map((r) => (r === oldChild ? normalized : r));
        }
      }),
    onToggleNestedRequired: (parentName, childName) =>
      update((draft) => {
        const parent = draft.properties?.[parentName];
        if (!parent) {
          return;
        }
        parent.required ??= [];
        const idx = parent.required.indexOf(childName);
        if (idx === -1) {
          parent.required.push(childName);
        } else {
          parent.required.splice(idx, 1);
        }
      }),
    onToggleRequired: (name) =>
      update((draft) => {
        draft.required ??= [];
        const idx = draft.required.indexOf(name);
        if (idx === -1) {
          draft.required.push(name);
        } else {
          draft.required.splice(idx, 1);
        }
      }),
  };

  const fieldCards = repeat(
    Object.entries(properties),
    ([name]) => name,
    ([name, def]) => fieldCardTpl(name, def, required.includes(name), handlers, contentTypeNames),
  );

  const addFieldState = addFieldStates.get(stateKey) ?? blankAddFieldState();

  return html`
    <div class="schema-builder">
      <div class="schema-field-list">${fieldCards}</div>
      ${addFieldOpen.has(stateKey)
        ? addFieldFormTpl(addFieldState, {
            onCancel: () => {
              addFieldOpen.delete(stateKey);
              addFieldStates.delete(stateKey);
              rerender?.();
            },
            onConfirm: () => {
              const raw = addFieldState.name.trim();
              const name = toCamelCase(raw);
              if (!name) {
                return;
              }
              // Close the form before update() rerenders with the committed value
              addFieldOpen.delete(stateKey);
              addFieldStates.delete(stateKey);
              update((draft) => {
                draft.properties![name] = schemaForType(
                  addFieldState.type,
                  addFieldState.format || undefined,
                );
                if (addFieldState.required && !draft.required!.includes(name)) {
                  draft.required!.push(name);
                }
              });
            },
            onInput: (field, val) => {
              addFieldStates.set(stateKey, { ...addFieldState, [field]: val });
              rerender?.();
            },
          })
        : html`
            <sp-action-button
              size="s"
              quiet
              @click=${() => {
                addFieldOpen.add(stateKey);
                addFieldStates.set(stateKey, blankAddFieldState());
                rerender?.();
              }}
            >
              <sp-icon-add slot="icon"></sp-icon-add> Add Field
            </sp-action-button>
          `}
    </div>
  `;
}

registerFormControl("schema-builder", schemaBuilderControl);

// ─── Secret control ──────────────────────────────────────────────────────────

// Secrets commit through the host's secret store, never project.json. TODO: the platform
// SetSecrets PAL member does not exist yet — until a host supplies ctx.commitSecret, the control
// Renders disabled as a placeholder.
registerFormControl("secret", ({ key, value, ctx }) => {
  const { commitSecret } = ctx;
  return html`<sp-textfield
    size="s"
    type="password"
    class="secret-field"
    placeholder=${value ? "••••••••" : "Not set"}
    ?disabled=${!commitSecret}
    @change=${(e: Event) => {
      if (commitSecret) {
        void commitSecret(key, (e.target as HTMLInputElement).value);
      }
    }}
  ></sp-textfield>`;
});

// Keep an explicit export so hosts can assert the built-ins module loaded
export const builtinFormControls = ["schema-builder", "secret"] as const;
