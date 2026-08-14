/// <reference lib="dom" />
/**
 * Built-in schema-form controls (specs/extensions.md §9.1): "schema-builder" (visual JSON-Schema
 * field editor wrapping settings/schema-field-ui), "secret" (value committed via the host's secret
 * store, never project.json) and "reference" (an entry of another content collection). The fourth
 * built-in, "binding", registers from panels/signals-panel.ts because it owns panel-local ephemeral
 * UI state (custom-ref mode) and the route-param picker semantics.
 *
 * Imported once for side effects from studio startup.
 */

import { html, nothing } from "lit-html";
import { repeat } from "lit-html/directives/repeat.js";
import { until } from "lit-html/directives/until.js";
import { errorMessage } from "@jxsuite/schema/parse";
import { referenceTarget, registerFormControl } from "./schema-form";
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
  const contentTypesValue = ctx.resolvePointer("#/$context/content");
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
        draft.properties[name] = { $ref: `#/content/${target}` };
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
      ${
        addFieldOpen.has(stateKey)
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
            `
      }
    </div>
  `;
}

registerFormControl("schema-builder", schemaBuilderControl);

// ─── Secret control ──────────────────────────────────────────────────────────

// Secret VALUES commit through the host's secret store (ctx.commitSecret → platform setSecrets),
// Never project.json; the field itself persists only the derived env-var NAME commitSecret
// Returns. Hosts without a secrets surface leave the control disabled.
registerFormControl("secret", ({ key, value, onChange, ctx, rerender }) => {
  const { commitSecret } = ctx;
  const envName = typeof value === "string" && value ? value : null;
  return html`<sp-textfield
    size="s"
    type="password"
    class="secret-field"
    placeholder=${envName ? `Stored as ${envName}` : "Not set"}
    ?disabled=${!commitSecret}
    @change=${async (e: Event) => {
      const target = e.target as HTMLInputElement;
      const secretValue = target.value;
      if (!commitSecret || !secretValue) {
        return;
      }
      const name = await commitSecret(key, secretValue);
      target.value = "";
      if (typeof name === "string" && name && name !== envName) {
        onChange(name);
      } else {
        rerender?.();
      }
    }}
  ></sp-textfield>`;
});

// ─── Reference control ───────────────────────────────────────────────────────

/**
 * An entry of another content collection — site-architecture.md §6.1's `{ "$ref": "#/content/x" }`
 * and §7.4's "entry picker (dropdown of collection entries)".
 *
 * **Registered once, consulted by everything.** `ui/schema-form.ts` dispatches to it for any
 * property whose `$ref` names a collection, so the settings forms, the entry editor and the
 * frontmatter card all draw the same picker without any of them knowing it exists. That is the
 * whole point: P5 collapsed six value-source vocabularies into one and three call sites still spoke
 * their own, so this one arrives as a registration rather than as a fourth renderer.
 *
 * Three states, and none of them lies:
 *
 * - **loading** — a disabled picker saying so, replaced when the read lands (which is why the control
 *   needs `rerender`; without it there is no second frame and "Loading…" is forever);
 * - **failed** — the current value stays EDITABLE as text, with the reason and a Retry beside it.
 *   Swapping a failed read for an empty dropdown would present "no entries" and "could not find
 *   out" as the same screen, which is §16.1's complaint in miniature;
 * - **ready** — the entries, plus the current value even when it is not among them, marked `— not
 *   found`. A dangling reference is a fact about the project and the author has to see it; silently
 *   blanking the field would delete the evidence and the value in one repaint.
 */

/** Entry ids per collection, as the in-flight read. Started on first ask. */
const entryIdCache = new Map<string, Promise<string[]>>();

/**
 * What the read ENDED as, per collection.
 *
 * Kept beside the promise so a settled collection renders synchronously. Without it every repaint
 * of the enclosing form hands `until` a fresh unsettled promise, `until` falls back to its
 * placeholder, and a picker that has had its answer for ten minutes flashes "Loading…" on every
 * keystroke in the field beside it.
 */
const entryIdResult = new Map<string, { ids: string[] } | { error: string }>();

/**
 * Forget cached entry ids — for one collection, or all of them.
 *
 * Creating, renaming or deleting an entry changes the answer, and the picker would otherwise keep
 * offering a file that is gone until the window reloads. Called by `content/entry-commands.ts`
 * after a create; exported so the test harness can start from a known state.
 */
