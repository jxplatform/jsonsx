---
title: "Create a project"
description: "Every step of the New Project wizard in Jx Studio: the starter gallery, Start from scratch, the import and agent sources, and naming the project."
code:
  - packages/studio/src/new-project/new-project-modal.ts
  - packages/studio/src/new-project/location-fields.ts
  - packages/studio/src/new-project/import-tab.ts
---

# Create a project

The New Project wizard is two steps: first you choose what to start from, then you name the project and say where it goes. Open it from the [Start pane](/docs/studio/interface/welcome-screen) with **New Project…**, or from the dropdown beside **Open Project** in the toolbar.

![The New Project dialog with the starter gallery and the Start from scratch card](../../images/new-project-modal.png)

## Step 1: choose a starting point

The first screen (**Choose a starting point**) opens on the starter gallery, because a real site is easier to judge than an empty one:

- **Starters**: complete, themed websites (restaurant, shop, portfolio, blog, and more) that Studio copies in as plain files you own. The first one is selected for you. Browse the full gallery in **[Starter templates](/docs/studio/projects/starters)**.
- **Start from scratch**: the last card in the gallery, an empty site with one page, for when you already know what you want to build.
- **Import**: recreate an existing website as a Jx project. Give Studio the site's URL and how many pages to crawl; the import is AI-assisted, so this tab asks you to connect AI before it unlocks. Not every Studio platform offers this tab.
- **Agent**: describe the site you want in a sentence or two and the AI assistant builds it in the editor while you watch. Like Import, it needs AI connected first.

Both AI tabs unlock the moment AI is available, by whichever route your Studio offers. They are the same options the [AI assistant](/docs/studio/ai) sidebar gives you:

- **Connect Cloudflare**: on Jx Cloud, run Workers AI on your own Cloudflare account with no API key at all. Click the button, approve the Cloudflare authorization, and the tab unlocks when you land back in Studio. With no model of your own chosen, Studio uses the one that backend says it prefers rather than guessing a name it may not serve.
- **An AI provider key**: paste any OpenAI-compatible key into the form. This is the only route on desktop and the dev server.
- **Nothing to do**: if the Studio backend already holds a provider key (a dev server started with `OPENAI_API_KEY`, or a Cloudflare account you connected earlier), both tabs are unlocked from the start.

Pick a source and click **Next**. **Cancel** is available on this step and the next one, and :kbd[Escape] closes the wizard from either.

## Step 2: name your project

The second screen (**Name your project**) shows which source you picked, then asks for two things:

1. **Project Name** (required): the human-readable name, e.g. "My Site".
2. **Location** (required): the existing folder to create the project folder inside, e.g. `/home/you/Sites`. **Browse…** opens your system's folder picker. In a browser that has no folder-picking support, the button is hidden and you type the path instead.
3. **Directory**: the folder name for the project. Studio derives it from the name as you type (`My Site` becomes `my-site`); edit it to take over.

Under **Location** and **Directory**, Studio shows exactly where the project will land (`/home/you/Sites/my-site`) before you commit to it.

Nothing else is asked at creation time. The site's production URL, its deployment adapter, and its colors, fonts and breakpoints are all **project settings** you can change as often as you like. Set them from **[Project settings](/docs/studio/projects/settings)** once the project is open.

### On Jx Cloud

Cloud projects are GitHub repositories, so the same step asks for a **repository location** instead of a folder:

1. **Owner** (required): the account the repository is created under, either your personal account or any organization you've installed the Jx Suite app on.
2. **Repository**: the repository name, derived from the project name the same way the directory is. Studio warns you if that name is already taken under the chosen owner.
3. **Visibility**: **Private** (the default) or **Public**.

The preview line shows the repository that will be created, e.g. `acme/my-site`.

## Create it

Click **Create Project** (or **Create & Start Agent** on the Agent tab). Studio writes the project folder, **initializes a git repository in it**, and opens it. **Back** returns to the source step without losing what you've typed.

If the **Project Name** is missing, the error appears directly under that field. A missing or non-absolute **Location** (or, on the cloud, a missing **Owner**) is reported under the destination fields. If creation itself fails, the message appears just above the footer buttons, so it stays visible however far the form is scrolled.

:::doc-note
Studio creates the folder you named, with `pages/`, `components/`, and a `project.json` carrying your project's name. The full folder anatomy is documented in [Site architecture](/docs/framework/site).
:::

:::doc-tip
Because the new project is a git repository from its first minute, every later change, including a rename or a delete you regret, can be reviewed and reverted from [Source control](/docs/studio/publish/source-control). Cloud projects are already repositories, so nothing extra happens there.
:::

:::doc-warning
There is no default location. Studio never picks a folder for you and never falls back to whatever directory it happens to be running in. If the **Location** is empty, nothing is created.
:::

### While an import runs

The Import tab streams a live log, one line per phase, with the current step at the top. A garbled line in that stream doesn't stop the import; the pages already crawled are kept. But it isn't ignored either: when the run finishes, Studio counts the lines it couldn't read and posts a warning saying so, because an import that quietly skipped a step looks exactly like one that didn't.

## Next

- **[Projects](/docs/studio/projects)**: the other ways to get a project, by opening a folder or cloning a repository
- **[The Library](/docs/studio/projects/browse)**: find your way around what was just created
- **[Starter templates](/docs/studio/projects/starters)**: the full starter gallery
