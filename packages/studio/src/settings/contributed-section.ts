/// <reference lib="dom" />
/**
 * Contributed settings section — the generic renderer behind `$studio.settings`
 * (specs/extensions.md §9.1). An extension's `project` class declares a settings section and this
 * module renders it over `projectConfig[key]`: layout "form" is one schema form over the whole
 * section value; layout "map" is master-detail (key list left, entry form right) for `type: object`
 * + `additionalProperties` sections. Persistence mirrors the content-types editor: mutate
 * projectState.projectConfig and rewrite project.json through the platform.
 */

import { html, nothing, render as litRender } from "lit-html";
import { errorMessage } from "@jxsuite/schema/parse";
import { getPlatform } from "../platform";
import { projectState } from "../store";
import { renderForm } from "../ui/schema-form";
import { resolveContextPointer } from "../services/context-resolver";
import { deriveSecretEnvName } from "../services/data-service";
import { validateProjectConfig } from "../services/jx-validate";
import { notify } from "../services/notify";

import type { TemplateResult } from "lit-html";
import type { JsonSchema, SchemaFormContext } from "../ui/schema-form";
import type { ProjectConfig } from "@jxsuite/schema/types";

// ─── Contribution shape ───────────────────────────────────────────────────────

/** A `$studio.settings` contribution paired with the entry schema from the project fragment. */
export interface SettingsContribution {
  /** The project.json top-level property the section owns. */
  key: string;
  /** Section heading; falls back to the key. */
  title?: string | undefined;
  /** The `$studio.settings` block from the class descriptor. */
  settings: {
    layout?: "map" | "form" | undefined;
    entry?:
      | {
          ui?: Record<string, { control?: string; enum?: unknown }> | undefined;
          newEntry?: Record<string, unknown> | undefined;
        }
      | undefined;
  };
  /** JSON Schema for one entry (map layout) or the whole section value (form layout). */
  entrySchema: JsonSchema;
}

/** Context handed to a host-provided section actions renderer. */
export interface SectionActionsContext {
  sectionKey: string;
  /** The selected entry key (map layout), or null. */
  selected: string | null;
  rerender: () => void;
}

/** Host options threaded to the schema-form context. */
export interface ContributedSectionOptions {
  /** Registered formats backing the `$formats` virtual root. */
  formats?: { name: string }[] | undefined;
  /**
   * Optional actions row rendered under the section title — the hook domain modules use to surface
   * section-scoped operations (e.g. the data surface's Test/Push actions) without the generic
   * renderer knowing any extension.
   */
  actions?: ((ctx: SectionActionsContext) => TemplateResult) | undefined;
}

// ─── Module state ─────────────────────────────────────────────────────────────

/** Selected entry key per section (map layout). */
const selectedEntries = new Map<string, string | null>();
/** Sections whose new-entry form is open (map layout). */
const newEntryOpen = new Set<string>();
/** Pending new-entry names per section (map layout). */
const newEntryNames = new Map<string, string>();

/** Reset contributed-section ephemeral UI state (test hook). */
export function resetContributedSectionState(): void {
  selectedEntries.clear();
  newEntryOpen.clear();
  newEntryNames.clear();
}

// ─── Validation (§7.1 inline tier, §7.2 Problems) ─────────────────────────────

/**
 * The last validator run's messages, keyed by the JSON-pointer base they were rendered under.
 *
 * `jx-validate` validates the WHOLE `project.json` against the project's generated entry document,
 * so its output has to be routed back to individual controls. Until now it was wired to exactly one
 * caller — the AI's `write_project_config` — which meant the model's edits to this file were
 * schema-checked and a human's edits through this very form were not.
 */
const diagnostics = new Map<string, Record<string, string>>();

/** Drop every cached diagnostic (test hook, and the "project closed" path). */
export function resetContributedDiagnostics(): void {
  diagnostics.clear();
}

/**
 * Route `jx-validate` messages ("/search/index: must be string") to the field they are about.
 *
 * Only the messages one level under `base` become field errors: `/search/index` belongs to the
 * `index` control, and `/search/index/0/kind` belongs to it too — the deepest control that exists
 * on this form is the one that can be corrected. A message ABOUT the base itself has no field to
 * live at and is returned separately, for the section line.
 *
 * @param {string} base - JSON pointer of the record the form is editing, e.g. `/search`
 * @param {string[]} messages
 * @returns {{ fields: Record<string, string>; section: string[] }}
 */
