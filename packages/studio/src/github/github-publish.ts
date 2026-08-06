/// <reference lib="dom" />
/**
 * Create a GitHub repository for a local project, add it as `origin`, and push.
 *
 * **This is not publishing, and it used to say it was.** Two unrelated operations shared the verb
 * (plan §9.5): this one creates a git repository, and `publish/publish-panel.ts` connects a hosting
 * provider that then builds the site. A user who wanted the second and found the first got a GitHub
 * repository and no site, and a user who wanted the first read "Publish to GitHub" and reasonably
 * expected a URL. The function, the dialog headline, the activity title and the notification source
 * now all say _Create GitHub Repository_; `Publish:` belongs to `publish/publish-commands.ts`.
 *
 * **It is an Activity, not three toasts.** Three `notify.info` lines sharing one key replaced each
 * other in a corner while a multi-second, three-request, partially-committing operation ran with no
 * log and no cancel — and its middle step (`gitAddRemote`) had no error path at all, so a remote
 * that already existed failed the push with a message about pushing. `beginActivity` gives it the
 * ordered steps, the captured log, and `fail()`, which raises the Problem the failure needs and
 * carries the log as its detail (§7.3). The caller therefore never also notifies.
 */

import { html } from "lit-html";
import { errorMessage } from "@jxsuite/schema/parse";
import { ref } from "lit-html/directives/ref.js";
import { showDialog } from "../ui/layers";
import { authenticateGithub } from "./github-auth";
import { beginActivity } from "../panels/activity-panel";
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

/** What the dialog collects. */
export interface RepoOptions {
  name: string;
  description: string;
  isPrivate: boolean;
}

/** The ordered steps, named once so the activity and its tests cannot disagree. */
export const REPO_STEPS = ["Create the repository", "Add the remote", "Push"] as const;

/**
 * Full "Create GitHub Repository" flow: 1. Authenticate (or reuse a stored token) 2. Prompt for
 * repo name / visibility 3. Create the repo via the GitHub API 4. Add remote + push
 *
 * A failed sign-in returns `false` having already reported itself — `github-auth.ts` owns that
 * message, because "GitHub is unreachable from a browser" is not a fact about creating a
 * repository.
 *
 * @param {{ projectName: string }} opts
 * @returns {Promise<boolean>} True if the repository was created and pushed.
 */
export async function createGithubRepository({ projectName }: { projectName: string }) {
  const token = await authenticateGithub();
  if (!token) {
    return false;
  }

  const repoOpts = await showDialog<RepoOptions | null>((done) => {
    let _nameInput: HTMLInputElement | null = null;
    let _descInput: HTMLInputElement | null = null;
    let _privateToggle: HTMLInputElement | null = null;

    return html`
      <sp-dialog-wrapper
        open
        headline="Create GitHub Repository"
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

  const activity = beginActivity({
    source: "Source Control",
    status: `Creating ${repoOpts.name}…`,
    steps: [...REPO_STEPS],
    title: "Create GitHub repository",
  });

  activity.step(REPO_STEPS[0]);
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
  }).catch((error: unknown) => {
    activity.log(errorMessage(error));
    return null;
  });

  if (!createRes) {
    activity.fail("Could not reach GitHub to create the repository.", {
      action: "git.createGithubRepository",
    });
    return false;
  }

  if (!createRes.ok) {
    const err = (await createRes.json()) as GithubErrorResponse;
    activity.log(err.errors?.[0]?.message || err.message || `GitHub answered ${createRes.status}.`);
    activity.fail("Could not create the GitHub repository.", {
      action: "git.createGithubRepository",
    });
    return false;
  }

  const repo = (await createRes.json()) as GithubRepoResponse;
  activity.log(`Created ${repo.html_url}`);
  const platform = getPlatform();

  activity.step(REPO_STEPS[1]);
  try {
    await platform.gitAddRemote("origin", repo.clone_url);
  } catch (error) {
    // The remote had no error path at all before this, so an `origin` that already existed
    // Surfaced as a push failure describing the push.
    activity.log(errorMessage(error));
    activity.fail("The repository was created, but the remote could not be added.", {
      action: "panel.focus.git",
    });
    return false;
  }

  activity.step(REPO_STEPS[2]);
  try {
    await platform.gitPush({ setUpstream: true });
  } catch (error) {
    activity.log(errorMessage(error));
    activity.fail("The repository was created, but the push failed.", {
      action: "git.push",
    });
    return false;
  }

  // Lazy import breaks the github-publish ↔ git-panel module cycle
  const { refreshGitStatus } = await import("../panels/git-panel");
  await refreshGitStatus();
  activity.done(repo.html_url);
  notify.success(`Repository created: ${repo.html_url}`, { key: "github.repo" });
  return true;
}
