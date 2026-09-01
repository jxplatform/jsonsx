# Jx Suite — Home Page Copy

A few framing notes before the copy itself:

**The challenge.** Hooking three audiences (enthusiasts, agencies, developers) on a single page is _the_ hardest job in landing-page copy. The trap is writing for everyone and resonating with no one. The escape is **stacking the page**: a top hero that works on aesthetic and ambition (everyone), followed by sections that each speak directly to one audience but reward the others as eavesdroppers.

**Voice.** Confident, modern, a touch editorial. No marketing throat-clearing ("In today's fast-paced digital landscape…"). Lead with the strongest thing on every section. Earn trust by being specific.

**A note on a phrase you used.** "Future-proof, standards-driven, AI-ready, fast and inexpensive" — I'd keep all of these as supporting claims but resist using them as headlines. They're a buzzword constellation that sounds like every other landing page. The actual claim that separates Jx from the field is the _JSON-DOM source of truth_. I'm leading with that and letting the buzzwords do work in the body, where they're earned.

Here's the page, top to bottom.

---

## SECTION 1 — Hero

**Eyebrow:** THE JSON-NATIVE WEB PLATFORM

**Headline:** _The websites of 2030, built in 2026._

**Subhead:** Jx is a visual builder, a file-based CMS, a reactive runtime, and a static site compiler — all operating on the same plain JSON files. Build anything the web can do. Ship it as static HTML. Edit it visually. Version it in git. Own it forever.

**Primary CTA:** Try Jx Studio →\
**Secondary CTA:** Read the spec

**Trust strip below the fold:** MIT licensed · Standards-driven · Deploy anywhere · ~10kB runtime

---

## SECTION 2 — The thesis (the moment that hooks everyone)

**Headline:** _One file. Structure, style, behavior, content._

**Body:** The web has three pillars — HTML, CSS, JavaScript — and the hardest part of building for it has always been the plumbing between them. Every framework since 1995 has been a strategy for closing that gap. Every visual builder has been a strategy for modeling that plumbing without inventing lock-in.

Jx closes the gap differently. **The DOM already integrates structure, style, and behavior.** We just made it the source format.

[CODE BLOCK — show the counter example with structure, state, style, and reactivity all in one tree]

```json
{
  "tagName": "my-counter",
  "state": {
    "count": 0,
    "increment": { "$prototype": "Function", "body": "state.count++" }
  },
  "style": {
    "display": "flex",
    "gap": "1rem",
    ":hover": { "background": "var(--surface-hover)" }
  },
  "children": [
    { "tagName": "span", "textContent": "${state.count}" },
    { "tagName": "button", "textContent": "+", "onclick": { "$ref": "#/state/increment" } }
  ]
}
```

**Caption under the code:** This is the source. It's also what the visual builder edits. It's also what the static compiler reads. One artifact, every consumer.

---

## SECTION 3 — Four products, one model

A grid of four cards. This is where the "we are everything" claim gets concrete without overwhelming.

**Section headline:** _Four tools. One source of truth._

**Subhead:** Most stacks are five products glued together. Jx is one model, expressed four ways.

**Card 1 — Jx Studio** **THE VISUAL IDE** Design, edit, and ship from one canvas. Responsive design with real breakpoints. WYSIWYG markdown editing. Inline scripting. Schema-driven content forms. Component library management. Built on Adobe Spectrum, runs in your browser or as a desktop app.

**Card 2 — File-based CMS** **CONTENT WITHOUT A DATABASE** Content collections live as Markdown, JSON, and CSV files on disk. Schema-validated. Queryable. Git-versioned. No backend to maintain, no admin panel to secure, no migration anxiety. Your writers edit in any text editor. Your editors edit in Studio.

**Card 3 — Reactive runtime** **WEB COMPONENTS, REACTIVITY, ZERO COMPROMISE** Web Components for encapsulation. `@vue/reactivity` for signals (TC39 proposal-aligned). Template literals for dynamic content. CSS custom properties and nesting for theming. ~10kB production footprint. Standards all the way down.

**Card 4 — Static compiler** **STATIC-FIRST, SERVER WHEN YOU NEED IT** Compile to plain HTML, CSS, and JS. Deploy to any CDN for pennies. File-based routing, content collections, image optimization, sitemap generation — out of the box. Need server logic? Opt into `timing: "server"` and the build bundles a worker. Cloudflare today, Netlify and Vercel next.

