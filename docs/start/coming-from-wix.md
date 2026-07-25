---
title: "Coming from Wix or Squarespace"
description: "Switching from Wix or Squarespace to Jx in practice — the same visual editing, with local files, git, and a host you choose instead of a lock-in."
---

# Coming from Wix or Squarespace

On Wix or Squarespace, your site lives inside your account: the editor, the files, and the hosting are one thing you rent. Jx separates them. You still build in a visual editor — click, type, drag, style — but the site itself is a folder of ordinary files that you own, and putting it on the web means handing those files to a hosting service. This page explains what that actually means day to day, including the parts you take on yourself.

## You still get a visual editor

Jx Studio is a full visual builder: click any text and type right on the page, drag in headings, images, and sections, and style everything with panels — colors, spacing, fonts — while a live canvas shows the page at every screen size. Nothing in the [Studio documentation](/docs/studio) assumes you can code.

![Jx Studio with a real-estate site open on the canvas, showing the layers tree and properties panel](../images/hero.png)

One difference you'll notice immediately: Studio is an app you [download](/docs/start/install), not a website you sign into. There's no account, because there's nothing to have an account _on_ — it opens your files directly.

## Where your site lives

Instead of one company's servers, your site touches three places, each with one job:

1. **Your computer** — the project folder. This is the site: pages, images, settings, all as ordinary files Studio edits.
2. **A repository** — an online copy of that folder, with its full history. It's your backup and your publishing channel.
3. **A host** — the service that shows the site to visitors. Every time you sync changes to the repository, the host rebuilds and the new version goes live.

The day-to-day loop is: edit in Studio, click **Commit and sync**, and a minute later the site is updated. All of it happens through Studio's buttons — you never type commands.

## A short glossary

| Term       | What it means                                                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Repository | The online copy of your project folder, with its full history. GitHub is the best-known place to keep one.                           |
| Commit     | A saved snapshot of your changes, with a short note saying what you did.                                                             |
| Sync       | Sending your commits to the repository — this is the moment the host notices and rebuilds.                                           |
| Host       | The service that serves your site to visitors. Cloudflare Pages, Netlify, and GitHub Pages all work, and their basic plans are free. |
| Build      | The automatic step where your project files are turned into the finished pages the host serves.                                      |

## What you take on

Honestly: some one-time setup that Wix or Squarespace did for you.

- **Connecting the pieces.** You'll create a GitHub account and connect a host. Studio walks you through the repository part with **[Publish to GitHub](/docs/studio/publish/github)**, has a built-in flow for **[Cloudflare Pages](/docs/studio/publish/cloudflare)**, and the **[other hosts](/docs/studio/publish/other-hosts)** guide covers the rest — the host setup is two fields, once.
- **Your domain.** Domains come from a registrar or your host, not from the builder, and you connect one in the host's settings.
- **No single support desk.** If something on the host's side misbehaves, it's their documentation you'll read — there's no one company renting you the whole stack.

Editing also happens where Studio and your files are — your computer — rather than from any browser anywhere. The repository lets you set up a second machine, but it's a copy you open, not a website you log into.

## What you get back

The trade is real, and so is the payoff: nothing is locked in.

- A lapsed subscription can never take your site down or hold your content — the files are on your machine and in your repository either way.
- You can switch hosts without rebuilding anything; the same files publish anywhere.
- Your pages and writing are readable files today and in twenty years, openable without Jx at all.
- Hosting a site like this is typically free, and the published site is plain, fast pages. Adding sign-ins or a database later gives your host one small program to run alongside them — but the build writes that program for you, and the pages themselves stay prebuilt either way. There's no server of yours to write or patch.

:::doc-tip
You don't have to set up publishing on day one. Create a project, build, and explore entirely on your own machine — the repository and host can come when you're ready to go live.
:::

## Start here

- **[Install Jx Studio](/docs/start/install)** — download the app for macOS, Windows, or Linux
- **[Your first project](/docs/start/first-project)** — from starter template to published site
- **[A tour of Jx Studio](/docs/start/studio-tour)** — find your way around the editor
