# Humanizing the documentation

The corpus was drafted with heavy AI assistance and reads like it. This file is the plan, the protocol each page goes through, and the live status board. The published rules live in the style guide, [docs/extending/contributing/docs.md](./docs/extending/contributing/docs.md); this file is the campaign around them and is deleted when it is finished.

## What is actually wrong

The vocabulary is already clean. Across 163,533 words there is not one hit for delve, seamless, comprehensive, crucial, pivotal, "at its core", "it's worth noting" or "let's dive in", because the style guide banned marketing language years ago and it worked. There are no decorative horizontal rules, no "Conclusion" or "Key takeaways" headings, and the nineteen emoji are all functional UI glyphs the docs are naming on screen.

What the corpus has instead is punctuation and cadence:

| Signature                                  | Count                                       |
| ------------------------------------------ | ------------------------------------------- |
| Em dashes in hand-authored prose           | 2,846, about one every forty-four words     |
| ...on a line carrying two or more          | 954                                         |
| ...opening the line's final clause         | 791 lines                                   |
| `rather than`, plus `X, not Y.` enders     | 212 and 94, and they went UP to 240 and 100 |
| Headings restated by their first paragraph | 130 of 1,210                                |
| Sentences over thirty words                | 845 of 5,807                                |
| Title Case headings                        | about 26, nearly all in `framework/`        |

**The dash rewrite has its own failure mode, and it is measured.** A dash and a contrast are the same gesture, so the obvious substitution keeps the gesture: `rather than` rose from 212 to 240 and the `X, not Y.` ender from 94 to 100 while the dashes fell to zero. No count is wrong. A page holding ten of them is, and the totals hide exactly that, so `check-prose.ts --report` ranks the two frames per thousand words and the consistency pass reads the top of that list. Neither frame is gated, because a budget would have to claim the fifth instance is wrong while the fourth was fine.

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
5. Answer both questions in the commit message, per section. To "what still sounds AI-generated?", "nothing" is never a true answer. To "did the rewrite add or remove any fact, name, number, date, quote, citation or claim?", paste the fact delta and adjudicate every line of it.

Commands, in this order, because `oxfmt` realigns tables and moves the offsets everything else reports on:

```sh
./node_modules/.bin/oxfmt docs/<path>.md
bun scripts/docs/unwrap-prose.ts docs/<path>.md
bun run docs:check
bun run docs:links
bun scripts/docs/check-prose.ts docs/<path>.md
bun scripts/docs/check-prose-facts.ts --base <branch point> docs/<path>.md
```

The fact differ compares the working tree against a base and blocks on a LOSS: a removed code fence, link, keystroke or image. Everything else it prints is advisory and gets adjudicated line by line in the commit message. **Point `--base` at the previous commit, not at `main`.** Later commits build on earlier ones, so a rename this branch already made reads as a loss when compared against the branch point.

The gate holds new prose to zero em dashes and holds each existing page to the count it already had, so a rewrite that removes some must lower that page's entry in `scripts/docs/prose.json`. `bun scripts/docs/check-prose.ts --ratchet` prints the corrected map. Delete a page's entry when it reaches zero.

Then, per commit, after committing, because `docs:verify` regenerates and diffs and so needs a clean tree:

