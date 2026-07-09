/// <reference lib="dom" />
/**
 * Settings modal — site-wide project settings (CSS variables, definitions, content types, head,
 * general). Modeled after VS Code / Obsidian settings panels: left sidebar nav + right content
 * area. Sections come from a registry: built-ins register at module init, and extensions add
 * descriptor-contributed sections through `registerSettingsSection`.
 */

import { html } from "lit-html";
import { classMap } from "lit-html/directives/class-map.js";
import { ref } from "lit-html/directives/ref.js";
import { renderDefsEditor } from "./defs-editor";
import { renderContentTypesEditor } from "./content-types-editor";
import { renderCssVarsEditor } from "./css-vars-editor";
import { renderHeadEditor } from "./head-editor";
import { renderGeneralSettings } from "./general-settings";
import { renderDependenciesEditor } from "./dependencies-editor";
import { openModal } from "../ui/layers";

// ─── Section registry ─────────────────────────────────────────────────────────

/** A settings-modal section: nav entry plus a renderer for the content area. */
export interface SettingsSection {
  key: string;
  label: string;
  /** Nav icon name (reserved for future nav treatments). */
  icon?: string | undefined;
  /** Sort position — lower orders render higher in the nav. */
  order: number;
  render: (container: HTMLElement) => void;
}

const sectionRegistry = new Map<string, SettingsSection>();

/**
 * Register (or replace) a settings section. Extensions use this hook to contribute
 * descriptor-driven sections; built-ins register below at module init.
 *
 * @param {SettingsSection} section
 */
export function registerSettingsSection(section: SettingsSection): void {
  sectionRegistry.set(section.key, section);
}

/** Registered sections sorted by order (registration order breaks ties). */
function sortedSections(): SettingsSection[] {
  return [...sectionRegistry.values()].toSorted((a, b) => a.order - b.order);
}

// Built-in sections — orders preserve the historical display order
registerSettingsSection({
  icon: "sp-icon-properties",
  key: "general",
  label: "General",
  order: 10,
  render: renderGeneralSettings,
});
registerSettingsSection({
  icon: "sp-icon-file-single-web-page",
  key: "head",
  label: "Head",
  order: 20,
  render: renderHeadEditor,
});
registerSettingsSection({
  icon: "sp-icon-brush",
  key: "cssVars",
  label: "CSS Variables",
  order: 30,
  render: renderCssVarsEditor,
});
registerSettingsSection({
  icon: "sp-icon-data",
  key: "definitions",
  label: "Definitions",
  order: 40,
  render: renderDefsEditor,
});
registerSettingsSection({
  icon: "sp-icon-view-grid",
  key: "contentTypes",
  label: "Content Types",
  order: 50,
  render: renderContentTypesEditor,
});
registerSettingsSection({
  icon: "sp-icon-box",
  key: "dependencies",
  label: "Dependencies",
  order: 60,
  render: renderDependenciesEditor,
});

// ─── Modal state ──────────────────────────────────────────────────────────────

let _handle: ReturnType<typeof openModal> | null = null;

let _activeSection = "general";

let _contentEl: HTMLElement | null = null;

export function openSettingsModal() {
  if (_handle) {
    return;
  }
  _activeSection = "general";
  renderModal();
}

export function closeSettingsModal() {
  if (!_handle) {
    return;
  }
  _handle.close();
  _handle = null;
  _contentEl = null;
}

function renderModal() {
  const onNavClick = (key: string) => {
    _activeSection = key;
    renderModal();
    renderActiveSection();
  };

  const tpl = html`
    <sp-underlay open @close=${closeSettingsModal}></sp-underlay>
    <div
      class="settings-modal"
      @keydown=${(e: KeyboardEvent) => {
        if (e.key === "Escape") {
          closeSettingsModal();
        }
      }}
    >
      <div class="settings-modal-header">
        <h2 class="settings-modal-title">Settings</h2>
        <sp-action-button quiet size="s" @click=${closeSettingsModal} title="Close">
          <sp-icon-close slot="icon"></sp-icon-close>
        </sp-action-button>
      </div>
      <div class="settings-modal-body">
        <nav class="settings-modal-nav">
          ${sortedSections().map(
            (s) => html`
              <button
                class=${classMap({
                  active: _activeSection === s.key,
                  "settings-nav-item": true,
                })}
                @click=${() => onNavClick(s.key)}
              >
                ${s.label}
              </button>
            `,
          )}
        </nav>
        <div
          class="settings-modal-content"
          ${ref((el: Element | undefined) => {
            _contentEl = (el as HTMLElement) || null;
            if (_contentEl) {
              requestAnimationFrame(() => renderActiveSection());
            }
          })}
        ></div>
      </div>
    </div>
  `;

  if (!_handle) {
    _handle = openModal(tpl);
  } else {
    _handle.update(tpl);
  }
}

function renderActiveSection() {
  if (!_handle || !_contentEl) {
    return;
  }
  sectionRegistry.get(_activeSection)?.render(_contentEl);
}
