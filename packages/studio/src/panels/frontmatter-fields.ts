/// <reference lib="dom" />
/**
 * Frontmatter-fields.ts — Shared schema-driven frontmatter field collection and renderers.
 *
 * Used by both frontmatter editing surfaces: the Document tab (head-panel) and the above-canvas
 * Properties panel (frontmatter-panel). Fields come from the content-collection schema
 * (`findContentTypeSchema`) plus any extra keys already present in the frontmatter; each renders as
 * a typed widget committing through `mutateUpdateFrontmatter`.
 */

import { html } from "lit-html";
import { live } from "lit-html/directives/live.js";
import { renderFieldRow } from "../ui/field-row";
import { spNumberField, spTextField } from "../ui/field-input";
import { renderMediaPicker } from "../ui/media-picker";
import { mutateUpdateFrontmatter, transactDoc } from "../tabs/transact";
import { findContentTypeSchema } from "../utils/studio-utils";
import { NULL_FORM_CONTEXT, getFormControl, referenceTarget } from "../ui/schema-form";
import type { JsonSchema } from "../ui/schema-form";

import type { JsonValue } from "../types";
import type { Tab } from "../tabs/tab";
import type { ProjectConfig } from "@jxsuite/schema/types";

export interface FmSchemaEntry {
  type?: string;
  enum?: string[];
  format?: string;
  properties?: Record<string, unknown>;
  /** `#/content/<type>` — a relationship to another collection (site-architecture.md §6.1). */
  $ref?: string;
}

export interface FmField {
  field: string;
  entry: FmSchemaEntry;
  value: JsonValue;
}

export interface FmFieldSet {
  /** Matched content collection, or null when the doc isn't part of one. */
  collection: { name: string; schema: unknown } | null;
  /** Schema-declared fields (schema order) followed by extra frontmatter keys. */
  fields: FmField[];
  requiredFields: Set<string>;
  /** True when the matched collection declares `schema.properties`. */
  hasSchema: boolean;
}

/**
 * Collect the frontmatter fields to display for a tab: schema-declared fields first (in schema
 * order), then any extra frontmatter keys not in the schema with types inferred from their values.
 * `$`-prefixed keys and `reserved` keys are skipped.
 *
 * @param {Tab} tab
 * @param {ProjectConfig | null | undefined} projectConfig
 * @param {Set<string>} reserved — keys managed by dedicated controls elsewhere
 * @returns {FmFieldSet}
 */
export function collectFmFields(
  tab: Tab,
  projectConfig: ProjectConfig | null | undefined,
  reserved: Set<string>,
): FmFieldSet {
  const fm = tab.doc.content?.frontmatter || {};
  const collection = findContentTypeSchema(tab.documentPath, projectConfig);
  const schema = collection?.schema as
    | { properties?: Record<string, FmSchemaEntry>; required?: string[] }
    | undefined;
  const schemaProps = schema?.properties;
  const requiredFields = new Set(schema?.required || []);

  const fields: FmField[] = [];
  if (schemaProps) {
    for (const [field, fieldSchema] of Object.entries(schemaProps)) {
      if (reserved.has(field)) {
        continue;
      }
      fields.push({ entry: fieldSchema, field, value: fm[field] as JsonValue });
    }
    for (const [field, value] of Object.entries(fm)) {
      if (schemaProps[field] || field.startsWith("$") || reserved.has(field)) {
        continue;
      }
      fields.push({
        entry: { type: typeof value === "boolean" ? "boolean" : "string" },
        field,
        value: value as JsonValue,
      });
    }
  } else {
    for (const [field, value] of Object.entries(fm)) {
      if (field.startsWith("$") || reserved.has(field)) {
        continue;
      }
      fields.push({
        entry: { type: typeof value === "boolean" ? "boolean" : "string" },
        field,
        value: value as JsonValue,
      });
    }
  }

  return { collection, fields, hasSchema: Boolean(schemaProps), requiredFields };
}

/**
 * Render one frontmatter field as a typed widget row. Commits through `transactDoc` +
 * `mutateUpdateFrontmatter` on `tab`.
 *
 * **`tab` is a parameter because this renderer has two hosts and only one of them follows the
 * focus.** It committed to `activeTab.value` at each of its seven widgets, which is right for the
 * Navigator's Document panel (an app-level surface showing the focused document) and wrong for the
 * Document Header card, which `panels/frontmatter-panel.ts` draws INSIDE a pane's stage, once per
 * pane. So a collection field edited on the card in one pane wrote into whichever document had the
 * keyboard: the card went on showing the old value, and a document nobody was looking at changed.
 * The Document Header's `transact(tab, …)` branch was fixed for JSON documents in an earlier pass
 * and this — every schema-driven frontmatter field, on every content document — is what that pass
 * missed.
 *
 * @param {Tab | null} tab The document to commit into.
 * @param {string} field
 * @param {FmSchemaEntry} entry
 * @param {JsonValue} value
 * @param {Set<string>} requiredFields
 * @returns {import("lit-html").TemplateResult}
 */
