---
title: "Your first project"
description: "Build and publish a website with Jx Studio: design visually, wire up interactivity, and commit to git, without hand-writing JSON."
---

# Your first project

In about ten minutes you'll create a site in Jx Studio, design a page, add a bit of interactivity, and publish it to git, all without hand-writing a line of JSON. (If you _do_ want to see the underlying format, every page here has a counterpart under **[Framework](/docs/framework)**.)

## 1. Get Studio

Download the desktop app for [macOS, Windows, or Linux](/docs/start/install). There is no hosted Studio to sign into; it runs on your machine, against your files. Full details are in **[Install Jx Studio](/docs/start/install)**.

## 2. Create a project

In Studio, choose **New Project**. The wizard opens on the [starter gallery](/templates): a restaurant, a shop, a portfolio, a SaaS landing page, a blog, and more. Each one is a complete, themed site (pages, components, content, and images) you can reshape into your own, and Studio copies it in as plain files. The last card, **Start from scratch**, gives you an empty site with one page instead.

Click **Next**, give the project a name, and choose the **Location** to create it in. **Browse…** opens your system's folder picker. Studio derives the folder name from the name as you type and shows you the exact path before you commit to it. That's the whole form: it writes the files, starts a git repository for them, and opens the project on the canvas.

Everything else about the site lives in [project settings](/docs/studio/projects/settings), where you can change it as often as you like: its description, its production URL, and the **deployment adapter** that packages it for your host. **Static** suits a site that's purely pages and content. If it will have a database, sign-ins, or server functions, pick one of the others, because those hosts can run the small worker Jx builds for them.

![The New Project dialog with the starter gallery and the Start from scratch card](../images/new-project-modal.png)

Already have a Jx project? Use **Open Project** to point Studio at a folder on disk, or **Clone** to pull one from git. (Developers who'd rather scaffold from a terminal can use `bun create @jxsuite` instead, described in [CLI commands](/docs/framework/build/cli), then open the result in Studio.)

## 3. Browse, edit, design

Studio gives you a surface for each part of the job. Start in **[The Library](/docs/studio/projects/browse)** to see your project: pages, components, content, and media, each with a live preview.

![The Library open in a Studio pane, listing a project's pages and components as cards with live previews](../images/mode-manage.png)

Open a content page and switch to **[Edit mode](/docs/studio/editing)** to write inline: click any text and type, use slash commands for blocks, fill in frontmatter on the side. Open a component and switch to **[Design](/docs/studio/design)** for the visual canvas: a live preview at every breakpoint, and a full CSS inspector for spacing, type, color, and hover states.

![Jx Studio design canvas showing one component across four responsive breakpoints with a style inspector](../images/mode-design.png)

## 4. Add an interaction

Websites do things. In Studio, interactivity comes from three surfaces working together, with no separate "code mode" required:

- The **State** panel declares a value or a computed one: a counter, a total, a fetched list.
- The Inspector's **Logic** tab binds a handler to a click, input, or submit with the structured expression editor.
- The **Code** editor is where you drop into Monaco when a handler needs JavaScript.

![Jx Studio editing a component state function in the Monaco code editor](../images/mode-script.png)

Add a `count` to state, a button, and an `onclick` that increments it, and you've built a reactive component. See **[Logic](/docs/studio/logic)** for the full toolkit.

## 5. Commit and publish

When you're happy, open **Source Control**. Review your changes, write a message, and **commit and sync**. If the project has no remote yet, **Create GitHub repository** makes one and pushes to it for you.

![Jx Studio commit box: write a message and commit-and-sync straight from the Source Control panel](../images/git-commit.png)

There is one boundary to know about: **Studio publishes code; it doesn't build or deploy the site.** It commits and pushes, and it records the deploy adapter set in project settings. Your host takes it from there, building the site (`bunx jx build`) on every push and serving the `dist/` output from a CDN. With one of the server-capable adapters, the build emits a small worker beside those files as well, and that worker is the piece that runs a database, sign-ins, or server functions. See **[Publish](/docs/studio/publish)** for the full flow.

## What's next

- **Using Studio:** [The Library](/docs/studio/projects/browse) · [Edit mode](/docs/studio/editing) · [Design mode](/docs/studio/design) · [Logic](/docs/studio/logic) · [Publish](/docs/studio/publish)
- **For developers:** [Site architecture](/docs/framework/site) · [Component model](/docs/framework/concepts/components) · [Spec overview](/docs/framework)
