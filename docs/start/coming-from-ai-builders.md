---
title: "Coming from Lovable or Builder.io"
description: "How Jx compares to AI site builders — the assistant edits inspectable documents you can see in Layers and State, review in git, and edit by hand."
---

# Coming from Lovable or Builder.io

AI builders have settled the question of whether a machine can build a page. The question that matters a month in is different: can you still understand and change what it built? That's the question Jx is shaped around. Studio's [AI assistant](/docs/studio/ai) doesn't generate a codebase beside your project — it edits the project itself, in a document format designed to be read three ways at once: by you, by the visual editor, and by the AI.

## What the assistant edits

A Jx page or component is a structured document — readable JSON describing its elements, styles, and state, in a format that's [fully documented](/docs/framework). Studio's assistant works on those documents, the same files you edit on the canvas. Ask it for a pricing section and the result isn't a wall of generated code: the structure appears in **Layers**, the values and behavior in **State**, and the styles in the Style inspector — the same panels, showing the same file, whether you built it or the assistant did.

| In an AI builder                    | In Jx                                                  |
| ----------------------------------- | ------------------------------------------------------ |
| Prompt-to-code generation           | An assistant editing your project's documents          |
| Generated source you may never read | Documents every Studio panel can show you              |
| Regenerate and hope                 | Edit by hand, visually, or by prompt — interchangeably |
| Export or eject                     | Nothing to export — the files are already yours        |

## Editable in both directions

This is the practical difference. With generated code, the AI is usually the only practical way back in — visual editing on top of a generated codebase is shallow, so changes mean re-prompting. In Jx, the visual editor and the assistant share one format, so you alternate freely: prompt a section into existence, then drag and restyle it by hand; build a component yourself, then ask the assistant to rework it. Click anything the assistant made and the **Properties**, **Style**, and **Events** tabs show exactly what it is — there's no layer you can't open.

## Every change is a diff

Because the assistant changes files, its work shows up in **[Source Control](/docs/studio/publish/source-control)** like your own edits: a list of changed files, each with a readable diff. Review what it did, commit what you like, discard what you don't, and roll back any commit later. AI output rides the same rails as your own work — it doesn't get a separate, unaccountable channel into your project.

## Ownership

A Jx project is plain files on your machine, versioned in your repository, published to a host you choose — [no hosted service holding it, no account your work lives behind](/docs/studio/publish). (Your _site_ can have a database and signed-in users of its own; those run on infrastructure you control too.) The assistant is optional: everything it does, you can do by hand in Studio, and the format it writes is documented in the open. If you stopped using the assistant — or Jx entirely — your project would still be a folder of readable files.

## Where Jx is different

Two differences are worth stating plainly, and neither is the one people expect. Jx builds full applications, not just brochure sites: [database connections](/docs/studio/data/connections), [user accounts and sessions](/docs/studio/data/auth-and-secrets), and [server-side logic](/docs/framework/concepts/timing) all ship, and your secrets stay on the server. The honest boundary is a rendering one — Jx has no per-request page rendering. Every page is prerendered at build time and interactivity hydrates as islands, so the set of routes is fixed when you build. That fits apps whose pages are known ahead of time; it does not fit one that assembles a different page structure for every visitor on every request.

The other difference is shape. Where Builder.io is a hosted platform your app plugs into, Jx is the opposite: a local tool that holds none of your work on anyone's servers.

## Start here

- **[The AI assistant](/docs/studio/ai)** — what it can do and how to work with it
- **[Your first project](/docs/start/first-project)** — see the editor the assistant shares with you
- **[Framework](/docs/framework)** — the document format underneath it all
