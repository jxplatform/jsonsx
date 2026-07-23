# Jx Specifications

These specs are the source of truth for Jx behavior. User documentation (`/docs`, published at jxsuite.com/docs) tracks what actually ships; the specs define what the contract is. Each top-level `*.md` here is one spec; files under `design-notes/` are working notes, not specs, and are exempt from everything below.

## Anatomy of a spec

```markdown
# `@jxsuite/server` Specification

## Development Server with Live Reload, Proxy Resolution, and Studio API

**Version:** 0.1.8
**Status:** Implemented
**Updated:** 2026-07-22
**License:** MIT

---

## 1. Overview

> **Status: Implemented.** …

… numbered sections …

## Changelog

- **0.1.8** (2026-07-22) — Proper spec versioning (`fb0f3ec7`).
- **0.1.7** (2026-07-22) — Fix failing tests (`56e073f8`).

---

_`@jxsuite/server` Specification v0.1.8_
```

| Field        | Rule                                                                                           |
| ------------ | ---------------------------------------------------------------------------------------------- |
| **Version:** | MAJOR.MINOR.PATCH, plus -draft while the spec is not Implemented                               |
| **Status:**  | One of Implemented, Partial, Pending, Future, Removed                                          |
| **Updated:** | ISO YYYY-MM-DD; equals the newest changelog entry's date                                       |
| footer       | Specification v<version> — must equal the header version (optional, but enforced when present) |

Numbered headings (`## 5`, `### 5.1`, `#### 19.4a`) are anchors: docs pages reference them from `spec:` frontmatter. **Edit sections in place — never renumber or remove a numbered heading**, or `bun run docs:check` fails. Per-section state is a blockquote directly under the heading: `> **Status: Partial.** …`.

## Releasing a spec

Every substantive edit is a release. Do not hand-edit the version, the date, or the changelog — run:

```sh
bun run spec:bump <spec.md> <major|minor|patch|stable> -m "<what changed>"
bun run docs:generate   # refresh the derived reference pages
```

That advances the header **and** footer version, restamps `**Updated:**` to today, and prepends a `## Changelog` entry.

| Level  | Use when                                                                                                    |
| ------ | ----------------------------------------------------------------------------------------------------------- |
| major  | A breaking change to a documented contract — renamed, removed, or redefined behavior that authors depend on |
| minor  | Additive — a new section, newly documented behavior, a contract that gains capability                       |
| patch  | Editorial — wording, examples, non-normative clarification                                                  |
| stable | Graduate a 0.x spec to 1.0.0 — a deliberate declaration that its contract is settled                        |

**Every spec is pre-1.0 today**, and while a spec is at `0.x` the release-please `bump-minor-pre-major` policy applies: `major` moves the **minor** digit, and `minor` and `patch` both move the **patch** digit. So a structural break reads `0.2.7 → 0.3.0`, and everything else reads `0.2.7 → 0.2.8`. Past `1.0.0` the levels mean exactly what they say.

These version numbers were not chosen by hand — they were **reconstructed from git history**. Every commit that touched a spec was classified by what it did to that spec's numbered-section anchor space (removed an anchor → structural break; added one → additive; neither → editorial) and the versions walked forward from `0.1.0` at the commit that introduced each spec. That is why each changelog entry carries the short SHA of the commit it describes.

The `-draft` suffix is derived from `**Status:**`, not chosen: specs that are not `Implemented` carry it, `Implemented` specs do not. To graduate a spec, set `**Status:** Implemented` first, then bump — the suffix drops automatically.

Changelog entries are one line each, newest first:

```markdown
- **<version>** (<YYYY-MM-DD>) — <what changed>
```

They are deliberately bullets rather than headings so changelog versions never collide with the numbered-section anchor space.

## Gates

| Command                   | Enforces                                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------------------------- |
| bun run docs:status       | Header fields, status vocabulary, footer/header version agreement, changelog ordering and consistency |
| bun run docs:spec-release | A spec whose body changed also advanced its version (this is what keeps versions meaningful)          |
| bun run docs:check        | Docs spec: anchors resolve to real numbered headings                                                  |
| bun run docs:verify       | The generated reference pages match the specs they derive from                                        |

A spec's "body" is everything except the release metadata — the `**Version:**` and `**Updated:**` lines, the `## Changelog` section, and the footer version. Header `**Status:**` and the per-section `> **Status: …**` markers _are_ body: changing what is built is a change worth releasing.

Two pages are generated from the metadata here and must never be hand-edited: [implementation status](../docs/extending/reference/implementation-status.md) and [spec changelog](../docs/extending/reference/spec-changelog.md).
