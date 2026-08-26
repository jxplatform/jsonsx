---
title: "Timing: client, server, compiler"
description: "Where Jx data entries resolve: in the browser, on the server across the RPC boundary, or at build time with values baked into the HTML."
spec:
  - spec.md#11.3
  - spec.md#11.4
  - compiler.md#6
---

# Timing: client, server, compiler

> **Studio writes this format for you.** The **Timing** field on a data source's editor ([Data sources](/docs/studio/logic/data-sources)) sets the values below, and this page documents what each one means.

The `timing` key on a state entry declares **where** its value is resolved. There are three values, and each moves the work to a different machine:

| Value        | When it resolves                                         |
| ------------ | -------------------------------------------------------- |
| `"client"`   | At runtime, in the visitor's browser (the default)       |
| `"server"`   | At runtime, on the server, called over an RPC boundary   |
| `"compiler"` | At build time; the result is baked into the emitted HTML |

The smallest complete server-timed entry is a function that runs on the server, whose return value lands in state:

```json
{
  "state": {
    "metrics": {
      "$src": "./dashboard.server.js",
      "$export": "fetchMetrics",
      "timing": "server"
    }
  }
}
```

## Client

`"client"` is the default: omit `timing` and the entry resolves in the browser. All the Web-API [data prototypes](/docs/framework/concepts/data-prototypes) (`Request`, `LocalStorage`, `IndexedDB`, …) are client-timed unless told otherwise.

## Server: the RPC function boundary

`timing: "server"` designates a cross-process function call. The entry names an async export in a server-side module via `$src` and `$export`, and no `$prototype` is used. The function receives `(args, env)`: the caller's arguments object, and the platform's environment bindings (Cloudflare Workers `env`, a Node `process.env` wrapper, …):

```js
export async function fetchMetrics(args, env) {
  const db = env.DB; // e.g. a Cloudflare D1 binding
  const { data } = await db.prepare("SELECT * FROM metrics").all();
  return data;
}
```

A function that needs no bindings simply ignores the second parameter.

### Arguments

An optional `arguments` field passes named parameters as a single object rather than a positional list. Values may be static or reactive `$ref`s; any reactive value makes the call re-run when it changes:

```json
{
  "metrics": {
    "$src": "./dashboard.server.js",
    "$export": "fetchMetrics",
    "timing": "server",
    "arguments": {
      "userId": { "$ref": "#/state/userId" },
      "filter": "active"
    }
  }
}
```

### The security boundary

Server credentials stay in the server process. The `env` parameter gives the function its platform bindings (databases, KV namespaces, secrets, email workers), and none of it crosses to the client: the browser receives only the function's serialized return value.

:::doc-warning
The boundary is enforced by the **compiled** output. During development, the runtime may execute a server entry client-side (falling back to the dev server's proxy when the module can't load in a browser), so don't treat dev behavior as proof that a secret is hidden. Build and deploy to exercise the boundary.
:::

## Compiler

`timing: "compiler"` resolves the entry during the build. The result is baked into the emitted HTML and the entry is stripped from the shipped state, so visitors download the finished value rather than the machinery that produced it. This is the natural timing for content that changes only when you rebuild, and the content prototypes (`MarkdownFile`, `MarkdownCollection`, `ContentCollection`) use it by design:

```json
{
  "posts": {
    "$prototype": "MarkdownCollection",
    "src": "./content/posts/*.md",
    "timing": "compiler"
  }
}
```

## How it works

For each `timing: "server"` entry, the [compiler](/docs/framework/build) emits two artifacts: a client-side `POST /_jx/server/<export>` fetch that stores the JSON response in a signal (wrapped in an effect when any argument is reactive), and a server-side Hono handler that imports the export from `$src` and serves that route.

When `build.adapter` is set in `project.json`, every server entry across the whole site is collected, deduplicated by export name, and bundled into a single worker (`dist/_worker.js` plus a `_routes.json` limiting invocation to `/_jx/*` on Cloudflare Pages). Without an adapter, a standalone per-document handler is generated instead. During development the [dev server](/docs/framework/build/dev-server) stands in for both.

Compiler-timed entries never produce runtime artifacts at all. The site build resolves them, bakes the values into the static HTML, and strips the entries from the document.

## Rules

- `"client"` is the default whenever `timing` is absent.
- A server entry uses `$src` + `$export` with **no** `$prototype`, and the export must be an async named export.
- The server function's signature is `(args, env)`; `arguments` is one named-values object.
- A reactive `$ref` in `arguments` makes the RPC call reactive.
- `env` and everything reachable through it stay server-side; only the return value is serialized to the browser.
- `timing: "compiler"` values are fixed at build time, so rebuild the site to refresh them.

## Related

- [Data prototypes](/docs/framework/concepts/data-prototypes): the entries `timing` applies to
- [Functions and sidecars](/docs/framework/concepts/functions): client-side functions by contrast
- [The build](/docs/framework/build): where server bundling and baking happen
- [Dev server](/docs/framework/build/dev-server): server timing during development
- [Data sources in Studio](/docs/studio/logic/data-sources): the Timing field in the editor
