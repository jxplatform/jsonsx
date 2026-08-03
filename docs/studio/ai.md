---
title: "AI assistant"
description: "What the Studio AI assistant can do with a project or page open, how to connect an AI provider, and exactly what leaves your machine when you chat."
code:
  - packages/studio/src/panels/chat-panel.ts
  - packages/studio/src/services/ai-system-prompt.ts
  - packages/studio/src/services/ai-settings.ts
  - packages/studio/src/services/tool-executor.ts
  - packages/studio/src/ui/ai-credentials-form.ts
  - packages/studio/src/ui/ai-managed-connect.ts
  - packages/studio/src/services/ai-models.ts
---

# AI assistant

Studio has a built-in AI assistant: a chat panel that doesn't just talk about your project but works on it — it creates pages and components, edits the page on the canvas while you watch, and answers questions about what it finds in your files. It runs against an AI provider **you** connect; Studio ships no account, no hosted AI, and sends nothing anywhere until you do.

![The assistant open beside a page on the canvas, mid-conversation](../images/ai-sidebar.png)

The assistant is the **fourth tab of the right panel**, beside Content, Style and Logic. Show it with :kbd[Cmd+Shift+4], with the chat-bubble button at the right end of the toolbar, or by clicking the tab. Because it shares the right panel's width, showing it costs the canvas nothing. It's available in every state: before you open a project, with a project open, and with a page on the canvas. What the assistant can do grows with each of those.

## What it can do

**With nothing open** — the assistant bootstraps. Describe a site and it creates a project for you: name, folders, starter pages, and a design quickstart (colors and fonts) derived from your description, then keeps building inside it. It will ask you where to put the project before creating anything — tell it a folder (or, on the cloud, a GitHub account or organization). The **[New Project](/docs/studio/projects/create)** dialog's **Agent** tab is the same idea as a form: describe the site you want, and the assistant builds it in the editor while you watch.

**With a project open** — the assistant works across files. It can list and read any project file, find files by name, create new pages and components, and rewrite files whole. Anything it writes as a Jx document is validated before it touches disk. It can also open a page on the canvas to continue there.

**With a page on the canvas** — the assistant edits that page live: text, styles, element properties, adding, moving, and removing elements, and the page's state entries. This is the most precise mode, and the one you can watch and undo — see **[Document assistant](/docs/studio/ai/document-assistant)**.

In every state it also answers questions — "what does this page's state do?", "which component renders the header?" — by reading the same files you see.

Each request gets five working rounds — five turns of thinking and calling tools before it must reply. If a big request runs out, the assistant stops and lists what it finished and what went wrong; send another message to continue, or split the request into smaller ones.

## Connect a provider

Until AI is connected, the tab shows the chat as usual with one line beneath it — _No AI provider is connected yet_ — and an **Open Preferences…** button. A provider key is something you set once for the whole app, so it lives in **[Preferences](/docs/studio/interface/preferences)** › **Assistant** (:kbd[Cmd+,]) rather than occupying the panel — which is also where you can see it listed and disconnect it later.

### Connect Cloudflare (Jx Cloud)

On Jx Cloud that section leads with **Connect Cloudflare**: Studio brokers **Workers AI** on your own Cloudflare account, so you need no API key and no third-party provider account. Click **Connect Cloudflare**, approve the authorization in the Cloudflare window that opens, and you land back in Studio with the assistant connected. Inference runs on — and bills to — your own Cloudflare account; Jx only brokers the request.

This option appears only where a platform can run that hosted flow. The desktop app and the dev server show the key form alone.

### Bring your own key

Below the Cloudflare option (or on its own, everywhere else) is the **AI provider key** form:

1. Paste an API key. Any OpenAI-compatible key works — OpenAI itself, a compatible hosted provider, or a local model server.
2. Pick a **Model**. Click **Fetch models** to list what your key can use, or type a model ID directly.
3. Optionally set an **Endpoint** — leave it empty for OpenAI, or point it at a compatible server such as a local LLM (for example `http://localhost:11434/v1`).
4. Click **Save**.

To change any of this later, click the gear button (**API key & endpoint**) at the bottom of the sidebar — it reopens the same dialog. You can also switch models per conversation with the model picker next to the message box.

:::doc-note
The key, endpoint, and model choice are stored locally on your machine, per browser or app install. If the Studio backend you're running already holds credentials — a dev server started with an `OPENAI_API_KEY` environment variable, or a Cloudflare account you connected earlier — the assistant unlocks without asking for anything.
:::

Whichever route you take unlocks the AI features everywhere in Studio, including the [New Project](/docs/studio/projects/create) dialog's **Import** and **Agent** tabs.

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
- Working the same project from outside Studio — with a coding agent, or in CI: **[Working with agents](/docs/framework/agents)**