```sh
bun run docs:verify
bun run docs:links && bun run docs:prose
bun run docs:claims && bun run docs:markdown && bun run docs:standards && bun run docs:spec-release
git diff --name-only origin/main... | bun scripts/ci/affected.ts --stdin
git diff --word-diff=color HEAD~1 -- docs/
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

## How this ships

**One pull request, off `docs/humanize`, with one commit per meaningful step.** The commit is the unit a reviewer reads: a section rewrite, a gate, a ruling applied. Read the branch with `git log -p --reverse` or a commit at a time, not as one 4,000-line diff.

Two consequences worth knowing:

- **The whole branch pays one full test matrix, once.** `package.json` and `.github/workflows/test.yml` are both in `affected.ts`'s `GLOBAL` list, and two commits touch them to register `docs:links` and `docs:prose`. Everything else here is `checks`-only, so splitting the work would have paid that cost repeatedly for no gain.
- **All twenty-six package, extension and meta READMEs land in one commit.** Each one seeds its workspace and that workspace's whole dependent closure, and `packages/README.md`, `extensions/README.md` and `scripts/README.md` match no rule in `affected.ts` at all, so they fail open. Landing them together keeps that to a single union instead of one fan-out per commit.

Verify a commit before making it, and the branch before opening the pull request. `docs:verify` needs a clean tree, so it runs after the commit rather than before.

## Working in a worktree

This work happens in a git worktree, and **a shell's working directory can revert between commands**. It did, and seven commits landed on an unrelated branch and reached the remote before anyone noticed; they were reverted in `b73b0ef3`. Start every command with an explicit `cd` to the worktree rather than trusting the shell to have stayed there, and check `git status -sb` names the right branch before any command that writes history.

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

- **Settled, and recorded so nobody re-opens it:** the jump bar really does print `h1 — Latest posts`. `nodeLabel()` in `packages/studio/src/state.ts` returns `` `${tag} — ${textContent.slice(0, 24)}` ``, so the em dash in that example on [The workspace](/docs/studio/interface) is verbatim UI, inside a code span, and the gate never saw it.
- **Two pages describe the same screenshot differently.** `docs/images/mode-manage.png` was captioned "Jx Studio Manage Files modal with live previews of every project file" on `start/first-project.md` and "The Library open in a Studio pane, listing a project's pages and components as cards with live previews" on `studio/projects/browse.md`, which owns the shot. Both now use the owning page's wording, which narrows the claim from every project file to pages and components and changes modal to pane. Someone who can see the image should confirm it.
- **`navigator-panels.ts` still comments that the Bottom dock's tabs are "Problems · Diff · Logic · Activity".** The code below it registers three. The style guide has been corrected; the comment has not.
- **Two dangling paths in `CLAUDE.md`**: `STANDARDS-ADOPTION.md`, which agents are told to read before picking up any `gap:` id, and `packages/studio/UX-REDESIGN-PLAN.md` §13, cited as the design authority for the shot contract. Neither exists in the tree.
- **`packages/README.md`, `extensions/README.md` and `scripts/README.md` match no rule in `affected.ts`** and fail open to a full test matrix.
- **`packages/compiler/README.md` and `specs/compiler.md` now disagree cosmetically.** The README's route table reads `0: Class`, `1: Static`, and so on; the same table in `specs/compiler.md` §2 still reads `0 — Class`. Specs are out of scope for this campaign, so the spec was left alone. Whoever next releases that spec should decide whether it follows.
- **`packages/runtime/README.md` carries two unsourced bundle-size figures** (`@vue/reactivity` ~7 kB gzip, `lit-html` ~3 kB gzip). `docs:claims` gates marketing copy and the root README, not package READMEs, so nothing checks them.
- **One fenced block was edited deliberately.** The style guide's own callout sample said `Neutral context — including …`, so the page teaching the dash rule was breaking it inside its worked example. The comma is the only fence edit on the branch; every other fence is byte for byte.
- **`platform-adapter.md` mixes British and American spelling.** `optimisation` sits beside `normalizes` and `serializes` on the same page. The corpus is American English by the style guide, so this is a one-word fix that nobody has made; it was left verbatim rather than guessed at.
- **The same notification is worded two ways upstream, and both reached the docs.** `platform-adapter.md` quotes "**Open in Browser** reports that this **target** cannot build a preview" from the `degradation` string in `packages/protocol/src/routes.ts`, and "this **backend** could not build a preview" from the toast in `packages/studio/src/panels/toolbar.ts`. Each page is faithful to a real string; the two strings disagree. Whoever owns the protocol route text picks a word.
- **`schema-composition.md`'s remaining fenced dash is generator output.** The `$comment` in the sample is the literal string `jx schema` writes, so removing it means changing `packages/schema`'s generator.
- **Whether a docs page should transcribe a spec at all.** `framework/concepts/` is a copy of `specs/spec.md`. This campaign fixes the prose; the information architecture is a larger question.

## Terminology, as ruled

Fourteen Studio names were checked against what the app registers. The rulings:

| Was                       | Now                         | Why                                                                                |
| ------------------------- | --------------------------- | ---------------------------------------------------------------------------------- |
| Run **Manage Files** (⌘K) | Open **The Library** (⌘⇧E)  | No command by that name exists. Three tutorial steps sent readers nowhere.         |
| Script & logic            | Logic                       | The page title and nav label; the old string is in no source file.                 |
| Stylebook                 | Project Styles              | Renamed in spec 0.6.0-draft, name only. The `stylebook` slug stays the wire value. |
| Browse your project       | The Library                 | The page's own title and H1.                                                       |
| Git & publish             | Publish                     | The nav label.                                                                     |
| Tabs and files            | Documents and panes         | The nav label.                                                                     |
| the right panel           | the Inspector               | A shell region with a canonical name.                                              |
| Code mode                 | the Code editor             | _Mode_ belongs to the View control; Code is an Editor kind.                        |
| the sidebar               | the Inspector's Content tab | Studio has no sidebar.                                                             |
| the State panel           | the Data panel              | State folded into Data. Removed from the guide.                                    |

The style guide gained what it was missing: **Languages** (Project group, off the rail, multilingual projects only), a declared but unbuilt **Search** panel, the **jump bar**, and the **Command Center** pill. **The palette** is now explicitly allowed as a collective for the Command Center and Quick Access.

## Status

| Step                                                       | State                                            |
| ---------------------------------------------------------- | ------------------------------------------------ |
| One line per paragraph, and `unwrap-prose.ts`              | done                                             |
| The link and anchor gate, and the 13 links it found broken | done                                             |
| The style guide, and this brief                            | done                                             |
| The prose gate                                             | done: 8 bans at zero, em-dash debt written down  |
| Pilot rewrite and the reference set                        | done: 7 pages, nothing lost                      |
| Stale surface names, titles, code fences                   | done: 14 rulings applied, 44 fences labelled     |
| The rewrite, section by section                            | done: all 131 hand-authored pages at zero        |
| Marketing copy, and the README pass                        | done: 8 marketing pages, 26 READMEs              |
| The gate goes absolute                                     | done: `em-dash` is a ban, the budget map is gone |
| Consistency pass                                           | in progress                                      |

The seven pilot pages are the reference set. Read them before rewriting anything else: `framework.md`, `framework/concepts/reactivity.md`, `framework/concepts/styling.md`, `extending/extensions/first-party.md`, `studio.md`, `studio/interface/modes.md`, `start/first-project.md`.