export function renderFmField(
  tab: Tab | null,
  field: string,
  entry: FmSchemaEntry,
  value: JsonValue,
  requiredFields: Set<string>,
) {
  const isRequired = requiredFields.has(field);
  const label = field.replaceAll(/([A-Z])/g, " $1").replace(/^./, (s) => s.toUpperCase());
  const displayLabel = label + (isRequired ? " *" : "");
  const hasVal = value !== undefined && value !== "" && value !== false;
  const onClear = () => transactDoc(tab, (t) => mutateUpdateFrontmatter(t, field));

  /* A relationship to another collection is the ONE registered `reference` control — the same
     picker the entry editor and the settings forms draw, reached through the registry rather than
     reimplemented here. Before this branch a `$ref` field fell through to the textfield at the
     bottom of this function, so the author typed an entry id from memory with no way to see what
     ids exist and no sign when the one they typed was wrong. */
  const referenceControl =
    referenceTarget(entry) === null ? undefined : getFormControl("reference");
  if (referenceControl) {
    return renderFieldRow({
      hasValue: hasVal,
      label: displayLabel,
      onClear,
      prop: field,
      widget: referenceControl({
        // The reference control resolves nothing through the context — its choices are files.
        ctx: NULL_FORM_CONTEXT,
        key: field,
        onChange: (next) =>
          transactDoc(tab, (t) =>
            mutateUpdateFrontmatter(t, field, (next ?? undefined) as JsonValue),
          ),
        schema: entry as JsonSchema,
        value,
      }),
    });
  }

  if (entry.type === "boolean") {
    return renderFieldRow({
      hasValue: hasVal,
      label: displayLabel,
      onClear,
      prop: field,
      widget: html`
        <sp-checkbox
          size="s"
          .checked=${live(Boolean(value))}
          @change=${(e: Event) =>
            transactDoc(tab, (t) =>
              mutateUpdateFrontmatter(
                t,
                field,
                (e.target as HTMLInputElement).checked || undefined,
              ),
            )}
        ></sp-checkbox>
      `,
    });
  }

  if (entry.type === "array") {
    const display = Array.isArray(value) ? value.join(", ") : (value as string) || "";
    return renderFieldRow({
      hasValue: hasVal,
      label: displayLabel,
      onClear,
      prop: field,
      widget: spTextField(
        `fm:${field}`,
        display,
        (v: string) => {
          const arr = v
            ? v
                .split(",")
                .map((s: string) => s.trim())
                .filter(Boolean)
            : undefined;
          transactDoc(tab, (t) => mutateUpdateFrontmatter(t, field, arr));
        },
        { placeholder: "comma, separated" },
      ),
    });
  }

  if (Array.isArray(entry.enum)) {
    return renderFieldRow({
      hasValue: hasVal,
      label: displayLabel,
      onClear,
      prop: field,
      widget: html`
        <sp-picker
          size="s"
          .value=${live(value || "")}
          @change=${(e: Event) =>
            transactDoc(tab, (t) =>
              mutateUpdateFrontmatter(t, field, (e.target as HTMLInputElement).value || undefined),
            )}
        >
          ${entry.enum.map((opt: string) => html`<sp-menu-item value=${opt}>${opt}</sp-menu-item>`)}
        </sp-picker>
      `,
    });
  }

  if (entry.format === "image") {
    return renderFieldRow({
      hasValue: hasVal,
      label: displayLabel,
      onClear,
      prop: field,
      widget: renderMediaPicker(field, value as string, (v: string) =>
        transactDoc(tab, (t) => mutateUpdateFrontmatter(t, field, v || undefined)),
      ),
    });
  }

  if (entry.type === "number") {
    return renderFieldRow({
      hasValue: hasVal,
      label: displayLabel,
      onClear,
      prop: field,
      widget: spNumberField(value !== undefined ? Number(value) : undefined, (n) =>
        transactDoc(tab, (t) => mutateUpdateFrontmatter(t, field, n)),
      ),
    });
  }

  return renderFieldRow({
    hasValue: hasVal,
    label: displayLabel,
    onClear,
    prop: field,
    widget: spTextField(
      `fm:${field}`,
      (value as string) || "",
      (v: string) => transactDoc(tab, (t) => mutateUpdateFrontmatter(t, field, v || undefined)),
      { placeholder: entry.format === "date" ? "YYYY-MM-DD" : "" },
    ),
  });
}
