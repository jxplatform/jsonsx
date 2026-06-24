/// <reference lib="dom" />
/**
 * Welcome screen — shown when no project is loaded and no document tabs are open. Mimics VS Code's
 * welcome tab with start actions and recent projects.
 */

import { html, render as litRender, nothing } from "lit-html";
import { clearRecentProjects, getRecentProjects, removeRecentProject } from "../recent-projects";
import { renderOnly } from "../store";
import { platformSupportsClone } from "./git-panel";

interface WelcomeCtx {
  openProject: () => void;
  openRecentProject: (root: string) => void;
  openNewProject: () => void;
  cloneRepository: () => void;
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
  const showClone = platformSupportsClone();

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
          </div>

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
