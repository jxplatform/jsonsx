---
title: "The AI sidebar"
description: "The persistent chat sidebar — open it, attach context, watch the assistant's edits land, manage chat history, and review or undo its changes."
code:
  - packages/studio/src/panels/ai-chat/composer.ts
  - packages/studio/src/panels/ai-chat/chat-view.ts
  - packages/studio/src/panels/ai-chat/sessions-view.ts
  - packages/studio/src/services/ai-session-store.ts
---

# The AI sidebar

The AI sidebar is the assistant's home: a chat column on the right edge of the workspace that stays put while you work. It survives tab switches — your draft message, scroll position, and conversation are all still there when you come back — and it works in every state of Studio, from the welcome screen to a page mid-edit.

<!-- TODO(screenshot): ai-sidebar-chat — the sidebar with a conversation: a user message with context chips, an assistant reply with tool chips, and the composer below -->

## Open it

Click the **Toggle Assistant** chat-bubble button at the right end of the toolbar. Click it again to collapse the sidebar; drag its inner edge to resize it. Both the width and the open/closed state are remembered across sessions.

If no AI provider is set up yet, the sidebar shows the key form instead of a chat — see **[Connect a provider](/docs/studio/ai#connect-a-provider)**.

## Send a message

Type in the message box at the bottom and press :kbd[Enter] to send — :kbd[Shift+Enter] inserts a newline. The box grows as you type, and the send button enables once there's something to send.

The row under the message box holds the composer's controls:

- **Attach context** (paperclip) — pin the current page or the selected element to your message (below).
- The **model picker** — switch models mid-conversation; the list comes from your provider.
- **API key & endpoint** (gear) — reopen the provider form.
- **Send** — becomes **Stop** while the assistant is replying; click it to halt the reply and any further actions.

## Attach context

The paperclip menu offers two attachments, each shown as a removable chip above the message box:

- **Current page** — the file open in the active tab.
- **Selected element** — the element currently selected on the canvas, identified by its tag and a snippet of its text.

Attaching the selected element is the precise way to say "this one": "make _this_ heading smaller" works reliably when the heading rides along as a chip. One chip of each kind is kept, chips clear after sending, and sent messages display their chips so you can see later what a request pointed at.

Even without attachments the assistant already knows a lot: each message carries the open page's full contents and a summary of the project — its name, settings, component names, and file paths. Attachments are for pointing, not for granting access.

## Watch it work

The assistant's reply streams in live. When it acts on your project, each action appears as a small labeled chip in the reply — one per edit or file operation — so the reply doubles as a log of what was done. Actions that fail show a warning row explaining why; successful ones stay quietly in their chips.

Document edits land on the canvas as they happen, so for canvas work you can literally watch the page change. If something goes wrong mid-request — a lost connection, a provider error — the sidebar shows the error with advice on how to recover.

## Review and undo edits

What the assistant may change, and how you take it back, follows two rules:

**Edits to a page open on the canvas** are applied to the open editor, not to disk. The page's tab is marked unsaved, exactly as if you had made the edits yourself — review them on the canvas, then save the tab to keep them or close without saving to discard. They also enter the page's normal undo history as **one undo step per request**: press :kbd[⌘Z] (macOS) or :kbd[Ctrl+Z] (Windows/Linux) once to roll back everything the assistant did to that page in its last reply. If one request edited several pages, each page carries its own single step.

**File-level changes** — new pages, new components, whole-file rewrites — are saved straight to disk and are **not undoable** from Studio's history. Two guards keep this safe: Jx documents are validated (and test-rendered) before writing, and the assistant refuses to overwrite a file you have open with unsaved changes. When it writes a file you _do_ have open (with no unsaved edits), the tab refreshes to show the new contents.

:::doc-tip
For disk-level changes, source control is the review tool: the **[Source Control](/docs/studio/publish/source-control)** panel shows every file the assistant touched as a pending change you can diff or discard before committing.
:::

## Chats and history

The header names the current chat and holds two buttons: the history button (left) opens the **Chats** list, and **+** starts a new chat.

- Chats are titled after your first message and listed newest-first with a timestamp and message count.
- Click a chat to reopen it; the conversation continues where it left off.
- Hover a row and click the trash button to delete a chat. Deleting the open one leaves you in a fresh empty chat.
- When you reopen Studio, your last open chat is restored.

History is stored on your machine and kept per project, so conversations never mix between projects. Each project keeps its 20 most recent chats, and each chat keeps its latest 50 messages.

## Next

- How the assistant edits the open page: **[Document assistant](/docs/studio/ai/document-assistant)**
- What each message shares with your provider: **[AI assistant](/docs/studio/ai#what-leaves-your-machine)**
- Where saved and unsaved files live: **[Tabs and files](/docs/studio/interface/tabs)**
