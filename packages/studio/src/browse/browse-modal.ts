/// <reference lib="dom" />
/**
 * Browse modal — fullscreen overlay for the project file browser (Manage view). Opens via toolbar
 * button; selecting a file closes the modal and opens it in the editor.
 */

import { html } from "lit-html";
import { ref } from "lit-html/directives/ref.js";
import { renderBrowse } from "./browse";
import { openFileInTab } from "../files/files";
import { openModal } from "../ui/layers";

let _handle: ReturnType<typeof openModal> | null = null;

export function openBrowseModal() {
  if (_handle) {
    return;
  }

  const tpl = html`
    <sp-underlay open @close=${closeBrowseModal}></sp-underlay>
    <div class="browse-modal">
      <div class="browse-modal-header">
        <h2 class="browse-modal-title">Manage Files</h2>
        <sp-action-button quiet size="s" @click=${closeBrowseModal} title="Close">
          <sp-icon-close slot="icon"></sp-icon-close>
        </sp-action-button>
      </div>
      <div
        class="browse-modal-content"
        ${ref((el) => {
          if (el) {
            requestAnimationFrame(() => {
              void renderBrowse(el as HTMLElement, {
                openFile: (path: string) => {
                  closeBrowseModal();
                  void openFileInTab(path);
                },
              });
            });
          }
        })}
      ></div>
    </div>
  `;

  _handle = openModal(tpl, { label: "Manage Files", onDismiss: closeBrowseModal });
}

export function closeBrowseModal() {
  if (!_handle) {
    return;
  }
  _handle.close();
  _handle = null;
}