export function routeDiagnostics(
  base: string,
  messages: string[],
): { fields: Record<string, string>; section: string[] } {
  const fields: Record<string, string> = {};
  const section: string[] = [];
  for (const message of messages) {
    const at = message.indexOf(": ");
    const pointer = at === -1 ? "" : message.slice(0, at);
    const text = at === -1 ? message : message.slice(at + 2);
    if (pointer === base) {
      section.push(text);
      continue;
    }
    if (!pointer.startsWith(`${base}/`)) {
      continue;
    }
    const [prop] = pointer.slice(base.length + 1).split("/");
    if (prop && fields[prop] === undefined) {
      fields[prop] = text;
    }
  }
  return { fields, section };
}

// ─── Persistence ──────────────────────────────────────────────────────────────

/**
 * Write `project.json`, then say what is wrong with it.
 *
 * The predecessor was `void saveProjectConfig()` at five call sites: no validation, and a rejected
 * write — a read-only file, a dead RPC — dropped on the floor while the form kept showing the value
 * it had failed to save. §7.2 files a failed config write as a Problem, because it must be fixed
 * and it is about a named file.
 *
 * **The write comes first, and the order is the honest one.** This form mutates
 * `projectState.projectConfig` in place before calling here, so the value is already live in the
 * editor and the canvas; a validator run in front of the write could not have prevented anything,
 * it would only have delayed persisting what the user can already see. This surface REPORTS. The
 * one that gates is `contexts-section.ts`, which builds a candidate map and validates it before
 * anything is applied.
 *
 * @param {string} base - JSON pointer of the record being edited, for routing field errors
 * @param {() => void} rerender
 */
async function saveProjectConfig(base: string, rerender: () => void) {
  const platform = getPlatform();
  const config = (projectState as { projectConfig: ProjectConfig }).projectConfig;

  try {
    await platform.writeFile("project.json", JSON.stringify(config, null, "\t"));
  } catch (error) {
    notify.error(`Could not save project.json — ${errorMessage(error)}`, {
      key: "settings:project.json",
      path: "project.json",
      source: "Settings",
    });
    return;
  }

  let messages: string[] = [];
  try {
    messages = await validateProjectConfig(config);
  } catch (error) {
    /* A validator that will not compile must not be silent about it — but it is not the edit's
       fault, so it is a problem of its own rather than an error parked on the user's field. */
    notify.warn(`Could not validate project.json — ${errorMessage(error)}`, {
      key: "settings:validator",
      path: "project.json",
      source: "Settings",
      tier: "problem",
    });
    return;
  }
  diagnostics.set(base, routeDiagnostics(base, messages).fields);
  rerender();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Apply a schema-form patch onto a record in place; `undefined` values unset the key. */
function applyPatch(target: Record<string, unknown>, patch: Record<string, unknown>) {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete target[key];
    } else {
      target[key] = value;
    }
  }
}

/** Slugify a user-entered entry name — same rules as new content-type names. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replaceAll(/\s+/g, "-")
    .replaceAll(/[^a-z0-9-]/g, "");
}

/** Instantiate a newEntry template, substituting `${key}` in every string value. */
function instantiateNewEntry(
  template: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> {
  if (!template) {
    return {};
  }
  const substitute = (value: unknown): unknown => {
    if (typeof value === "string") {
      return value.replaceAll("${key}", key);
    }
    if (Array.isArray(value)) {
      return value.map((item) => substitute(item));
    }
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = substitute(v);
      }
      return out;
    }
    return value;
  };
  return substitute(template) as Record<string, unknown>;
}

/**
 * Schema-form context resolving `#/$context/…` pointers over the live project config. When the
 * platform has a secrets surface, `commitSecret` backs the "secret" control: the VALUE goes to
 * platform.setSecrets under a derived env name; the returned NAME is what lands in project.json.
 */
