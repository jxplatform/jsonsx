/// <reference lib="dom" />
/**
 * Settings modal — site-wide project settings (CSS variables, definitions, content types, head,
 * general). Modeled after VS Code / Obsidian settings panels: left sidebar nav + right content
 * area.
 */

import { html } from "lit-html";
import { classMap } from "lit-html/directives/class-map.js";
import { ref } from "lit-html/directives/ref.js";
import { renderDefsEditor } from "./defs-editor";
import { renderContentTypesEditor } from "./content-types-editor";
import { renderCssVarsEditor } from "./css-vars-editor";
import { renderHeadEditor } from "./head-editor";
import { renderGeneralSettings } from "./general-settings";
import { openModal } from "../ui/layers";

let _handle: ReturnType<typeof openModal> | null = null;

let _activeSection: string = "general";

let _contentEl: HTMLElement | null = null;

const sections = [
  { icon: "sp-icon-properties", key: "general", label: "General" },
  { icon: "sp-icon-file-single-web-page", key: "head", label: "Head" },
  { icon: "sp-icon-brush", key: "cssVars", label: "CSS Variables" },
  { icon: "sp-icon-data", key: "definitions", label: "Definitions" },
  { icon: "sp-icon-view-grid", key: "contentTypes", label: "Content Types" },
];

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
          ${sections.map(
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

  switch (_activeSection) {
    case "general": {
      renderGeneralSettings(_contentEl);
      break;
    }
    case "head": {
      renderHeadEditor(_contentEl);
      break;
    }
    case "cssVars": {
      renderCssVarsEditor(_contentEl);
      break;
    }
    case "definitions": {
      renderDefsEditor(_contentEl);
      break;
    }
    case "contentTypes": {
      renderContentTypesEditor(_contentEl);
      break;
    }
  }
}
