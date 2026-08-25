# Humanizing the documentation

The corpus was drafted with heavy AI assistance and reads like it. This file is the plan, the protocol each page goes through, and the live status board. The published rules live in the style guide, [docs/extending/contributing/docs.md](./docs/extending/contributing/docs.md); this file is the campaign around them and is deleted when it is finished.

## What is actually wrong

The vocabulary is already clean. Across 163,533 words there is not one hit for delve, seamless, comprehensive, crucial, pivotal, "at its core", "it's worth noting" or "let's dive in", because the style guide banned marketing language years ago and it worked. There are no decorative horizontal rules, no "Conclusion" or "Key takeaways" headings, and the nineteen emoji are all functional UI glyphs the docs are naming on screen.

What the corpus has instead is punctuation and cadence:

| Signature                                  | Count                                   |
| ------------------------------------------ | --------------------------------------- |
| Em dashes in hand-authored prose           | 2,846, about one every forty-four words |
| ...on a line carrying two or more          | 954                                     |
| ...opening the line's final clause         | 791 lines                               |
| `rather than`, plus `X, not Y.` enders     | 212 and 94                              |
| Headings restated by their first paragraph | 130 of 1,210                            |
| Sentences over thirty words                | 845 of 5,807                            |
| Title Case headings                        | about 26, nearly all in `framework/`    |

And two failure modes, not one. `start/` and `studio/` are over-cadenced: confident, aphoristic, and rhythmically identical page after page. `framework/concepts/` is under-written, because it is a transcription of `specs/spec.md` with the spec's headings title-cased on the way in.

## The rules

In the style guide, under [Voice and style](./docs/extending/contributing/docs.md). Read that first. The short version: no em dashes, bold only labels a reader can search for, sentences under thirty words, never invent a fact, and read it aloud before you keep it.

## Per-page protocol

Read once per session: the style guide, and the reference pages listed under Status below.

For each page:

1. Read the whole page before changing anything.
2. Read the sections its `spec:` frontmatter names, and the header comments of its `code:` paths.
   Those are the only places new prose may come from.
3. Rewrite. Keep verbatim: fenced code byte for byte, the token inside any code span, `:kbd[…]`,
   the `:::doc-*` directive lines, image paths, `title`/`spec:`/`code:` frontmatter, the canonical UI names, and the protected heading slugs below. Alt text may change only to drop a dash or a banned word, because you cannot see the image.
4. `description` frontmatter is prose and should be rewritten too, but it is capped at 155
   characters and `docs:check` enforces it.
5. Answer both questions in the pull request body, per page. To "what still sounds AI-generated?", "nothing" is never a true answer. To "did the rewrite add or remove any fact, name, number, date, quote, citation or claim?", paste the fact delta and adjudicate every line of it.

Commands, in this order, because `oxfmt` realigns tables and moves the offsets everything else reports on:

```sh
./node_modules/.bin/oxfmt docs/<path>.md
bun scripts/docs/unwrap-prose.ts docs/<path>.md
bun run docs:check
bun run docs:links
bun scripts/docs/check-prose.ts docs/<path>.md
```

The gate holds new prose to zero em dashes and holds each existing page to the count it already had, so a rewrite that removes some must lower that page's entry in `scripts/docs/prose.json`. `bun scripts/docs/check-prose.ts --ratchet` prints the corrected map. Delete a page's entry when it reaches zero.

Then, per pull request, after committing, because `docs:verify` regenerates and diffs and so needs a clean tree:

```sh
bun run docs:verify
bun run docs:links && bun run docs:prose
bun run docs:claims && bun run docs:markdown && bun run docs:standards && bun run docs:spec-release
git diff --name-only origin/main... | bun scripts/ci/affected.ts --stdin   # expect an empty matrix
git diff --word-diff=color origin/main... -- docs/
```

## Headings you may re-case but must not reword

An anchor is minted from a heading's rendered text, lowercased, so `## How It Works` and `## How it works` publish the same anchor. Rewording one of these breaks every link listed beside it. `bun scripts/docs/check-doc-links.ts --anchors` regenerates this list, and `bun run docs:links` fails if you get it wrong.

