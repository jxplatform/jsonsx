/**
 * Settings modal — site-wide project settings (CSS variables, definitions, content types, head,
 * general). Modeled after VS Code / Obsidian settings panels: left sidebar nav + right content
 * area.
 */

import { html } from "lit-html";
import { classMap } from "lit-html/directives/class-map.js";
import { ref } from "lit-html/directives/ref.js";
import { renderDefsEditor } from "./defs-editor.js";
import { renderContentTypesEditor } from "./content-types-editor.js";
import { renderCssVarsEditor } from "./css-vars-editor.js";
import { renderHeadEditor } from "./head-editor.js";
import { renderGeneralSettings } from "./general-settings.js";
import { openModal } from "../ui/layers.js";

/** @type {ReturnType<typeof openModal> | null} */
let _handle = null;

/** @type {string} */
let _activeSection = "general";

/** @type {HTMLElement | null} */
let _contentEl = null;

const sections = [
  { key: "general", label: "General", icon: "sp-icon-properties" },
  { key: "head", label: "Head", icon: "sp-icon-file-single-web-page" },
  { key: "cssVars", label: "CSS Variables", icon: "sp-icon-brush" },
  { key: "definitions", label: "Definitions", icon: "sp-icon-data" },
  { key: "contentTypes", label: "Content Types", icon: "sp-icon-view-grid" },
];

export function openSettingsModal() {
  if (_handle) return;
  _activeSection = "general";
  renderModal();
}

export function closeSettingsModal() {
  if (!_handle) return;
  _handle.close();
  _handle = null;
  _contentEl = null;
}

function renderModal() {
  const onNavClick = (/** @type {string} */ key) => {
    _activeSection = key;
    renderModal();
    renderActiveSection();
  };

  const tpl = html`
    <sp-underlay open @close=${closeSettingsModal}></sp-underlay>
    <div
      class="settings-modal"
      @keydown=${(/** @type {KeyboardEvent} */ e) => {
        if (e.key === "Escape") closeSettingsModal();
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
          ${sections.map(
            (s) => html`
              <button
                class=${classMap({ "settings-nav-item": true, active: _activeSection === s.key })}
                @click=${() => onNavClick(s.key)}
              >
                ${s.label}
              </button>
            `,
          )}
        </nav>
        <div
          class="settings-modal-content"
          ${ref((el) => {
            _contentEl = /** @type {HTMLElement | null} */ (el || null);
            if (_contentEl) requestAnimationFrame(() => renderActiveSection());
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
  if (!_handle || !_contentEl) return;

  switch (_activeSection) {
    case "general":
      renderGeneralSettings(_contentEl);
      break;
    case "head":
      renderHeadEditor(_contentEl);
      break;
    case "cssVars":
      renderCssVarsEditor(_contentEl);
      break;
    case "definitions":
      renderDefsEditor(_contentEl);
      break;
    case "contentTypes":
      renderContentTypesEditor(_contentEl);
      break;
  }
}
