---
title: "Create a project"
description: "Every field of the New Project modal in Jx Studio — templates, starter sites, import and agent sources, project details, and the design quickstart."
code:
  - packages/studio/src/new-project/new-project-modal.ts
  - packages/studio/src/new-project/templates.ts
  - packages/studio/src/new-project/design-fields.ts
  - packages/studio/src/new-project/location-fields.ts
  - packages/studio/src/new-project/import-tab.ts
---

# Create a project

The New Project modal is a two-step wizard: first you choose what to start from, then you fill in the project's details and an optional design quickstart. Open it from the [Welcome screen](/docs/studio/interface/welcome-screen) with **New Project…**, or from the dropdown beside **Open Project** in the toolbar.

![The New Project dialog with the template gallery, name, directory, production URL, and deployment adapter fields](../../images/new-project-modal.png)

## Step 1: choose a source

The first screen — **Start new project from:** — has up to four tabs:

- **Template** — a minimal skeleton to build on. Four options:
  - **Blank** — start from scratch.
  - **Desktop First** — an empty project preset with max-width breakpoints, so you design the large layout first and adapt down.
  - **Mobile First** — the same, with min-width breakpoints: design the phone layout first and adapt up.
  - **Mobile App** — an app shell with bottom navigation.
- **Starter Site** — a complete, themed website (restaurant, shop, portfolio, blog, and more) that Studio copies in as plain files you own. Browse the full gallery in **[Starter templates](/docs/studio/projects/starters)**.
- **Import** — recreate an existing website as a Jx project. Give Studio the site's URL and how many pages to crawl; the import is AI-assisted, so this tab asks for an AI provider key before it unlocks. Not every Studio platform offers this tab.
- **Agent** — describe the site you want in a sentence or two and the AI assistant builds it in the editor while you watch. Like Import, it needs an AI provider key first.

Pick a source and click **Next**.

## Step 2: fill in the parameters

The second screen — **New Project Parameters** — shows which source you picked, then the project's identity:

1. **Project Name** (required) — the human-readable name, e.g. "My Site".
2. **Location** (required) — the existing folder to create the project folder inside, e.g. `/home/you/Sites`. **Browse…** opens your system's folder picker. In a browser that has no folder-picking support, the button is hidden and you type the path instead.
3. **Directory** — the folder name for the project. Studio derives it from the name as you type (`My Site` becomes `my-site`); edit it to take over.
4. **Description** — a short line about the site.
5. **Production URL** — where the site will live once published, e.g. `https://example.com`.
6. **Deployment Adapter** — how the build packages the site for your host: **Static**, **Cloudflare Pages**, **Node**, or **Bun**. **Static** emits plain files for any host that serves them, which is all a site of pages and content needs. Pick one of the others if the site will have a database, sign-ins, or server functions: those adapters also package the small server that answers those requests. A database or sign-ins make that mandatory — the build refuses to run on **Static**. Server functions still build there; they just never get served. The choice isn't final — change it later in **[Project settings](/docs/studio/projects/settings)**.

Under **Location** and **Directory**, Studio shows exactly where the project will land — `/home/you/Sites/my-site` — before you commit to it.

On the Import tab, this step shows only the name, location, and directory plus the import's progress — the remaining fields and the design quickstart don't apply.

### On Jx Cloud

Cloud projects are GitHub repositories, so the same step asks for a **repository location** instead of a folder:

1. **Owner** (required) — the account the repository is created under: your personal account, or any organization you've installed the Jx Suite app on.
2. **Repository** — the repository name, derived from the project name the same way the directory is. Studio warns you if that name is already taken under the chosen owner.
3. **Visibility** — **Private** (the default) or **Public**.

The preview line shows the repository that will be created, e.g. `acme/my-site`.

## The design quickstart

Below the parameters sits a creation-time subset of the design settings. Every field is optional — anything you leave empty keeps the template or starter's own defaults:

- **Colors** — pick an **Accent**, **Background**, and **Text** color with a swatch or by typing a value.
- **Fonts** — a **Body Font** and **Heading Font**.
- **Logo** — upload an image (SVG, PNG, JPEG, WebP, GIF, or ICO); Studio copies it into the project's `public/` folder.
- **Breakpoints** — the screen sizes your design responds to, as name/value rows. Templates prefill their preset; for a starter site, leave this empty to keep the starter's own breakpoints. **Add Breakpoint** adds a row.

## Create it

Click **Create Project** (or **Create & Start Agent** on the Agent tab). Studio writes the project folder and opens it. **Back** returns to the source step without losing what you've typed.

If the **Project Name** is missing, the error appears directly under that field. A missing or non-absolute **Location** (or, on the cloud, a missing **Owner**) is reported under the destination fields. If creation itself fails, the message appears just above the footer buttons, so it stays visible however far the form is scrolled.

:::doc-note
Studio creates the folder you named, with `pages/`, `components/`, and a `project.json` carrying your name, URL, adapter, and design choices. The full folder anatomy is documented in [Site architecture](/docs/framework/site).
:::

:::doc-warning
There is no default location. Studio never picks a folder for you and never falls back to whatever directory it happens to be running in — if the **Location** is empty, nothing is created.
:::

## Next

- **[Projects](/docs/studio/projects)** — the other ways to get a project: open a folder or clone a repository
- **[Browse your project](/docs/studio/projects/browse)** — find your way around what was just created
- **[Starter templates](/docs/studio/projects/starters)** — the full starter gallery
