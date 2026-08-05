---
title: "Auth and secrets"
description: "How Jx keeps secret values out of your project — names on the wire, values in .dev.vars — and how the auth extension adds accounts, sessions, and sign-in."
code:
  - packages/server/src/dev-vars.ts
  - packages/studio/src/ui/form-controls.ts
  - packages/studio/src/services/data-service.ts
  - extensions/auth/src/Auth.class.json
  - extensions/auth/src/Session.class.json
  - extensions/auth/src/AuthActions.class.json
  - extensions/auth/src/session.ts
  - extensions/auth/src/actions.ts
  - extensions/auth/src/config.ts
  - extensions/auth/schemas/project.fragment.schema.json
---

# Auth and secrets

Two related subjects live here: how Studio handles values that must stay secret (database URLs, signing keys, API credentials), and what the auth extension — user accounts and sign-in for your site — adds to Studio.

## Secrets: values stay put, names travel

A hard rule runs through everything database-related: **secret values never enter your project files.** What `project.json` records is only the _name_ of an environment variable — `MAIN_URL`, `AUTH_SECRET` — and the value lives elsewhere:

- **Locally**, values are stored in `.dev.vars` at your project root — a plain name-equals-value file that is ignored by git, so a commit can never carry a credential. The dev server and the desktop app read it automatically whenever a database or auth feature needs the value.
- **Deployed**, the same names are looked up in your host's environment. You set the values there once — for Cloudflare, with `wrangler secret put` or the dashboard's environment settings.

In Studio you meet this as the **secret field**: settings that hold something sensitive (a Supabase URL in **[Connections](/docs/studio/data/connections)**, the auth signing secret below) render as a password-style box. Paste the value and press :kbd[Enter]; Studio sends it to the backend's secret store, the box empties, and from then on it just reads "Stored as MAIN_URL" — the value is write-only and is never displayed or sent back to the browser again. The derived name is what gets written into `project.json`. To replace a value, paste a new one; to inspect what's stored, open `.dev.vars` itself — Studio will only ever show you the names.

:::doc-warning
`.dev.vars` is the one place your local secret values exist — it is deliberately not committed, so back it up your own way, and re-enter the values (or copy the file) when moving to another machine.
:::

## The auth extension

The `@jxsuite/auth` extension gives your site user accounts: sign-up and sign-in, sessions, and the table permission rules that depend on knowing who someone is. It's honest to say up front that **most of auth is server-side** — it runs a full authentication service (Better Auth) inside your site, mounted at `/_jx/auth`, and that machinery has no Studio panels of its own. What you see in Studio is three things: a settings section, its account tables in the data grid, and its building blocks for sign-in pages.

### Turn it on

Auth is an extension package, and it keeps its accounts in a database, so it builds on what **[Databases](/docs/studio/data)** already set up:

1. **Have a connection.** Add one in **[Connections](/docs/studio/data/connections)** if the project has none — the account tables live on one of them.
2. **Install the package.** Type `@jxsuite/auth` into _Settings > Dependencies_ and click **Add** (see **[Dependencies and imports](/docs/studio/projects/dependencies)**).
3. **List it as an extension.** Open `project.json` and add `"@jxsuite/auth"` to its `extensions` array — that list is what switches the section on. Studio has no field for it yet, so this one edit happens in **[Code mode](/docs/studio/logic/code)**; the array is described in **[project.json](/docs/framework/site/project-json)**.
4. **Pick a server-capable adapter.** In **[Project settings](/docs/studio/projects/settings)**, set the deployment target to Cloudflare Pages, Cloudflare Workers, Node, or Bun. A site with accounts is no longer purely static, and the build says so if you leave it on Static.

Reopen Settings and an **Authentication** section is waiting. Filling it in writes an `auth` section into `project.json`.

### The Authentication settings section

The section is a single form, and every field is optional — the defaults below are what applies when you leave one blank:

