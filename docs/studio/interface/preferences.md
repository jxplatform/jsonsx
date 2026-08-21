---
title: "Preferences"
description: "Application settings in Jx Studio — the theme, the AI provider, every account Studio holds, and a rebindable keyboard sheet generated from the app itself."
spec: studio.md#15
code:
  - packages/studio/src/settings/preferences-dialog.ts
  - packages/studio/src/settings/preferences-accounts.ts
  - packages/studio/src/settings/preferences-keymap.ts
---

# Preferences

Preferences holds the settings that belong to **Studio**, not to a project: how the editor looks, which AI provider it talks to, which accounts it has signed you into, and what every keyboard shortcut does. Open it with :kbd[Cmd+,] on macOS or :kbd[Ctrl+,] elsewhere, or find **Preferences…** in the command palette.

:::doc-note
**Preferences is not Project Settings.** Preferences is a dialog, it follows you between projects, and it works with no project open at all. Project Settings — contexts, definitions, packages, deploy — belongs to one project, and it is a **document**: the project's own `project.json`, open in a pane with undo and :kbd[Cmd+S] like any other file. See **[Project settings](/docs/studio/projects/settings)**.
:::

Preferences opens over the workspace rather than replacing it, and :kbd[Escape] closes it. Nothing you do behind it is suspended.

## Appearance

Choose the **Light** or **Dark** chrome theme. The choice applies immediately — the whole window, including any open [code editor](/docs/studio/logic/code) and anything showing over it — and is remembered for the next session.

This is the editor's own theme. It has no effect on the site you're building, whose colors come from your project's styles, and the canvas stays a light document page in either theme so that what you see is what you ship. To preview your own site in a dark colour scheme, use the light/dark control on the canvas instead — see **[Contexts](/docs/studio/projects/settings)**.

## Assistant

Connect the AI provider the [assistant](/docs/studio/ai) talks to: a key from any OpenAI-compatible service, the model to use, and an optional endpoint if you're running a local or self-hosted model. On platforms that broker it, a keyless **Connect Cloudflare** option sits above the key form.

Everything you enter is stored locally, on this machine, and sent only to the endpoint you chose. Saving leaves Preferences open, so you can check the result in **Accounts** without reopening anything.

## Accounts

Every credential Studio is holding, in one list — **GitHub**, the **AI provider**, and **Cloudflare**. All three are always listed: a connected one says what is stored (the model and endpoint your key is used with, the Cloudflare account it is tied to), a disconnected one says what connecting would buy you and when Studio will ask for it.

A connected GitHub account also says **where** the credential is kept, because that differs by build: the desktop app holds it in a file in its own configuration folder that only your user account can read; a browser keeps it in that browser's storage. A connected account offers **Disconnect**, which forgets it on this machine immediately and takes its row back to the disconnected wording. Nothing else is touched — disconnecting the AI provider leaves GitHub signed in — and anything that was waiting on that credential notices at once, so the assistant's setup notice appears or disappears without you reopening anything.

The list never shows the credential itself, only that one is stored.

## Keyboard

Every keyboard shortcut Studio has, grouped by where the key is live: **Anywhere**, **Canvas selection**, **Text caret**, **Data grid**, **Code editor**, **Focused dock**, **Palette**. The sheet is **generated from the app's own command registry**, so it cannot be out of date: a shortcut cannot exist without appearing here, a command with no shortcut is not listed because there is nothing to press, and a command an extension adds shows up without anyone maintaining a list.

The same projection produces the published **[Keyboard shortcuts](/docs/studio/interface/shortcuts)** page. That page is what Studio ships with; the sheet in front of you is what your keyboard actually does.

### Finding one

Two searches, because there are two questions:

- **By name.** Type in the field. It matches the command's name, its id, and the printed keys.
- **By keystroke.** Press **Search by keystroke**, then press the keys. The sheet narrows to whatever holds exactly that chord, and says so plainly when nothing does — _Nothing is bound to ⌘J._ This is the question a list can't answer by being read, because a shortcut's printed form is not what you would type looking for it.

While the sheet is listening for a keystroke, the keys you press do **not** run their commands — you can press :kbd[Cmd+S] to find out what it does without saving anything. :kbd[Escape] stops it listening; it doesn't close Preferences.

### Changing one

**Change** on any row starts listening — the row reads _Press a shortcut…_ — and the next keys you press become that command's shortcut. **Cancel** stops without changing anything.

Studio refuses three bindings, tells you which one you hit, and leaves the shortcut alone:

- **That is not a shortcut.** Modifiers on their own are not a chord: hold a key as well.
- **It would fire while you type.** A plain letter, digit or punctuation key needs :kbd[⌘], :kbd[Ctrl] or :kbd[Alt] with it, because Studio listens for shortcuts across the whole window. Keys that type nothing may be bound bare — :kbd[Escape], :kbd[Enter], :kbd[Tab], :kbd[Backspace], :kbd[Delete], the arrows, :kbd[Home], :kbd[End], the page keys, and :kbd[F1]–:kbd[F24].
- **Something already has it.** The refusal names the holder — _⌘D is already Duplicate._ — and offers **Show Duplicate**, which filters the sheet to that row so you can move it out of the way first. Only the same group conflicts: the same keys can mean one thing in the canvas and another in the data grid, and each group is checked on its own.

A row you have changed is marked **— changed** and grows a **Reset**, which gives the command the shortcut Studio ships with. Choosing that shipped shortcut yourself is the same as resetting: Studio records that you never changed it, so if the default moves in a later release your keyboard moves with it.

A command that ships with two shortcuts has a row each; changing either leaves it with just the one you chose, and **Reset** brings both back.

Your changes take effect immediately, are kept on this machine, and survive a reload. They are yours rather than the project's — nothing is written into your repository, so a teammate opening the same project keeps their own keyboard.

## Related

- **[The workspace](/docs/studio/interface)** — every region of the Studio window
- **[AI assistant](/docs/studio/ai)** — what the assistant can do once a provider is connected
- **[Keyboard shortcuts](/docs/studio/interface/shortcuts)** — the same sheet, published: what Studio ships with
