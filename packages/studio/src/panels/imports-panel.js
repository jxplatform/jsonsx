/**
 * Imports panel — context-aware import manager with cherry-pick component selection.
 *
 * When editing project.json: shows Class Imports, Dependencies (add/remove packages), and
 * per-package component toggles for cherry-picking individual elements. When editing a
 * page/layout/component/content type: shows Component Imports ($ref picker) and per-package
 * component toggles.
 */

import { html, nothing } from "lit-html";
import { componentRegistry, computeRelativePath } from "../files/components.js";
import { projectState } from "../store.js";
import { updateSiteConfig } from "../site-context.js";
import { getPlatform } from "../platform.js";

/** @typedef {import("../files/components.js").ComponentEntry} ComponentEntry */

/** @typedef {string | JxMutableNode | { $ref: string }} ElementsEntry */

/**
 * @typedef {{
 *   renderLeftPanel: () => void;
 *   documentPath: string | null;
 *   documentElements: ElementsEntry[];
 *   applyMutation: (fn: (doc: JxMutableNode) => void) => void;
 * }} ImportsContext
 */

/**
 * Build the subpath specifier for a component: `<package>/<modulePath>`
 *
 * @param {ComponentEntry} comp
 * @returns {string}
 */
function componentSpecifier(comp) {
  return `${comp.package}/${comp.modulePath}`;
}

/**
 * Check if a component is enabled (present in $elements array). Supports both cherry-picked subpath
 * specifiers and legacy full-package imports.
 *
 * @param {ComponentEntry} comp
 * @param {ElementsEntry[]} elements
 * @returns {boolean}
 */
function isComponentEnabled(comp, elements) {
  if (!elements?.length) return false;
  const specifier = componentSpecifier(comp);
  for (const entry of elements) {
    if (typeof entry !== "string") continue;
    // Cherry-picked subpath match
    if (entry === specifier) return true;
    // Legacy full-package match
    if (entry === comp.package) return true;
  }
  return false;
}

/**
 * Group npm components by package name.
 *
 * @returns {Map<string, ComponentEntry[]>}
 */
function groupByPackage() {
  /** @type {Map<string, ComponentEntry[]>} */
  const groups = new Map();
  for (const comp of componentRegistry) {
    if (comp.source !== "npm" || !comp.package || !comp.modulePath) continue;
    if (!groups.has(comp.package)) groups.set(comp.package, []);
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
}) {
  const isSiteLevel = documentPath?.endsWith("project.json");

  if (isSiteLevel) {
    return renderSiteLevelImports(renderLeftPanel);
  }

  return renderDocumentLevelImports({
    renderLeftPanel,
    documentPath,
    documentElements,
    applyMutation,
  });
}

// ─── Site-level: Class Imports + Dependencies + Component Cherry-pick ─────────

