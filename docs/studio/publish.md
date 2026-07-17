---
title: "Publish"
description: "Commit, branch, and push from inside Jx Studio, publish to GitHub in a click, and let your host build the static site on every push."
---

# Git & publish

Jx Studio has a full git client built in, so shipping is part of the flow — not a context switch to the terminal.

![Jx Studio commit box — write a message and commit-and-sync straight from the Source Control panel](/screenshots/git-commit.png)

## Source control in Studio

The Source Control panel shows your branch, how far ahead or behind you are, and every changed file grouped by folder. From here you can:

- **Stage, unstage, and discard** changes per file or in bulk
- Write a message and **commit**, or **commit and sync** to push in one step
- **Create and switch branches**
- **Fetch, pull, and push**
- Open a **diff** of any change against HEAD, and browse **history**

Because every Jx file is plain JSON or Markdown, each change is a clean, reviewable diff — no binary blobs, no opaque database dumps.

## Publish to GitHub

Starting a brand-new project? **Publish to GitHub** authorizes with your account, creates the repository, adds the remote, and pushes — all from Studio. You go from local folder to a hosted repo without leaving the app.

## How it goes live

Here's the important boundary: **Studio publishes your code — it doesn't build or deploy the site.** When you push, your host takes over:

1. Studio commits and pushes your JSON and Markdown to git.
2. Your host (or CI) runs the build — `bunx jx build` — compiling the project to static HTML, CSS, and minimal JS in `dist/`.
3. The host serves `dist/` from a CDN.

The **deployment adapter** you picked when you created the project (Static, Cloudflare, Node, or Bun) tells the build how to package the output for your target. Change hosts later by changing the adapter — the source never changes.

## Next

- Understand the build and routing in **[Site architecture](/docs/framework/site)**
