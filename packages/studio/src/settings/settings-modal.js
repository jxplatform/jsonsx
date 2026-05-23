/**
 * Settings modal — site-wide project settings (CSS variables, definitions, content types, head,
 * general). Modeled after VS Code / Obsidian settings panels: left sidebar nav + right content
 * area.
 */

import { html, render as litRender } from "lit-html";
import { ref } from "lit-html/directives/ref.js";
import { renderDefsEditor } from "./defs-editor.js";
import { renderContentTypesEditor } from "./content-types-editor.js";
import { renderCssVarsEditor } from "./css-vars-editor.js";
import { renderHeadEditor } from "./head-editor.js";
import { renderGeneralSettings } from "./general-settings.js";

/** @type {HTMLElement | null} */
let _host = null;

/** @type {string} */
let _activeSection = "general";

const sections = [
  { key: "general", label: "General", icon: "sp-icon-properties" },
  { key: "head", label: "Head", icon: "sp-icon-file-single-web-page" },
  { key: "cssVars", label: "CSS Variables", icon: "sp-icon-brush" },
  { key: "definitions", label: "Definitions", icon: "sp-icon-data" },
  { key: "contentTypes", label: "Content Types", icon: "sp-icon-view-grid" },
];

export function openSettingsModal() {
  if (_host) return;

  _host = document.createElement("div");
  _host.style.display = "contents";
  const themeRoot = document.querySelector("sp-theme") || document.body;
  themeRoot.appendChild(_host);
  _activeSection = "general";
  renderModal();
}

export function closeSettingsModal() {
  if (!_host) return;
  _host.remove();
  _host = null;
}

function renderModal() {
  if (!_host) return;

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
                class="settings-nav-item${_activeSection === s.key ? " active" : ""}"
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
            if (el) requestAnimationFrame(() => renderActiveSection());
          })}
        ></div>
      </div>
    </div>
  `;

  litRender(tpl, _host);
}

function renderActiveSection() {
  if (!_host) return;
  const container = _host.querySelector(".settings-modal-content");
  if (!container) return;

  switch (_activeSection) {
    case "general":
      renderGeneralSettings(/** @type {HTMLElement} */ (container));
      break;
    case "head":
      renderHeadEditor(/** @type {HTMLElement} */ (container));
      break;
    case "cssVars":
      renderCssVarsEditor(/** @type {HTMLElement} */ (container));
      break;
    case "definitions":
      renderDefsEditor(/** @type {HTMLElement} */ (container));
      break;
    case "contentTypes":
      renderContentTypesEditor(/** @type {HTMLElement} */ (container));
      break;
  }
}
