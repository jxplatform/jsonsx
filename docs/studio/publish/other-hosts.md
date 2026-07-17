---
title: "Other hosts"
description: "Publish a Jx site anywhere: pick an adapter, have your host run the build, and serve the output — with Netlify and GitHub Pages sketches."
spec:
  - site-architecture.md#14
---

# Other hosts

A Jx site doesn't need a special host. The build turns your project into an ordinary folder of web files, so any host that can run one build command and serve a folder can serve your site. Studio's built-in flow covers **[Cloudflare Pages](/docs/studio/publish/cloudflare)**; for everything else, the recipe below is the whole story.

## The recipe

1. **Pick the deployment adapter.** In _Settings > General_, set **Platform Adapter** for your target. **Static** is the safe default — it works on any host that serves files. **Node** and **Bun** are for hosts that run a server for you. See **[Project settings](/docs/studio/projects/settings)**.
2. **Put the project on GitHub** (or another repository host) so your host can see it — **[GitHub](/docs/studio/publish/github)** does this from inside Studio.
3. **Tell the host two things**: the build command is `bunx jx build`, and the folder to publish is `dist`.

That's it. From then on, every **Commit and sync** in **[Source control](/docs/studio/publish/source-control)** pushes your changes, the host runs the build, and the fresh site goes live — the flow described in **[Publish](/docs/studio/publish)**.

## Netlify

Create a new site in Netlify and connect it to your repository. In the build settings, set:

- **Build command**: `bunx jx build`
- **Publish directory**: `dist`

Netlify then builds and publishes on every push, with a free site address until you attach your own domain.

## GitHub Pages

GitHub Pages serves files but doesn't take a build command directly — the build runs in a GitHub Actions workflow instead. In your repository, set Pages to deploy from GitHub Actions, and add a workflow that runs `bunx jx build` on every push and publishes the `dist` folder with GitHub's Pages deploy action. GitHub's own Pages documentation covers the workflow setup; the only Jx-specific parts are the command and the folder.

## Anywhere else

The same two values — build with `bunx jx build`, serve `dist` — fit Vercel, Render, a plain web server, or your own CI. If a host can't run the build, you can even run `bunx jx build` yourself and upload the `dist` folder by hand; it's a complete site.

:::doc-note
With an adapter set, the build may add small host-specific files (like a server worker for Node, Bun, or Cloudflare) alongside the static output in `dist/`. The full list of adapters and what each one emits is in [Site architecture](/docs/framework/site).
:::

## Next

- **[Publish to Cloudflare Pages](/docs/studio/publish/cloudflare)** — the host with a built-in Studio flow
- **[GitHub](/docs/studio/publish/github)** — get the project into a repository first
