/// <reference lib="dom" />
/**
 * Imports panel — context-aware import manager with cherry-pick component selection.
 *
 * When editing project.json: shows imported modules, Dependencies (add/remove packages), and
 * per-package component toggles for cherry-picking individual elements. When editing a
 * page/layout/component/content type: shows Component Imports ($ref picker) and per-package
 * component toggles.
 */

import { html, nothing } from "lit-html";
import { createRef, ref } from "lit-html/directives/ref.js";
import { componentRegistry } from "../files/components";
import {
  disableElement,
  enableElement,
  hasElement,
  removeElementRef,
  removePackageElements,
} from "../files/elements";
import { projectState } from "../store";
import { updateSiteConfig } from "../site-context";
import { getPlatform } from "../platform";
import { showConfirmDialog } from "../ui/layers";
import { renderEmptyState } from "./empty-state";
import { registerPanel } from "./panel-registry";
import { activeTab } from "../workspace/workspace";
import { transact } from "../tabs/transact";

import type { ComponentEntry } from "../files/components";
import type { ElementsEntry } from "../files/elements";
import type { JxElement, JxMutableNode } from "@jxsuite/schema/types";

/** The add-an-import draft fields — uncontrolled, held rather than re-found. See head-panel.ts. */
const _addName = createRef<HTMLInputElement>();
const _addPath = createRef<HTMLInputElement>();

interface ImportsContext {
  renderLeftPanel: () => void;
  documentPath: string | null;
  documentElements: ElementsEntry[];
  applyMutation: (fn: (doc: JxMutableNode) => void) => void;
}

/* `ElementsEntry` is `files/elements.ts`'s now — the module that decides what belongs in the
   array owns the type of its members. Re-exported so importers of this panel keep resolving. */
export type { ElementsEntry } from "../files/elements";

/* `componentSpecifier` and `isComponentEnabled` are `files/elements.ts`'s `npmSpecifier` and
   `hasElement`. They lived here and answered only for the two checkboxes in this file; the picker
   below and the canvas drop each asked the question their own way and got different answers
   (plan §11.2). One rule, four call sites. */

/**
 * Group npm components by package name.
 *
 * @returns {Map<string, ComponentEntry[]>}
 */
function groupByPackage() {
  const groups = new Map<string, ComponentEntry[]>();
  for (const comp of componentRegistry) {
    if (comp.source !== "npm" || !comp.package || !comp.modulePath) {
      continue;
    }
    if (!groups.has(comp.package)) {
      groups.set(comp.package, []);
    }
    groups.get(comp.package)?.push(comp);
  }
  return groups;
}

/**
 * @param {ImportsContext} ctx
 * @returns {import("lit-html").TemplateResult}
 */
export function renderImportsTemplate({
  renderLeftPanel,
  documentPath,
  documentElements,
  applyMutation,
}: ImportsContext) {
  const isSiteLevel = documentPath?.endsWith("project.json");

  if (isSiteLevel) {
    return renderSiteLevelImports(renderLeftPanel);
  }

  return renderDocumentLevelImports({
    applyMutation,
    documentElements,
    documentPath,
    renderLeftPanel,
  });
}

// ─── Site-level: Imported Modules + Dependencies + Component Cherry-pick ──────

