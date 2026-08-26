# The shot contract

This file is the **normative home of the shot contract** (UX-REDESIGN-PLAN §13.5). Not a spec
section, deliberately: every substantive spec edit is a `spec:bump` release, so writing the region
grammar into `specs/studio.md` would add a release to every registry rename that touches it, and the
predictable failure would be bumping `CONTRACT_VERSION` instead of fixing four manifest lines.

Shots live in [manifest.json](./manifest.json). The runner boots the repo dev server, materialises a
writable copy of every project a shot opens, drives Studio in headless Chromium through
`window.__jxAutomation`, and writes PNGs to the manifest's `outDir`.

Two rules govern everything below, and both are review-enforceable:

> **R1. A shot may name inputs the app accepts. It may never name values the app derives.** Deltas,
> coordinates and rendered text are all derived.
>
> **R2. The pipeline may only ask the app to do sooner what the plan already commits to doing.** It
> may never ask for anything the plan does not already want.

## Usage

**The browser is driven over [WebDriver BiDi](https://www.w3.org/TR/webdriver-bidi/), not CDP.** CDP
is Chrome's own protocol and no standard describes it; everything this pipeline asks of a browser is
in BiDi, and the captured bytes are identical under both: the same shot captured over each, with
everything else held equal, hashes the same. Set `JX_SHOTS_PROTOCOL=cdp` to fall back if a Chromium
release regresses BiDi.

One consequence worth knowing before you write a step: **BiDi refuses a pointer move outside the
viewport.** CDP tolerated `(-1, -1)`, which is how the pipeline used to park the cursor where
nothing could match `:hover`; it now parks at the viewport's bottom-right corner. A step that
computes a coordinate must keep it inside the viewport, or `input.performActions` fails the shot
with "move target out of bounds".

```bash
bun run screenshots                 # all shots; visually-identical images keep their bytes
bun run screenshots --only hero     # one shot (comma-separate for several)
bun run screenshots --headed        # visible browser + a 15s linger, for tuning
bun run screenshots --force         # re-baseline: overwrite every image
bun run screenshots --reuse-server  # photograph a dev server the runner did not start
bun run screenshots --manifest x.json
CHROMIUM_BIN=/path/to/chromium bun run screenshots
```

Requires a system Chromium/Chrome (`CHROMIUM_BIN`, else `chromium` / `google-chrome` / … on PATH).
No browser is downloaded, which is what makes the runner work on NixOS and plain CI alike.

`--reuse-server` is the one opt-in that trades determinism for turnaround. By default the runner
**spawns its own** dev server, because an adopted one is serving whatever `packages/studio/dist` it
happened to be started with, a bundle nobody in the run can name. Reuse is announced in the log and
gated on a freshness assertion: `dist/studio.js` must be newer than every file under
`packages/studio/src`, or the run fails naming the source file it is behind.

## The five verbs

```jsonc
{
  "contract": 1,
  "outDir": "docs/images",
  "defaults": {
    // NOT `project`: see `open.project` below.
    "viewport": { "width": 1920, "height": 1000 },
    "deviceScaleFactor": 2,
    "theme": "dark",
    "profile": "fresh",
    "clock": "2026-01-15T09:30:00Z",
  },
  "shots": [
    {
      "name": "git-panel",
      "docs": ["studio/publish"],

      // OPEN — the world the app wakes up in. TOTAL, never a delta.
      "open": {
        "project": "scripts/screenshots/fixtures/repos/showcase",
        "file": "pages/index.md",
        "view": "design",
        "fit": "width",
        "profile": "fresh",
        "clock": "2026-01-15T09:30:00Z",
        "docks": { "chat": { "collapsed": true } },
      },

      // STEPS — exactly one of cmd | seed | input per entry.
      "steps": [
        { "cmd": "view.showPanel", "args": { "panel": "git" } },
        { "seed": "seed.git", "args": { "status": {} } },
      ],

      // EXPECT — fails the shot. probe.idle() already ran after boot and after every step.
      "expect": [{ "region": "navigator/panel:git" }, { "state": { "git": { "dirtyCount": 3 } } }],

      // CAPTURE — region ids, never selectors.
      "capture": [
        { "image": "git-panel", "of": "navigator/panel:git" },
        { "image": "git-commit", "of": "navigator/panel:git/commit", "padding": 16 },
      ],

      // THEN — more pictures from the same boot. What `variants` was.
      "then": [],
    },
  ],
}
```

There is **no sixth verb**, and no `wait`, `waitFor`, `clip`, `regions`, `variants`, `actions`,
`canvasMode`, `noProject`, `noCanvas`, or `selector` anywhere. A manifest still carrying one of them
fails validation naming its replacement. They are deleted, not deprecated, so a half-executed shot
is impossible.

### `open`

`open` is total. `profile` is what makes that true: it names a startup profile
(`packages/studio/src/services/profile.ts`) which resets every Studio-owned storage key before any
other field applies, so a default flip is a no-op here instead of silently inverting eighteen steps.
Unstated fields fall back to `manifest.defaults` and then to the profile's own value, which is a
_defined_ state rather than "whatever was in storage". The default profile is `fresh`.

**`project` is stated per shot and never inherited.** It is deliberately absent from `defaults`,
because a default makes "omit `open.project`" mean _the default project_ rather than _no project_,
and `welcome-screen` is a shot **of** the no-project state. One field left out of `defaults` is the
whole fix, and every shot's boot now reads without going back to the top of the file.

| field                                    | how it reaches the app                                     |
| ---------------------------------------- | ---------------------------------------------------------- |
| `project` · `file` · `profile` · `clock` | query string, read at boot                                 |
| `view` · `fit` · `theme`                 | one idempotent command each (`OPEN_COMMANDS` in `shot.ts`) |
| `docks`                                  | `view.setDock` per declared dock                           |
| `viewport` · `deviceScaleFactor`         | the browser                                                |

`project` is repo-relative and is **never opened directly**. See [the overlay](#the-overlay) below.

### `steps`

| verb    | means                                                                                             |
| ------- | ------------------------------------------------------------------------------------------------- |
| `cmd`   | `{ "cmd": "<category>.<verb>", "args": {…} }`: `__jxAutomation.run`, a projection of the registry |
| `seed`  | `{ "seed": "seed.git", "args": {…} }`: stands in for a **remote**, never for a user               |
| `input` | the budgeted hatch. Four kinds, counted and ratcheted                                             |

`run()` throws on an unknown id, on any `toggle*` id, and when a command's own `enablement` refuses,
and every one of those becomes the shot's failure. Reject loudly, never clamp: a step that asks
for a state the app refuses is a step that is lying.

A **seed** may only write state whose real writer is a network or IPC boundary. `setStatus`,
`setActivity`, `select`, `setZoom` and `openSettings` are all refused by name, because a user does
each of those, so a _command_ does each of those.

**`input` is debt with a cap.** State cannot express a gesture in flight, and faking one would be a
worse lie than a two-line hatch. Every kind is addressed by a region id or a `JxPath`, never a
selector:

```jsonc
{ "input": "hover",    "region": "navigator/panel:git" }
{ "input": "type",     "text": "/", "region": "inspector/field:href" }  // region is optional
{ "input": "dragOver", "region": "pane.primary/library/dropZone" }
{ "input": "caret",    "path": ["children", 3], "clickCount": 2 }
```

`caret` goes through `probe.pointAt()`, which answers in **top-document coordinates** with the app's
own transforms already composed, per canvas host. That is why the runner no longer carries a
`Math.abs(scale - 1) < 0.001` branch guessing whether a fit transform is in play, and why a second
canvas pane does not break it.

### `expect`

`{ "region": "<id>" }` resolves the id to an element with a non-empty box. `{ "state": {…} }` is a
partial deep match against `probe.state()`, the same `CommandContext` every `when` predicate reads.
All failures in a segment are reported at once.

### `capture`

`{ "image": "<basename>", "of": "<region id>", "padding": 0 }`. `of` defaults to `viewport`, the
camera's own frame, which names no DOM node and so no rename can reach it. Image names are unique
across the whole manifest. Every capture saves and restores the page's scroll offsets, so capture
N's `scrollIntoView` is not capture N+1's starting position.

### `then`

Follow-on `{ steps, expect, capture }` against the same boot. It carries none of `variants`' cleanup
role. See [the overlay](#the-overlay).

## The region grammar

`<surface>[.<instance>][/<part>]`. Surfaces: `rail` · `navigator` · `inspector` · `pane` ·
`dock.bottom` · `statusbar` · `commandbar` · `overlay`. Instances: `pane.primary`, `pane.secondary`,
`overlay.palette`, `overlay.dialog`, `overlay.menu`, `overlay.toasts`. `pane` aliases `pane.primary`.

```text
navigator/panel:git           the Source Control panel
navigator/panel:git/commit    a leaf within it
inspector/tab:style           the Style tab's body
inspector/field:href          a field row
pane.primary/tabs             the primary pane's tab strip
overlay.dialog:settings       a named overlay slot
```

**Ids are derived, not authored.** The panel host stamps `navigator/panel:${panel.id}` once and
every panel gets a region for free, so a panel rename propagates automatically and a stale manifest
id goes red in the renaming PR. Only leaves are hand-stamped, and those are counted.

The runner checks **well-formedness** only. Whether an id is one the app stamps is Lane 1's question
(it reads the registries) and, at capture time, the app's own. An unresolvable id fails the shot
where it is used. The in-page resolver in `lib/shot.ts` mirrors
`packages/studio/src/ui/regions.ts`: the `data-jx-region` attribute, the `pane` alias, last-match-
wins for stacked overlays, and the one derived resolver (`inspector/field:*` reads `data-prop`). It
is written out rather than imported because `page.evaluate` ships a function's source into the
browser and cannot carry its imports; the app remains the authority.

## Determinism

There are **no sleeps**. "Settled" is two predicates, and they are not redundant:

1. **`probe.idle()`** is the app's own account: queued lit renders, pending panel-scheduler frames,
   unacked canvas generations _per host_, in-flight platform I/O. It **rejects** with `blockedBy`
   (`["canvas[pane.primary]: gen 7 unacked", "platform: 1 in-flight (gitStatus)"]`), and the runner
   prints that list as the shot's failure. This is the whole reason it can fail: 115 sleeps were 115
   places that _could not_, so a slow subsystem got answered with `+500 ms` and the wrong capture was
   accepted.
2. **The runner's quiescence** covers outstanding network requests across every frame, running Web
   Animations, fonts loading, and a focus ring that has stopped moving. The app cannot see what the
   canvas iframe is fetching, and that gap is a measured 15% drift: the `hero` shot's starter site
   loads Google Fonts inside the canvas frame, where `document.fonts.ready` resolves `"loaded"`
   against an empty font set while the frame is still blank.

Both run after boot, after every step, and before every capture.

Also fixed, and each was a real source of churn: the animation freeze is installed via
`evaluateOnNewDocument` + `frameattached` (so a canvas rebuilt by a later step is still frozen); one
fresh `BrowserContext` per shot (the HTTP cache is context-scoped, so shot warmth used to depend on
running order); `--force-color-profile=srgb --font-render-hinting=none --disable-lcd-text`; `TZ=UTC`
and `LANG=C.UTF-8` in the browser's environment; pointer and focus reset before every capture.

`DIFF_THRESHOLD = 0.0002` decides whether committed bytes are rewritten. It is a COUNT of pixels whose
channels moved more than `CHANNEL_TOLERANCE` (16), at native resolution. (It was a mean-absolute
difference over 32×32 THUMBNAILS, at which size a 3840×2400 frame's whole status bar is a fraction
of one pixel row; a rail that lost two buttons scored 0.07 % and the stale bytes were kept.) Per
§13.4 it is for **review presentation** and is no longer load-bearing for identity.

The number is sized against measurement. Of the 21 images the lane pushed across 24 consecutive
`chore(screenshots)` commits, every one was nondeterminism rather than a UI change: the rail's git
badge (11, 0.010–0.014 %), a `data-grid` cell's range outline (5, 0.089 %), `blog-grid`'s collection
row order (3, 0.12–0.16 %) and `media-upload`'s drop-zone indicator (2, 0.038 %). 0.0002 clears the
first band and deliberately stops there: a status bar going from empty to three fields scores
~0.1 %, so a threshold that also swallowed the rest would sit above the very regression this gate
exists to catch. **The other bands are fixed where they are caused, not absorbed here**, and no
whole-frame pixel metric could separate them anyway, since a 1206×76 row swap and a 3840×24 status
bar have the same area.

## The overlay

**No shot ever opens a committed project.** `lib/server.ts` materialises a copy under
`.cache/screenshots/projects/` and the shot opens that.

**The copy is sealed as its own git repository** (`sealOverlayRepo`): `git init`, everything
committed, `node_modules`/`dist`/`.cache` excluded, branch pinned to `main`. The overlay has to live
inside this repository (the dev server refuses a project root outside its own tree), and a directory
with no `.git` of its own makes git walk UP: `studio-api.ts` runs every `/__studio/git/*` command
with `cwd` set to the active project root, so `git status` answered for THE MONOREPO and the rail
rendered its dirty count into the picture. That is a feedback loop rather than a mere leak, because the
runner writes each PNG as it goes, so the count climbs during the run. It alone accounted for
11 of the 21 images the lane pushed over 24 commits. Sealed, the answer is the overlay's own state:
clean, unless the shot itself edited something.

This deletes a real hazard, not a theoretical one. `slash-menu-shot` pressed Enter into
`packages/starters/sites/restaurant/pages/index.md`, a committed file, and then ran a cleanup
`variant` to undo the damage. It was one crash away from corrupting a starter, and it was one of the
two shots red on main. With the overlay there is nothing to undo, and the whole class of
self-undoing shots goes with it.

The copy is materialised once per project per run and reset after every shot: files a step modified
are re-copied, files it created are deleted, files it removed come back. `node_modules` is symlinked
rather than copied. `.cache/` is already in `.gitignore`, so nothing a shot writes can be staged, and
the copy lives inside the repository because the dev server refuses to activate a project root
outside its own tree.

### Fixture repositories

A project directory carrying `fixture.json` is materialised as a **real git repository** with pinned
`GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE` and a stated dirty set. Its reset is a full rebuild, so a shot
may stage, commit and branch inside it.

[`fixtures/repos/showcase/`](./fixtures/repos/showcase/) is the first one, and it exists because the
`git-panel` shot used to open a project **inside this monorepo**, so `git status` reported whatever
the author had uncommitted, and the picture changed on every machine. A nested `.git` cannot be
committed to a parent repository, so the fixture ships as its plain working files plus a recipe and
the repository is built at capture time. See its README for the recipe format.

## The gate

**Lane 1 is `scripts/check-shot-contract.ts`: every PR, no browser, seconds.** Fails when a `cmd` id
is unknown or refused by the projection, when `args` fail the command's own JSON Schema, when a
region id is not one the registries declare, when a `seed` id is unknown, when any `toggle*` id
appears, when `contract` mismatches, or when the committed budgets go **up**:

| budget                                                                                        | what it counts                                                                   |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `inputSteps`                                                                                  | raw gestures. §13.6 lands this at **≤ 6**; target 3                              |
| `nonDerivedRegions`                                                                           | distinct region ids no registry stamps for free                                  |
| `unstable`                                                                                    | `{reason, until}` escape hatches. CI fails once `until` has shipped              |
| `selectorActions` · `waitForSelectors` · `regionSelectors` · `clipSelectors` · `argSelectors` | contract-0 debt. **All zero** since the conversion, and structurally unreachable |

Every number is a **ratchet**: it may fall, and raising one needs the same written justification as
lowering a coverage threshold. When a count falls the run prints the new value; lowering the
committed number is then a one-line edit.

**Lane 2 is `.github/workflows/screenshots.yml`.** Required on any PR touching
`packages/studio/src/**`, `scripts/screenshots/**` or `packages/starters/**`. Its failure mode is a
**bot commit, not a red X**: it re-captures, pushes the changed PNGs and the updated lock to the
branch, and comments with a before/after table and the docs pages each changed image appears on.
Status is always `neutral` on a visual change, and red only on a shot _error_: a failed `expect`,
an unknown command id, an unresolvable region, an `idle()` timeout. Those are regressions. A picture
merely changing is an aesthetic judgement CI cannot make.

**The lane declines its own commits, and that is load-bearing.** Its push moves the PR head, which
raises `pull_request: synchronize`, which queues the lane again on the commit it just wrote. Nothing
in the trigger can prevent that, because `paths:` matches the PR's whole diff against its base and one
landed re-capture puts `docs/images/**` in that diff permanently, so the refusal is a job-level
`if:` on `github.actor`. Two facts made it necessary, and both were measured rather than assumed:

- A `GITHUB_TOKEN` push **does** queue this workflow here. Sixteen of the thirty runs on the branch
  that found this were headed by the lane's own `chore(screenshots)` commit.
- The `action_required` state those runs sit in is a repository Actions policy, not a termination
  condition. Approve one and the lane re-captures its own output and pushes again; the button is
  the crank handle, not the brake.

**CI never passes `--force`.** That flag is for a deliberate re-baseline (§13.4) and it works by
skipping `writeIfChanged`, the pixel comparison that keeps committed screenshots from churning.
In the lane it rewrote all 63 PNGs every run, and since Chromium does not re-encode a PNG
byte-for-byte, ~28 files whose own report read `0.00% of pixels` were pushed as changes. Under
`DIFF_THRESHOLD` those files are now kept, and `git diff` means what the lane needs it to mean.

## Authoring notes

- **Deleting a shot is a first-class fix.** A screenshot of content the docs pipeline already
  generates is a bug. Every phase asks which shots it can delete before asking which it must
  re-author. 61 is not a target.
- A shot may carry `"status": {"state": "quarantined", "reason": "…", "since": "<sha>"}`, marking a shot the
  repo **admits** is broken. The runner skips it and names it, Lane 1 reads past it (its ids are
  checked again the moment the quarantine is lifted, which is when someone is looking), and
  `docs:check` fails if any docs page still illustrates itself with its image. Quarantine keeps the
  definition, and therefore the diagnosis, instead of deleting the evidence.
- Markdown pages show inline-edit placeholders in **design** view, so use `preview` for clean content
  shots, or a `.json` page for design-view shots with selections.
- `--headed` keeps each page open 15s so you can see what the shot definition produced.
- Every phase that renames a command id, a panel id or a region id fixes the manifest **in the same
  PR**, because Lane 1 is red until it does. Every phase that adds an async subsystem registers it
  with `probe.idle()`, because the reflex when a shot times out will be to re-add a sleep, and that is how
  this decays back to 73 seconds of them.