- **connection** — which of your **[connections](/docs/studio/data/connections)** stores the account tables. Defaults to the first one you declared.
- **secretEnv** — the _name_ of the environment variable holding the signing secret that protects sessions. Defaults to `BETTER_AUTH_SECRET`. It renders as a secret field: paste any long random string and it's stored as described above. Auth refuses to start without a value for it.
- **methods** — first-party sign-in methods; **emailPassword** (on by default) enables classic email + password accounts.
- **providers** — social sign-in, keyed by provider (`github`, `google`, …), each with a **clientIdEnv** and **clientSecretEnv**. As everywhere, these are env-var _names_; leave them blank and the provider's own defaults apply (`GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`). Setting one up takes a couple more steps — see **Social sign-in** below.
- **redirects** — **afterSignIn** and **afterSignOut**: the paths a visitor lands on after each. Leave them empty and the page stays where it is.
- **roles** — role names you want to grant (say `admin`, `editor`), usable in table rules as `role:admin`. Declaring any role is also what adds the `role` column to the `user` table.
- **trustedOrigins** — extra origins allowed to call the sign-in routes; most sites leave this empty, since a site's own pages are always allowed.

### Account tables and roles

Auth keeps its users and sessions in ordinary database tables (`user`, `session`, `account`, `verification`) on the connection you chose, and they show up in the **[data grid](/docs/studio/data/grid)** like any other table. That grid _is_ the user-management surface today: to make someone an `admin`, open the `user` table and set their `role` cell. Sign-up can never set a role, so roles only come from you.

The tables are created for you two ways: `jx dev` creates them the first time anything touches `/_jx/auth`, and **[Push Schema](/docs/studio/data/tables)** plans them as its own steps after the connector's, so a dry run shows them before anything runs.

:::doc-warning
`jx db push` from a terminal covers your **Data Tables** only — the account tables are not part of the CLI push today. A database that only ever received a CLI push has no `user` table, and sign-in fails against it.
:::

### What the rules mean

Declaring auth is what makes table **permissions** beyond `public`/`none` work (**[Data tables](/docs/studio/data/tables)** is where you set them):

- `authenticated` — any signed-in user.
- `owner` — the user a row belongs to. The table's **ownerField** column is stamped with the signed-in user's id on every insert — visitors can't forge ownership — and reads and writes are scoped to their own rows.
- `role:<name>` — users whose `role` matches.

Without the auth extension these rules simply deny — the door fails closed, never open.

### Sign-in pages

There are no ready-made sign-in components to drop in. You build the pages yourself, from ordinary elements plus two sources the extension adds to the **+ Add…** picker in the **[State panel](/docs/studio/logic/state)**, alongside every other **[data source](/docs/studio/logic/data-sources)**.

**Session** — who is signed in, kept up to date as that changes. It gives you the signed-in user's **id**, their whole **user** record (email, name, and anything else the account carries), and their **role** when they have one — or nothing at all when no one is signed in. Bind a greeting to the email, and hide the "Sign in" link when a session exists.

One thing to plan around: **the session is always empty at build time.** Your pages are prerendered, and there is no visitor and no browser during a build, so the HTML that ships always shows the signed-out state; the signed-in version appears a moment later, once the page loads and asks the server who is there. That is a consequence of how Jx publishes, not a bug — so keep the signed-out state presentable, and don't put anything at the top of a page that only makes sense to someone signed in.

**Auth actions** — the four handlers a form's submit event points at: **sign in with email**, **sign up with email**, **sign in with a provider**, and **sign out**. Each one reads the fields of the form that submitted it, so the **name** you give each input is the contract:

| Handler        | Reads                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------- |
| `signInEmail`  | `email`, `password`                                                                                     |
| `signUpEmail`  | `email`, `password`, and optionally `name` — without it, the part of the address before the `@` is used |
| `signInSocial` | `provider` — or the default provider set on the state entry                                             |
| `signOut`      | nothing — wire it to a button's click                                                                   |