- `extending/reference/studio-routes#failures` (1 inbound) from docs/extending/embedding/backend-protocol.md:67
- `framework/concepts/expressions#choosing-an-elements-tag` (2 inbound) from docs/studio/design/layers.md:24, docs/studio/design/properties.md:23
- `framework/concepts/styling#named-media-breakpoints` (1 inbound) from docs/framework/concepts/color-schemes.md:15
- `framework/site/i18n#content-in-one-directory-per-locale` (2 inbound) from docs/framework/site/feeds.md:69, docs/framework/site/search.md:74
- `studio/ai#connect-a-provider` (1 inbound) from docs/studio/ai/chat.md:21
- `studio/ai#what-leaves-your-machine` (1 inbound) from docs/studio/ai/chat.md:93
- `studio/ai/chat#attach-context` (1 inbound) from docs/studio/ai/document-assistant.md:30
- `studio/ai/chat#review-and-undo-edits` (1 inbound) from docs/studio/ai/document-assistant.md:47
- `studio/design/layers#select-several-at-once` (6 inbound) from docs/start/coming-from-webflow.md:54, docs/studio/interface/canvas.md:42, docs/studio/interface/canvas.md:67, docs/studio/interface/canvas.md:87, docs/studio/editing/writing.md:36, docs/studio/design/elements.md:37
- `studio/design/properties#layout-elements` (1 inbound) from docs/studio/interface/canvas.md:40
- `studio/interface#bottom-dock` (2 inbound) from docs/studio/logic/formula-workspace.md:12, docs/studio/logic/code.md:28
- `studio/interface#status-bar` (1 inbound) from docs/studio/interface/tabs.md:128
- `studio/interface#the-jump-bar` (4 inbound) from docs/start/studio-tour.md:37, docs/studio/interface/tabs.md:21, docs/studio/interface/tabs.md:122, docs/studio/interface/problems-and-progress.md:129
- `studio/interface/canvas#the-block-action-bar` (1 inbound) from docs/studio/design/layers.md:60
- `studio/interface/preferences#appearance` (1 inbound) from docs/studio/logic/code.md:22
- `studio/interface/tabs#the-pane-context-bar` (1 inbound) from docs/studio/interface.md:148
- `studio/interface/tabs#two-panes` (2 inbound) from docs/studio/interface/modes.md:43, docs/studio/publish/source-control.md:23
- `studio/interface/welcome-screen#repository-access` (1 inbound) from docs/studio/publish/github.md:56
- `studio/logic/code#code-mode-the-whole-file-as-source` (1 inbound) from docs/studio/interface/modes.md:49
- `studio/projects/content-types#drafts` (1 inbound) from docs/studio/projects/browse.md:32
- `studio/projects/pages-layouts-components#before-you-delete-or-rename` (1 inbound) from docs/studio/projects/browse.md:63

## Out of scope

- **`specs/**`.** `check-spec-release.ts` compares a spec's normalised body line by line, so
  touching one demands a version bump. Seventeen releases for prose is not a trade worth making, and the em dash is a parsed delimiter in the changelog grammar and the standards tables.
- **The nine `generated: true` pages.** Their prose lives in string literals in
  `scripts/docs/generators/*.ts`, and `spec-changelog.md`'s comes from historical spec changelogs. Fixing generator prose is a separate, optional change that must run `docs:generate` in the same commit.
- **`sites/jxsuite.com/pages/privacy.md`.** Legal text. Rewording it for cadence is a legal change.
- **The `props.icon` emoji on the marketing cards.** A design-system element with a visual
  consequence, not prose decoration.
- **Page renames.** A shot's `docs:` field in the screenshot manifest names page slugs, so a rename
  reds `docs:check`.

## Findings to route, not fix

A rewrite must never guess at a fact. Anything below gets recorded here and decided by a person.

- **Stale Studio surface names, about eighty occurrences.** `Script & logic` is link text thirteen
  times for a page the app and the nav both call **Logic**, and the string appears nowhere in `packages/studio/src`. Also `Manage` and `Browse your project` for **The Library**, `Stylebook` for **Project Styles**, and `right panel` for the **Inspector**. The same screenshot carries two different alt texts, one calling The Library a "Manage Files modal".
- **17 pages whose frontmatter `title` disagrees with their `nav.json` label**, and one whose H1
  disagrees with its own title (`start/install.md`: "Install Jx Studio" against "Get Studio").
- **44 code fences with no language tag**, across 17 files.
- **Two dangling paths in `CLAUDE.md`**: `STANDARDS-ADOPTION.md`, which agents are told to read
  before picking up any `gap:` id, and `packages/studio/UX-REDESIGN-PLAN.md` §13, cited as the design authority for the shot contract. Neither exists in the tree.
- **`packages/README.md`, `extensions/README.md` and `scripts/README.md` match no rule in
  `affected.ts`** and fail open to a full test matrix.
- **Whether a docs page should transcribe a spec at all.** `framework/concepts/` is a copy of
  `specs/spec.md`. This campaign fixes the prose; the information architecture is a larger question.

## Status

| Step                                                       | State       |
| ---------------------------------------------------------- | ----------- |
| One line per paragraph, and `unwrap-prose.ts`              | done        |
| The link and anchor gate, and the 13 links it found broken | done        |
| The style guide, and this brief                            | done        |
| The prose gate                                             | not started |
| Pilot rewrite and the reference set                        | not started |
| Stale surface names, titles, code fences                   | not started |
| The rewrite, by section                                    | not started |
| Marketing copy, and the README pass                        | not started |
| Consistency pass, and the gate goes absolute               | not started |

The pilot freezes the voice every later page is written against. Until it lands, there is no reference set.
