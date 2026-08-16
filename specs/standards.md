# Jx Standards Alignment Specification

## Which External Standards Jx Adopts, and How That Is Recorded

**Version:** 0.1.12-draft
**Status:** Partial
**Updated:** 2026-08-16
**License:** MIT

---

## 1. Overview

> **Status: Implemented.** The parser, the gate and the generated page ship (`scripts/docs/lib/standards.ts`, `scripts/docs/check-standards.ts`, `docs/extending/reference/standards.md`), and **every spec with numbered headings carries its table** — both ratchets in the checker (`UNCITED`, `EXEMPT_UNNUMBERED`) are empty, so a new spec with no table fails on its first pull request. The program closing the gaps this registry tracks has its status board at [`STANDARDS-ADOPTION.md`](../STANDARDS-ADOPTION.md).

Jx builds on external standards, and until now it said so only in prose — unevenly, without citations, and with no way for a machine to tell a genuine conformance claim from a borrowed name. This specification defines how that is recorded instead: **each spec carries a numbered `## N. Standards Alignment` section holding one table**, and every row states what Jx does about one standard, which section of that spec it binds, and what backs the claim.

Two properties follow, and they are the point:

- **A citation cannot rot.** A bound section that stops existing, an evidence path that is deleted, or a URL that drifts from the catalog all fail `bun run docs:standards` in the pull request that caused them.
- **A gap is addressable.** A standard Jx intends to adopt and has not is a `Pending` row carrying a `gap:` identifier, which the generated reference page lists by tier — and the tier is derived from the bound section's own `> **Status:**` marker, so "is it built" still has exactly one source of truth.

The specs own the tables. Nothing generates them, and nothing else is authoritative.

## 2. Scope

### 2.1 Recognized issuing bodies

A row may cite a published standard from IETF, W3C, WHATWG, the Unicode Consortium, Ecma International, IANA (its registries), ISO, or JSON Schema. The issuing body is not a column: it is a property of the standard rather than of the binding, so it is recorded once in the catalog (§5.1) and rendered on the generated page.

### 2.2 What is not a standard

A library, a framework convention, or a de-facto vendor format is **not** citable, however widely adopted. Those belong in ordinary spec prose.

This rule resolves three entries that sat in `spec.md` §18's alignment tables before this specification existed:

- **`@vue/reactivity`** is a library. §18 already said so ("a library, not a web standard"); it now says so in prose instead of in the table.
- **The CSS `@custom-media` convention** is a syntax borrowed from an unshipped Media Queries Level 5 feature that Jx resolves itself. The convention is prose; a `Borrowed` row against Media Queries Level 5 is the citable form.
- **The OpenAI chat-completions wire format** (`ai.md` §2) is a vendor de-facto format with no standards body, so it is described in that spec's prose and appears in no row at all.

`Rejected` is **not** the class for these. It is for a real standard from a recognized body that was considered and declined, so that a deliberate decision reads as a decision rather than as an oversight. A thing that was never citable cannot be rejected.

## 3. The Conformance Vocabulary

Six classes. Four are **cited** — present-tense claims about the code as it stands, which therefore owe committed evidence. Two are **uncited** — a forward claim and a negative one, which cannot have evidence and owe prose instead.

| Class       | Means                                                               | Evidence      | Note     |
| ----------- | ------------------------------------------------------------------- | ------------- | -------- |
| `Adopted`   | Implemented as specified; conformance claimed without qualification | **required**  | optional |
| `Subset`    | Everything implemented conforms; part of the standard is absent     | **required**  | required |
| `Divergent` | Conformance claimed **with** enumerated deviations                  | **required**  | required |
| `Borrowed`  | The name or shape is taken; **conformance is not claimed**          | **required**  | required |
| `Pending`   | Intended, not built — a promise                                     | **forbidden** | required |
| `Rejected`  | Considered and declined                                             | **forbidden** | required |

### 3.1 `Adopted`

Jx implements the standard as written, and a reader may rely on conformance without reading further. The evidence is what makes that safe to say.

### 3.2 `Subset`

Every part Jx implements is conformant; some part of the standard is not implemented at all. The note names what is absent. This is distinct from `Divergent`: a subset never behaves differently from the standard, it merely does less.

A `Subset` **may** open its note with a `` `gap:<slug>` `` id, because the part it omits is a real, trackable absence — the row then appears in the gap list beside the `Pending` ones. It is optional rather than required: some subsets are permanent and deliberate, and inventing a gap id for one would promise work nobody intends to do.

### 3.3 `Divergent`

