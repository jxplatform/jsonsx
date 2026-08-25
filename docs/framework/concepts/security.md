---
title: "Security"
description: "Where Jx runs document code, why compiled sites need no unsafe-eval, and how table permissions, sessions, and secrets are enforced on the server."
spec:
  - spec.md#21
  - extensions.md#11
  - extensions.md#13
code:
  - extensions/connector/src/worker.ts
  - extensions/auth/src/worker.ts
  - packages/studio/src/services/trusted-types.ts
---

# Security

A Jx site has two security surfaces. The **evaluation surface** comes with the format: a document contains executable code — `${}` templates and function `body`/`$src` entries — so where that code runs decides the posture. The **data and session boundary** appears only once a site has a database or sign-ins, and decides what the deployed worker will do on a visitor's behalf.

## Compiled sites run no eval

`jx build` produces plain HTML/CSS plus per-island ES modules. It does **not** emit `new Function` or `eval` — a `${}` template is spliced verbatim into an emitted module as a real template literal, and expressions and statements lower to genuine JavaScript. So a compiled static or island page runs under a **strict Content-Security-Policy with no `'unsafe-eval'`**. This is enforced by a compiler test (`packages/compiler/tests/no-eval.test.ts`).

Ship compiled output to production and the eval requirement disappears — that is the main reason the compiler exists.

## The interpreter needs `'unsafe-eval'`

The interpreting runtime — the dev server, the Studio canvas, and `@jxsuite/runtime` used directly as a library — compiles `${}` templates and inline `body` functions with `new Function` on the fly. Any page that hosts the interpreter must allow `'unsafe-eval'` in its CSP.

:::doc-warning
`${}` templates are **full JavaScript**, not a sandbox. A template has the component's `state` in scope, but also the entire global environment, and it can assign or call side effects. Do not render a template built from untrusted input in the interpreting runtime.
:::

**This is two settings, permanently — not one with a fix pending.** A compiled site never needs `'unsafe-eval'`; a page hosting the interpreter always will. The interpreter _is_ the code that compiles expressions as it reads them, so "remove eval from the runtime" would mean removing the interpreter. Ship compiled output to production and the requirement is simply not there.

## Trusted Types

Jx takes the half of [Trusted Types](https://www.w3.org/TR/trusted-types/) that applies to it and declines the half that cannot.

**Nothing Jx ships writes `innerHTML`.** The runtime and the compiled element modules clear elements with `replaceChildren()` instead — identical behavior, and not a DOM injection sink. That is a smaller surface in every site you build, whether or not any policy is enforcing.

**Studio's markdown goes through a policy that refuses.** The assistant's rendered markdown is the one place a string becomes markup in Studio's own window, and it passes a policy whose `createHTML` throws — naming what it found — if anything script-shaped survived sanitization. Its `createScript` and `createScriptURL` refuse outright.

:::doc-note
**Enforcement is declined, not pending.** `require-trusted-types-for 'script'` gates `eval` and `new Function` as well as DOM injection — and the interpreter _is_ those calls, in the canvas and in Studio's window alike. Enforcing would mean a policy that passes scripts through, which satisfies the API and defends nothing. Studio's remaining injection sinks belong to the libraries it bundles, which no policy of Jx's can route.
:::

This is why the canvas and the shell keep separate policies permanently — and it works only because the canvas is a real page with its own response: a frame loaded over `http` gets its own policy, while a `srcdoc` frame inherits its parent's.

## Treat documents as code

A Jx document is executable input. Loading and rendering an untrusted document in the interpreter runs its code; **compiling** an untrusted document runs its code at build time (template text becomes code in the bundle). Give a `.json` document the same trust you would give a `.js` file from the same source.

If you compile documents you did not author — user-submitted content merged into the tree, for example — sanitize or escape `${` sequences first.

## The data and session boundary

A site with a database and sign-ins has a second security surface: the `/_jx/*` routes the [generated worker](/docs/framework/site/deployment) serves. Nothing there trusts the browser.

**Every table declares its own rules.** A `data` table's `permissions` carry one rule per action — `read`, `insert`, `update`, `delete` — each of them `public`, `none`, `authenticated`, `owner`, or `role:<name>`. The defaults are read `public` and every write `none`, so a table you have just declared is readable by anyone and writable by no one until you say otherwise. Rules are evaluated on the server for every request; there is no client-side check to bypass.

**Authorization fails closed.** Anything beyond `public` and `none` needs the auth extension: it mounts first and publishes the session hooks the data mount authorizes against. Without it those rules deny — a missing auth mount answers 401, never a silent grant. The session lookup itself is fail-closed too: an unreachable auth backend reads as signed out rather than as trusted.

**Ownership cannot be forged.** When a table declares an `ownerField`, the server stamps that column with the signed-in user's id on every session-granted insert, and scopes `owner` reads and writes to rows that match — the value in the request body is not consulted. Roles work the same way: they live in the `user` table's `role` column, which sign-up input can never set.

**Secrets stay names.** `project.json` records env-var _names_ (`urlEnv`, `secretEnv`, `clientIdEnv`), never values. Values reach code only through the server's `env` — from the git-ignored `.dev.vars` locally, from your host's secret store in production — which is also why a `timing: "server"` entry is the right home for anything holding a credential. See [Auth and secrets](/docs/studio/data/auth-and-secrets).

:::doc-warning
A table with `insert: "public"` is an open write endpoint: anyone on the internet can post rows to it, and there is no rate limiting or CAPTCHA in the contract today. Prefer `authenticated` inserts unless you knowingly want a public drop-box.
:::

The extension-author side of the same model — what a mount may and may not do — is [Security and secrets](/docs/extending/extensions/security).

## The dev server's network controls

The dev server binds loopback by default and gates its remote-code-execution routes (`/__jx_resolve__`, `/__jx_server__`), extension mounts, and the whole `/__studio/*` API behind an Origin/Host check, with realpath path containment. See [Dev server internals](/docs/extending/embedding/dev-server) and `@jxsuite/server` §4.2 for the full model.

## Related

- [References](/docs/framework/concepts/references) — `$ref` binding vs. `${}` templates
- [Dev server internals](/docs/extending/embedding/dev-server) — the network security model
- [Auth and secrets](/docs/studio/data/auth-and-secrets) — sessions, roles, and where secret values live
- [Data tables](/docs/studio/data/tables) — where the permission rules are declared
- [Security and secrets](/docs/extending/extensions/security) — the same boundary from an extension author's side
