# Standards Adoption Program

**Status: complete. Build track B1–B15, smaller items §4.11, and services track S1–S9 all shipped.** Branch: `claude/standards-adoption-impl-4f3ald` (was `feat/standards-registry`). Started 2026-08-14, finished 2026-08-16.

This document is the working plan **and** the status board. It was migrated into the repository so the program can be continued from anywhere — everything needed to pick up the next phase is here, including the operational knowledge that is not derivable from the code.

---

## 0. What this program is

An audit of all 16 specs found Jx's standards reference derived almost entirely from WHATWG and, to a lesser extent, Ecma. The IETF surface was **two RFCs** (6901, 4180) and the W3C surface was effectively nothing.

That gap was not cosmetic. It showed up as real defects: a redirect shape the schema forbade and the compiler read, `/node_modules/…` URLs that 404 in production, an i18n config nothing read, a runtime loaded from a third-party CDN with no integrity story, and `slugifyHeading` reducing every non-Latin heading to the empty string.

**Intended outcome:** every standard Jx relies on is cited next to the contract it binds, in a table a machine reads; every standard it _should_ rely on and does not is a tracked, addressable gap; and the highest-leverage gaps are closed.

**Current state:** 116 bindings across 16 specs, 5 standards on the adoption backlog, and a green `bun run docs:standards`.

**Three gap ids remain, and each is a live `Subset` row rather than unstarted work** — they name the part of a standard the repo does not claim, which is what a gap id is for:

| Gap                  | Where                                    | What is left                                                                                                                                                                                                                 |
| -------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| gap:wcag-conformance | studio-ui-guidelines.md §1.1, §8.2, §8.7 | Four criteria are met and checked (4.1.3, 2.5.7, 1.4.3/1.4.11, 1.4.1). No level is claimed, because claiming one needs an end-to-end audit in a browser.                                                                     |
| gap:apg-coverage     | studio-ui-guidelines.md §6, §8, §12      | Tree, menu, toolbar, radiogroup, combobox and dialog are done. The tab strips still carry no tab semantics; the Tabulator grid is deliberately left alone (hand-authoring role="grid" over virtualized rows makes it worse). |

`gap:example-only` is reserved for `standards.md` §4.4's worked examples and names no work.

## 1. Decisions taken — do not re-litigate

| Decision          | Choice                                                                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registry location | Specs own the tables. A numbered ## N. Standards Alignment section per spec; a parser derives the registry; a gate validates it; docs:generate emits docs/extending/reference/standards.md. |
| Delivery          | Foundation → citations → domain PRs. Machinery first, then every citation and the whole gap list, then domain PRs close gaps and flip rows with evidence.                                   |
| i18n              | Full site-architecture.md §13 implementation, not just validation.                                                                                                                          |
| Extras            | All four in scope: PWA, security.txt + .well-known, JSON Feed + RFC 5005 alongside Atom, WebDriver BiDi for the screenshot pipeline.                                                        |
| Shadow DOM        | Opt-in only. Light DOM stays the default.                                                                                                                                                   |
| Breaking changes  | Acceptable and expected — the platform has very few adopters.                                                                                                                               |

## 2. Status board

Legend: **✅ shipped** · **◻ not started** · **◐ partly shipped, remainder named**

### Foundation

| PR   | Title                          | Status | Commits                             |
| ---- | ------------------------------ | ------ | ----------------------------------- |
| PR 0 | Registry, gate, generated page | ✅     | 879e01ad                            |
| PR 1 | Cite standards in all 16 specs | ✅     | dfc29aa9 e222de30 de7dd2ee ab02006d |

PR 0 shipped `specs/standards.md` (the contract), `scripts/docs/lib/standards.ts` (the parser), `scripts/docs/check-standards.ts` (~52 violation codes), `scripts/docs/standards.json` (the catalogue), and the `docs:standards` gate. PR 1 landed every citation; **both ratchets are empty**, so a new spec with numbered headings and no table fails on its first PR.

### Build track — complete

| PR  | Title                                    | Status | Commit(s)         |
| --- | ---------------------------------------- | ------ | ----------------- |
| B1  | Redirects: schema, statuses, HTML policy | ✅     | f6080eff          |
| B2  | _headers + .nojekyll                     | ✅     | 48ff6365          |
| B3  | Sitemap standards pass                   | ✅     | f0c7a224          |
| B4  | Head assembly                            | ✅     | 61484bcc 68757151 |
| B5  | Date coercion                            | ✅     | 5ccb99e3          |
| B6  | Responsive images                        | ✅     | 14f920de          |
| B7  | /node_modules → /assets                  | ✅     | 038cc401          |
| B8a | Self-host the client runtime             | ✅     | b2ab1b13          |
| B8b | Content-Security-Policy                  | ✅     | 139402bb          |
| B9  | i18n core                                | ✅     | b806b4cc          |
| B10 | Feeds (Atom + JSON Feed + RFC 5005)      | ✅     | 6269bced          |
| B11 | hreflang alternates + sitemap xhtml:link | ◐      | 106a924c          |
| B12 | Manifest + .well-known/security.txt      | ✅     | 8e6dfca8          |
| B13 | Service worker + tombstone               | ✅     | 688e4fd5          |
| B14 | Opt-in Declarative Shadow DOM            | ✅     | 1d9954b4 4a8f2e59 |
| B15 | Media types + I-JSON                     | ✅     | 3e7db19e 1934e7c1 |

