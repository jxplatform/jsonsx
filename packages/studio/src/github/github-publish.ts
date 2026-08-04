/// <reference lib="dom" />
/** Publish a local project to GitHub — creates a new repo and pushes. */

import { html } from "lit-html";
import { errorMessage } from "@jxsuite/schema/parse";
import { ref } from "lit-html/directives/ref.js";
import { showDialog } from "../ui/layers";
import { authenticateGithub } from "./github-auth";
import { getPlatform } from "../platform";
import { notify } from "../services/notify";

interface GithubErrorResponse {
  errors?: { message?: string }[];
  message?: string;
}

interface GithubRepoResponse {
  clone_url: string;
  html_url: string;
}

/**
 * Full "Publish to GitHub" flow: 1. Authenticate (or reuse stored token) 2. Prompt for repo name /
 * visibility 3. Create the repo via GitHub API 4. Add remote + push
 *
 * @param {{ projectName: string }} opts
 * @returns {Promise<boolean>} True if published successfully
 */
export async function publishToGithub({ projectName }: { projectName: string }) {
  const token = await authenticateGithub();
  if (!token) {
    return false;
  }

  const repoOpts = await showDialog<{
    name: string;
    description: string;
    isPrivate: boolean;
  } | null>((done) => {
    let _nameInput: HTMLInputElement | null = null;
    let _descInput: HTMLInputElement | null = null;
    let _privateToggle: HTMLInputElement | null = null;

    return html`
      <sp-dialog-wrapper
        open
        headline="Publish to GitHub"
        confirm-label="Create Repository"
        cancel-label="Cancel"
        @confirm=${() => {
          done({
            description: _descInput?.value || "",
            isPrivate: _privateToggle?.checked ?? true,
            name: _nameInput?.value || projectName,
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
            ${ref((el) => {
              _nameInput = (el as HTMLInputElement | null) || null;
            })}
          ></sp-textfield>

          <sp-field-label for="repo-desc">Description (optional)</sp-field-label>
          <sp-textfield
            id="repo-desc"
            name="repo-desc"
            placeholder="A brief description"
            ${ref((el) => {
              _descInput = (el as HTMLInputElement | null) || null;
            })}
          ></sp-textfield>

          <sp-field-label>Visibility</sp-field-label>
          <sp-switch
            name="repo-private"
            checked
            ${ref((el) => {
              _privateToggle = (el as HTMLInputElement | null) || null;
            })}
            >Private repository</sp-switch
          >
        </div>
      </sp-dialog-wrapper>
    `;
  });

  if (!repoOpts) {
    return false;
  }

  // One key across the whole publish, so the three progress lines REPLACE each other instead of
  // Stacking into a transcript. A long operation's log belongs in the Bottom dock's Activity tab.
  notify.info("Creating GitHub repository…", { key: "github.publish", source: "Publish" });

  const createRes = await fetch("https://api.github.com/user/repos", {
    body: JSON.stringify({
      auto_init: false,
      description: repoOpts.description,
      name: repoOpts.name,
      private: repoOpts.isPrivate,
    }),
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });

  if (!createRes.ok) {
    const err = (await createRes.json()) as GithubErrorResponse;
    const msg = err.errors?.[0]?.message || err.message || "Failed to create repository";
    notify.error("Could not create the GitHub repository.", {
      detail: msg,
      key: "github.publish",
      source: "Publish",
    });
    return false;
  }

  const repo = (await createRes.json()) as GithubRepoResponse;
  const platform = getPlatform();

  notify.info("Setting remote and pushing…", { key: "github.publish", source: "Publish" });

  await platform.gitAddRemote("origin", repo.clone_url);

  notify.info("Pushing to GitHub…", { key: "github.publish", source: "Publish" });
  try {
    await platform.gitPush({ setUpstream: true });
  } catch (error) {
    notify.error("Could not push to GitHub.", {
      detail: errorMessage(error),
      key: "github.publish",
      source: "Publish",
    });
    return false;
  }

  // Lazy import breaks the github-publish ↔ git-panel module cycle
  const { refreshGitStatus } = await import("../panels/git-panel");
  await refreshGitStatus();
  notify.success(`Published to GitHub: ${repo.html_url}`, { key: "github.publish" });
  return true;
}
