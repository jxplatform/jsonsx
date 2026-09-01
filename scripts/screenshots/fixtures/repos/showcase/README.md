# `showcase` — a git repository the camera can rely on

The Source Control shot used to open a project **inside this monorepo**, so `git status` reported whatever the person running the pipeline had uncommitted. The picture changed on every machine and nobody could tell that from a real change.

This directory is that repository's **recipe**, not the repository. A nested `.git` cannot be committed to a parent git repository, so `lib/server.ts`'s `materialiseGitFixture()` builds it under `.cache/screenshots/projects/` at capture time:

- `fixture.json` — the branch, the author, the commits (each with a pinned `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE`) and the dirty set.
- `commits/<n>-<name>/` — a tree overlaid onto the working directory and committed as one commit.
- `dirty/` — files written **after** the last commit, plus `dirty.deleted` for removals.

The result is one modified file, one untracked file and one deletion, forever, with commit dates in January 2026. Pair it with `open.clock` so the panel's relative timestamps ("2 days ago") are constant too.

The project is deliberately plain — no remote webfonts, no images. Remote fonts inside the canvas iframe are the measured cause of the pipeline's largest historical drift (§13.4), and a fixture is the last place that should be reintroduced.
