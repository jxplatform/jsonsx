/// <reference lib="dom" />
/**
 * Schema-form — reusable JSON-Schema → form rendering engine, extracted from the signals panel.
 *
 * Maps schema property types to Spectrum controls (enum → picker, boolean → checkbox,
 * number/integer → number-field, `json-schema` format → multiline JSON editor, array-of-objects →
 * multi-row inline form, other array/object → JSON text field, default → textfield). Hosts commit
 * edits through a single `onChange(patch)` callback; dynamic enum choices and `$ref` bindings
 * resolve through a {@link SchemaFormContext}. Custom controls register by name via
 * {@link registerFormControl} and are consulted first for `ui` overrides.
 */

import { html, nothing } from "lit-html";
import { ifDefined } from "lit-html/directives/if-defined.js";
import { live } from "lit-html/directives/live.js";
import { styleMap } from "lit-html/directives/style-map.js";
import { isRef } from "@jxsuite/schema/guards";
import { renderFieldRow } from "./field-row";
import type { TemplateResult } from "lit-html";

/** A (possibly nested) JSON Schema node, covering both object and property level keys. */
export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  description?: string;
  enum?: unknown;
  default?: unknown;
  format?: string;
  minimum?: number;
  maximum?: number;
  examples?: string[];
  name?: string;
  items?: JsonSchema;
}

/** Host-provided context threaded to every control. */
export interface SchemaFormContext {
  /** Resolve a `#/$context/…` pointer (or legacy sentinel) against the host's project config. */
  resolvePointer: (pointer: string, scope?: Record<string, unknown>) => unknown;
  /** Route params available for `$ref` bindings (e.g. from the document path). */
  params?: string[] | undefined;
  /** Unique prefix for per-field ephemeral UI state (e.g. the binding control's custom mode). */
  fieldKeyPrefix?: string | undefined;
  /**
   * Commit hook for the "secret" control: stores the VALUE in the platform's secret store (never
   * project.json) and returns the derived env-var NAME, which the control persists to the field
   * instead of the value.
   */
  commitSecret?: ((key: string, value: string) => string | Promise<string>) | undefined;
}

/** Arguments passed to a registered form control. */
export interface SchemaFormControlArgs {
  key: string;
  schema: JsonSchema;
  value: unknown;
  onChange: (next: unknown) => void;
  ctx: SchemaFormContext;
  rerender?: (() => void) | undefined;
}

export type SchemaFormControl = (args: SchemaFormControlArgs) => TemplateResult;

/** Options for {@link renderForm}. */
export interface RenderFormOptions {
  onChange: (patch: Record<string, unknown>) => void;
  context?: SchemaFormContext | undefined;
  /**
   * Per-field overrides from `$studio.settings.entry.ui`: a registered control name, and/or an
   * `enum` source (choice list or `{ "$ref": "#/$context/<pointer>" }`) layered over the field
   * schema — fragments stay valid JSON Schema while descriptors add dynamic choices.
   */
  ui?: Record<string, { control?: string; enum?: unknown }> | undefined;
  rerender?: (() => void) | undefined;
}

// ─── Control registry ────────────────────────────────────────────────────────

const controlRegistry = new Map<string, SchemaFormControl>();

/** Register (or replace) a named form control. */
export function registerFormControl(name: string, control: SchemaFormControl): void {
  controlRegistry.set(name, control);
}

/** Look up a registered form control by name. */
export function getFormControl(name: string): SchemaFormControl | undefined {
  return controlRegistry.get(name);
}

/** Inert context used when a host renders a form without one. */
const NULL_CONTEXT: SchemaFormContext = {
  resolvePointer: () => {
    // Nothing to resolve against without a host context
  },
};

// ─── Enum resolution ─────────────────────────────────────────────────────────

/**
 * Resolve a schema enum definition to concrete choices. Plain arrays pass through; `$ref` objects
 * and sentinel strings resolve through the context's pointer resolver, applying object →
 * `Object.keys` and string[] → itself.
 *
 * @param {unknown} enumDef
 * @param {SchemaFormContext | undefined} ctx
 * @param {Record<string, unknown>} [scope] - Scope for `{@param}` substitution (the form value)
 * @returns {string[] | undefined}
 */