/** @param {() => void} renderLeftPanel */
function renderSiteLevelImports(renderLeftPanel: () => void) {
  const siteImports = projectState?.projectConfig?.imports || {};
  const entries = Object.entries(siteImports);
  const siteElements = (projectState?.projectConfig?.$elements || []) as ElementsEntry[];

  const packageGroups = groupByPackage();

  return html`
    <div class="imports-panel">
      <!-- Imported modules ($prototype sources) -->
      <div class="imports-section">
        <div class="imports-section-header">
          <span class="imports-section-title">Imported Modules</span>
          <span class="imports-count">${entries.length}</span>
        </div>
        ${
          entries.length > 0
            ? html`
                <div class="imports-list">
                  ${entries.map(
                    ([name, path]) => html`
                      <div class="import-row">
                        <span class="import-name" title=${path as string}>${name}</span>
                        <span class="import-path">${path}</span>
                        <sp-action-button
                          quiet
                          size="xs"
                          title="Remove"
                          @click=${async () => {
                            const updated = { ...siteImports };
                            delete updated[name];
                            await updateSiteConfig({ imports: updated });
                            renderLeftPanel();
                          }}
                        >
                          <sp-icon-close slot="icon" size="xs"></sp-icon-close>
                        </sp-action-button>
                      </div>
                    `,
                  )}
                </div>
              `
            : renderEmptyState({
                compact: true,
                message:
                  "Imported modules give this project extra kinds of data — " +
                  "a content collection, a CMS, an API client. Name one below.",
              })
        }
        <div class="import-add-form">
          <sp-textfield
            placeholder="Name"
            size="s"
            class="import-add-name"
            ${ref(_addName)}
          ></sp-textfield>
          <sp-textfield
            placeholder="Path"
            size="s"
            class="import-add-path"
            ${ref(_addPath)}
          ></sp-textfield>
          <sp-action-button
            quiet
            size="xs"
            title="Add import"
            @click=${async () => {
              /* Handles rather than a closest() walk back to a form drawn six lines above. The
                 fields are an uncontrolled draft, so a ref is what reading and clearing them
                 wants — and the panel is rebuilt on every repaint, so a node found once is gone. */
              const name = _addName.value?.value?.trim();
              const path = _addPath.value?.value?.trim();
              if (!name || !path) {
                return;
              }
              if (_addName.value) {
                _addName.value.value = "";
              }
              if (_addPath.value) {
                _addPath.value.value = "";
              }
              const updated = { ...siteImports, [name]: path };
              await updateSiteConfig({ imports: updated });
              renderLeftPanel();
            }}
          >
            <sp-icon-add slot="icon" size="xs"></sp-icon-add>
          </sp-action-button>
        </div>
      </div>

      <!-- npm Dependencies with per-component toggles -->
      ${[...packageGroups.entries()].map(
        ([pkg, comps]) => html`
          <div class="imports-section">
            <div class="imports-section-header">
              <span class="imports-section-title import-mono">${pkg}</span>
              <sp-action-button
                quiet
                size="xs"
                title="Remove package"
                @click=${async () => {
                  const confirmed = await showConfirmDialog("Remove Package", `Remove ${pkg}?`, {
                    confirmLabel: "Remove",
                    destructive: true,
                  });
                  if (!confirmed) {
                    return;
                  }
                  try {
                    const platform = getPlatform();
                    await platform.removePackage(pkg);
                    // Also remove all cherry-picked elements for this package
                    // …including the legacy whole-package entry. The hand-rolled filter kept it,
                    // So removing a package left `@acme/ui` importing a package that was gone.
                    const updatedElements = removePackageElements(siteElements, pkg);
                    const { loadComponentRegistry } = await import("../files/components.js");
                    await loadComponentRegistry();
                    await updateSiteConfig({
                      $elements: updatedElements as (string | JxElement)[],
                    });
                    renderLeftPanel();
                  } catch (error) {
                    console.error("Failed to remove package:", error);
                  }
                }}
              >
                <sp-icon-close slot="icon" size="xs"></sp-icon-close>
              </sp-action-button>
            </div>
            <div class="imports-list imports-component-list">
              ${comps.map((comp: ComponentEntry) => {
                const enabled = hasElement(siteElements, comp, null);
                return html`
                  <div class="import-row import-component-row">
                    <sp-checkbox
                      size="s"
                      .checked=${enabled}
                      @change=${async (e: Event) => {
                        // ONE service (`files/elements.ts`) — this checkbox, the picker below and
                        // The canvas drop each had their own idea of "already imported".
                        const updated = (e.target as HTMLInputElement).checked
                          ? enableElement(siteElements, comp, null)
                          : disableElement(siteElements, comp, null);
                        await updateSiteConfig({
                          $elements: updated as (string | JxElement)[],
                        });
                        renderLeftPanel();
                      }}
                    >
                      <span class="import-component-label">&lt;${comp.tagName}&gt;</span>
                    </sp-checkbox>
                  </div>
                `;
              })}
            </div>
          </div>
        `,
      )}

      <!-- Add package -->
      <div class="imports-section">
        <div class="imports-section-header">
          <span class="imports-section-title">Add Dependency</span>
        </div>
        <div class="import-add-form">
          <sp-textfield
            placeholder="Package name…"
            size="s"
            style="flex:1"
            @keydown=${async (e: KeyboardEvent) => {
              if (e.key !== "Enter") {
                return;
              }
              const name = (e.target as HTMLInputElement).value?.trim();
              if (!name) {
                return;
              }
              (e.target as HTMLInputElement).value = "";
              try {
                const platform = getPlatform();
                await platform.addPackage(name);
                const { loadComponentRegistry } = await import("../files/components.js");
                await loadComponentRegistry();
                renderLeftPanel();
              } catch (error) {
                console.error("Failed to add package:", error);
              }
            }}
          ></sp-textfield>
          <sp-action-button
            quiet
            size="xs"
            title="Add package"
            @click=${async (e: Event) => {
              const input = (e.target as HTMLElement)
                .closest(".import-add-form")
                ?.querySelector("sp-textfield");
              const name = (input as HTMLInputElement | null)?.value?.trim();
              if (!name) {
                return;
              }
              (input as HTMLInputElement).value = "";
              try {
                const platform = getPlatform();
                await platform.addPackage(name);
                const { loadComponentRegistry } = await import("../files/components.js");
                await loadComponentRegistry();
                renderLeftPanel();
              } catch (error) {
                console.error("Failed to add package:", error);
              }
            }}
          >
            <sp-icon-add slot="icon" size="xs"></sp-icon-add>
          </sp-action-button>
        </div>
      </div>
    </div>
  `;
}