**B11 is complete.** Discovery shipped first (alternates in `<head>` and the sitemap); negotiation followed — see §4.1, now closed.

### Services track — not started

| PR  | Title                               | Status | Depends on |
| --- | ----------------------------------- | ------ | ---------- |
| S1  | RFC 9457 Problem Details            | ✅     | —          |
| S2  | Fetch Metadata + loopback hardening | ✅     | —          |
| S3  | Collab subprotocol                  | ✅     | —          |
| S4  | Auth hardening (RFC 8252 + cookies) | ✅     | S2         |
| S5  | ECMA-402 + Unicode                  | ✅     | —          |
| S6  | Accessibility (live region first)   | ✅     | —          |
| S7  | ATAG Part B surface                 | ✅     | S6         |
| S8  | Trusted Types + Studio-shell CSP    | ✅     | —          |
| S9  | WebDriver BiDi for screenshots      | ✅     | —          |

### What each phase changed, and what it found

The designs below held. What follows is only what they did **not** anticipate — the part worth reading before touching any of this again.

- **S3.** The probe had to become the negotiation input, as designed. What the design missed is that `new WebSocket(url, [])` is **not** the same as `new WebSocket(url)` — an empty array still sends the header, and a server that echoes nothing then fails the connection. The client offers no `protocols` argument at all when the list is empty, and a test pins the distinction.
- **S4.** Two Better Auth defaults were wrong for Cloudflare Workers in the same way: both `useSecureCookies` and `rateLimit.enabled` fall back to `NODE_ENV === "production"`, which is **unset** there. The library's own defaults therefore shipped non-`Secure`, unprefixed session cookies with rate limiting off, in production. Reaching `__Host-` also meant setting `useSecureCookies: false` and restoring `Secure` by hand, because the library prepends `__Secure-` to whatever name it is given — a test asserts the resulting names so a library upgrade is loud.
- **S5.** `i18n.timeZone` was **not** added. The determinism fix is a fixed `UTC` default in the helpers, which is what the test proves; a config key nothing reads is the exact defect §4.1 of this document records `i18n` itself having had. Also: Bun's `Intl.Segmenter` answers `isWordLike: false` for a mixed alphanumeric segment (`v3`, `h1`), so the word-count predicate is spelled out as "contains a letter or a digit" rather than trusting the flag.
- **S6.** The live region was the whole point and it landed. The contrast gate found one real failure — white on the brand blue is **3.68:1**, below the 4.5:1 normal text owes — and it is on the debt list rather than fixed, because darkening the brand is a design decision. The guidelines-vs-tokens rule found **seven** wrong hex values, one more than the six this document predicted.
- **S7.** Shipped as a model plus a Problems reporter and a command, **not** a modal: Problems is already the surface for records that outlive the frame you were not watching, and a second one would have been a window to open. B.3.2 is partial and says so — most repairs have no command yet, and naming one that merely reopens a panel would put a button on a finding that does not do what the button says.
- **S8.** The scope check was worth doing: under Trusted Types `eval` and `new Function` **are** gated, so the shell ships the policy and does not enforce. The policy refuses rather than passing through, which is the difference between a control and a ceremony. **The report-only run has since been removed, and `gap:trusted-types` retired.** It answered its question — every violation belonged to a dependency's sink or to the interpreter, and no Jx-owned sink remained — and once answered, the emitter could only file warnings about a decision already taken. A Problems panel that reports what its reader cannot act on teaches its reader to stop reading it. The one finding worth acting on was in the other profile: the compiler emitted `this.innerHTML = ''` into every light-DOM element module, so the runtime's `replaceChildren()` change now reaches shipped sites too.
- **S9.** BiDi drives everything the pipeline needs, and the captured bytes are **identical** — verified by capturing the same shot over each protocol and hashing. One real difference: BiDi refuses a pointer move outside the viewport, where CDP allowed `(-1, -1)`. Fixed in the pipeline rather than worked around.

### Smaller items track — complete

Everything §4.11 named, plus two red gates the work uncovered:

| Item                                                                  | Status |
| --------------------------------------------------------------------- | ------ |
| gap:bcp47-locale-validation — a schema pattern on the language tags   | ✅     |
| gap:sse-reconnect — retry: and one reload on Last-Event-ID            | ✅     |
| gap:markdown-variant, gap:yaml-media-type — what hosts actually serve | ✅     |
| gap:link-relation-validation — the IANA registry, checked             | ✅     |
| gap:identifier-syntax — UAX #31 §R4 at the parse boundary             | ✅     |
| gap:sitemap-fields — a generated route's own <lastmod>                | ✅     |
| BCP 14 — standards.md §12, gated by docs:status                       | ✅     |
| ECMA-426 source maps — recorded Rejected                              | ✅     |
| RFC 7464 — already Rejected; the NDJSON drop counter shipped          | ✅     |

**Two gates were already red before any of this work**, and both are worth remembering as a pattern:

- `bun run schema:verify` failed on the branch: B8b, B13 and B14 each added a project-config key and none re-ran `generate:schema`, so the committed core schema and all 25 per-project entry documents described a config three phases behind the compiler. **A phase that changes `defs/` must run `generate:schema` and `schema:generate-all`, not one or the other.**
- The container's Bun was one patch behind the CI pin, which produced **29 phantom test failures** in `packages/schema` from an ajv ESM-interop difference. Match `.github/actions/setup-bun` before believing a failure.

## 3. What the build track actually shipped

Read this before touching any of it — several phases established contracts later phases depend on.

- **B1** `REDIRECT_STATUSES = [301,302,303,307,308]`; rewrite modelled as `{destination, rewrite:true}` rather than as status 200, which is a host convention and not a redirection status.
- **B2** `dist/_headers` and `.nojekyll`. `IMMUTABLE_PATTERN = "/images/_optimized/*"` is the **only** content-addressed output; `NEVER_IMMUTABLE = ["/components/*","/assets/*"]` is asserted by a test. Several later phases key off this distinction.
- **B4** `headEntryKey` widened to `rel` + `href` + whichever of `hreflang`/`type`/`media`/`sizes` is present. **B10 and B11 both depend on this** — without it a set of `rel="alternate"` links collapses to one.
- **B5** Dates coerced to RFC 3339 in `content-loader.ts`, between `load` and `validateEntries` — the only point holding both entries and schema.
- **B6** `<picture>` per format (a bare AVIF `srcset` is undecodable to a browser that declines AVIF); `img-loading.ts` is the single owner of `loading`/`decoding`/`fetchpriority`; the LCP image is no longer force-lazied; `lazyLoad` is independent of `optimize`.
- **B7** `$head` bare specifiers are **copied** to `/assets/`, `$elements` are **bundled** there. One claim map arbitrates the shared URL space; an unresolvable specifier is a build error.
- **B8a** `@vue/reactivity` and `lit-html` bundled from **the compiler's own dependencies** into `/assets/`. SRI is `Divergent`: the gap closed by removing the subresource, not by attesting to it.
- **B8b** CSP derived from a scan of **finished HTML**. Strict `script-src`; `style-src` keeps `'unsafe-inline'` and is recorded as a divergence. Off by default.
- **B9** `packages/schema/src/locale.ts` (BCP 47 via `Intl.Locale`) and `packages/compiler/src/site/i18n.ts` (route-prefix locales, script-derived `dir`, `$page.locale`).
- **B12** Manifest and `security.txt`; a past `Expires` fails the build.
- **B13** Service worker with the tombstone contract. `serviceWorker: false` ≠ deleting the key.
- **B14** `$shadow` opt-in emitting a declarative shadow root the element **adopts**.
- **B15** RFC 6838 media-type parsing, `text/markdown; variant=GFM`, and I-JSON enforced at the document parse boundary.

## 4. Remaining work

### 4.1 i18n negotiation — the open half of B11 ✅ **shipped**

> Shipped as `packages/compiler/src/site/locale-negotiation.ts`, with `site-architecture.md` §13.6. The design below was followed; two things are worth carrying forward. The negotiation is **middleware, not a route** — when the negotiated locale is the one `/` already serves the request has to continue down whatever chain the adapter uses, and a route would have to reproduce it. And the algorithm exists twice, in TypeScript and as the JavaScript the worker gets, because the worker bundles from the _project_ root and cannot import the compiler; a test evaluates the emitted source and drives it through the same corpus as the implementation, which is the only thing standing between two copies and a silent divergence.

`gap:locale-lookup` (RFC 4647) and the `Accept-Language` half of RFC 9110 §12.5.4.

Discovery is done. What is missing is sending a visitor to their own language, which needs a request — and **the static path does not have one**. The design must state which deployment shapes can negotiate and which cannot, rather than implying a universal feature:

- **Adapter-less static output**: cannot negotiate. There is no runtime router; the preview server is a pure file mapper. This is a `Divergent` row, not a gap to close.
- **The generated worker** (`build.adapter` set): can. Read `Accept-Language`, run RFC 4647 _lookup_ (not filtering) against `i18n.locales`, redirect or rewrite the bare `/`, and emit `Vary: Accept-Language` — without which any cache in front of the site serves one visitor's language to everyone.

`translationKey()` and `localeAlternates()` in `packages/compiler/src/site/i18n.ts` already model translation sets; the lookup needs the same canonicalization (`canonicalizeLocale`) so a tag matches the same way it does everywhere else.

~~Also still open here: `{locale}` in a collection `source` is not expanded (§13.3 is `Pending`), and `prefix-always` is accepted but not enforced.~~ **Both shipped.** `{locale}` expands in `extensions/parser/src/content-loader.ts` (§13.3 is `Implemented`), and `unprefixedRoutes` in `packages/compiler/src/site/i18n.ts` is called from `site-build.ts` and warns, naming every route outside the locale tree. The warning is deliberately not an error: the author may genuinely mean it, and failing a build over a page that works would be the compiler overruling a decision it cannot see the reason for.

### 4.2 S1 — RFC 9457 Problem Details ✅ **shipped**

> Shipped as `packages/protocol/src/{problem,problems}.ts`, `packages/server/src/problem.ts` and `packages/server/scripts/check-error-shapes.ts`, with `server.md` §4.3. The plan held, including the `error`\-alias sequencing and all three "would be wrong" exemptions. Two things it did not anticipate: **401 and 403 needed separate types** (the status belongs to the type, and collapsing them made a missing API key indistinguishable from a refused root), and `gitPull`'s documented `409 {conflicts}` was **structurally impossible** to produce — `runGit` threw `stderr` alone and git writes every CONFLICT line to stdout. Both are fixed.