export function resolveFormEnum(
  enumDef: unknown,
  ctx?: SchemaFormContext,
  scope?: Record<string, unknown>,
): string[] | undefined {
  if (Array.isArray(enumDef)) {
    return enumDef as string[];
  }
  let pointer: string | undefined;
  if (enumDef && typeof enumDef === "object") {
    const ref = (enumDef as Record<string, unknown>).$ref;
    if (typeof ref === "string") {
      pointer = ref;
    }
  } else if (typeof enumDef === "string") {
    // Legacy sentinel strings (e.g. "$contentTypes") resolve through the host's pointer resolver
    pointer = enumDef;
  }
  if (pointer === undefined || !ctx) {
    return undefined;
  }
  const resolved = ctx.resolvePointer(pointer, scope);
  if (Array.isArray(resolved)) {
    return resolved.map(String);
  }
  if (resolved && typeof resolved === "object") {
    return Object.keys(resolved);
  }
  return undefined;
}

// ─── Field helpers ───────────────────────────────────────────────────────────

/** Parse a numeric field value, returning NaN for blank input (so callers can treat it as unset). */
export function parseNumericField(raw: string, integer: boolean): number {
  if (raw.trim() === "") {
    return Number.NaN;
  }
  return integer ? Math.trunc(Number(raw)) : Number(raw);
}

/** Plain textfield editing a `{ $ref }` value directly — the fallback when no binding control. */
function refTextField(key: string, refVal: string, onChange: (next: unknown) => void) {
  return html`<sp-textfield
    size="s"
    label=${key}
    placeholder=${key}
    .value=${live(refVal)}
    @change=${(e: Event) => {
      const v = (e.target as HTMLInputElement).value.trim();
      onChange(v ? { $ref: v } : undefined);
    }}
  ></sp-textfield>`;
}

/**
 * Render a single inline field within an array-of-objects row. Dispatches by schema type: enum →
 * picker, boolean → switch, number → number-field, else → textfield.
 *
 * @param {string} key
 * @param {JsonSchema} schema
 * @param {unknown} value
 * @param {(val: unknown) => void} onChange
 * @param {SchemaFormContext | undefined} ctx
 * @param {Record<string, unknown>} [scope] - Scope for dependent enum refs (the parent form value)
 */
export function renderInlineField(
  key: string,
  schema: JsonSchema,
  value: unknown,
  onChange: (val: unknown) => void,
  ctx?: SchemaFormContext,
  scope?: Record<string, unknown>,
) {
  if (isRef(value)) {
    return refTextField(key, value.$ref, onChange);
  }
  const enumValues = resolveFormEnum(schema.enum, ctx, scope);

  if (enumValues) {
    return html`<sp-picker
      size="s"
      label=${key}
      value=${value !== undefined ? String(value) : "__none__"}
      @change=${(e: Event) =>
        onChange(
          (e.target as HTMLInputElement).value === "__none__"
            ? undefined
            : (e.target as HTMLInputElement).value,
        )}
    >
      <sp-menu-item value="__none__">—</sp-menu-item>
      ${enumValues.map((v: string) => html`<sp-menu-item value=${v}>${v}</sp-menu-item>`)}
    </sp-picker>`;
  }
  if (schema.type === "boolean") {
    return html`<sp-switch
      size="s"
      ?checked=${Boolean(value)}
      @change=${(e: Event) => onChange((e.target as HTMLInputElement).checked)}
      >${key}</sp-switch
    >`;
  }
  if (schema.type === "integer" || schema.type === "number") {
    return html`<sp-number-field
      size="s"
      label=${key}
      .value=${value !== undefined ? value : nothing}
      step=${schema.type === "integer" ? "1" : nothing}
      @change=${(e: Event) => {
        const parsed = parseNumericField(
          (e.target as HTMLInputElement).value,
          schema.type === "integer",
        );
        onChange(Number.isNaN(parsed) ? undefined : parsed);
      }}
    ></sp-number-field>`;
  }
  return html`<sp-textfield
    size="s"
    label=${key}
    placeholder=${key}
    .value=${value ?? ""}
    @input=${(e: Event) => onChange((e.target as HTMLInputElement).value || undefined)}
  ></sp-textfield>`;
}

/** Render a debounced multiline JSON text field for array/object schema properties. */
function renderJsonTextField(currentValue: unknown, ps: JsonSchema, commit: (v: unknown) => void) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let debounce: ReturnType<typeof setTimeout> | undefined;
  return html`<sp-textfield
    multiline
    size="s"
    style="min-height:40px"
    .value=${currentValue !== undefined ? JSON.stringify(currentValue, null, 2) : ""}
    placeholder=${ps.default !== undefined ? JSON.stringify(ps.default) : nothing}
    @input=${(e: Event) => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        try {
          commit(JSON.parse((e.target as HTMLInputElement).value) as unknown);
        } catch {}
      }, 500);
    }}
  ></sp-textfield>`;
}