---

## SECTION 4 — For agencies

This section explicitly addresses the agency reader. The header signals it; eavesdroppers will keep reading because the claims are concrete.

**Eyebrow:** FOR AGENCIES

**Headline:** _The WordPress replacement your developers will thank you for._

**Body:** Stop maintaining plugin compatibility matrices. Stop fielding 2am breach alerts. Stop quoting custom development for "just one little interactive thing." Jx gives your team a visual builder with the unlimited ceiling of the web platform and the maintenance profile of a static site.

**Three-column proof:**

**Faster builds** Component libraries become real assets. The hero block from one client is the starting point for the next.

**Recurring revenue without recurring work** Static hosting costs pennies. No CVE patching. Care plans become margin instead of overhead.

**Say yes to anything** Interactive calculators. Real-time forms. AI features. E-commerce. Dashboards. All in the visual canvas, all in plain JSON.

**CTA:** See how agencies use Jx →

---

## SECTION 5 — For developers

**Eyebrow:** FOR DEVELOPERS

**Headline:** _A schema, a runtime, and a compiler. No magic._

**Body:** Jx is a JSON Schema 2020-12 dialect. Documents validate against standard tooling. `$ref` and `$defs` work as you'd expect. The reactivity model is `@vue/reactivity`, which is converging on the TC39 signals proposal. The runtime is ~10kB, light DOM, with manual slot distribution for Web Components composition. Server functions are a clean RPC boundary — `(args, env)` signature, bundled per-adapter at build time.

**Technical proof points (two-column list):**

| What you get    | How it works                                           |
| --------------- | ------------------------------------------------------ |
| Component model | Web Components with explicit `$props` at the boundary  |
| Reactivity      | Vue signals, TC39-aligned, no virtual DOM              |
| Templating      | Standard JS template literals (`${state.count}`)       |
| Styling         | CSS nesting + custom properties, scoped per element    |
| Routing         | File-based, URLPattern-compliant, dynamic via `$paths` |
| Content         | Schema-validated collections (MD / JSON / CSV)         |
| Server          | Opt-in `timing: "server"`, bundled to one worker       |
| Output          | Static HTML/CSS/JS, deployable to any CDN              |
| Escape hatch    | Drop to raw JS via `$src` whenever you need            |

**CTA:** Read the spec → · Browse on GitHub →

---

## SECTION 6 — For the curious / enthusiasts

This is where the platform-aligned story gets to sing. Enthusiasts want the _why_, not just the _what_.

**Eyebrow:** FOR WEB PLATFORM ENTHUSIASTS

**Headline:** _We're not inventing primitives. We're connecting the ones the browser already ships._

**Body:** Five years ago, building Jx would have meant inventing half a dozen new primitives. Today, the platform ships every one of them. Web Components for encapsulation. CSS custom properties for theming. CSS nesting for locality. Template literals for interpolation. Signals as a TC39 proposal. Git for collaboration.

The realization that makes Jx possible is older than the framework: **the DOM is the integrated runtime model of the web.** Serialize it, and you have a source format that's native to the platform — no JSX, no SFCs, no proprietary IR. Just data that mirrors what the browser already understands.

**Three small celebrations:**

**Standards-aligned by construction.** JSON Schema 2020-12. JSON Pointer (RFC 6901). URLPattern. CSS `@custom-media`. Web Components v1. We extend known dialects; we don't invent new ones.

**Markdown as the content layer.** The native language of AI agents. Human-readable. Lossless via remark directives. Your content is ready for answer engines, search engines, and human eyes.

**No virtual DOM, no compiler magic.** The runtime is the DOM. The reactivity is signals. The composition is slots. If you understand the browser, you understand Jx.

**CTA:** Read "The DOM was always the answer" →

---

## SECTION 7 — How a Jx project actually looks

A single screenshot or filesystem-tree visualization, with prose that gives the reader the texture of working in Jx.

**Headline:** _A site is a directory._

**Filesystem block:**

```
my-site/
├── project.json          # Site config
├── pages/                # File-based routes
│   ├── index.json
│   └── blog/[slug].json
├── components/           # Reusable Jx components
├── layouts/              # Page shells
├── content/              # Markdown / JSON / CSV
│   └── blog/*.md
├── public/               # Static assets
└── dist/                 # Build output
```

