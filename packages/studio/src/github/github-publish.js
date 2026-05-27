/** Publish a local project to GitHub — creates a new repo and pushes. */

import { html } from "lit-html";
import { showDialog } from "../ui/layers.js";
import { authenticateGithub } from "./github-auth.js";
import { getPlatform } from "../platform.js";
import { refreshGitStatus } from "../panels/git-panel.js";
import { statusMessage } from "../panels/statusbar.js";

/**
 * Full "Publish to GitHub" flow: 1. Authenticate (or reuse stored token) 2. Prompt for repo name /
 * visibility 3. Create the repo via GitHub API 4. Add remote + push
 *
 * @param {{ projectName: string }} opts
 * @returns {Promise<boolean>} True if published successfully
 */
export async function publishToGithub({ projectName }) {
  const token = await authenticateGithub();
  if (!token) return false;

  const repoOpts = await showDialog((done) => {
    return html`
      <sp-dialog-wrapper
        open
        headline="Publish to GitHub"
        confirm-label="Create Repository"
        cancel-label="Cancel"
        @confirm=${(/** @type {Event} */ e) => {
          const dialog = /** @type {HTMLElement} */ (e.target);
          const nameInput = /** @type {HTMLInputElement | null} */ (
            dialog.querySelector('[name="repo-name"]')
          );
          const descInput = /** @type {HTMLInputElement | null} */ (
            dialog.querySelector('[name="repo-desc"]')
          );
          const privateToggle = /** @type {HTMLInputElement | null} */ (
            dialog.querySelector('[name="repo-private"]')
          );
          done({
            name: nameInput?.value || projectName,
            description: descInput?.value || "",
            isPrivate: privateToggle?.checked ?? true,
          });
        }}
        @cancel=${() => done(null)}
        @close=${() => done(null)}
      >
        <div class="github-publish-dialog">
          <sp-field-label for="repo-name">Repository name</sp-field-label>
          <sp-textfield
            id="repo-name"
            name="repo-name"
            value="${projectName}"
            placeholder="my-project"
          ></sp-textfield>

          <sp-field-label for="repo-desc">Description (optional)</sp-field-label>
          <sp-textfield
            id="repo-desc"
            name="repo-desc"
            placeholder="A brief description"
          ></sp-textfield>

          <sp-field-label>Visibility</sp-field-label>
          <sp-switch name="repo-private" checked>Private repository</sp-switch>
        </div>
      </sp-dialog-wrapper>
    `;
  });

  if (!repoOpts) return false;

  statusMessage("Creating GitHub repository…");

  const createRes = await fetch("https://api.github.com/user/repos", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: repoOpts.name,
      description: repoOpts.description,
      private: repoOpts.isPrivate,
      auto_init: false,
    }),
  });

  if (!createRes.ok) {
    const err = await createRes.json();
    const msg = err.errors?.[0]?.message || err.message || "Failed to create repository";
    statusMessage(`Error: ${msg}`);
    return false;
  }

  const repo = await createRes.json();
  const platform = getPlatform();

  statusMessage("Setting remote and pushing…");

  await platform.gitAddRemote("origin", repo.clone_url);

  statusMessage("Pushing to GitHub…");
  try {
    await platform.gitPush({ setUpstream: true });
  } catch (/** @type {unknown} */ e) {
    statusMessage(`Push failed: ${/** @type {Error} */ (e).message}`);
    return false;
  }

  await refreshGitStatus();
  statusMessage(`Published to GitHub: ${repo.html_url}`);
  return true;
}
