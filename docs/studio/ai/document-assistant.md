---
title: "Document assistant"
description: "How the assistant edits the page open on the canvas — live, validated changes in one undo step per request — and when to work project-wide instead."
code:
  - packages/studio/src/panels/ai-panel.ts
  - packages/studio/src/services/document-assistant.ts
  - packages/studio/src/services/ai-tools.ts
---

# Document assistant

The document assistant is what the **[AI sidebar](/docs/studio/ai/chat)** becomes when a page or component is open on the canvas: the same chat, now scoped to that document. It isn't a separate panel — opening a document simply hands the assistant that page's full structure and a set of precise editing abilities it doesn't have otherwise. This is the mode to use when you want to _see_ the assistant work and be able to take it back.

The sidebar starts closed and stays however you last left it, so open it with **Toggle Assistant** first; provider setup lives in its **Assistant: Settings…** dialog rather than in the column itself.

![The sidebar with an assistant reply carrying edit chips beside the open page on the canvas](../../images/ai-document-assistant.png)

## What it can do on the open page

With a document active, the assistant edits the page the way you would, one change at a time:

- rewrite any text,
- restyle elements property by property — the same styles you'd set in the **[style inspector](/docs/studio/design/style-inspector)**,
- change element properties: tags, classes, attributes, component options,
- add new elements, move them, and remove them,
- add or update the page's state entries — the same ones the **[State panel](/docs/studio/logic/state)** shows.

Every change lands on the canvas the moment it's made, so the page updates in front of you while the reply streams. To aim the assistant at one specific element, select it on the canvas and attach it with the composer's paperclip menu — see **[Attach context](/docs/studio/ai/chat#attach-context)**.

## Every edit is checked

After each change, Studio validates the document and test-renders it out of sight. If an edit introduced a problem — an invalid property, something that breaks rendering — the assistant is told exactly what went wrong and fixes it with follow-up edits in the same request. The page may pass through an imperfect intermediate state while it iterates; that's the self-correction loop working, not the final result.

The rules it's checked against are your project's own — the same generated schemas the **[code editor](/docs/studio/logic/code)** underlines against, so sections contributed by the extensions you've enabled are enforced too. Writes to `project.json` go through the same gate before they reach disk, and a change to your enabled extensions updates the rules for both surfaces immediately.

If the assistant runs out of working rounds before everything is fixed, it stops and lists what was applied and which problems remain, so nothing fails silently.

## Undo and save

Document edits follow Studio's normal editing rules:

- They go into the page's undo history as **one step per request** — :kbd[⌘Z] (macOS) or :kbd[Ctrl+Z] (Windows/Linux) rolls back the assistant's whole last reply on that page. If a request switched between pages, each page gets its own single step.
- They live in the open editor, not on disk: the tab is marked unsaved until you save it, and closing without saving discards them.

The full review workflow — including the file-level changes that _don't_ work this way — is covered in **[Review and undo edits](/docs/studio/ai/chat#review-and-undo-edits)**.

## Page open or not — which to choose

Where the assistant works depends only on what's on the canvas, so you steer it by what you open:

- **Open the page first** when you care about watching and undoing. With the page on the canvas, requests like "tighten the hero spacing" become live, validated, undoable canvas edits to that page.
- **Leave the canvas empty (or ignore it)** for project-wide work. Without a document scope the assistant creates and rewrites files directly — faster for "scaffold an about page and a contact page", but those writes go straight to disk and aren't undoable from Studio.
- **Let it switch itself.** The assistant can open a page on the canvas as part of a request; from then on its document edits target that page. It does this when you ask to see a page, or when fine-grained editing suits the task better than rewriting the file.

A simple habit: if you'd want to press undo afterwards, open the page before you ask.

## Next

- The chat itself — composer, history, reviewing edits: **[The AI sidebar](/docs/studio/ai/chat)**
- What the assistant can do in every state, and provider setup: **[AI assistant](/docs/studio/ai)**
- The state entries it adds are explained in the **[State panel](/docs/studio/logic/state)**
