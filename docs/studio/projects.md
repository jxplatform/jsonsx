---
title: "Projects"
description: "What a Jx project is on disk — a folder of plain files — and the three ways to get one in Studio: create new, open a folder, or clone a repository."
code:
  - packages/studio/src/panels/welcome-screen.ts
  - packages/studio/src/browse/browse.ts
---

# Projects

A Jx project is a folder on your computer. No hosted service holds your work and no account owns it — everything you build in Studio is a plain file inside that folder, which you can back up, copy, or put under version control like any other document. A published site can still keep its own runtime data in a real database (see **[Databases](/docs/studio/data)**); the project you edit is always just files.

## What's in the folder

Studio and the folder are two views of the same thing. Each area of your project maps to a subfolder:

| On disk        | What it holds                                   | In Studio                                                    |
| -------------- | ----------------------------------------------- | ------------------------------------------------------------ |
| `pages/`       | One file per page of your site                  | **Pages** in the [Manage view](/docs/studio/projects/browse) |
| `layouts/`     | Shared page shells — headers, footers, wrappers | **Layouts**                                                  |
| `components/`  | Reusable building blocks                        | **Components**                                               |
| `content/`     | Posts, entries, and other collection content    | **Content**                                                  |
| `public/`      | Images, video, fonts, and other media           | **Media** (see [Media](/docs/studio/projects/media))         |
| `project.json` | The site's settings — name, URL, design tokens  | Project settings                                             |

What each kind of file is for — and when to reach for which — is covered in **[Pages, layouts, and components](/docs/studio/projects/pages-layouts-components)**. The full folder anatomy is documented in **[Site architecture](/docs/framework/site)**.

## Get a project

There are three ways to end up with a project open in Studio, all available from the [Welcome screen](/docs/studio/interface/welcome-screen):

1. **Create a new one.** Click **New Project…**. The wizard opens on the starter gallery — complete sites you can look at — with a **Start from scratch** card at the end of it. You choose the folder it's created in (on studio.jxsuite.com, the GitHub repository); Studio never picks one for you. The whole wizard is walked through in **[Create a project](/docs/studio/projects/create)**.
2. **Open an existing folder.** Click **Open Project…** and point Studio at a Jx project already on your machine. On studio.jxsuite.com the same button lists the GitHub repositories you can write to instead — pick one and Studio opens it, or use the links in the picker's footer to grant the Jx Suite GitHub App access to more of them. Recently opened projects also appear on the Welcome screen for one-click reopening.
3. **Clone a repository.** Click **Clone Git Repository…**, paste a repository URL, and click **Clone** — Studio downloads the project and opens it. On platforms linked to a GitHub account, **Add Existing Repository…** lets you pick from your repositories instead of pasting a URL.

:::doc-note
Because a project is just a folder, "moving to Jx" or "leaving Jx" is copying files. Studio never locks your work into a format only it can read.
:::

## Next

- **[Create a project](/docs/studio/projects/create)** — the New Project modal, field by field
- **[Browse your project](/docs/studio/projects/browse)** — the Manage view with live previews
- **[Publish](/docs/studio/publish)** — commit your project and put it live