// ─── Document-level: Component Imports + npm Component Cherry-pick ───────────

/** @param {ImportsContext} ctx */
function renderDocumentLevelImports({
  renderLeftPanel,
  documentPath,
  documentElements,
  applyMutation,
}: ImportsContext) {
  const refEntries = documentElements.filter(
    (e: ElementsEntry) => e && typeof e === "object" && e.$ref,
  );
  const npmEntries = documentElements.filter((e: ElementsEntry) => typeof e === "string");

  // Available JX components not yet imported
  const importedRefs = new Set(refEntries.map((e: ElementsEntry) => (e as { $ref: string }).$ref));
  const availableComponents = componentRegistry.filter(
    (c: ComponentEntry) =>
      c.source !== "npm" &&
      c.path != null &&
      !importedRefs.has(`./${c.path}`) &&
      !importedRefs.has(c.path),
  );

  const packageGroups = groupByPackage();

  /** @param {string} elementRef The element reference to drop. Not `ref` — that is lit's directive. */
  const removeRef = (elementRef: string) => {
    applyMutation((doc: JxMutableNode) => {
      doc.$elements = removeElementRef((doc.$elements ?? []) as ElementsEntry[], elementRef) as (
        | string
        | JxElement
      )[];
    });
    renderLeftPanel();
  };

  return html`
    <div class="imports-panel">
      <!-- Component Imports ($ref) -->
      <div class="imports-section">
        <div class="imports-section-header">
          <span class="imports-section-title">Components</span>
          <span class="imports-count">${refEntries.length}</span>
        </div>
        ${
          refEntries.length > 0
            ? html`
                <div class="imports-list">
                  ${refEntries.map(
                    (entry: ElementsEntry) => html`
                      <div class="import-row">
                        <span class="import-path" title=${(entry as { $ref: string }).$ref}
                          >${(entry as { $ref: string }).$ref}</span
                        >
                        <sp-action-button
                          quiet
                          size="xs"
                          title="Remove"
                          @click=${() => removeRef((entry as { $ref: string }).$ref)}
                        >
                          <sp-icon-close slot="icon" size="xs"></sp-icon-close>
                        </sp-action-button>
                      </div>
                    `,
                  )}
                </div>
              `
            : renderEmptyState({
                compact: true,
                message:
                  availableComponents.length > 0
                    ? "Components you add here can be dropped onto this page. Pick one below."
                    : "Components you add here can be dropped onto this page. " +
                      "This project has none yet — create one from any selection on the canvas.",
              })
        }
        ${
          availableComponents.length > 0
            ? html`
                <div class="import-add-form">
                  <sp-picker
                    size="s"
                    label="Add component…"
                    class="import-picker"
                    @change=${(e: Event) => {
                      const tag = (e.target as HTMLInputElement).value;
                      if (!tag) {
                        return;
                      }
                      (e.target as HTMLInputElement).value = "";
                      const comp = componentRegistry.find((c: ComponentEntry) => c.tagName === tag);
                      if (!comp?.path) {
                        return;
                      }
                      // Through the service, which is also what makes this idempotent: it checked
                      // Nothing and pushed a second `$ref` every time you chose the same component.
                      applyMutation((doc: JxMutableNode) => {
                        doc.$elements = enableElement(
                          (doc.$elements ?? []) as ElementsEntry[],
                          comp,
                          documentPath,
                        ) as (string | JxElement)[];
                      });
                      renderLeftPanel();
                    }}
                  >
                    ${availableComponents.map(
                      (c: ComponentEntry) =>
                        html`<sp-menu-item value=${c.tagName}>&lt;${c.tagName}&gt;</sp-menu-item>`,
                    )}
                  </sp-picker>
                </div>
              `
            : nothing
        }
      </div>

      <!-- npm Package Components (cherry-pick toggles) -->
      ${[...packageGroups.entries()].map(
        ([pkg, comps]) => html`
          <div class="imports-section">
            <div class="imports-section-header">
              <span class="imports-section-title import-mono">${pkg}</span>
            </div>
            <div class="imports-list imports-component-list">
              ${comps.map((comp: ComponentEntry) => {
                const enabled = hasElement(npmEntries, comp, documentPath);
                return html`
                  <div class="import-row import-component-row">
                    <sp-checkbox
                      size="s"
                      .checked=${enabled}
                      @change=${(e: Event) => {
                        // The FOURTH writer of this array, and the same service as the other three.
                        const { checked } = e.target as HTMLInputElement;
                        applyMutation((doc: JxMutableNode) => {
                          const before = (doc.$elements ?? []) as ElementsEntry[];
                          doc.$elements = (
                            checked
                              ? enableElement(before, comp, documentPath)
                              : disableElement(before, comp, documentPath)
                          ) as (string | JxElement)[];
                        });
                        renderLeftPanel();
                      }}
                    >
                      <span class="import-component-label">&lt;${comp.tagName}&gt;</span>
                    </sp-checkbox>
                  </div>
                `;
              })}
            </div>
          </div>
        `,
      )}
    </div>
  `;
}

/**
 * Contribute the Packages panel.
 *
 * `level: "document"` — it writes the open document's `$elements`. The id and the title are both
 * `packages` now: "Imports" named the mechanism, and the panel silently changed meaning on
 * `documentPath?.endsWith("project.json")` with nothing on screen saying so. The header the
 * Navigator draws from this record ("PACKAGES · document") is where that stops.
 */
export function registerPackagesPanel(): void {
  registerPanel({
    id: "packages",
    title: "Packages",
    level: "document",
    dock: "navigator",
    icon: "sp-icon-box",
    requiresDocument: "Open a page to choose which components it can use.",
    render: (ctx) =>
      ctx.deps.renderImportsTemplate({
        applyMutation: (fn: (doc: JxMutableNode) => void) => {
          transact(activeTab.value, fn);
        },
        documentElements: ctx.doc?.document.$elements ?? [],
        documentPath: ctx.doc?.documentPath ?? null,
        renderLeftPanel: ctx.rerender,
      }),
  });
}
