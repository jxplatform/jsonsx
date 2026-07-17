---
title: "Auth and secrets"
description: "How Jx Studio keeps secret values out of your project — .dev.vars locally, names on the wire — and what the auth extension adds to Studio today."
code:
  - packages/server/src/dev-vars.ts
  - packages/studio/src/ui/form-controls.ts
  - packages/studio/src/services/data-service.ts
  - extensions/auth/src/Auth.class.json
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

The `@jxsuite/auth` extension gives your site user accounts: sign-up and sign-in, sessions, and the table permission rules that depend on knowing who someone is. It's honest to say up front that **most of auth is server-side** — it runs a full authentication service (Better Auth) inside your site, and that machinery has no Studio panels of its own. What you see in Studio is three things: a settings section, its account tables in the data grid, and its building blocks for sign-in pages.

### The Authentication settings section

With the extension enabled, the **Settings** gear gains an **Authentication** section — a single form:

- **connection** — which of your **[connections](/docs/studio/data/connections)** stores the account tables; defaults to the first one you declared.
- **secretEnv** — the signing secret that protects sessions, as a secret field: paste any long random string and it's stored as described above.
- **methods** — first-party sign-in methods; **emailPassword** (on by default) enables classic email + password accounts.
- **providers** — social sign-in, keyed by provider (`github`, `google`, …). As everywhere, you configure env-var _names_ for each provider's OAuth credentials; the defaults follow the provider (`GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`), and the values go in your secrets.
- **redirects** — where visitors land after signing in or out.
- **roles** — role names you want to grant (say `admin`, `editor`), usable in table rules as `role:admin`.
- **trustedOrigins** — extra origins allowed to call the sign-in routes; most sites leave this empty.

### Account tables and roles

Auth keeps its users and sessions in ordinary database tables (`user`, `session`, `account`, `verification`) on the connection you chose. They're created by the same additive **[Push Schema](/docs/studio/data/tables)** flow — auth's steps appear at the end of the push plan — and they show up in the **[data grid](/docs/studio/data/grid)** like any other table. That grid _is_ the user-management surface today: to make someone an `admin`, open the `user` table and set their `role` cell. Sign-up can never set a role, so roles only come from you.

### What the rules mean

Declaring auth is what makes table **permissions** beyond `public`/`none` work (**[Data tables](/docs/studio/data/tables)** is where you set them):

- `authenticated` — any signed-in user.
- `owner` — the user a row belongs to. The table's **ownerField** column is stamped with the signed-in user's id on every insert — visitors can't forge ownership — and reads and writes are scoped to their own rows.
- `role:<name>` — users whose `role` matches.

Without the auth extension these rules simply deny — the door fails closed, never open.

### Sign-in pages

Sign-in UI is built like everything else in Jx — from state. The auth extension provides a **Session** source (who is signed in right now, updating live, and empty on statically generated pages) and auth **actions** (sign in, sign up, social sign-in, sign out) that wire to a form's submit event, in the **[State panel](/docs/studio/logic/state)** like any other **[data source](/docs/studio/logic/data-sources)**. There are no ready-made sign-in components to drop in today.

### Current limits

- No emails are sent yet — no address verification and no password reset; email accounts work immediately after sign-up.
- A table with `insert: "public"` accepts writes from anyone on the internet. Prefer `authenticated` inserts unless you knowingly want an open drop-box.

## Next

- **[Data tables](/docs/studio/data/tables)** — put the permission rules on your tables
- **[Data grid](/docs/studio/data/grid)** — manage users and roles by editing rows