function buildContext(
  sectionKey: string,
  opts: ContributedSectionOptions,
  entryKey: string | null = null,
): SchemaFormContext {
  const platform = getPlatform();
  return {
    fieldKeyPrefix: `$settings.${sectionKey}`,
    resolvePointer: (pointer, scope) =>
      resolveContextPointer(pointer, {
        projectConfig: (projectState?.projectConfig ?? {}) as Record<string, unknown>,
        ...(scope !== undefined && { scope }),
        ...(opts.formats !== undefined && { formats: opts.formats }),
      }),
    ...(typeof platform.setSecrets === "function"
      ? {
          commitSecret: async (key: string, value: string) => {
            const envName = deriveSecretEnvName(sectionKey, entryKey, key);
            await platform.setSecrets!({ set: { [envName]: value } });
            return envName;
          },
        }
      : {}),
  };
}

/** The section's value object in the project config, created on demand. */
function sectionValue(key: string): Record<string, unknown> | null {
  const config = projectState?.projectConfig as Record<string, unknown> | null | undefined;
  if (!config) {
    return null;
  }
  const existing = config[key];
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    return existing as Record<string, unknown>;
  }
  const fresh: Record<string, unknown> = {};
  config[key] = fresh;
  return fresh;
}

// ─── Render ───────────────────────────────────────────────────────────────────

/**
 * Render a contributed settings section into a settings-modal content container.
 *
 * @param {HTMLElement} container
 * @param {SettingsContribution} contribution
 * @param {ContributedSectionOptions} [opts]
 */
export function renderContributedSection(
  container: HTMLElement,
  contribution: SettingsContribution,
  opts: ContributedSectionOptions = {},
) {
  const rerender = () => renderContributedSection(container, contribution, opts);
  const title = contribution.title ?? contribution.key;
  const layout = contribution.settings.layout ?? "form";

  const body =
    layout === "map"
      ? renderMapLayout(contribution, opts, rerender)
      : renderFormLayout(contribution, opts, rerender);

  const selected = layout === "map" ? (selectedEntries.get(contribution.key) ?? null) : null;
  const actions = opts.actions
    ? opts.actions({ rerender, sectionKey: contribution.key, selected })
    : nothing;

  const tpl = html`
    <div class="settings-section contributed-section">
      <h3 class="settings-section-title">${title}</h3>
      ${actions}${body}
    </div>
  `;

  litRender(tpl, container);
}

/** Layout "form" — one schema form over the whole section value. */
function renderFormLayout(
  contribution: SettingsContribution,
  opts: ContributedSectionOptions,
  rerender: () => void,
): TemplateResult {
  const value = sectionValue(contribution.key) ?? {};
  const ui = contribution.settings.entry?.ui;
  const base = `/${contribution.key}`;

  return html`
    <div class="settings-form-panel">
      ${renderForm(contribution.entrySchema, value, {
        context: buildContext(contribution.key, opts, null),
        errors: diagnostics.get(base) ?? {},
        onChange: (patch) => {
          const target = sectionValue(contribution.key);
          if (!target) {
            return;
          }
          applyPatch(target, patch);
          rerender();
          void saveProjectConfig(base, rerender);
        },
        rerender,
        ...(ui !== undefined && { ui }),
      })}
    </div>
  `;
}

