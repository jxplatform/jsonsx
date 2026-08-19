---
title: "Feeds"
description: "Generate Atom and JSON Feed from a content collection, with automatic discovery links and RFC 5005 archives for long histories."
spec:
  - site-architecture.md#6.7
  - extensions.md#8.6
code:
  - extensions/feed/src/feed.ts
  - extensions/feed/src/atom.ts
  - extensions/feed/src/json-feed.ts
---

# Feeds

A feed turns a [content collection](/docs/framework/site/content-collections) into something readers subscribe to. Add `@jxsuite/feed` to `extensions` and declare which collection to syndicate:

```json
{
  "extensions": ["@jxsuite/parser", "@jxsuite/feed"],
  "feed": {
    "blog": {
      "collection": "posts",
      "basePath": "/blog/",
      "title": "Example Blog"
    }
  }
}
```

The build writes `dist/feed.xml` and `dist/feed.json`, and adds the discovery links to every page's `<head>` so a browser or reader finds them on its own.

`url` must be set in `project.json` — a feed's entries are identified by absolute URL, so there is nothing to generate without one.

## Options

| Key                         | Default            | What it does                                                      |
| --------------------------- | ------------------ | ----------------------------------------------------------------- |
| `collection`                | the key            | Which content collection to syndicate                             |
| `basePath`                  | —                  | URL prefix the entries are served under, e.g. `/blog/`            |
| `title`, `description`      | —                  | Feed metadata                                                     |
| `formats`                   | `["atom", "json"]` | Which documents to write                                          |
| `output`                    | `/feed`            | Base path; `.xml` and `.json` are appended                        |
| `pageSize`                  | `20`               | Entries in the subscription document                              |
| `archive`                   | `false`            | Write older entries to archive documents                          |
| `author`                    | —                  | `{ name, uri, email }`, overridden per entry by an `author` field |
| `dateField`, `updatedField` | `date`, `updated`  | Which frontmatter fields carry the timestamps                     |
| `contentMode`               | `"summary"`        | `full` puts the whole entry in the feed; `none` omits content     |
| `language`                  | `defaults.lang`    | BCP 47 tag                                                        |

## Dates

Feed timestamps come from your frontmatter. Declare the field with a `format` so the loader normalizes it:

```json
{ "properties": { "date": { "type": "string", "format": "date" } } }
```

An entry with no date falls back to the source file's modification time. The feed's own timestamp is the newest entry — never the build time, so redeploying does not re-notify everyone who subscribes.

## Long histories

With `archive: true`, entries past `pageSize` are written to `/feed/archive/1.xml`, `2.xml` and so on, linked in both directions ([RFC 5005](https://www.rfc-editor.org/rfc/rfc5005)). Archive 1 is the oldest and stays put as you publish — only the newest archive grows — so a reader that already fetched an archive never needs it again.

When a feed contains your entire history it says so, and readers can stop looking for more.

## One feed per language

If the feed's collection keeps [one directory per locale](./i18n.md#content-in-one-directory-per-locale), you get one feed per language — no extra configuration:

| File              | Holds             | Says               |
| ----------------- | ----------------- | ------------------ |
| `/feed.xml`       | the English posts | `xml:lang="en"`    |
| `/fr-ca/feed.xml` | the French posts  | `xml:lang="fr-CA"` |
| `/ar/feed.xml`    | the Arabic posts  | `xml:lang="ar"`    |

Item links point into that language's URL space too, so a French subscriber who clicks through lands on the French post rather than the English one.

Every page advertises all of them, each tagged with `hreflang` — the discovery links are written before the build knows which language the page is in, so they name every language and let the reader's client choose.

:::doc-note
One feed carrying three languages would deliver every post three times to every subscriber, twice in a language they don't read. That's why the split isn't optional.
:::

## Why not RSS?

RSS 2.0 has no standards body, its date format is a 1982 email spec, and its `<guid>` semantics were never pinned down. Atom is an IETF standard with required identity and timestamps, and every reader made in the last twenty years handles it. If you need RSS for a specific consumer, open an issue with the case.

## Related

- [Content collections](/docs/framework/site/content-collections) — the source a feed reads
- [SEO and metadata](/docs/framework/site/seo) — how the discovery links join the rest of `<head>`
- [Build output](/docs/framework/site/deployment) — where the feed files land in `dist/`
