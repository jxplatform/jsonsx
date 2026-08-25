---
title: "Extending"
description: "Extend Jx with custom formats, classes, project sections, and server mounts — or embed Studio on your own backend."
---

# Extending

Jx is built to be extended. First-party extensions (the Markdown parser, the data connector, auth) use only the public extension hooks — anything they can do, your extension can do. Studio itself is an embeddable app: any backend that speaks its protocol can host it. This section covers both directions, plus how to work on Jx itself.

## Extensions

An extension is an npm package that contributes formats, classes, capability methods, project settings sections, server mounts, and data connectors to a Jx project. Start with [the anatomy of an extension](/docs/extending/extensions/anatomy), then go deep on the individual contribution points: [schema composition](/docs/extending/extensions/schema-composition), [classes](/docs/extending/extensions/classes), [formats](/docs/extending/extensions/formats), [capabilities](/docs/extending/extensions/capabilities), [project sections](/docs/extending/extensions/project-sections), [server mounts](/docs/extending/extensions/server), [connectors](/docs/extending/extensions/connectors), and the [security model](/docs/extending/extensions/security). Two tutorials build one end-to-end — [a TOML format](/docs/extending/extensions/tutorial-toml-format) and [a guestbook with server routes and a connector](/docs/extending/extensions/tutorial-guestbook) — and the [first-party extensions](/docs/extending/extensions/first-party) are the reference implementations to crib from.

## Embedding Studio

Studio is backend-agnostic: all of its file, git, and project operations go through a platform-adapter layer, and every adapter ultimately speaks one wire contract, the Studio Backend Protocol. The [embedding overview](/docs/extending/embedding) lays out the options and helps you pick an integration path; [writing a platform adapter](/docs/extending/embedding/platform-adapter) covers the in-page `StudioPlatform` interface; [the backend protocol](/docs/extending/embedding/backend-protocol) defines the contract any backend can serve, with every endpoint listed in the [protocol route reference](/docs/extending/reference/studio-routes); and [dev server internals](/docs/extending/embedding/dev-server) walks through the reference implementation.

## Contributing

To work on Jx itself, [working in the monorepo](/docs/extending/contributing/monorepo) covers the repository layout, test and coverage policy, and the tooling conventions; [contributing to these docs](/docs/extending/contributing/docs) is the style guide every page in `/docs` follows.
