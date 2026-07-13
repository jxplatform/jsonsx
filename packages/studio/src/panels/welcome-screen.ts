/// <reference lib="dom" />
/**
 * Welcome screen — shown when no project is loaded and no document tabs are open. Mimics VS Code's
 * welcome tab with start actions and recent projects.
 */

import { html, render as litRender, nothing } from "lit-html";
import { getAccountStatus, needsAppInstall } from "../account-status";
import { platformSupportsAddRepo } from "../new-project/add-repo-modal";
import { getProjectList } from "../project-list";
import { clearRecentProjects, getRecentProjects, removeRecentProject } from "../recent-projects";
import { renderOnly } from "../store";
import { platformSupportsClone } from "./git-panel";

interface WelcomeCtx {
  openProject: () => void;
  openRecentProject: (root: string) => void;
  openNewProject: () => void;
  cloneRepository: () => void;
  addExistingRepo: () => void;
}

let _ctx: WelcomeCtx | null = null;

/** @param {WelcomeCtx} ctx */
export function initWelcome(ctx: WelcomeCtx) {
  _ctx = ctx;
}

/** @param {HTMLElement} host */
export function renderWelcome(host: HTMLElement) {
  const ctx = _ctx as WelcomeCtx;
  const recent = getRecentProjects();
  // Catalogue entries already in Recent stay in that section only.
  const catalogue = getProjectList().filter((p) => !recent.some((r) => r.root === p.root));
  const showClone = platformSupportsClone();
  const showAddRepo = platformSupportsAddRepo();

  litRender(
    html`
      <div class="welcome-screen">
        <div class="welcome-content">
          <h1 class="welcome-title">Jx Studio</h1>
          <p class="welcome-subtitle">Visual component builder</p>

          <div class="welcome-section">
            <h2 class="welcome-section-title">Start</h2>
            <button class="welcome-action" @click=${() => ctx.openNewProject()}>
              <svg
                class="welcome-action-icon"
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="currentColor"
              >
                <path
                  d="M9.5 1.1l3.4 3.5.1.4v2h-1V6H8.5L8 5.5V2H3.5l-.5.5v11l.5.5H6v1H3.5l-1.5-1.5v-11l1.5-1.5h5.7l.3.1zM9 2v3h2.9L9 2zm4 14h-1v-3H9v-1h3V9h1v3h3v1h-3v3z"
                />
              </svg>
              New Project...
            </button>
            <button class="welcome-action" @click=${() => ctx.openProject()}>
              <svg
                class="welcome-action-icon"
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="currentColor"
              >
                <path
                  d="M14.5 3H7.71l-.85-.85L6.51 2h-5l-.5.5v11l.5.5h13l.5-.5v-10L14.5 3zm-.51 8.49V13h-12V7h4.49l.35-.15.86-.86H14v5.5zM6.51 6l-.35.15-.86.86H2v-3h4.29l.85.85.36.15H14V6H6.51z"
                />
              </svg>
              Open Project...
            </button>
            ${showClone
              ? html`<button class="welcome-action" @click=${() => ctx.cloneRepository()}>
                  <svg
                    class="welcome-action-icon"
                    width="16"
                    height="16"
                    viewBox="0 0 16 16"
                    fill="currentColor"
                  >
                    <path
                      d="M4.7 12.3a4.2 4.2 0 0 1-1.2-1.7A4.4 4.4 0 0 1 3 8.9a4 4 0 0 1 .3-1.5 3.8 3.8 0 0 1 .8-1.3c.4-.4.8-.7 1.3-.9.5-.2 1-.4 1.6-.4V3l3.5 2.5L7 8V6.2c-.9.1-1.6.5-2.1 1.1a3 3 0 0 0-.8 2.1c0 .4.1.8.2 1.2.1.3.3.7.5 1l-.1.7zM11 6.9c.9-.1 1.6-.5 2.1-1.1a3 3 0 0 0 .8-2.1 3 3 0 0 0-.2-1.2 3.5 3.5 0 0 0-.5-1l.1-.7a4.2 4.2 0 0 1 1.2 1.7c.3.5.4 1.1.4 1.7a4 4 0 0 1-.3 1.5 3.8 3.8 0 0 1-.8 1.3c-.4.4-.8.7-1.3.9-.5.2-1 .4-1.6.4V11L7.5 8.5 11 6v.9z"
                    />
                  </svg>
                  Clone Git Repository...
                </button>`
              : nothing}
            ${showAddRepo
              ? html`<button class="welcome-action" @click=${() => ctx.addExistingRepo()}>
                  <svg
                    class="welcome-action-icon"
                    width="16"
                    height="16"
                    viewBox="0 0 16 16"
                    fill="currentColor"
                  >
                    <path
                      d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.5 2.5 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.25.25 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z"
                    />
                  </svg>
                  Add Existing Repository...
                </button>`
              : nothing}
          </div>

          ${needsAppInstall()
            ? html`
                <div class="welcome-section">
                  <h2 class="welcome-section-title">Repository access</h2>
                  <a
                    class="welcome-action"
                    href=${getAccountStatus()?.appInstallUrl ?? "#"}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <svg
                      class="welcome-action-icon"
                      width="16"
                      height="16"
                      viewBox="0 0 16 16"
                      fill="currentColor"
                    >
                      <path
                        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"
                      />
                    </svg>
                    Install the Jx Suite GitHub App
                  </a>
                  <p class="welcome-install-note">
                    Grants repository access so you can create and open projects — choose “All
                    repositories”.
                  </p>
                </div>
              `
            : nothing}
          ${catalogue.length > 0
            ? html`
                <div class="welcome-section">
                  <h2 class="welcome-section-title">Projects</h2>
                  ${catalogue.map(
                    (p) => html`
                      <div class="welcome-recent-row">
                        <button
                          class="welcome-recent welcome-catalogue"
                          @click=${() => ctx.openRecentProject(p.root)}
                          title=${p.root}
                        >
                          <span class="welcome-recent-name">${p.name}</span>
                          <span class="welcome-recent-path">
                            ${p.description ?? shortenPath(p.root)}
                          </span>
                        </button>
                      </div>
                    `,
                  )}
                </div>
              `
            : nothing}
          ${recent.length > 0
            ? html`
                <div class="welcome-section">
                  <div class="welcome-section-header">
                    <h2 class="welcome-section-title">Recent</h2>
                    <button
                      class="welcome-clear"
                      @click=${() => {
                        clearRecentProjects();
                        renderOnly("canvas");
                      }}
                    >
                      Clear
                    </button>
                  </div>
                  ${recent.map(
                    (p) => html`
                      <div class="welcome-recent-row">
                        <button
                          class="welcome-recent"
                          @click=${() => ctx.openRecentProject(p.root)}
                          title=${p.root}
                        >
                          <span class="welcome-recent-name">${p.name}</span>
                          <span class="welcome-recent-path">${shortenPath(p.root)}</span>
                        </button>
                        <button
                          class="welcome-recent-remove"
                          title="Remove from recent"
                          @click=${() => {
                            removeRecentProject(p.root);
                            renderOnly("canvas");
                          }}
                        >
                          ✕
                        </button>
                      </div>
                    `,
                  )}
                </div>
              `
            : nothing}
        </div>
      </div>
    `,
    host,
  );
}

/** @param {string} path */
function shortenPath(path: string) {
  if (path.startsWith("/home/")) {
    const parts = path.split("/");
    return `~/${parts.slice(3).join("/")}`;
  }
  return path;
}
