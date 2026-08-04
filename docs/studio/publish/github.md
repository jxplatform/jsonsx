---
title: "GitHub"
description: "Connect Jx Studio to GitHub — authorize with a one-time code, then publish your project as a new repository and push it in one flow."
code:
  - packages/studio/src/github/github-auth.ts
  - packages/studio/src/github/github-publish.ts
---

# GitHub

Studio can take a project that exists only on your machine and put it on GitHub — account sign-in, repository creation, and the first push — without leaving the app. Once it's there, every **Commit and sync** from the [Source Control panel](/docs/studio/publish/source-control) keeps the repository current, and your host can build the site from it.

## Authorize Studio

The first time you use a GitHub feature, Studio asks you to sign in with a one-time code:

1. A **Sign in to GitHub** dialog appears showing a short code.
2. Click the link in the dialog — it opens GitHub's device-authorization page in your browser.
3. Enter the code there and approve the request.
4. Back in Studio, the dialog closes on its own once GitHub confirms.

Studio remembers the authorization on this device, so you won't be asked again on your next publish.

## Put the project on GitHub

**Create GitHub repository** lives in the Source Control panel — it's offered when your project isn't tracked by git yet, and again in the sync bar while the project has no remote.

1. Click **Create GitHub repository**. Sign in first if prompted.
2. In the dialog, confirm the **Repository name** (prefilled with your project's name) and add an optional **Description**.
3. Choose the visibility. **Private repository** is on by default — turn it off to make the code public.
4. Click **Create Repository**.

Studio creates the repository on GitHub, connects your project to it, and pushes everything up. Each step announces itself in the corner as it happens, and when it finishes, the Source Control panel switches from **Local only (no remote)** to live sync status — you're one **Commit and sync** away from publishing changes from now on.

:::doc-note
Publishing uploads your project's files to GitHub. With **Private repository** on, only you (and people you invite on GitHub) can see them; public repositories are visible to anyone.
:::

:::doc-tip
Some Studio platforms connect to GitHub through the **Jx Suite GitHub App** instead — when that applies, the [Welcome screen](/docs/studio/interface/welcome-screen) offers **Install the Jx Suite GitHub App** and an **Add Existing Repository…** picker for repositories your account can already reach. The picker's footer links to the App's repository-access settings for each account, so you can widen what Studio sees at any time — see [Repository access](/docs/studio/interface/welcome-screen#repository-access).
:::

## Next

- **[Source control](/docs/studio/publish/source-control)** — the day-to-day commit and sync flow
- **[Publish](/docs/studio/publish)** — how a push becomes a live site