// ─── Per-property control dispatch ───────────────────────────────────────────

/** Render the widget for one schema property, honoring registered-control overrides. */
function renderPropertyControl(
  prop: string,
  ps: JsonSchema,
  value: Record<string, unknown>,
  required: Set<string>,
  opts: RenderFormOptions,
  ctx: SchemaFormContext,
): TemplateResult {
  const currentValue = value[prop];
  const commit = (next: unknown) => opts.onChange({ [prop]: next });
  const controlArgs: SchemaFormControlArgs = {
    ctx,
    key: prop,
    onChange: commit,
    rerender: opts.rerender,
    schema: ps,
    value: currentValue,
  };

  // Explicit ui override → consult the control registry first
  const overrideName = opts.ui?.[prop]?.control;
  if (overrideName) {
    const custom = controlRegistry.get(overrideName);
    if (custom) {
      return custom(controlArgs);
    }
  }

  if (
    isRef(currentValue) &&
    ps.format !== "json-schema" &&
    ps.type !== "object" &&
    ps.type !== "array"
  ) {
    const binding = controlRegistry.get("binding");
    if (binding) {
      return binding(controlArgs);
    }
    return refTextField(prop, currentValue.$ref, commit);
  }

  const enumValues = resolveFormEnum(opts.ui?.[prop]?.enum ?? ps.enum, ctx, value);
  if (enumValues) {
    return html`
      <sp-picker
        size="s"
        value=${
          currentValue !== undefined
            ? String(currentValue)
            : ps.default !== undefined
              ? String(ps.default)
              : "__none__"
        }
        @change=${(e: Event) =>
          commit(
            (e.target as HTMLInputElement).value === "__none__"
              ? undefined
              : (e.target as HTMLInputElement).value,
          )}
      >
        ${!required.has(prop) ? html`<sp-menu-item value="__none__">—</sp-menu-item>` : nothing}
        ${enumValues.map((val: string) => html`<sp-menu-item value=${val}>${val}</sp-menu-item>`)}
      </sp-picker>
    `;
  }
  if (ps.type === "boolean") {
    return html`<sp-checkbox
      ?checked=${currentValue ?? ps.default ?? false}
      @change=${(e: Event) => commit((e.target as HTMLInputElement).checked)}
    ></sp-checkbox>`;
  }
  if (ps.type === "integer" || ps.type === "number") {
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let debounce: ReturnType<typeof setTimeout> | undefined;
    return html`<sp-number-field
      size="s"
      min=${ifDefined(ps.minimum)}
      max=${ifDefined(ps.maximum)}
      step=${ps.type === "integer" ? "1" : nothing}
      .value=${currentValue !== undefined ? currentValue : nothing}
      placeholder=${ps.default != null ? String(ps.default) : nothing}
      @change=${(e: Event) => {
        clearTimeout(debounce);
        debounce = setTimeout(() => {
          const parsed = parseNumericField(
            (e.target as HTMLInputElement).value,
            ps.type === "integer",
          );
          commit(Number.isNaN(parsed) ? undefined : parsed);
        }, 400);
      }}
    ></sp-number-field>`;
  }
  if (ps.format === "json-schema") {
    const hasValue =
      currentValue && typeof currentValue === "object" && Object.keys(currentValue).length > 0;
    const cv = currentValue as Record<string, unknown>;
    const isSchemaRef = hasValue && cv.$ref;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let debounce: ReturnType<typeof setTimeout> | undefined;
    return html`
      <div class="schema-param-editor">
        ${
          hasValue && !isSchemaRef && cv.properties
            ? html`
                <div style="display:flex;flex-wrap:wrap;gap:3px;margin-bottom:4px">
                  ${Object.entries(cv.properties as Record<string, Record<string, unknown>>).map(
                    ([k, v]) => html`
                      <span
                        style="background:var(--bg);padding:1px 6px;border-radius:var(--radius);font-size:10px;color:var(--fg-dim)"
                        >${k}: ${v.type ?? "any"}</span
                      >
                    `,
                  )}
                </div>
              `
            : nothing
        }
        <sp-textfield
          multiline
          size="s"
          style=${styleMap({
            fontFamily: "monospace",
            fontSize: "11px",
            minHeight: hasValue ? "80px" : "40px",
          })}
          .value=${currentValue !== undefined ? JSON.stringify(currentValue, null, 2) : ""}
          placeholder=${ps.description ?? "JSON Schema defining the data shape…"}
          @input=${(e: Event) => {
            clearTimeout(debounce);
            debounce = setTimeout(() => {
              try {
                commit(JSON.parse((e.target as HTMLInputElement).value) as unknown);
              } catch {}
            }, 500);
          }}
        ></sp-textfield>
      </div>
    `;
  }
  if (ps.type === "array" && ps.items?.type === "object" && ps.items?.properties) {
    // Array of objects with defined schema → multi-row inline form
    const rows: Record<string, unknown>[] = Array.isArray(currentValue)
      ? (currentValue as Record<string, unknown>[])
      : [];
    const itemProps = ps.items.properties;
    return html`
      <div class="array-object-field">
        ${rows.map(
          (row: Record<string, unknown>, idx: number) => html`
            <div
              class="array-object-row"
              style="display:flex;gap:4px;align-items:center;margin-bottom:4px"
            >
              ${Object.entries(itemProps).map(([propKey, propSchema]) =>
                renderInlineField(
                  propKey,
                  propSchema,
                  row[propKey],
                  (val) => {
                    const updated = [...rows];
                    updated[idx] = { ...updated[idx], [propKey]: val };
                    commit(updated);
                  },
                  ctx,
                  value,
                ),
              )}
              <sp-action-button
                quiet
                size="s"
                @click=${() => {
                  const updated = rows.filter((_: unknown, i: number) => i !== idx);
                  commit(updated.length > 0 ? updated : undefined);
                  opts.rerender?.();
                }}
              >
                <sp-icon-delete slot="icon"></sp-icon-delete>
              </sp-action-button>
            </div>
          `,
        )}
        <sp-action-button
          quiet
          size="s"
          @click=${(e: Event) => {
            e.stopPropagation();
            const newRow: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(itemProps)) {
              if (v.default !== undefined) {
                newRow[k] = v.default;
              }
            }
            commit([...rows, newRow]);
            opts.rerender?.();
          }}
          >+ Add</sp-action-button
        >
      </div>
    `;
  }
  if (ps.type === "array" || ps.type === "object") {
    return renderJsonTextField(currentValue, ps, commit) as TemplateResult;
  }

  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let debounce: ReturnType<typeof setTimeout> | undefined;
  const params = ctx.params ?? [];
  const ph = ps.default !== undefined ? String(ps.default) : (ps.examples?.[0] ?? "");
  return html`<div style="display:flex;gap:4px;align-items:center">
    <sp-textfield
      size="s"
      style="flex:1"
      .value=${currentValue ?? ""}
      placeholder=${ph || nothing}
      title=${ps.description || nothing}
      @input=${(e: Event) => {
        clearTimeout(debounce);
        debounce = setTimeout(() => commit((e.target as HTMLInputElement).value || undefined), 400);
      }}
    ></sp-textfield>
    ${
      params.length > 0
        ? html`<sp-action-button
            quiet
            size="s"
            title="Bind to route param"
            @click=${() => {
              commit({ $ref: `#/$params/${params[0]}` });
              opts.rerender?.();
            }}
            ><sp-icon-link slot="icon"></sp-icon-link
          ></sp-action-button>`
        : nothing
    }
  </div>`;
}

// ─── Form rendering ──────────────────────────────────────────────────────────

/**
 * Render form field rows for a JSON Schema's `properties`, committing edits through `opts.onChange`
 * as single-key patches (`undefined` values mean "unset the key").
 *
 * @param {JsonSchema} schema
 * @param {Record<string, unknown>} value - The record being edited
 * @param {RenderFormOptions} opts
 * @returns {TemplateResult}
 */
export function renderForm(
  schema: JsonSchema,
  value: Record<string, unknown>,
  opts: RenderFormOptions,
): TemplateResult {
  const required = new Set(schema.required);
  const ctx = opts.context ?? NULL_CONTEXT;

  const propertyFields = Object.entries(schema.properties ?? {}).map(([prop, ps]) => {
    const labelText = prop + (required.has(prop) ? " *" : "");
    return renderFieldRow({
      hasValue: false,
      label: labelText,
      prop: ps.name || prop,
      widget: renderPropertyControl(prop, ps, value, required, opts, ctx),
    });
  });

  return html`${propertyFields}`;
}
