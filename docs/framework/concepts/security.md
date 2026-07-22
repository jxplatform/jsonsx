---
title: "Security and the evaluation surface"
description: "Where Jx runs document code, why compiled sites need no unsafe-eval, and how to treat untrusted documents."
spec:
  - spec.md#21
---

# Security and the evaluation surface

A Jx document contains executable code: `${}` templates and function `body`/`$src` entries. Where that code runs depends on how you ship the project, and the security posture follows from it.

## Compiled sites run no eval

`jx build` produces plain HTML/CSS plus per-island ES modules. It does **not** emit `new Function` or `eval` — a `${}` template is spliced verbatim into an emitted module as a real template literal, and expressions and statements lower to genuine JavaScript. So a compiled static or island page runs under a **strict Content-Security-Policy with no `'unsafe-eval'`**. This is enforced by a compiler test (`packages/compiler/tests/no-eval.test.ts`).

Ship compiled output to production and the eval requirement disappears — that is the main reason the compiler exists.

## The interpreter needs `'unsafe-eval'`

The interpreting runtime — the dev server, the Studio canvas, and `@jxsuite/runtime` used directly as a library — compiles `${}` templates and inline `body` functions with `new Function` on the fly. Any page that hosts the interpreter must allow `'unsafe-eval'` in its CSP.

:::doc-warning
`${}` templates are **full JavaScript**, not a sandbox. A template has the component's `state` in scope, but also the entire global environment, and it can assign or call side effects. Do not render a template built from untrusted input in the interpreting runtime.
:::

## Treat documents as code

A Jx document is executable input. Loading and rendering an untrusted document in the interpreter runs its code; **compiling** an untrusted document runs its code at build time (template text becomes code in the bundle). Give a `.json` document the same trust you would give a `.js` file from the same source.

If you compile documents you did not author — user-submitted content merged into the tree, for example — sanitize or escape `${` sequences first.

## The dev server's network controls

The dev server binds loopback by default and gates its remote-code-execution routes (`/__jx_resolve__`, `/__jx_server__`), extension mounts, and the whole `/__studio/*` API behind an Origin/Host check, with realpath path containment. See [Dev server internals](/docs/extending/embedding/dev-server) and `@jxsuite/server` §4.2 for the full model.

## Related

- [References](/docs/framework/concepts/references) — `$ref` binding vs. `${}` templates
- [Dev server internals](/docs/extending/embedding/dev-server) — the network security model
