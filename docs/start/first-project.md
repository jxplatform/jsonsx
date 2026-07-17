---
title: "Your first project"
description: "Build and publish a website with Jx Studio — design visually, wire up interactivity, and commit to git, without hand-writing JSON."
---

# Your first project

In about ten minutes you'll create a site in Jx Studio, design a page, add a bit of interactivity, and publish it to git — all without hand-writing a line of JSON. (If you _do_ want to see the underlying format, every page here has a counterpart under **Format & Reference**.)

## 1. Get Studio

Download the desktop app for [macOS, Windows, or Linux](/docs/start/install), or install the CLI and run Studio locally:

```bash
bun create @jxsuite my-site
cd my-site && bun run dev
```

There's no hosted Studio to sign into — it runs on your machine, against your files. Full details on both paths — including a current caveat about the scaffolded `dev` script — are in **[Install Jx Studio](/docs/start/install)**. This tutorial uses the desktop app.

## 2. Create a project

In Studio, choose **New Project**. Give it a name and a folder, set your production URL, and pick a **deployment adapter** — Static, Cloudflare, Node, or Bun.

Then pick a **template**. Start from **Blank** for an empty project, or clone one of the [starter sites](/templates) — a restaurant, shop, portfolio, SaaS landing, blog, and more. Each one is a complete, themed site (pages, components, content, and images) you can reshape into your own. Studio copies it in as plain files and opens it on the canvas.

![Jx Studio New Project dialog — template gallery, name, directory, production URL, and deployment adapter picker](/screenshots/new-project-modal.png)

Prefer the terminal? The CLI takes the same templates:

```bash
bun create @jxsuite my-site --template restaurant
```

Already have a Jx project? Use **Open Project** to point Studio at a folder on disk, or **Clone** to pull one from git.

## 3. Manage, edit, design

Studio gives you a surface for each part of the job. Start in **[Manage](/docs/studio/projects/browse)** to see your project — pages, components, content, and media — with live previews.

![Jx Studio Manage Files modal with live previews of every project file](/screenshots/mode-manage.png)

Open a content page and switch to **[Edit](/docs/studio/editing)** to write inline — click any text and type, use slash commands for blocks, fill in frontmatter on the side. Open a component and switch to **[Design](/docs/studio/design)** for the visual canvas: a live preview at every breakpoint, and a full CSS inspector for spacing, type, color, and hover states.

![Jx Studio design canvas showing one component across four responsive breakpoints with a style inspector](/screenshots/mode-design.png)

## 4. Add an interaction

Websites do things. In Studio, interactivity comes from three panels working together — no separate "code mode" required:

- **State** — declare a value or a computed one (a counter, a total, a fetched list).
- **Events** — bind a handler to a click, input, or submit with the structured expression editor.
- **Code** — drop into the Monaco editor when a handler needs real JavaScript.

![Jx Studio editing a component state function in the Monaco code editor](/screenshots/mode-script.png)

Add a `count` to state, a button, and an `onclick` that increments it — you've built a reactive component. See **[Script & logic](/docs/studio/logic)** for the full toolkit.

## 5. Commit and publish

When you're happy, open **Source Control**. Review your changes, write a message, and **commit and sync** — or, for a brand-new project, **Publish to GitHub** and Studio creates the repository for you.

![Jx Studio commit box — write a message and commit-and-sync straight from the Source Control panel](/screenshots/git-commit.png)

Here's the one boundary worth knowing: **Studio publishes code; it doesn't build or deploy the site.** It commits and pushes, and it sets the deploy adapter you chose in step 2. Your host takes it from there — building the static site (`bunx jx build`) on every push and serving the `dist/` output from a CDN. See **[Git & publish](/docs/studio/publish)** for the full flow.

## What's next

- **Using Studio:** [Manage](/docs/studio/projects/browse) · [Edit](/docs/studio/editing) · [Design](/docs/studio/design) · [Script & logic](/docs/studio/logic) · [Git & publish](/docs/studio/publish)
- **For developers:** [Site architecture](/docs/framework/site) · [Component model](/docs/framework/concepts/components) · [Spec overview](/docs/framework)