Jx implements the standard and deliberately behaves differently in enumerated ways. The note lists each deviation. Silence here is the failure mode this class exists to prevent.

### 3.4 `Borrowed`

Jx takes a standard's **name or syntactic shape** and gives it different semantics. **Conformance is not claimed**, and the note states what the semantics actually are. `spec.md` §18's original "borrowed shape, Jx-specific semantics" distinction is exactly this class.

### 3.5 `Pending`

A standard Jx intends to adopt and has not. The note opens with a `` `gap:<slug>` `` code span, and the slug is unique across the repository, so a gap can be named in an issue, a commit message, or a link to the generated page. Because a promise is a statement about unbuilt work, at least one section the row binds must carry a `> **Status:**` marker that is not `Implemented` (§7.3).

### 3.6 `Rejected`

A standard that was considered and declined. The note opens with `because:` and states either the alternative Jx uses instead or the constraint that makes adoption wrong here. A short or evasive reason fails the gate; see §8.

## 4. The Standards Alignment Section

### 4.1 Placement and numbering

The section is **numbered**, sits before any `## Appendix` heading so the numbered sections stay contiguous, and always precedes the `## Changelog` heading.

It must never be an appendix. Unnumbered headings are invisible to `scripts/docs/check-doc-refs.ts` and `scripts/docs/lib/spec-status.ts` alike: an unnumbered section is not an anchor, so no docs page can reference it, it never reaches the implementation-status page, and — because the status parser resets its current section only at `## Changelog` — a `> **Status:**` marker placed under it is silently credited to the last numbered section **above** it. The gate reports this case by name.

The section itself carries **no** `> **Status:**` marker. A registry is not a feature; its state is the union of its rows.

### 4.2 Column contract

Five columns, in this order and with exactly these headings:

```markdown
| Standard | Class | Binds | Evidence | Note |
| -------- | ----- | ----- | -------- | ---- |
```

| Column     | Carries                                           |
| ---------- | ------------------------------------------------- |
| `Standard` | the identifier and its canonical URL              |
| `Class`    | the conformance class from §3                     |
| `Binds`    | the section or sections of **this** spec it binds |
| `Evidence` | committed proof, or the empty sentinel            |
| `Note`     | the honesty column                                |

### 4.3 Cell grammar

- **Standard** — `[<id>](<url>)`, a real markdown link so it is clickable in the spec. The identifier follows §5.3; the URL must equal the catalog's URL for that identifier, which is what stops a spec quietly citing a different document than the catalog vouches for.
- **Class** — bold, e.g. `**Adopted**`. Bold is not decoration: `docs:status` already rejects an unbolded table cell reading "Planned", so an unbolded class cell would be reported by the wrong checker with a message about an unrelated subsystem. Bolding every class cell keeps the two parsers from disagreeing about the same line.
- **Binds** — one or more `§<anchor>` references separated by `, `, each resolving to a numbered heading in the same spec.
- **Evidence** — one or more repository paths separated by `, `, or a `specs/<file>#<anchor>` reference, or the empty sentinel `—`. A path must exist and must be a file; a directory is too vague to be evidence.
- **Note** — free prose, or `—`. It may not contain a literal `|`: reword rather than escape.

### 4.4 Worked examples

One row per class:

```markdown
| Standard                                                                                  | Class         | Binds | Evidence                           | Note                                                                                                                                                     |
| ----------------------------------------------------------------------------------------- | ------------- | ----- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [JSON Schema 2020-12](https://json-schema.org/draft/2020-12/schema)                       | **Adopted**   | §3.2  | packages/schema/src/schema.ts      | —                                                                                                                                                        |
| [RFC 4180](https://www.rfc-editor.org/rfc/rfc4180)                                        | **Subset**    | §4    | extensions/parser/src/csv.ts       | Quoted fields and CRLF records only; no dialect negotiation and no header-less mode.                                                                     |
| [ECMA-262](https://ecma-international.org/publications-and-standards/standards/ecma-262/) | **Divergent** | §19   | packages/runtime/src/expression.ts | Operator punctuators and arity are ECMAScript's; evaluation is total, with no exceptions.                                                                |
| [RFC 6901](https://www.rfc-editor.org/rfc/rfc6901)                                        | **Borrowed**  | §7    | packages/runtime/src/runtime.ts    | Shape only. A `$ref` binds live state rather than substituting a schema; `~0`/`~1` escapes are unimplemented and `.` is a separator.                     |
| [Media Queries 5](https://www.w3.org/TR/mediaqueries-5/)                                  | **Pending**   | §5    | —                                  | `gap:example-only` The worked examples use a reserved slug: a real id here would be a second, unreachable definition of a gap that is tracked elsewhere. |
| [RFC 7386](https://www.rfc-editor.org/rfc/rfc7386)                                        | **Rejected**  | §20   | —                                  | because: JSON Merge Patch cannot express positional array edits, and statement lists need splices; Jx defines an explicit statement grammar instead.     |
```