`@jxsuite/protocol` is the home: the only package both the server and Studio already depend on. Two new files — `problem.ts` (shape and constructors) and `problems.ts` (a `PROBLEM_TYPES` registry in `STUDIO_ROUTES`'s exact idiom, so the same generator and drift machinery applies).

`type` URIs are **absolute** under `https://jxsuite.com/problems/`: a relative reference resolves against the request URL, which on the dev server is `http://127.0.0.1:3000/problems/…` and serves nothing. `instance` is deliberately **not** emitted — Jx has no per-occurrence resource, and a field whose only possible value is a fabrication is noise.

`PlatformErrorInfo` reconciles cleanly because RFC 9457's `type` **is** the code: `problemSlug(type)` derives it, and `installUrl`/`conflicts` become extension members.

**The sequencing unlock for a ~160-site change:** emit `error` as an extension member equal to `detail` for one release. Every existing client reader keeps working, so the server PR lands alone, the client PR follows, and a third one-line PR deletes the alias.

**Three places where adopting RFC 9457 would be wrong** — say so rather than converting them: the code-services routes stay 200 (a syntax error in the author's snippet is the _result_, not a transport failure); the AI model-catalogue route stays 200 (degraded success that still delivers a catalogue); and in-stream frames are not response bodies — a mid-stream failure cannot change a status code, so the right adoption is to make the frame _carry_ a problem object.

Guard regrowth with `packages/server/scripts/check-error-shapes.ts` in `check-styles.ts`'s ratcheting-allow-list idiom, banning bare-text 4xx/5xx responses, `{error:` bodies, and `Access-Control-Allow-`.

Gaps closed: `gap:backend-failure-contract`, `gap:studio-problem-details`, `gap:studio-error-reader`, `gap:ai-problem-details`.

### 4.3 S2 — Fetch Metadata and loopback hardening ✅ **shipped**

> Shipped in `packages/server/src/net-guard.ts`, with `server.md` §4.2. Everything the design named landed, including the `embeddable` policy and the `fetchMetadataAbsentIsAccepted` test. One thing it did not: tokening `/__studio__/ai/*` meant the desktop had to append the token, and `ai-models.ts` derived the models URL with `chatUrl.replace(/\/chat$/, …)` — a regex anchored on the end of the string, which silently stopped matching the moment a query appeared and would have pointed the models request at the chat endpoint. **A "one-line" gate change reached three packages.**

One predicate folded into the existing `originHostGate`, so **zero new call sites**. `Sec-Fetch-Site: same-origin`/`none` allow; `cross-site` allows only a top-level document navigation; `same-site` **denies** — stricter than the standard Resource Isolation Policy and justified: on `127.0.0.1` there is no meaningful "site" broader than the origin, so `same-site` means a different port on the same host, which is precisely the other-local-process threat the loopback bind cannot address.

**Absent ⇒ accept is a hard requirement.** The header is browser-supplied; `packages/server/tests/**` builds 124 bare `Request`s, and curl, Bun-native clients and the desktop RPC bridge all omit it. Name the test pinning this so its deletion is loud.

A second, looser `"embeddable"` policy is needed for the project server's static branches, because the desktop canvas iframe's subresources arrive `cross-site`.

Same PR closes: the ungated `/_jx/*` (gate on Origin/Host, **not** the token — the canvas iframe's own fetch carries no `?token=`); `/__studio__/ai/*` (this one _does_ need the token, which means a desktop-side edit to append it); `127.0.0.0/8` in `LOOPBACK_HOSTS` (but `0.0.0.0` accepted only as a `Host`, never as an `Origin`); a constant-time token compare; and `Authorization: Bearer` accepted additively.

**Add a "never CORS" rule** to `server.md` §4.2 and to the guard script. There is no `Access-Control-Allow-*` anywhere in the repo today and that is load-bearing — the whole loopback model rests on the browser refusing cross-origin reads.

Gap closed: `gap:fetch-metadata`.

One free fix while in there: `normalizeForCompare` does not normalize Unicode, so an NFD path from `readdir` and an NFC path from a picker compare unequal and containment silently fails on any accented path. One `.normalize("NFC")`.

### 4.4 S3 — Collab subprotocol ✅ **shipped**

`jx.collab.v1` — one token per wire-envelope major. Bump when `decodeFrame` would mis-parse a peer's frame; **do not** bump for a new frame type, since both sides tolerate unknowns.

**The hazard that makes the probe load-bearing:** RFC 6455 §4.1 requires a client that offered subprotocols and received no echo to _fail the connection_, and browsers enforce it. A new Studio against an old dev server would lose collab entirely. So the probe — which already returns `{version: 1}` and which the client already throws away — becomes the negotiation input: `{collab, protocols, version}`, read by a shared `negotiate.ts` that both `devserver.ts` and `cloud.ts` call (`cloud.ts` never probes at all today).

**Do not put a version in the `hello` control message.** It arrives after the socket is up and after frames may have been sent — too late to prevent the divergent-history merge `schema.ts:45-46` warns about.

Gap closed: `gap:collab-subprotocol`.

**permessage-deflate: do not adopt**, and write the reasons into §5 so it is not re-litigated. lib0 Yjs updates are near-incompressible; the dominant frame volume is awareness cursors, where the deflate block header exceeds the payload; both transports are loopback or already compressed at the edge; and `Bun.serve` allocates a zlib context per socket.

### 4.5 S4 — Auth (depends on S2) ✅ **shipped**

**Device Flow is wrong for desktop and right for browser Studio.** RFC 8628 exists for input-constrained devices; a desktop app with a browser and a keyboard is not one. Desktop gets RFC 8252 loopback + PKCE; browser Studio keeps Device Flow; cloud keeps its brokered flow.

The host already exists — `project-server.ts` owns a loopback `Bun.serve` on an ephemeral port. Hard requirements: the redirect host is the literal `127.0.0.1`, never `localhost` (§8.3 — `localhost` can be redirected by a hosts entry); `S256` only; `state` compared constant-time, single-use, short TTL.

**The callback route must be exempt from the token gate** — the IdP redirects the browser and cannot carry `?token=`. It keeps the Host gate and Fetch Metadata, and an IdP redirect looks exactly like the one cross-site shape the strict policy admits. **This is why S4 depends on S2.**

Tokens go to the desktop's own config store at `0600`, **not `localStorage`**. An OS keychain is the right answer and a large dependency; ship the file and state the limitation.

**Three standards that apply vacuously — record, do not fake:** RFC 8414 discovery (GitHub publishes neither well-known document); RFC 7519/8725 JWT BCP (Jx issues and validates no JWTs — the strongest posture is not having one); RFC 8252 for the Cloudflare token (no authorization endpoint exists for third-party desktop clients).

Cookies: `buildAuthOptions` sets **no** cookie, session, rate-limit or password config today. Add `__Host-` derived from the scheme, explicit session lifetimes, and rate limiting. **`Partitioned` must not default on** — CHIPS is for third-party contexts; Jx auth cookies are first-party, and defaulting it forces `SameSite=None; Secure`. The `Cookie` prototype's unescaped-RegExp bug is best fixed by **not building a RegExp** — split on `"; "` and compare. The declared-but-unread `expires` should be **deleted**, not implemented (`maxAge` covers it; RFC 6265bis §5.5 makes `Max-Age` win). Note in the doc comment that `HttpOnly`'s absence is _correct_ for a JS-written cookie, so nobody "adds the missing attribute".

Gaps: `gap:oauth-pkce`, `gap:native-oauth`, `gap:cookie-prefixes`.

### 4.6 S5 — ECMA-402 and Unicode ✅ **shipped**

**`i18n.timeZone` belongs in scope and was missing from the audit.** `Intl.DateTimeFormat` with no `timeZone` uses the host's — the identical determinism bug to the locale one, and worse, because a date can shift by a whole day. Both default deterministically on the compiler path (`"en-US"`, `"UTC"`), and the test that proves it compiles the same document twice under different `TZ`/`LANG` and asserts byte-identical output.

**The four-place blessed-global registration is itself the defect**, and one of the four is a prose JSON-Schema description enumerating the helpers by name with no test checking it. Move the name list into `packages/schema` and have both the runtime and the schema description read it.

New helpers: `formatList`, `plural`, `compare` (collation — `sort()` on strings is code-unit order, wrong for every accented language), `displayName`, `segment`. **Not `DurationFormat`** — baseline support is not universal, and a blessed global that throws on a supported browser is worse than its absence.

**`slugifyHeading` has a mitigation that shrinks the blast radius to near zero:** `\w` includes `_` and `\p{L}\p{N}` does not, so keeping `_` in the character class makes the new implementation **byte-identical on every pure-ASCII heading**. Ship a test asserting exactly that against an ASCII corpus, plus legacy secondary anchors behind a flag for one release. Two notes for its doc comment: use `toLowerCase`, **not** `toLocaleLowerCase` (locale-sensitive casing would make one heading produce different anchors in different projects); and NFC _before_ casing is the whole UAX #15 payoff.

`readingTime` and `$wordCount` run in the parser under Bun, so `Intl.Segmenter` has no browser-support question. Keep 200 wpm and state the limitation rather than shipping a per-script table. SEO counters switch to grapheme counts; **do not model pixel width**.

Gaps: `gap:locale-formatting`, `gap:heading-slug-normalization`, `gap:word-segmentation`.

### 4.7 S6 — Accessibility ✅ **shipped**

**The single highest-value change in the program is a live region.** `notify.ts`'s own doc calls itself the app's only way to say what happened, and its default tier routes **error ⇒ problem** — but the `role="status"` host covers only _toasts_, and `problems-panel.ts` has no live region at all. So a failure currently reaches **no** live region. A panel-local region would also announce nothing while another Bottom-dock tab is showing. The fix is one shared announcer called from `notify()` itself — one call site, assertive for errors.

Then, in order of harm × cheapness: `showDialog` gains `role="dialog"`/`aria-modal`/label (which also answers the existing comment about not trapping Tab into a shadow root — `aria-modal` constrains the virtual cursor without a DOM trap); the command palette gains ids, `aria-controls`, `aria-activedescendant` and an honest `aria-expanded`; the Bottom dock and then the tab strip get real tab semantics, copying the roving-tabindex idiom from `layers-panel.ts`.

**Do not hand-author ARIA on the Tabulator grid.** Adding `role="grid"` over a _virtualized_ table is a classic way to make things worse. Audit what Tabulator emits, label the container, document the keyboard-accessible alternative, and record the gap honestly.

**Drag and drop** needs WCAG 2.2 SC 2.5.7. Do _not_ build an APG keyboard-drag mode — the commands already exist: cut/paste on the layers tree reusing `mutateMoveNode`, surfaced in the already-correct context menu, paired with an announcement.

**`forced-colors` is a real gap with a concrete failure**: Windows High Contrast drops `background-image` and `box-shadow`, which is how most focus and selection affordances here are drawn. Add a `@media (forced-colors: active)` block, `forced-color-adjust: none` on the canvas, and an outline anywhere a ring is drawn with `box-shadow`.

**Contrast gate:** extend `packages/studio/scripts/check-styles.ts`, not `token-lint.ts` — the latter is a deliberately non-failing hint over _user documents_. Parse the `sp-theme` block for each token's hex fallback, assert a required-pairs table at 4.5:1 and 3:1, ratchet exceptions with a comment. Then the part that matters more: **a rule that parses `studio-ui-guidelines.md` §1.1's token table and asserts each fallback matches `tokens.css`** — the spec has eight wrong hex values right now, and correcting them without a gate just resets the clock.

**ARIA assertions need a real browser.** `packages/studio/src/panels/tab-strip.ts:733` records that a `role="menuitemcheckbox"` set in Studio code does not survive into the rendered Spectrum component — "verified in a real browser, because happy-dom never catches it".

Gaps: `gap:wcag-conformance`, `gap:apg-coverage`, `gap:authoring-accessibility-review`.

### 4.8 S7 — ATAG Part B surface (depends on S6) ✅ **shipped**

Modelled directly on `Search appearance`, whose "no score, warnings only" argument transfers verbatim. A pure `a11y-report.ts` model beside an `a11y-modal.ts` render, a command registered like `document.openSeo`, and findings routed through `notify(..., {tier: "problem"})` in the byte-for-byte shape of `reportRedirectProblems`. Each finding carries a `criterion` and, where possible, an `action` command id that **repairs** it — which is ATAG B.3.2, not just B.3.1.

Author-time checks: missing/empty `alt`, heading-level skips and multiple `h1`, missing `lang`, unlabelled form controls, link purpose, missing accessible names, positive `tabindex`, duplicate ids, autoplay without controls, and target size and contrast **only where both values are literally declared**.

Everything needing layout or the cascade is **only checkable on built output** and would need axe-core. Do not build that now; record the divergence.

**Copy the redirects idiom for the gap:** `redirects-grid.ts` files an explicit "this run could not check X" Problem rather than reporting a clean bill. A report that silently passes what it could not check is worse than no report.

While in there, route the existing SEO warnings to Problems too — five lines.

Gap: `gap:atag-authoring-support`.

### 4.9 S8 — Trusted Types and the Studio-shell CSP ✅ **shipped**

**Verify the scope before committing to the staging.** The tempting claim is that `require-trusted-types-for 'script'` governs only DOM injection sinks and leaves `new Function` to `script-src 'unsafe-eval'`. **That is not right as stated** — under TT, `eval()` and `new Function()` are _also_ gated and throw with no default policy. The escape hatch is a default policy whose `createScript` passes through, which re-permits the interpreter and makes TT's script half a rubber stamp.

Honest staging: the four `innerHTML = ""` become `replaceChildren()` regardless (identical semantics, four fewer sinks); a real policy handles the one `unsafeHTML` sink and must **sanitize or assert, never pass through**; and enforcing TT on the shell requires a permissive `createScript`, which is a documented `Divergent` row. **Verify against a report-only deployment first** — this is the one place where getting the standard's scope wrong produces a plan that cannot be executed.

The two-profile CSP conclusion survives and is the real win: compiled output already has a committed test proving no `new Function`/`eval` (and B8b now ships that strict policy), while the interpreting canvas keeps `'unsafe-eval'` permanently. Say so in a new `spec.md` §21.5 so "remove eval from the runtime" stops living as an implied TODO — the interpreter _is_ those twenty sites.

Gap: none — `gap:trusted-types` was opened by this phase and retired when the observation run answered it. Trusted Types is a permanent, deliberate `Subset`: the injection-sink half, without enforcement.

### 4.10 S9 — WebDriver BiDi for the screenshot pipeline ✅ **shipped**

Contained to `scripts/screenshots/`, which is what the shot contract requires (nothing may exist in `src/` to serve the pipeline). `launchBrowser()` at `scripts/screenshots/lib/browser.ts:59-80` calls puppeteer-core's `launch({ executablePath, … })` over CDP; puppeteer-core ≥23 accepts `protocol: "webDriverBiDi"`. The change is that option plus a verification run, and the acceptance criterion is that `scripts/screenshots/capture.lock.json` either does not change or changes only in ways the lane's before/after review accepts.

**If BiDi cannot drive `__jxAutomation`'s `idle()` handshake, abandon it and record a `Rejected` row with the reason** — that is exactly what the Rejected class is for.

### 4.11 Smaller open items ✅ **all shipped** — kept for the reasoning

- **`gap:sitemap-fields`** — a page generated from a template reports the template's `<lastmod>`. Entries now carry `_meta.mtime` (`parser.md` §9.3), so the data exists; routing it through `$paths` expansion is the remaining work. **Attempted once and reverted**: `Content.resolvePaths` could not be shown to run in a probe build even after rebuilding `dist`. Do not re-attempt without first proving the hook is reached.
- **`gap:sse-reconnect`** — `retry: 500` on `/__reload` is one line and worth it. Full `id:`/`Last-Event-ID` replay is not. Emit an id purely to arm the header, no buffer, and on a reconnect carrying `Last-Event-ID` push one reload. The comment must say this is deliberately not replay, so nobody later "completes" it.
- **`gap:bcp47-locale-validation`** — the build validates and canonicalizes every language tag, but the **schema** carries no `pattern`, so `jx validate` accepts `en_US` and the build then fails on it. Author-time and build-time disagree about the same value. Fix: a `pattern` on `i18n.defaultLocale` and `i18n.locales[]` catching the shape errors that matter (underscores, empty subtags) without pretending to the full RFC 5646 grammar, which a regex should not attempt.
- **`gap:link-relation-validation`** — `rel` values are not checked against the IANA registry.
- **`gap:markdown-variant`, `gap:yaml-media-type`, `gap:identifier-syntax`** — see the rows that carry them.
- **BCP 14 normative keywords** — the specs use MUST and SHOULD informally and none declares the RFC 2119/8174 boilerplate. On the backlog rather than tracked as a gap, because it is a convention for the whole corpus and no section exists to declare it in; adopting it means writing that section first (`specs/README.md` is the likely home) and then auditing every existing MUST.
- **RFC 7464 `application/json-seq`: do not adopt.** Its advantage over NDJSON is that a record containing a raw newline cannot break framing — but the producer is always `JSON.stringify`, which escapes newlines. The real defect on that stream is unrelated: `import-client.ts:89-90` silently drops unparseable lines. Count them and surface one warning.
- **TC39 source maps: reclassify as `Rejected`.** The "hand-rolled remapping" is `line -= 1` and `offset -= headerLen` for a single synthetic header. A source map for a constant offset is more machinery than the thing it maps.

### 4.12 Two stale rows the migration audit caught

Worth naming as a pattern, not just as two fixes. A phase that closes a gap must update **every** row that describes the old state, and twice it did not:

- The RFC 9110 redirect row still said "only 301 and 302 are documented" three phases after B1 shipped all five. Its gap id is now retired; the row states what the build does.
- `gap:bcp47-locale-validation` still said "nothing reads the key" after B9 made the compiler read it. Narrowed to the half that is still true — the schema, not the build.

Both were found by diffing the gap ids this document names against the ids the specs actually carry. That diff is cheap and worth re-running after every phase — but it must read **table rows only**. A closed gap keeps being named in the spec's changelog entry that closed it, and a naive `grep` counts those as live:

```
rg '^\| \[' specs/*.md | grep -o 'gap:[a-z0-9][a-z0-9-]*' | LC_ALL=C sort -u
```

Everything that prints is a gap a row still carries. `gap:example-only` is reserved for `standards.md` §4.4's worked examples and names no work.

## 5. The adoption backlog

`specs/standards.md` §11 holds standards whose **owning section does not exist yet** — a `Pending` row must bind a section the spec admits is unbuilt, and a feature that has not been designed has no such section. Eight entries remain:

| Standard           | Waiting on                                                         |
| ------------------ | ------------------------------------------------------------------ |
| BCP 14             | standards.md — a section declaring the corpus's keyword convention |
| RFC 8414           | desktop.md §10 — an authorization flow (S4)                        |
| WebAuthn Level 3   | desktop.md §10 — a registered relying-party id and recovery story  |
| CSS Cascade Layers | spec.md §9 — the style model has no layer concept                  |
| CSS Containment 3  | spec.md §9 — $media is viewport-only                               |
| Media Queries 5    | spec.md §9.4 — no browser ships @custom-media                      |
| CSS Shadow Parts   | spec.md §16.6 — shadow roots exist now; nothing emits part         |
| WebDriver BiDi     | studio.md — the screenshot pipeline has no spec section (S9)       |

`backlog-already-cited` fails if an entry is left in both places, which is the intended workflow: a graduating entry is **removed from §11 in the same commit** that adds its row.

## 6. Working rules for this program

These are the registry's contracts. Violating one fails `bun run docs:standards`.

- A **`Pending`** row must bind a section whose `> **Status:**` is explicitly non-Implemented. When no such section exists, the honest move is to downgrade the section **or drop the row** — never manufacture a status. Two rows were dropped for exactly this reason.
- A **cited class** (`Adopted`/`Subset`/`Divergent`/`Borrowed`) may not bind a `Pending`/`Future` section, and owes evidence: committed files, comma-separated.
- Only `Pending` (required) and `Subset` (optional) may name a `gap:` id. A `Divergent` row **may not** — if you need to track work, the class is `Subset`.
- Non-standards (libraries, vendor formats, community manifests) are **prose**, never a `Rejected` row.
- Gap tiers are **derived** from the bound section's status marker (`Partial→Near`, `Pending→Next`, `Future→Later`), so "is it built" has one source of truth.
- `scripts/docs/standards.json` is the lexicon of citable identifiers, **sorted by id**. Adding a standard means adding it there first, with issuing body, title and canonical URL.
- Every substantive spec edit is a release: `bun run spec:bump <spec.md> <major|minor|patch>`, then `bun run docs:generate`.

## 7. Operational knowledge

Hard-won during the build track. None of it is derivable from reading the code.

### Verification

- **`bun run test:workspaces` does NOT pass `--coverage`, so it hides per-file threshold failures.** Two red gates survived five sweeps that way. Always run `bun test --isolate --coverage` in each touched workspace and **check the exit code** — the table prints "0 fail" either way.
- Bun's coverage table is `% Funcs | % Lines`, in that order. An uncovered _function_ is usually a **default-parameter arrow no caller reaches**; delete the fiction rather than testing it.
- `docs:verify` and `schema:verify` `git diff` against HEAD, so they only pass on a **clean tree** — commit before believing a failure.
- A core-schema change needs `bun run schema:generate-all` (25 projects × 2 entry documents), not just `generate:schema`.
- **Build a real site to verify**: `bun packages/compiler/src/cli.ts build` from a project root. Use the source entry, **not** the `jx` binary — `packages/compiler/bin/jx.js` imports `../dist/cli.js` and silently tests stale prebuilt code.
- **Extension `$implementation` paths point at built `dist/*.js`**, so editing an extension's `.ts` and running a probe tests STALE code. Run `bun run --cwd extensions/<x> prepare` first. `@jxsuite/feed` deliberately points at `./feed.ts` to avoid this.
- Sharp is unloadable on NixOS, so the build-service image path cannot be probed locally. Mock the optimizer in tests and say so.
- Scripted edits via python heredocs have twice injected NUL bytes into source files — invisible to oxfmt and oxlint. A hygiene test in `scripts/docs/lib/standards.test.ts` guards it.

### Browser-verified facts — do not re-derive

- A `script-src` SHA-256 **does** authorize `<script type="importmap">`.
- `<script type="application/ld+json">` is a **data block**: CSP never checks it, and hashing it authorizes nothing.
- A hash and `'unsafe-inline'` in the same directive **cancel** — the browser ignores the keyword. A partial set of style hashes is therefore worse than none.
- Jx binds event handlers as listeners, never as `onclick=` attributes, which is why `script-src` can be strict.
- **lit `render()` appends into its container.** A declarative shadow root must be cleared before the first render or the component shows twice — but the stylesheet `<link>` inside it must survive.
- A **closed** declarative shadow root is not on `element.shadowRoot`; only `attachInternals().shadowRoot` finds it, and `attachShadow` over an existing root throws.
- **`cache.addAll()` is all-or-nothing**: one unreachable precache URL rejects the install and the worker never activates, with no visible error. Symptom: "the service worker does nothing" — the cache exists but no registration does.

### Toolchain

- **Bun picks a package's `development` export condition unless the build's own `define` sets `process.env.NODE_ENV`** — it ignores an env var set after the process started. Every client bundle shipped dev builds under Bun while esbuild shipped production. Fixed in `bundler.ts` via `BROWSER_DEFINE`; do not remove it.
- `mock.module()` before importing the module under test; `await import()` afterwards. sharp and `electrobun/bun` must always be mocked.
- Commit bodies are capped at 100 characters per line by commitlint.

### Jx authoring gotchas

- Event handlers must be a `$ref`, a structured `body`, a Function def, or an `$expression`. A raw string (`"onclick": "state.n++"`) is **silently dropped**. Working form: `{"$expression":{"operator":"+=","target":{"$ref":"#/state/n"},"value":1}}`.
- A node-level `src`/`alt` is **not** emitted by `buildAttrs`, which renders a fixed list (`id`, `className`, `hidden`, `tabIndex`, `title`, `lang`, `dir`, `style`, `attributes`). The image pipeline normalizes node-level `src` into `attributes`; the general case is still open.
- `evaluateStaticTemplate` binds `state`, `$map`, `$site`, `$page` as `new Function` parameters. If a template silently yields its own source text, that is the shape of the bug.
- oxfmt reformats fenced \`\`\`html blocks in Markdown as real HTML. A sample of nested-looking tags will be "corrected" into nesting — use a table or an unfenced block.

### CI

- Adding a workspace needs no CI edit, but it must ship a `bunfig.toml` with a `coverageThreshold` or `scripts/ci/affected.ts` fails the run by name.
- A test that reads a file **outside its own workspace** needs an `EXTRA_EDGES` entry in `scripts/ci/affected.ts`, citing the test file that proves it. Those anchors are `existsSync`\-checked before any other job starts.
- `docs:spec-release` compares against `main`, so a spec created on this branch is skipped there. The pre-commit hook (which compares against `HEAD~`) is the one that notices.

## 8. Gates that must stay green

```
bun run lint && bun run typecheck
bun run docs:check          # page/spec/code associations
bun run docs:standards      # the alignment tables
bun run docs:status         # spec headers, vocabulary, changelogs
bun run docs:claims         # marketing copy
bun run docs:verify         # generated-page drift (clean tree only)
bun run test:workspaces     # NOTE: no --coverage; see §7
```

Plus, per touched workspace: `cd <workspace> && bun test --isolate --coverage` and check `$?`.
