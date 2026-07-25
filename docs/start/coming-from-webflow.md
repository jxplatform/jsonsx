---
title: "Coming from Webflow or Framer"
description: "A translation guide from Webflow or Framer to Jx — classes, symbols, CMS collections, interactions — for a project that's plain files, not a subscription."
---

# Coming from Webflow or Framer

You already think in boxes, breakpoints, reusable components, and CMS collections — that model carries straight over to Jx. What changes is where your work lives. A Jx project is a folder of plain files on your machine, edited by [Jx Studio](/docs/studio) (a desktop app, or your browser against a local dev server) and published with git to a host you choose. There's no subscription keeping the site alive, no seats to buy, and no export wall between you and your own project.

## The concept map

| Webflow / Framer      | Jx                                | Where to look                                             |
| --------------------- | --------------------------------- | --------------------------------------------------------- |
| Style panel + classes | Style inspector                   | [Style inspector](/docs/studio/design/style-inspector)    |
| Variables             | Design tokens                     | [Design tokens](/docs/studio/design/tokens)               |
| Tag-level styles      | Stylebook                         | [Stylebook](/docs/studio/design/stylebook)                |
| Symbols / components  | Components                        | [Working with components](/docs/studio/design/components) |
| CMS collections       | Content types                     | [Content types](/docs/studio/projects/content-types)      |
| Collection lists      | Repeaters                         | [Repeaters](/docs/studio/design/repeaters)                |
| Interactions          | Events, state, and formulas       | [Logic](/docs/studio/logic)                               |
| Breakpoint bar        | A live canvas per breakpoint      | [Design mode](/docs/studio/design)                        |
| Site plan + publish   | Commit and sync; your host builds | [Publish](/docs/studio/publish)                           |

## Styling, without class anxiety

In Webflow, every style is a class you name, combine, and manage forever. Jx spreads the same work across layers, so most elements never need a class at all:

- The **[Stylebook](/docs/studio/design/stylebook)** sets what _every_ heading, button, link, and form control looks like — your baseline, in one catalog.
- **Component styles** cover "this card looks like this wherever it's used."
- **Per-element styles** from the [Style inspector](/docs/studio/design/style-inspector) are reserved for true one-offs.
- **[Design tokens](/docs/studio/design/tokens)** sit underneath all three — named colors, fonts, and sizes that every picker offers, like Webflow's Variables.

The Style inspector itself gives you the CSS control you're used to — spacing, typography, layout, backgrounds — plus `:hover`, `:focus`, and selectors of your own via **[States and selectors](/docs/studio/design/states-and-selectors)**.

## A canvas per breakpoint

Instead of one canvas you flip between breakpoints, Design mode renders a live panel for **every** breakpoint side by side, each running your real responsive rules. A tablet-only change shows up in the tablet panel while the others hold still — no more toggling back and forth to check you didn't break desktop. See **[Design mode](/docs/studio/design)** and **[Breakpoints](/docs/studio/design/breakpoints)**.

![Jx Studio's Design mode rendering one component across four responsive breakpoints with the style inspector open](../images/mode-design.png)

## Symbols and components

Webflow symbols and Framer components map to Jx **[components](/docs/studio/design/components)**: select something you've built, turn it into a component, and every copy stays in sync with the definition. Per-instance variation comes through **props** — the equivalent of component properties — and **slots** let a component leave room for different content in each use. Build your first one in **[Your first component](/docs/start/first-component)**.

## CMS collections

Collections translate directly. A **[content type](/docs/studio/projects/content-types)** names a collection, defines its fields — text, numbers, images, dates, and references between types — and gives every entry a schema-backed form. **[Repeaters](/docs/studio/design/repeaters)** are your collection lists: bind one element to a collection and it repeats per entry. Dynamic detail pages — one page per entry — are part of the site model too; **[Your first collection](/docs/start/first-collection)** builds the whole loop.

Two differences worth knowing. Entries are files (Markdown, CSV, or JSON) in a folder, not rows in a hosted database — which means you can edit a whole collection like a spreadsheet in [Grid mode](/docs/studio/editing/grid), and there are no plan-based item limits because there are no plans. And there's no hosted Editor for clients: content editing happens in Studio, and collaborators work through the shared repository.

Collections cover the content you author. Data that arrives while the site is running — form submissions, sign-ups, orders — belongs somewhere else: a real database you connect deliberately through **[Databases](/docs/studio/data)**, with **[accounts and sessions](/docs/studio/data/auth-and-secrets)** for the visitors who sign in. Content being files doesn't rule any of that out; it just keeps the two kinds of data apart.

## Interactions, honestly

Behavior in Jx comes from three surfaces working together: **[State](/docs/studio/logic/state)** declares what a page knows, the **[Events](/docs/studio/logic/events)** tab binds behavior to clicks, typing, and submits, and **[formulas](/docs/studio/logic/formulas)** compute values live. Toggles, tabs, filtered lists, form behavior — the logic side of interactions — is covered, often more directly than a timeline can express it.

What Jx doesn't have is Webflow's scroll-driven animation timeline. Hover and focus effects with CSS transitions come through [States and selectors](/docs/studio/design/states-and-selectors), but choreographed scroll animation isn't a built-in surface today.

## Publishing and the missing lock-in

When you publish, Studio commits your files and pushes them to your repository; your host builds the site and serves the prebuilt pages from a CDN — **[Cloudflare Pages](/docs/studio/publish/cloudflare)** has a built-in flow, and **[Netlify, GitHub Pages, and others](/docs/studio/publish/other-hosts)** take a two-line setup. Hosting costs whatever your host charges, which for sites this shape is often nothing. Collaborators clone the repository — there are no seats.

In Webflow, code export is a snapshot that leaves the CMS behind. In Jx there's nothing to export, because the project already _is_ files: readable documents for pages and components, Markdown for content. Open them in any editor, diff them in git, hand them to other tools — Studio is how you edit your project, not where it's kept. The format underneath is fully documented in **[Framework](/docs/framework)**.

## Start here

- **[Your first project](/docs/start/first-project)** — starter template to published site
- **[Your first component](/docs/start/first-component)** — the symbol workflow, in Jx
- **[Your first collection](/docs/start/first-collection)** — the CMS workflow, in Jx
