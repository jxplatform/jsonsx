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
import type { AnyCommand, CommandRegistry } from "../commands/registry";

let _handle: ReturnType<typeof openModal> | null = null;

export function openBrowseModal() {
  if (_handle) {
    return;
  }

  const tpl = html`
    <sp-underlay open @close=${closeBrowseModal}></sp-underlay>
    <div class="browse-modal" data-jx-region="overlay.dialog:library">
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

// ─── Commands ─────────────────────────────────────────────────────────────────

/**
 * Open the file browser.
 *
 * Idempotent by construction — {@link openBrowseModal} returns early when the overlay is already up,
 * so a shot that says "the browser is open" gets that whether or not a previous step opened it.
 *
 * @returns {AnyCommand[]}
 */
export function browseCommands(): AnyCommand[] {
  return [
    {
      category: "Project",
      id: "project.browse",
      level: "project",
      menus: ["commandbar/overflow", "palette"],
      group: "1_file",
      requires: "an open project",
      when: (ctx) => ctx.project.open,
      aiTool: {
        description: "Open the project's file browser (Manage Files).",
        name: "open_file_browser",
      },
      run: () => {
        openBrowseModal();
      },
      title: "Manage Files",
    },
  ];
}

/**
 * Register the file-browser verb.
 *
 * @param {CommandRegistry} registry
 */
export function registerBrowseCommands(registry: CommandRegistry): void {
  registry.registerAll(browseCommands());
}
