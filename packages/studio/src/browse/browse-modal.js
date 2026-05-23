/**
 * Browse modal — fullscreen overlay for the project file browser (Manage view). Opens via toolbar
 * button; selecting a file closes the modal and opens it in the editor.
 */

import { html, render as litRender } from "lit-html";
import { renderBrowse } from "./browse.js";
import { openFileInTab } from "../files/files.js";

/** @type {HTMLElement | null} */
let _host = null;

/** @type {((e: KeyboardEvent) => void) | null} */
let _escHandler = null;

export function openBrowseModal() {
  if (_host) return;

  _host = document.createElement("div");
  _host.style.display = "contents";
  const themeRoot = document.querySelector("sp-theme") || document.body;
  themeRoot.appendChild(_host);

  _escHandler = (/** @type {KeyboardEvent} */ e) => {
    if (e.key === "Escape") closeBrowseModal();
  };
  document.addEventListener("keydown", _escHandler, true);

  renderModal();
}

export function closeBrowseModal() {
  if (!_host) return;
  if (_escHandler) {
    document.removeEventListener("keydown", _escHandler, true);
    _escHandler = null;
  }
  _host.remove();
  _host = null;
}

function renderModal() {
  if (!_host) return;

  const tpl = html`
    <sp-underlay open @close=${closeBrowseModal}></sp-underlay>
    <div class="browse-modal">
      <div class="browse-modal-header">
        <h2 class="browse-modal-title">Manage Files</h2>
        <sp-action-button quiet size="s" @click=${closeBrowseModal} title="Close">
          <sp-icon-close slot="icon"></sp-icon-close>
        </sp-action-button>
      </div>
      <div class="browse-modal-content"></div>
    </div>
  `;

  litRender(tpl, _host);

  requestAnimationFrame(() => {
    const container = _host?.querySelector(".browse-modal-content");
    if (container) {
      renderBrowse(/** @type {HTMLElement} */ (container), {
        openFile: (/** @type {string} */ path) => {
          closeBrowseModal();
          openFileInTab(path);
        },
      });
    }
  });
}
