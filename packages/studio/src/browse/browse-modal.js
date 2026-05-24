/**
 * Browse modal — fullscreen overlay for the project file browser (Manage view). Opens via toolbar
 * button; selecting a file closes the modal and opens it in the editor.
 */

import { html } from "lit-html";
import { renderBrowse } from "./browse.js";
import { openFileInTab } from "../files/files.js";
import { openModal } from "../ui/layers.js";

/** @type {ReturnType<typeof openModal> | null} */
let _handle = null;

/** @type {((e: KeyboardEvent) => void) | null} */
let _escHandler = null;

export function openBrowseModal() {
  if (_handle) return;

  _escHandler = (/** @type {KeyboardEvent} */ e) => {
    if (e.key === "Escape") closeBrowseModal();
  };
  document.addEventListener("keydown", _escHandler, true);

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

  _handle = openModal(tpl);

  requestAnimationFrame(() => {
    const container = _handle?.host.querySelector(".browse-modal-content");
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

export function closeBrowseModal() {
  if (!_handle) return;
  if (_escHandler) {
    document.removeEventListener("keydown", _escHandler, true);
    _escHandler = null;
  }
  _handle.close();
  _handle = null;
}
