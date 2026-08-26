---
title: "Languages"
description: "Work in more than one language in Studio: a translation-parity grid, a per-pane rendering language, side-by-side translations, and the Locales setting."
spec:
  - studio.md#20
code:
  - packages/studio/src/panels/i18n-panel.ts
  - packages/studio/src/i18n/i18n-commands.ts
  - packages/studio/src/settings/locales-section.ts
  - packages/studio/src/site-context.ts
---

# Languages

A [multilingual Jx site](/docs/framework/site/i18n) keeps each language in its own directory (`pages/fr-ca/about.json` beside `pages/about.json`), and that is the whole mapping. There is no message catalogue and no `t()`: a translation is a **different file**, so Studio's job is to show you which files exist, which do not, and which have fallen behind.

Every surface here appears only once `project.json` declares more than one locale.

## Declare the languages first

**Project Settings › Locales** is where the list lives. Add a tag, pick which one is the default, and choose how locales appear in URLs:

| Routing                             | `/about` is | `/fr-ca/about` is |
| ----------------------------------- | ----------- | ----------------- |
| Prefix every locale but the default | English     | French            |
| Prefix every locale                 | nothing     | French            |

Tags are [BCP 47](https://www.rfc-editor.org/info/bcp47) and validated as you type, by the same parser the build uses, so a tag Studio accepts is a tag that builds. `en_US` is refused with a sentence rather than written and discovered later.

:::doc-tip
:kbd[⌘K] → **Add Language** does the same write. It is the one language command available in a project that has none yet. That is exactly where you need it.
:::

## Languages panel: what exists, what doesn't

:kbd[⌘K] → **Show Translation Parity** opens **Languages** in the Navigator. It is a grid: one row per page, one column per language, and one of three answers in every cell.

| Cell        | Means                                                       | Clicking it              |
| ----------- | ----------------------------------------------------------- | ------------------------ |
| **present** | the file is there                                           | opens it                 |
| **stale**   | it is there, and older than the page it was translated from | opens it                 |
| **missing** | it is not there, and this is where it would go              | creates it, and opens it |

A page whose URL is translated still counts as one page: the panel reads the same `$translationKey` the build does, so `pages/fr-ca/a-propos.json` sits in the French column of `pages/about.json`'s row rather than starting a row of its own.

This is the one thing the rest of the toolchain cannot tell you. A build is perfectly happy to ship a French page that went wrong six months ago, and the `hreflang` links will dutifully advertise it. The Files panel draws `fr-ca/` the way it draws any folder, and a page nobody has translated is invisible precisely because the file that would prove it doesn't exist.

:::doc-note
**Stale** means the default language's file is newer than the translation. A file your platform reports no timestamp for is shown as present, never stale, because an absent timestamp isn't evidence of being behind.
:::

The panel has no rail button on purpose: a language grid shouldn't cost a rail slot in every monolingual project, or push every document panel's :kbd[⌘1]–:kbd[⌘8] chord along by one.

## Side by side

Split a pane and choose **Same page in ⟨language⟩** from the derive menu, the same menu that gives you Code, Layout and the component definition. The second pane follows the first: move the source pane to another page and the companion moves with it, to that page's translation.

Because a translation is a different file, the companion **opens** it rather than re-rendering the one you have. If it doesn't exist yet the pane says so and names the fix, instead of going blank under a chip claiming a language.

## Rendering language

The pane context bar's **Language** segment (:kbd[⌘K] → **Set Rendering Language**) is a different thing, and worth keeping straight:

| Control                 | Changes                                    |
| ----------------------- | ------------------------------------------ |
| **Same page in** (pane) | which **file** the pane is showing         |
| **Language** (context)  | the `lang` and `dir` the artboard draws in |

The second is how you check that a right-to-left language actually mirrors. It sets the language the canvas renders **as**. The text is whatever file is open, and the control says so. It's the same axis as breakpoint and colour scheme: a preview state, stored with the tab.

The bar only names a language when it differs from the document's own, so a French page open in a French pane reads as it always did.

## Finding files by language

The [Library](/docs/studio/projects/browse) has a **Language** facet and column, and the Files tree tags each row with the language of the directory it sits under, in that language's own name (_français_ rather than _French_).

## Commands

| Command                     | Does                                                         |
| --------------------------- | ------------------------------------------------------------ |
| **Add Language**            | appends a tag to `i18n.locales`                              |
| **Show Translation Parity** | opens the Languages panel                                    |
| **Open Translation**        | opens this page's file in another language                   |
| **Create Translation**      | creates the missing file, seeded from this one, and opens it |
| **Set Rendering Language**  | sets the language the pane's artboard renders as             |

## Related

- [Locales and languages](/docs/framework/site/i18n): what the framework does with all this at build time
- [Browse the library](/docs/studio/projects/browse): the Language facet
- [Project settings](/docs/studio/projects/settings): the rest of `project.json`