/** @param {() => void} renderLeftPanel */
function renderSiteLevelImports(renderLeftPanel) {
  const siteImports = projectState?.projectConfig?.imports || {};
  const entries = Object.entries(siteImports);
  const siteElements = /** @type {ElementsEntry[]} */ (
    projectState?.projectConfig?.$elements || []
  );

  const packageGroups = groupByPackage();

  return html`
    <div class="imports-panel">
      <!-- Class Imports -->
      <div class="imports-section">
        <div class="imports-section-header">
          <span class="imports-section-title">Class Imports</span>
          <span class="imports-count">${entries.length}</span>
        </div>
        ${entries.length > 0
          ? html`
              <div class="imports-list">
                ${entries.map(
                  ([name, path]) => html`
                    <div class="import-row">
                      <span class="import-name" title=${/** @type {string} */ (path)}>${name}</span>
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
          : html`<div class="imports-empty">No class imports</div>`}
        <div class="import-add-form">
          <sp-textfield placeholder="Name" size="s" class="import-add-name"></sp-textfield>
          <sp-textfield placeholder="Path" size="s" class="import-add-path"></sp-textfield>
          <sp-action-button
            quiet
            size="xs"
            title="Add import"
            @click=${async (/** @type {Event} */ e) => {
              const form = /** @type {HTMLElement} */ (e.target).closest(".import-add-form");
              const nameField = /** @type {HTMLInputElement} */ (
                form?.querySelector(".import-add-name")
              );
              const pathField = /** @type {HTMLInputElement} */ (
                form?.querySelector(".import-add-path")
              );
              const name = nameField?.value?.trim();
              const path = pathField?.value?.trim();
              if (!name || !path) return;
              nameField.value = "";
              pathField.value = "";
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
                  if (!confirm("Remove " + pkg + "?")) return;
                  try {
                    const platform = getPlatform();
                    await platform.removePackage(pkg);
                    // Also remove all cherry-picked elements for this package
                    const updatedElements = siteElements.filter(
                      (/** @type {ElementsEntry} */ e) =>
                        typeof e !== "string" || !e.startsWith(pkg + "/"),
                    );
                    const { loadComponentRegistry } = await import("../files/components.js");
                    await loadComponentRegistry();
                    await updateSiteConfig({
                      $elements: /** @type {(string | JxElement)[]} */ (updatedElements),
                    });
                    renderLeftPanel();
                  } catch (/** @type {unknown} */ e) {
                    console.error("Failed to remove package:", e);
                  }
                }}
              >
                <sp-icon-close slot="icon" size="xs"></sp-icon-close>
              </sp-action-button>
            </div>
            <div class="imports-list imports-component-list">
              ${comps.map((/** @type {ComponentEntry} */ comp) => {
                const enabled = isComponentEnabled(comp, siteElements);
                const specifier = componentSpecifier(comp);
                return html`
                  <div class="import-row import-component-row">
                    <sp-checkbox
                      size="s"
                      .checked=${enabled}
                      @change=${async (/** @type {Event} */ e) => {
                        let updated = [...siteElements];
                        // Remove legacy full-package import if present
                        updated = updated.filter((/** @type {ElementsEntry} */ el) => el !== pkg);
                        if (/** @type {HTMLInputElement} */ (e.target).checked) {
                          if (!updated.includes(specifier)) updated.push(specifier);
                        } else {
                          updated = updated.filter(
                            (/** @type {ElementsEntry} */ el) => el !== specifier,
                          );
                        }
                        await updateSiteConfig({
                          $elements: /** @type {(string | JxElement)[]} */ (updated),
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
            @keydown=${async (/** @type {KeyboardEvent} */ e) => {
              if (e.key !== "Enter") return;
              const name = /** @type {HTMLInputElement} */ (e.target).value?.trim();
              if (!name) return;
              /** @type {HTMLInputElement} */ (e.target).value = "";
              try {
                const platform = getPlatform();
                await platform.addPackage(name);
                const { loadComponentRegistry } = await import("../files/components.js");
                await loadComponentRegistry();
                renderLeftPanel();
              } catch (/** @type {unknown} */ err) {
                console.error("Failed to add package:", err);
              }
            }}
          ></sp-textfield>
          <sp-action-button
            quiet
            size="xs"
            title="Add package"
            @click=${async (/** @type {Event} */ e) => {
              const input = /** @type {HTMLElement} */ (e.target)
                .closest(".import-add-form")
                ?.querySelector("sp-textfield");
              const name = /** @type {HTMLInputElement | null} */ (input)?.value?.trim();
              if (!name) return;
              /** @type {HTMLInputElement} */ (input).value = "";
              try {
                const platform = getPlatform();
                await platform.addPackage(name);
                const { loadComponentRegistry } = await import("../files/components.js");
                await loadComponentRegistry();
                renderLeftPanel();
              } catch (/** @type {unknown} */ err) {
                console.error("Failed to add package:", err);
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
}) {
  const refEntries = documentElements.filter(
    (/** @type {ElementsEntry} */ e) => e && typeof e === "object" && e.$ref,
  );
  const npmEntries = documentElements.filter(
    (/** @type {ElementsEntry} */ e) => typeof e === "string",
  );

  // Available JX components not yet imported
  const importedRefs = new Set(
    refEntries.map((/** @type {ElementsEntry} */ e) => /** @type {{ $ref: string }} */ (e).$ref),
  );
  const availableComponents = componentRegistry.filter(
    (/** @type {ComponentEntry} */ c) =>
      c.source !== "npm" && !importedRefs.has(`./${c.path}`) && !importedRefs.has(c.path),
  );

  const packageGroups = groupByPackage();

  /** @param {string} ref */
  const removeRef = (ref) => {
    applyMutation((/** @type {JxMutableNode} */ doc) => {
      doc.$elements = (doc.$elements || []).filter(
        (/** @type {ElementsEntry} */ e) => !(e && typeof e === "object" && e.$ref === ref),
      );
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
        ${refEntries.length > 0
          ? html`
              <div class="imports-list">
                ${refEntries.map(
                  (/** @type {ElementsEntry} */ entry) => html`
                    <div class="import-row">
                      <span
                        class="import-path"
                        title=${/** @type {{ $ref: string }} */ (entry).$ref}
                        >${/** @type {{ $ref: string }} */ (entry).$ref}</span
                      >
                      <sp-action-button
                        quiet
                        size="xs"
                        title="Remove"
                        @click=${() => removeRef(/** @type {{ $ref: string }} */ (entry).$ref)}
                      >
                        <sp-icon-close slot="icon" size="xs"></sp-icon-close>
                      </sp-action-button>
                    </div>
                  `,
                )}
              </div>
            `
          : nothing}
        ${availableComponents.length > 0
          ? html`
              <div class="import-add-form">
                <sp-picker
                  size="s"
                  label="Add component…"
                  class="import-picker"
                  @change=${(/** @type {Event} */ e) => {
                    const tag = /** @type {HTMLInputElement} */ (e.target).value;
                    if (!tag) return;
                    /** @type {HTMLInputElement} */ (e.target).value = "";
                    const comp = componentRegistry.find(
                      (/** @type {ComponentEntry} */ c) => c.tagName === tag,
                    );
                    if (!comp) return;
                    const relPath = computeRelativePath(documentPath, comp.path);
                    applyMutation((/** @type {JxMutableNode} */ doc) => {
                      if (!doc.$elements) doc.$elements = [];
                      doc.$elements.push({ $ref: relPath });
                    });
                    renderLeftPanel();
                  }}
                >
                  ${availableComponents.map(
                    (/** @type {ComponentEntry} */ c) =>
                      html`<sp-menu-item value=${c.tagName}>&lt;${c.tagName}&gt;</sp-menu-item>`,
                  )}
                </sp-picker>
              </div>
            `
          : nothing}
      </div>

      <!-- npm Package Components (cherry-pick toggles) -->
      ${[...packageGroups.entries()].map(
        ([pkg, comps]) => html`
          <div class="imports-section">
            <div class="imports-section-header">
              <span class="imports-section-title import-mono">${pkg}</span>
            </div>
            <div class="imports-list imports-component-list">
              ${comps.map((/** @type {ComponentEntry} */ comp) => {
                const enabled = isComponentEnabled(comp, npmEntries);
                const specifier = componentSpecifier(comp);
                return html`
                  <div class="import-row import-component-row">
                    <sp-checkbox
                      size="s"
                      .checked=${enabled}
                      @change=${(/** @type {Event} */ e) => {
                        applyMutation((/** @type {JxMutableNode} */ doc) => {
                          if (!doc.$elements) doc.$elements = [];
                          // Remove legacy full-package import if present
                          doc.$elements = doc.$elements.filter(
                            (/** @type {ElementsEntry} */ el) => el !== pkg,
                          );
                          if (/** @type {HTMLInputElement} */ (e.target).checked) {
                            if (!doc.$elements.includes(specifier)) doc.$elements.push(specifier);
                          } else {
                            doc.$elements = doc.$elements.filter(
                              (/** @type {ElementsEntry} */ el) => el !== specifier,
                            );
                          }
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
