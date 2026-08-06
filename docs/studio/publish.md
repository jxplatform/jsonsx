---
title: "Publish"
description: "How a Jx site goes live: a checklist of what is missing, a commit and a push, then your host builds prebuilt pages plus a worker if the project needs one."
code:
  - packages/studio/src/panels/git-panel.ts
  - packages/studio/src/github/github-publish.ts
  - packages/studio/src/publish/publish-commands.ts
  - packages/studio/src/publish/deploy-checklist.ts
---

# Publish

Shipping a Jx site is part of the Studio flow — no terminal, no separate deploy tool. The one boundary worth knowing up front: **Studio publishes your code — it doesn't build the site.** Studio's job ends when your files reach your repository and your provider has been told about it; the build itself happens on your host.

![Jx Studio commit box — write a message and commit-and-sync straight from the Source Control panel](../images/git-commit.png)

## How it goes live

1. In the **Source Control** panel, you write a message and **Commit and sync** — Studio records the change and pushes it to your repository.
2. The push wakes your host (or CI), which builds the project into plain HTML, CSS, and a little JavaScript.
3. The host serves that output from a CDN. Your site is live.

**How you hear about it.** Anything that takes a while runs as an **Activity** in the Bottom dock, with its steps ticked off in order and its log underneath — creating the repository, adding the remote, pushing — and a toast at the end naming the repository it pushed to. Nothing about that is transient once it goes wrong: a repository that couldn't be created or a push the remote refused goes on the **Problems** list, carrying the host's own error and the activity's log, and stays there until you deal with it. See **[Problems and progress](/docs/studio/interface/problems-and-progress)**.

The **deployment adapter** — Static, Bun, Node, Cloudflare Workers, or Cloudflare Pages — tells the build how to package the output for your target. It isn't a creation-time decision: set it in [Project settings](/docs/studio/projects/settings) whenever you know where the site is going. Switching hosts means switching the adapter; your pages, components, and content stay the same.

Every page is built ahead of time, so what the CDN serves is finished HTML however the site is put together. Pick one of the non-Static adapters and the same build writes a small worker beside those files for your host to run — that is what answers the `/_jx/*` routes behind a database, sign-ins, or server functions. A database or sign-ins make an adapter mandatory: the build stops with an error on **Static**. Server functions still build there, but nothing serves them without an adapter. **[Build output and adapters](/docs/framework/site/deployment)** lists what each adapter emits.

Because every Jx file is plain JSON or Markdown, each publish is a clean, reviewable set of changes — no binary blobs, no database dumps.

## What's missing, before you start

Publishing is a chain: the project is tracked by git, it has a remote and the remote is current, a provider is connected, and something has actually deployed. Each link is a different action, so Studio keeps the whole chain in one place — the **Deploy checklist**, in the **Activity** tab of the Bottom dock (:kbd[⌘J] / :kbd[Ctrl+J]). It sits with the long operations because a deploy is one: it pushes a branch and then waits on a build happening somewhere else.

Four steps, in the order they have to be done, each ticked off or explained:

| Step                            | Satisfied by                                |
| ------------------------------- | ------------------------------------------- |
| **Track this project with git** | **Initialize Repository**                   |
| **Push to a remote**            | **Create GitHub Repository**, then **Push** |
| **Connect a deploy provider**   | **Set Up Publishing**                       |
| **Deploy**                      | **Deploy**                                  |

Every step carries the command that satisfies it as a button, rather than a sentence telling you to go and find one — and the button wears that command's own name, so it's disabled with a reason when it isn't available yet. A step that's done says what is true now (the branch you're on, the Pages project you're connected to); a step that isn't says what satisfying it buys you.

:::doc-note
A step Studio can't answer says so with a **?** rather than guessing. "Nothing has deployed" and "nobody has asked Cloudflare" look the same from inside the app, and a checklist that renders the second as the first would tell you to redo a deploy that already worked.
:::

The **status bar** carries the same chain in 24 pixels: its project field shows the **next blocking step** as its label, so the item both explains what's missing and fixes it when you click it. With the chain whole it reads **Deployed**, and clicking it opens your provider's dashboard.

:::doc-tip
The **Ship** layout tab arranges the window for exactly this: Source Control in the Navigator, the Bottom dock open on **Activity**, and the Inspector collapsed so the diff gets the full width. A layout never removes anything — the Inspector is one :kbd[⌘⌥B] away from coming back.
:::

## The Publish commands

Three commands, in [Quick Access](/docs/studio/interface/quick-access) under **Publish**, always listed and each disabled with the one sentence that says why:

- **Set Up Publishing** — opens the provider connection flow. Needs a platform that can reach the Cloudflare API; see **[Cloudflare Pages](/docs/studio/publish/cloudflare)**.
- **Deploy** — pushes the current branch and then asks your provider what it made of it. Needs a repository with a remote and a connected provider. It doesn't commit for you — commit first if there are unsaved changes.
- **Open Deployment Dashboard** — opens the connected Pages project on Cloudflare.

**Deploy runs as an Activity, not a toast.** The row shows its two steps — pushing, then asking for the deployment — with the log underneath, and it's honest about which one it's on: it waits for the deployment _record_, which appears within seconds, not for the build, which takes minutes. If the push fails, the failure becomes a Problem carrying the log and a recovery button — **Push**, the real command, so it can be run straight from the row — and it outlives the operation. If nothing has been reported yet when the wait is over, the activity says exactly that instead of claiming a result.

## The surfaces

- **[Source control](/docs/studio/publish/source-control)** — the built-in git client: review and stage changes, commit and sync, branches, pulling, and history.
- **[GitHub](/docs/studio/publish/github)** — connect your GitHub account and publish a brand-new project as a repository in one flow.
- **[Cloudflare Pages](/docs/studio/publish/cloudflare)** — connect a provider so every push builds and publishes on its own.
- **[Redirects](/docs/studio/publish/redirects)** — keep old URLs working when a page moves, checked for chains, loops and rules a real page shadows.

## Next

- Understand the build and routing in **[Site architecture](/docs/framework/site)**
