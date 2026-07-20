---
title: "AI assistant"
description: "What the Studio AI assistant can do with a project or page open, how to connect an AI provider, and exactly what leaves your machine when you chat."
code:
  - packages/studio/src/panels/chat-panel.ts
  - packages/studio/src/services/ai-system-prompt.ts
  - packages/studio/src/services/ai-settings.ts
  - packages/studio/src/ui/ai-credentials-form.ts
---

# AI assistant

Studio has a built-in AI assistant: a chat sidebar that doesn't just talk about your project but works on it — it creates pages and components, edits the page on the canvas while you watch, and answers questions about what it finds in your files. It runs against an AI provider **you** connect; Studio ships no account, no hosted AI, and sends nothing anywhere until you do.

![The assistant sidebar open beside a page on the canvas, mid-conversation](/screenshots/ai-sidebar.png)

Open it with the **Toggle Assistant** chat-bubble button at the right end of the toolbar. The sidebar is always available — before you open a project, with a project open, and with a page on the canvas — and what the assistant can do grows with each of those states.

## What it can do

**With nothing open** — the assistant bootstraps. Describe a site and it creates a project for you: name, folders, starter pages, and a design quickstart (colors and fonts) derived from your description, then keeps building inside it. The **[New Project](/docs/studio/projects/create)** dialog's **Agent** tab is the same idea as a form: describe the site you want, and the assistant builds it in the editor while you watch.

**With a project open** — the assistant works across files. It can list and read any project file, find files by name, create new pages and components, and rewrite files whole. Anything it writes as a Jx document is validated before it touches disk. It can also open a page on the canvas to continue there.

**With a page on the canvas** — the assistant edits that page live: text, styles, element properties, adding, moving, and removing elements, and the page's state entries. This is the most precise mode, and the one you can watch and undo — see **[Document assistant](/docs/studio/ai/document-assistant)**.

In every state it also answers questions — "what does this page's state do?", "which component renders the header?" — by reading the same files you see.

Each request gets a limited number of working rounds. If a big request runs out, the assistant stops and lists what it finished and what went wrong; send another message to continue.

## Connect a provider

The first time you open the sidebar (and any time no key is stored), the chat is replaced by the **AI provider key** form:

1. Paste an API key. Any OpenAI-compatible key works — OpenAI itself, a compatible hosted provider, or a local model server.
2. Pick a **Model**. Click **Fetch models** to list what your key can use, or type a model ID directly.
3. Optionally set an **Endpoint** — leave it empty for OpenAI, or point it at a compatible server such as a local LLM (for example `http://localhost:11434/v1`).
4. Click **Save**.

To change any of this later, click the gear button (**API key & endpoint**) at the bottom of the sidebar. You can also switch models per conversation with the model picker next to the message box.

:::doc-note
The key, endpoint, and model choice are stored locally on your machine, per browser or app install. If the Studio backend you're running already has a provider key configured (for example a dev server started with an `OPENAI_API_KEY` environment variable), the assistant unlocks without asking for one.
:::

## What leaves your machine

Nothing is sent anywhere until you send a message. When you do, Studio sends your configured provider — and only your configured provider — what the assistant needs to answer:

- your message and the rest of the conversation,
- any context you attached (the current page reference, the selected element),
- the full contents of the page open on the canvas,
- a summary of the open project: its name and settings, component names, and file paths,
- whatever files the assistant reads while working on your request.

Requests travel through Studio's own local proxy straight to the endpoint you configured; your key rides along only on those requests. If you point the endpoint at a model running on your own machine, nothing leaves it at all.

## Learn the two surfaces

- **[The AI sidebar](/docs/studio/ai/chat)** — the chat itself: attaching context, watching edits land, chat history, and reviewing or undoing what the assistant changed.
- **[Document assistant](/docs/studio/ai/document-assistant)** — how the assistant works when a page is open on the canvas, and when to use that instead of project-wide edits.

## Next

- Create a project for the assistant to work in: **[New Project](/docs/studio/projects/create)**
- The state entries it can add for you are explained in the **[State panel](/docs/studio/logic/state)**
