---
title: "GitHub"
description: "Connect Jx Studio to GitHub: authorize with a one-time code, then publish your project as a new repository and push it in one flow."
code:
  - packages/studio/src/github/github-auth.ts
  - packages/studio/src/github/github-publish.ts
---

# GitHub

Studio can take a project that exists only on your machine and put it on GitHub without leaving the app: account sign-in, repository creation, and the first push. Once it's there, every **Commit and sync** from the [Source Control panel](/docs/studio/publish/source-control) keeps the repository current, and your host can build the site from it.

## Authorize Studio

The first time you use a GitHub feature, Studio asks you to sign in. **How it asks depends on where Studio is running**, because the two places have genuinely different options.

**In the desktop app**, your browser opens GitHub's own authorization page:

1. Your default browser opens with GitHub's **Authorize** page. If you're already signed in to GitHub there, this is one click.
2. Approve the request.
3. GitHub sends you to a small page that says you're signed in. Close that tab and go back to Studio. It already has what it needs.

**In a browser**, Studio asks for a one-time code instead:

1. A **Sign in to GitHub** dialog appears showing a short code.
2. Click the link in the dialog, which opens GitHub's device-authorization page.
3. Enter the code there and approve the request.
4. Back in Studio, the dialog closes on its own once GitHub confirms.

Studio remembers the authorization on this device, so you won't be asked again on your next publish. You can also start it yourself with the **Sign In to GitHub** command in [Quick Access](/docs/studio/interface/quick-access). It's an application-level command, so it works with no project open, which is what you want before cloning something.

:::doc-note
The authorization belongs to the machine, not to a project. **Preferences › Accounts** lists it alongside every other credential Studio holds and is where you forget it. No page in Studio ever prints the token back to you.

Where it's kept differs too, and the Accounts row says which: the desktop app stores it in a file in its own configuration folder that only your user account can read, while the browser keeps it in that browser's storage. Signing out from Accounts forgets it either way. Revoking Studio's access entirely is done on [GitHub's own applications page](https://github.com/settings/applications), because no app can revoke its own token for you.
:::

## Put the project on GitHub

**Create GitHub repository** lives in the Source Control panel. It's offered when your project isn't tracked by git yet, and again in the sync bar while the project has no remote. It's also the **Create GitHub Repository** command in Quick Access, and the second step of the [deploy checklist](/docs/studio/publish) names it there too.

1. Click **Create GitHub repository**. Sign in first if prompted.
2. In the dialog, confirm the **Repository name** (prefilled with your project's name) and add an optional **Description**.
3. Choose the visibility. **Private repository** is on by default. Turn it off to make the code public.
4. Click **Create Repository**.

Studio creates the repository on GitHub, connects your project to it, and pushes everything up. It runs as one **Create GitHub repository** activity in the Bottom dock with three steps (_Create the repository_, _Add the remote_, _Push_), and when it finishes, the Source Control panel switches from **Local only (no remote)** to live sync status. You're one **Commit and sync** away from publishing changes from now on.

A step that fails says which one it was, and raises a Problem under **Source Control** carrying GitHub's own error, including the honest middle cases: the repository exists but the remote couldn't be added, or the push was refused.

:::doc-note
Publishing uploads your project's files to GitHub. With **Private repository** on, only you (and people you invite on GitHub) can see them; public repositories are visible to anyone.
:::

:::doc-tip
Some Studio platforms connect to GitHub through the **Jx Suite GitHub App** instead. When that applies, the [Welcome screen](/docs/studio/interface/welcome-screen) offers **Install the Jx Suite GitHub App** and an **Add Existing Repository…** picker for repositories your account can already reach. The picker's footer links to the App's repository-access settings for each account, so you can widen what Studio sees at any time. See [Repository access](/docs/studio/interface/welcome-screen#repository-access).
:::

## Next

- **[Source control](/docs/studio/publish/source-control)** is the day-to-day commit and sync flow.
- **[Publish](/docs/studio/publish)** covers how a push becomes a live site.
- **[Cloudflare Pages](/docs/studio/publish/cloudflare)** is the next link in the chain, a provider that builds the repository on every push.
