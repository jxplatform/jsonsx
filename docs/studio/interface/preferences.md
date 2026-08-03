---
title: "Preferences"
description: "Application settings in Jx Studio — the theme, the AI provider, every account Studio holds, and a keyboard sheet generated from the app itself."
spec: studio.md#15
code:
  - packages/studio/src/settings/preferences-dialog.ts
  - packages/studio/src/settings/preferences-accounts.ts
---

# Preferences

Preferences holds the settings that belong to **Studio**, not to a project: how the editor looks, which AI provider it talks to, which accounts it has signed you into, and what every keyboard shortcut does. Open it with :kbd[Cmd+,] on macOS or :kbd[Ctrl+,] elsewhere, or find **Preferences…** in the command palette.

:::doc-note
**Preferences is not Project Settings.** Preferences follows you between projects and works with no project open at all. Project Settings — breakpoints, definitions, packages, deploy — belongs to one project and lives in that project's `project.json`. See **[Project settings](/docs/studio/projects/settings)**.
:::

Preferences opens over the workspace rather than replacing it, and :kbd[Escape] closes it. Nothing you do behind it is suspended.

## Appearance

Choose the **Light** or **Dark** chrome theme. The choice applies immediately and is remembered for the next session. This is the editor's own theme — it has no effect on the site you're building, whose colors come from your project's styles.

## Assistant

Connect the AI provider the [assistant](/docs/studio/ai) talks to: a key from any OpenAI-compatible service, the model to use, and an optional endpoint if you're running a local or self-hosted model. On platforms that broker it, a keyless **Connect Cloudflare** option sits above the key form.

Everything you enter is stored locally, on this machine, and sent only to the endpoint you chose. Saving leaves Preferences open, so you can check the result in **Accounts** without reopening anything.

## Accounts

Every credential Studio is holding, in one list — **GitHub**, the **AI provider**, and **Cloudflare** — each with what it's for and whether it's connected. A connected account offers **Disconnect**, which forgets it on this machine immediately.

The list never shows the credential itself, only that one is stored. Disconnecting one account never affects the others.

## Keyboard

Every keyboard shortcut Studio has, grouped by where the key is live — anywhere, in the canvas, in a text caret, and so on. This sheet is **generated from the app's own command registry**, which means it is never out of date: a shortcut cannot exist without appearing here, and a command with no shortcut is not listed, because there is nothing to press.

The same list is published as **[Keyboard shortcuts](/docs/studio/interface/shortcuts)**, from the same source, so the page and the app always agree.

## Related

- **[The workspace](/docs/studio/interface)** — every region of the Studio window
- **[AI assistant](/docs/studio/ai)** — what the assistant can do once a provider is connected
- **[Keyboard shortcuts](/docs/studio/interface/shortcuts)** — the published copy of the Keyboard sheet