An input named anything else is invisible to the handler, and the attempt goes out with an empty value.

On success a handler stops the browser's own form submission, refreshes the session, re-runs the page's table queries — so a list scoped to `owner` fills in the moment someone signs in — and sends the visitor to the matching **redirect** if you configured one. On failure (wrong password, an address that already has an account) the page is simply left as it was; surfacing a message is up to you.

:::doc-note
The wiring is two state entries and one property on the form. The **[Events](/docs/studio/logic/events)** section of the Inspector's **Logic** tab (:kbd[⌘⇧3]) lists plain functions in its handler picker, and an auth handler is one key inside a state entry rather than a function of its own — so point the form at it in **[Code mode](/docs/studio/logic/code)**:

```json
{
  "state": {
    "session": { "$prototype": "Session", "timing": "client" },
    "auth": { "$prototype": "AuthActions", "timing": "client" }
  },
  "tagName": "main",
  "children": [
    {
      "tagName": "form",
      "onsubmit": { "$ref": "#/state/auth/signInEmail" },
      "children": [
        { "tagName": "input", "attributes": { "type": "email", "name": "email", "required": "" } },
        {
          "tagName": "input",
          "attributes": { "type": "password", "name": "password", "required": "" }
        },
        { "tagName": "button", "textContent": "Sign in" }
      ]
    },
    { "tagName": "p", "textContent": "${state.session ? state.session.user.email : 'Signed out'}" }
  ]
}
```

`Session` resolves to `{ userId, role?, user }` or `null`, so `${state.session?.userId}` and `${state.session?.role === 'admin'}` are the expressions to reach for. `AuthActions` resolves to a map of the four handlers, which is why the reference is `#/state/auth/signInEmail`. Both belong to the browser — `"timing": "client"` is what the State panel writes for them, and it keeps the build from trying to resolve a session that can't exist yet. Both also accept an optional `baseUrl`; without one they talk to the site's own `/_jx/auth`.
:::

### Social sign-in

A provider needs three things, in this order:

1. **Register an OAuth app** with the provider (GitHub, Google, …). The redirect — or callback — URL to give it is your site's origin plus `/_jx/auth/callback/` and the provider's id: `https://example.com/_jx/auth/callback/github`. Add a second app, or a second callback URL, for local development against `http://localhost:3000`.
2. **Store the credentials as secrets**, under the names the settings form shows — `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` unless you changed them. Locally that means `.dev.vars`; deployed, your host's secret store.
3. **Point a form at the social sign-in handler**, with the provider id in a field named `provider` (a hidden input on a per-provider button works well).

Two behaviors to know. A provider whose id or secret has no value is dropped from the configuration entirely — nothing fails at startup, the sign-in attempt just doesn't work — so check the names match if a button does nothing. And if your site reaches visitors through a different origin than the worker sees (a proxy, or a custom domain in front of it), set `BETTER_AUTH_URL` to the public origin, `https://example.com`; otherwise the origin is taken from each incoming request and the provider can send people back to the wrong place. `BETTER_AUTH_URL` isn't secret, but it's set the same way as the other environment values.

### Current limits

- No emails are sent yet — no address verification and no password reset; email accounts work immediately after sign-up.
- A table with `insert: "public"` accepts writes from anyone on the internet. Prefer `authenticated` inserts unless you knowingly want an open drop-box.
- Sign-in errors aren't surfaced for you; a failed attempt leaves the form as it was.

## Next

- **[Data tables](/docs/studio/data/tables)** — put the permission rules on your tables
- **[Data grid](/docs/studio/data/grid)** — manage users and roles by editing rows
- **[project.json](/docs/framework/site/project-json)** — the `auth`, `connections`, and `data` sections as committed config
- **[Security](/docs/framework/concepts/security)** — what the server enforces, and what it never trusts