**Body:** No database. No admin panel. No proprietary store. Your entire site is plain files in git — readable, diffable, version-controlled, deployable anywhere. Studio is a tool that operates on this directory. If you stopped using Studio tomorrow, your site is still here, still editable, still deployable.

---

## SECTION 8 — The numbers

A horizontal stat strip. This is for skimmers who scrolled past everything else.

**~10kB** runtime footprint in production **0** databases to maintain **100/100** typical Lighthouse score **MIT** licensed, forever **$0.02/mo** typical hosting cost on Cloudflare

---

## SECTION 9 — Comparison table

This is the slide-4 table from the agency deck, repositioned for self-service evaluation. Skeptical buyers love these.

**Headline:** _How Jx compares._

|                    | Visual builder | Maintenance | Performance | Lock-in  | Ceiling         |
| ------------------ | -------------- | ----------- | ----------- | -------- | --------------- |
| WordPress          | ✓              | Heavy       | Patchy      | High     | Plugin-limited  |
| Headless + Next.js | —              | Heavy       | Strong      | Medium   | Unlimited       |
| Astro              | —              | Light       | Strong      | Open     | Unlimited       |
| Webflow            | ✓              | Light       | Strong      | Total    | Webflow-limited |
| **Jx**             | **✓**          | **Light**   | **Strong**  | **Open** | **Unlimited**   |

---

## SECTION 10 — Social proof / showcase placeholder

**Headline:** _Built with Jx._

A grid of three to six site thumbnails with brand names. If you don't have these yet, replace with: _"Coming soon — the first Jx-built sites are launching this quarter. Want yours featured?"_ and a CTA. Don't fake this section.

---

## SECTION 11 — Get started

Three pathways, side by side. This respects the three audiences without forcing them to read each other's onramps.

**Headline:** _Three ways in._

**Path 1 — Try Studio in your browser** No install. Open Jx Studio, build a real component in five minutes, see what the JSON-DOM model feels like. [Open Studio →]

**Path 2 — Spin up a project locally**

```bash
git clone https://github.com/jxsuite/jx
cd jx && bun install
bun run dev
```

You'll be on `localhost:3000` with the example gallery in under a minute. [Read the quickstart →]

**Path 3 — Talk to us about an agency engagement** Pilot projects, team training, custom component libraries. White-glove support to fold Jx into your shop. [Book a call →]

---

## SECTION 12 — Footer

Standard. Includes:

- Product links (Studio, Runtime, Compiler, Server, Desktop)
- Docs links (Getting started, Spec, Site architecture, Studio guide)
- Community (GitHub, Discord, Mastodon, RSS)
- Legal (License, Privacy)
- A small repeat of the closing line: _Welcome to the future._

---

## Notes on how this hangs together

**The thesis lives in section 2, not section 1.** The hero needs to land emotionally; the thesis needs to land intellectually. Splitting them gives each room to do its job. A reader who only reads the hero gets the vibe; a reader who scrolls one section gets the actual claim.

**The three-audience sections (4, 5, 6) are explicitly labeled.** This is counterintuitive — most landing pages try to write copy that "works for everyone." That usually means copy that resonates with no one. Labeling the sections lets each audience self-route to their relevant pitch _and_ gives the others permission to eavesdrop on a section that wasn't written for them, which often lands harder than direct address.

**The "for enthusiasts" section is the secret weapon.** Most landing pages omit it because enthusiasts don't pay the bills. But enthusiasts write the blog posts, file the GitHub stars, and tell agencies and developers what to look at. Giving them a section that _celebrates the platform-alignment story_ turns them into your distribution channel.

**The numbers section (8) is for skimmers.** Most page visitors don't read; they scan. A well-placed stat strip is a content-anchor that conveys the value in under five seconds.

**The comparison table (9) is for buyers.** It exists because the question "how does this compare to X?" will be in every visitor's head and answering it directly is more trustworthy than dodging it.

**What I deliberately left out:** testimonials (you don't have them yet — never fake these), pricing (Jx is open source; if you're adding a hosted Studio tier, that gets its own page), and a newsletter signup in the hero (kill the conversion energy before it builds).