Tables inside fenced blocks — including the two above — are skipped by the parser, so a specification may show examples without registering them.

That skip is why the example rows above can be freely wrong about the code. It is **not** why their gap slug is `gap:example-only`: a slug is unique across the repository (§3.5), and a plausible-looking one in an example is a second definition of a gap tracked for real somewhere else — indistinguishable from the real thing to a `grep`, and to anyone auditing the gap list against the specs. `gap:example-only` is reserved for these rows and names no work.

## 5. Citation Rules

### 5.1 The standards catalog

`scripts/docs/standards.json` is a **lexicon, not a registry**: it says what an identifier _is_ — issuing body, title, canonical URL — while the specs say what Jx _does_ about it. It is what makes an offline check of a typo'd identifier possible at all, since a well-formed URL for a standard that does not exist is indistinguishable from a correct one.

It ratchets in both directions, as `scripts/docs/claims.json` does for marketing claims: an entry no spec cites fails, and an identifier no entry vouches for fails. Entries are sorted by identifier in codepoint order.

### 5.2 Canonical URL forms per body

| Body        | Form                                                                                  |
| ----------- | ------------------------------------------------------------------------------------- |
| IETF        | `https://www.rfc-editor.org/rfc/rfcNNNN`, or `/info/bcpNN` and `/info/stdNN`          |
| W3C         | `https://www.w3.org/TR/<shortname>/` — the latest-version URL, never a dated snapshot |
| WHATWG      | `https://<spec>.spec.whatwg.org/`                                                     |
| Unicode     | `https://www.unicode.org/reports/trNN/`                                               |
| Ecma        | `https://ecma-international.org/publications-and-standards/standards/ecma-NNN/`       |
| IANA        | `https://www.iana.org/assignments/<registry>`                                         |
| ISO         | `https://www.iso.org/standard/NNNNN.html`                                             |
| JSON Schema | `https://json-schema.org/…`                                                           |

`tools.ietf.org` is retired and `datatracker.ietf.org/doc/html/rfcNNNN` is a second spelling of the same document; both are rejected with the replacement named, so the fix is mechanical. One canonical form per body is deliberate: two would mean the same RFC gets two spellings across sixteen specs and neither a reader nor a diff could tell them apart.

### 5.3 Identifier grammar

`RFC 9110`, `BCP 47`, `STD 90`, `UAX #15`, `UTS #46`, `ECMA-402`, `ISO/IEC 8859-1`, or a title-cased name for a body that does not number its documents (`WebAuthn Level 3`, `JSON Schema 2020-12`). The identifier is what the generated page groups by, so it is stable across specs.

## 6. Evidence

### 6.1 What counts as evidence

A committed repository path — a test that exercises the behaviour, the source file that implements it, or a generated artifact that demonstrates it — or a `specs/<file>#<anchor>` reference to a numbered section. A test is the strongest form, because it fails when the claim stops being true.

### 6.2 Why forward and negative claims may not carry it

`Pending` says the work is not done, and `Rejected` says it will not be. Neither can point at code that proves anything, and a path attached to either is a sign the class is wrong. The gate rejects it rather than ignoring it.

## 7. Gaps

### 7.1 Gap identifiers

A lowercase kebab-case slug, unique across every spec, written as `` `gap:<slug>` `` at the start of the note. It anchors the entry on the generated page, so a gap has a stable link.

`Pending` rows must carry one; `Subset` rows may (§3.2). `Adopted`, `Divergent`, `Borrowed` and `Rejected` rows may not — an `Adopted` has nothing missing, a `Divergent`'s deviations are deliberate, and the other two make no forward promise. A gap id on any of them is a sign the class is wrong.

### 7.2 Tiers are derived from the bound section's status

| Section `> **Status:**` | Tier    | Reading                                |
| ----------------------- | ------- | -------------------------------------- |
| `Partial`               | `Near`  | partly there; finishing is incremental |
| `Pending`               | `Next`  | committed, not started                 |
| `Future`                | `Later` | acknowledged, unscheduled              |