/** Layout "map" — master-detail: entry key list left, entry form right. */
function renderMapLayout(
  contribution: SettingsContribution,
  opts: ContributedSectionOptions,
  rerender: () => void,
): TemplateResult {
  const { key: sectionKey } = contribution;
  const entries = sectionValue(sectionKey) ?? {};
  const entryKeys = Object.keys(entries);
  const selected = selectedEntries.get(sectionKey) ?? null;
  const ui = contribution.settings.entry?.ui;

  const handleCreate = () => {
    const slug = slugify(newEntryNames.get(sectionKey) ?? "");
    const target = sectionValue(sectionKey);
    if (!slug || !target || target[slug]) {
      return;
    }
    target[slug] = instantiateNewEntry(contribution.settings.entry?.newEntry, slug);
    selectedEntries.set(sectionKey, slug);
    newEntryOpen.delete(sectionKey);
    newEntryNames.delete(sectionKey);
    rerender();
    void saveProjectConfig(`/${sectionKey}`, rerender);
  };

  const handleDelete = () => {
    const target = sectionValue(sectionKey);
    if (!selected || !target?.[selected]) {
      return;
    }
    delete target[selected];
    selectedEntries.set(sectionKey, null);
    rerender();
    void saveProjectConfig(`/${sectionKey}`, rerender);
  };

  const handleRename = (newName: string) => {
    const target = sectionValue(sectionKey);
    const slug = slugify(newName);
    if (!selected || !target || !slug || slug === selected || target[slug]) {
      return;
    }
    // Rebuild the map to preserve entry order under the new key
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(target)) {
      next[k === selected ? slug : k] = v;
      delete target[k];
    }
    Object.assign(target, next);
    selectedEntries.set(sectionKey, slug);
    rerender();
    void saveProjectConfig(`/${sectionKey}`, rerender);
  };

  // Left column — entry key list
  const listTpl = html`
    <div class="settings-list-panel">
      ${entryKeys.map(
        (name) => html`
          <sp-action-button
            size="s"
            data-jx-region=${`overlay.dialog:settings/entry:${name}`}
            ?selected=${selected === name}
            @click=${() => {
              selectedEntries.set(sectionKey, name);
              rerender();
            }}
          >
            ${name}
          </sp-action-button>
        `,
      )}
      ${
        newEntryOpen.has(sectionKey)
          ? html`
              <div class="settings-inline-form">
                <sp-textfield
                  size="s"
                  placeholder="entry-name"
                  .value=${newEntryNames.get(sectionKey) ?? ""}
                  @input=${(e: Event) => {
                    newEntryNames.set(sectionKey, (e.target as HTMLInputElement).value);
                  }}
                  @keydown=${(e: KeyboardEvent) => {
                    if (e.key === "Enter") {
                      handleCreate();
                    }
                    if (e.key === "Escape") {
                      newEntryOpen.delete(sectionKey);
                      rerender();
                    }
                  }}
                ></sp-textfield>
                <sp-action-button size="s" @click=${handleCreate}>Create</sp-action-button>
              </div>
            `
          : html`
              <sp-action-button
                size="s"
                quiet
                @click=${() => {
                  newEntryOpen.add(sectionKey);
                  rerender();
                }}
              >
                <sp-icon-add slot="icon"></sp-icon-add> New Entry
              </sp-action-button>
            `
      }
    </div>
  `;

  // Right column — entry form
  const selectedEntry = selected ? entries[selected] : undefined;
  const editorTpl: TemplateResult =
    selected && selectedEntry && typeof selectedEntry === "object"
      ? html`
          <div class="settings-editor-panel" data-jx-region="overlay.dialog:settings/editor">
            <div class="settings-editor-header">
              <sp-textfield
                size="s"
                quiet
                class="entry-name-input"
                value=${selected}
                @change=${(e: Event) => {
                  const target = e.target as HTMLInputElement;
                  handleRename(target.value.trim());
                  target.value = selectedEntries.get(sectionKey) ?? selected;
                }}
                @keydown=${(e: KeyboardEvent) => {
                  const target = e.target as HTMLInputElement;
                  if (e.key === "Enter") {
                    target.blur();
                  }
                  if (e.key === "Escape") {
                    target.value = selected;
                    target.blur();
                  }
                }}
              ></sp-textfield>
              <sp-action-button size="xs" quiet title="Delete entry" @click=${handleDelete}>
                <sp-icon-delete slot="icon"></sp-icon-delete>
              </sp-action-button>
            </div>
            ${renderForm(contribution.entrySchema, selectedEntry as Record<string, unknown>, {
              context: buildContext(sectionKey, opts, selected),
              errors: diagnostics.get(`/${sectionKey}/${selected}`) ?? {},
              onChange: (patch) => {
                applyPatch(selectedEntry as Record<string, unknown>, patch);
                rerender();
                void saveProjectConfig(`/${sectionKey}/${selected}`, rerender);
              },
              rerender,
              ...(ui !== undefined && { ui }),
            })}
          </div>
        `
      : html`<div class="settings-empty-state">Select or create an entry</div>`;

  return html` <div class="settings-two-col">${listTpl} ${editorTpl}</div> `;
}