export function invalidateReferenceEntries(collection?: string): void {
  if (collection === undefined) {
    entryIdCache.clear();
    entryIdResult.clear();
  } else {
    entryIdCache.delete(collection);
    entryIdResult.delete(collection);
  }
}

/** The collection's entry ids, reading them once however many fields reference it. */
function entryIdsFor(collection: string): Promise<string[]> {
  const known = entryIdCache.get(collection);
  if (known) {
    return known;
  }
  /* Dynamic: the collection reader pulls in the platform, the format registry and the workspace,
     and this module is imported for its side effects at startup and by the bare-Bun checks. A
     static import would make registering a form control cost the whole file layer. */
  const pending = import("../grid/sources/content-source").then((m) =>
    m.listCollectionEntryIds(collection),
  );
  entryIdCache.set(collection, pending);
  return pending;
}

/** Plain text editing of the reference id — the fallback when the choices cannot be listed. */
function referenceTextField(current: string, onChange: (next: unknown) => void) {
  return html`<sp-textfield
    size="s"
    class="reference-field"
    .value=${current}
    @change=${(e: Event) => onChange((e.target as HTMLInputElement).value.trim() || undefined)}
  ></sp-textfield>`;
}

/** The picker, once the ids are in. */
function referencePicker(
  collection: string,
  ids: string[],
  current: string,
  onChange: (next: unknown) => void,
) {
  const dangling = current !== "" && !ids.includes(current);
  return html`
    <sp-picker
      size="s"
      class="reference-field"
      value=${current || "__none__"}
      @change=${(e: Event) => {
        const chosen = (e.target as HTMLInputElement).value;
        onChange(chosen === "__none__" ? undefined : chosen);
      }}
    >
      <sp-menu-item value="__none__">—</sp-menu-item>
      ${
        dangling
          ? html`<sp-menu-item class="reference-missing" value=${current}
              >${current} — not found</sp-menu-item
            >`
          : nothing
      }
      ${ids.map((id) => html`<sp-menu-item value=${id}>${id}</sp-menu-item>`)}
    </sp-picker>
    ${ids.length === 0 ? html`<span class="reference-note">No ${collection} entries yet.</span>` : nothing}
  `;
}

registerFormControl("reference", ({ schema, value, onChange, rerender }: SchemaFormControlArgs) => {
  const collection = referenceTarget(schema);
  const current = typeof value === "string" ? value : "";
  if (collection === null) {
    /* The control was named by a `ui.control` override on a property that references nothing. The
       field is still editable — refusing to draw it would lose the value — and the note says which
       half of the declaration is missing. */
    return html`<div class="reference-control">
      ${referenceTextField(current, onChange)}
      <span class="reference-note"
        >No collection referenced — add <code>"$ref": "#/content/&lt;type&gt;"</code> to this
        field.</span
      >
    </div>`;
  }

  const failedTpl = (error: string) => html`
    ${referenceTextField(current, onChange)}
    <span class="reference-note reference-note--failed"
      >Could not list ${collection} entries — ${error}</span
    >
    ${
      /* Retry only where a repaint is possible. A button that cannot do the thing it is named
           after is worse than its absence — the field beside it still edits the value. */
      rerender
        ? html`<sp-action-button
            size="s"
            quiet
            @click=${() => {
              invalidateReferenceEntries(collection);
              rerender();
            }}
            >Retry</sp-action-button
          >`
        : nothing
    }
  `;

  // Already answered: render it now. Only the FIRST paint of a collection waits.
  const done = entryIdResult.get(collection);
  if (done) {
    return html`<div class="reference-control">
      ${
        "ids" in done
          ? referencePicker(collection, done.ids, current, onChange)
          : failedTpl(done.error)
      }
    </div>`;
  }

  /* `until` rather than a host repaint: a form control cannot ask its host to draw a second frame,
     and the frontmatter renderer passes no `rerender` at all — with one, this field would have said
     "Loading…" for the life of the panel. */
  const resolved = entryIdsFor(collection).then(
    (ids) => {
      entryIdResult.set(collection, { ids });
      return referencePicker(collection, ids, current, onChange);
    },
    (error: unknown) => {
      const message = errorMessage(error);
      entryIdResult.set(collection, { error: message });
      return failedTpl(message);
    },
  );

  return html`<div class="reference-control">
    ${until(
      resolved,
      html`<sp-picker size="s" class="reference-field" disabled label="Loading…"></sp-picker>`,
    )}
  </div>`;
});

// Keep an explicit export so hosts can assert the built-ins module loaded
export const builtinFormControls = ["schema-builder", "secret", "reference"] as const;