No priority is ever authored. A row binding several sections takes the nearest tier, and a tier moves the moment its section's marker moves.

### 7.3 One source of truth for "is it built"

The `> **Status:**` marker remains the only answer to _is this built_; a `Pending` row answers a different question, _which standard does this section owe_. The gate enforces the join in both directions, so the two cannot drift:

- A `Pending` row must bind at least one section whose explicit status is not `Implemented`.
- A cited row — `Adopted`, `Subset`, `Divergent` or `Borrowed` — may not bind a section explicitly marked `Pending` or `Future`.

`Partial` accepts a cited row, because a half-built section can still contain a conformant piece. An **unmarked** section carries no opinion in either direction, so adding this specification forces no churn on the existing marker set.

## 8. Declining a Standard

A `Rejected` row is a decision the whole repository lives with, so it is written once and applies everywhere: a standard may not be `Rejected` in one spec and cited in another.

The `because:` reason must name either the alternative Jx uses instead, or the constraint that makes adoption wrong here — not merely that it was inconvenient. "Not worth it" is not a reason; "the producer is always `JSON.stringify`, so the framing this standard fixes is already unambiguous" is.

A rejection is reversible. Reversing it means deleting the row and writing the new class with its evidence, in a pull request that says why the reasoning changed.

## 9. Gates and Generated Output

### 9.1 `bun run docs:standards`

Runs `scripts/docs/check-standards.ts` over every spec and the catalog. It stands alone rather than joining `docs:verify`, matching `docs:status` and `docs:spec-release`, so a failure names the right subsystem: a bad citation is a spec-content problem, not a generated-page drift.

### 9.2 `docs/extending/reference/standards.md`

Generated by `bun run docs:generate` and diffed by `docs:verify`. It carries the conformance table across all specs, the tracked gap list by tier, the declined standards with their reasons, the adoption backlog (§11), and the catalog itself — which is the page where a human can see a wrong identifier.

### 9.3 The uncited-spec ratchet

`UNCITED` in `scripts/docs/check-standards.ts` names the specs that do not yet carry a table, and `EXEMPT_UNNUMBERED` names those with no numbered headings for a `Binds` cell to reference. Both only shrink: a spec that gains a section, or gains numbered headings, must leave its list in the same pull request. When `UNCITED` is empty the requirement is universal, and a new spec with numbered headings and no table fails on its first pull request.

## 10. Standards Alignment

| Standard                                           | Class       | Binds | Evidence                      | Note                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------- | ----------- | ----- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [RFC 3986](https://www.rfc-editor.org/rfc/rfc3986) | **Subset**  | §5.2  | scripts/docs/lib/standards.ts | The canonical-URL rules admit only absolute `https` URIs with no query and no fragment — a subset of the generic syntax.                                                                                                                                                                                                                    |
| [BCP 14](https://www.rfc-editor.org/info/bcp14)    | **Adopted** | §12   | specs/standards.md#12         | The RFC 8174 boilerplate, declared once for the whole corpus. Its "and only when they appear in all capitals" clause is the operative half: these specifications are explanatory prose using "must" and "should" in their ordinary senses constantly, so the capitalized forms are rare and every one of them is a conformance requirement. |

## 11. Adoption Backlog

Standards the audit found relevant whose **owning spec section does not exist yet**. A `Pending` row must bind a section the spec admits is unbuilt (§7.3), and a feature that has not been designed has no such section — so without this table a standard identified before its feature would survive only in someone's notes.

An entry names the spec that will own it. When that section is written, the entry moves out of this table and becomes a `Pending` row bound to it; `backlog-already-cited` fails if it is left in both places.

| Standard                                                      | Target                                  | Why not yet                                                                                                                                                                                                         |
| ------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [RFC 8414](https://www.rfc-editor.org/rfc/rfc8414)            | `desktop.md` §10                        | Discovery is only reachable once an authorization flow exists (`gap:native-oauth`), and the one provider in use publishes no metadata document.                                                                     |
| [WebAuthn Level 3](https://www.w3.org/TR/webauthn-3/)         | `desktop.md` §10                        | Passkeys need a registered relying-party id and a recovery story, neither of which is designed.                                                                                                                     |
| [CSS Cascade Layers](https://www.w3.org/TR/css-cascade-5/)    | `spec.md` §9                            | The style model has no layer concept; adding one is a design change, not a citation.                                                                                                                                |
| [CSS Containment 3](https://www.w3.org/TR/css-contain-3/)     | `spec.md` §9                            | `$media` is viewport-only. Container queries would need a named-container model in the style object.                                                                                                                |
| [Media Queries 5](https://www.w3.org/TR/mediaqueries-5/)      | `spec.md` §9.4                          | `$media` borrows `@custom-media`'s shape from this level, but Jx resolves it itself and no browser ships it — so there is nothing to conform to until one does.                                                     |
| [CSS Shadow Parts](https://www.w3.org/TR/css-shadow-parts-1/) | `spec.md` §16.6 — `::part` from outside | Shadow roots exist now (the `$shadow` opt-in), so `::part` is finally _possible_ — but nothing emits a `part` attribute and no selector addresses one from a page stylesheet, so there is no behaviour to cite yet. |
| [WebDriver BiDi](https://www.w3.org/TR/webdriver-bidi/)       | `studio.md` — screenshot pipeline       | The pipeline drives Chrome over CDP from `scripts/`, which no spec section describes.                                                                                                                               |

## 12. Normative Keywords

> **Status: Implemented.** The convention below governs every specification in `specs/`, and
> `bun run docs:status` fails if a specification uses one of these keywords while this section is
> missing or names a different set.

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**, **SHOULD**,
**SHOULD NOT**, **RECOMMENDED**, **NOT RECOMMENDED**, **MAY** and **OPTIONAL** in the Jx
specifications are to be interpreted as described in BCP 14
([RFC 2119](https://www.rfc-editor.org/rfc/rfc2119), [RFC 8174](https://www.rfc-editor.org/rfc/rfc8174))
when, and only when, they appear in all capitals, as shown here.

The "and only when" half is what makes the rest of the corpus readable. These specifications are
explanatory prose, and they use "must", "should" and "may" in their ordinary English senses on
almost every page — a sentence saying the build "must" find a layout describes what happens, it does
not impose a conformance requirement on an implementer. RFC 8174 exists so a document can do both,
and declaring it here turns a corpus-wide informality into a deliberate distinction rather than an
ambiguity a reader has to resolve sentence by sentence.

The capitalized forms are therefore **rare and load-bearing**: a reader who meets one should
understand that an implementation doing otherwise is non-conformant, not merely unusual.

This section is the whole declaration. Individual specifications do not repeat the boilerplate, and
a specification that uses a keyword needs no BCP 14 row of its own. Deleting this section while any
specification still uses a capitalized keyword would leave those requirements undefined, which is
the failure the gate exists to make loud.

## Changelog

- **0.1.12-draft** (2026-08-16) — §12 declares the BCP 14 normative keywords for the whole corpus, gated by docs:status; BCP 14 graduates off the backlog.
- **0.1.11-draft** (2026-08-16) — §4.4 worked examples use a reserved gap:example-only slug so an illustration cannot squat on a real gap id.
- **0.1.10-draft** (2026-08-16) — §1 is Implemented — both ratchets are empty; BCP 14 moves to the backlog, since no section declares the corpus's keyword convention.
- **0.1.9-draft** (2026-08-16) — Service Workers graduates to a bound row in site-architecture.md §14.6.
- **0.1.8-draft** (2026-08-16) — CSS Shadow Parts backlog entry now waits on part attributes, not on shadow roots.
- **0.1.7-draft** (2026-08-16) — Retarget the CSS Shadow Parts backlog entry at spec.md §16.6, which now owns the shadow-DOM question.
- **0.1.6-draft** (2026-08-15) — Web App Manifest, RFC 9116 and RFC 8615 graduate to bound rows in site-architecture.md §14.5.
- **0.1.5-draft** (2026-08-15) — UAX #9 and UTS #35 graduate to bound rows in site-architecture.md §13.4.
- **0.1.4-draft** (2026-08-15) — RFC 4287, JSON Feed 1.1 and RFC 5005 graduate to bound rows in site-architecture.md §6.7.
- **0.1.3-draft** (2026-08-15) — Three backlog entries graduate to bound rows in site-architecture.md §14.3 (HSTS, Referrer-Policy, Permissions-Policy).
- **0.1.2-draft** (2026-08-15) — Add §11 Adoption Backlog: standards whose owning section does not exist yet, each naming the spec that will own it.
- **0.1.1-draft** (2026-08-15) — A Subset may name a gap for the half it omits; a non-standard is prose rather than a Rejected row.
- **0.1.0-draft** (2026-08-14) — Initial specification: the conformance vocabulary, the `## N. Standards Alignment` table contract, citation and canonical-URL rules, gap tiers derived from section status, and governance for declining a standard.

---

_Jx Standards Alignment Specification v0.1.12-draft_
