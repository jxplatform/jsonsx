# Jxsuite.com Marketing Site Redesign — Implementation Plan

## Overview

Redesign the jxsuite.com marketing site from a single-page developer landing into a multi-page marketing site that positions Jx Suite as a credible competitor to WordPress, Webflow, and Wix. The site must be built with Jx itself (JSON pages + Markdown), use existing design tokens, and maintain the dark editorial aesthetic.

---

## Information Architecture

```
/                     → Homepage (flagship page)
/features             → Deep-dive feature breakdown
/pricing              → Value positioning / cost comparison
/studio               → Visual IDE showcase
/docs/[slug]          → Existing docs (unchanged)
```

---

## Phase 1: Shared Infrastructure

### 1.1 Update `site-toolbar.json`

The nav currently has: Docs, Spec, GitHub. Needs to expand to support the new pages.

**New nav links:** Features, Studio, Pricing, Docs, GitHub

Add a mobile hamburger pattern (or keep minimal with horizontal scroll on small screens matching the current convention).

### 1.2 Update `site-footer.json`

Expand from the single-line footer to a multi-column footer appropriate for a marketing site:

- Column 1: Brand mark + tagline
- Column 2: Product links (Features, Studio, Pricing)
- Column 3: Resources (Docs, Spec, GitHub)
- Column 4: Community (Discord?, Twitter/X?)

### 1.3 New Shared Components to Create

| Component file                     | Purpose                                                                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `components/section-header.json`   | Reusable section title block: monospace label + h2 + subtitle paragraph. Eliminates repetitive inline styling throughout pages. |
| `components/stat-card.json`        | Large number + label + optional subtitle (for "100", "Perfect Lighthouse", etc.)                                                |
| `components/comparison-row.json`   | Row for comparison tables: feature name + Jx column + competitor column                                                         |
| `components/pillar-card.json`      | Larger featured card for the "four pillars" sections — icon, title, description, link                                           |
| `components/testimonial-card.json` | Quote + attribution block                                                                                                       |
| `components/pricing-column.json`   | Pricing tier card: title, price, feature list, CTA                                                                              |
| `components/mode-card.json`        | For Studio page — mode name, screenshot/illustration area, description                                                          |
| `components/nav-link.json`         | Extracted toolbar link with active-state support                                                                                |

### 1.4 Layout: Marketing Page Layout

Create `layouts/marketing.json` — identical to `base.json` but with slightly different `main` styling (no max-width constraint on main, since sections manage their own widths). This keeps marketing pages full-bleed while docs stay contained.

---

## Phase 2: Homepage Redesign (`pages/index.md`)

The homepage is the most impactful page. Keep it as Markdown (`.md`) since the current pattern works well and the directive syntax is expressive enough.

### Section Breakdown

#### 2.1 Hero (keep + refine)

- **Headline:** "Build websites without the weight." or similar positioning statement
- **Subtitle:** Emphasis on visual builder + zero lock-in + static output
- **CTAs:** Get Started (primary), View on GitHub (secondary) — same as current
- **Install snippet:** `bun create jx-suite my-site` — same as current
- **Enhancement:** Add animated/subtle background gradient (already has radial-gradient, keep it)

#### 2.2 Social Proof Bar (NEW)

- Logos or text badges: "MIT Licensed", "100 Lighthouse Score", "Zero Dependencies", "< 5kb hydration"
- Use `stat-card` component in a horizontal flex row

#### 2.3 Comparison Section (NEW — the "Why Jx" section)

- Monospace section label: "WHY JX SUITE"
- Headline: "Everything they charge for, without the baggage"
- Comparison table (using `comparison-row` components):

| Capability       | WordPress / Webflow / Wix          | Jx Suite                     |
| ---------------- | ---------------------------------- | ---------------------------- |
| Visual editing   | Proprietary builder                | Open-source IDE (Jx Studio)  |
| Hosting          | $20-50/mo managed                  | Any static host, free tier   |
| Performance      | 60-80 Lighthouse                   | 100 Lighthouse               |
| Lock-in          | Proprietary format                 | Plain JSON + Markdown in git |
| Maintenance      | Plugins, updates, security patches | Zero — static files          |
| AI-ready content | Requires API / plugins             | Markdown files, git-native   |

#### 2.4 Four Pillars (REFACTOR existing feature grid)

- Use new `pillar-card` component (larger, more prominent than `feature-card`)
- Four cards in 2x2 grid (1-col on mobile):
  1. **File-based CMS** — JSON + Markdown content, git-native
  2. **Reactive Framework** — Signals, template bindings, web components
  3. **Visual Composer** — Jx Studio design/edit/script modes
  4. **Static Generator** — Compiles to pure HTML/CSS/JS

Each links to relevant section on /features page.

#### 2.5 Code Example (keep + refine)

- Same JSON-in / HTML-out pattern
- Consider a more compelling example — maybe a real component like a pricing card or nav

#### 2.6 How It Works (keep)

- Author (write JSON/Markdown or design in Studio)
- Commit (push to git)
- Live (deployed on CDN via any static host)
- Use existing `step-card` component

#### 2.7 Stats/Testimonial Callout (NEW)

- Full-width section with 3-4 stat cards:
  - "100" — Lighthouse performance score
  - "0kb" — Default JavaScript shipped
  - "< 2s" — Time to first deploy
  - "MIT" — Forever open source
- Optional: testimonial quote if available

#### 2.8 Final CTA (keep + refine)

- Same pattern as current cta-banner section
- Stronger copy: "Start shipping in minutes, not months"

---

## Phase 3: Features Page (`pages/features.json`)

Use JSON format since this is a structured page with no long-form prose.

### Section Breakdown

#### 3.1 Hero

- Section label: "FEATURES"
- Headline: "A complete website framework"
- Subtitle: "Four integrated systems that replace your entire stack"

#### 3.2 Pillar Deep-Dives (4 sections, alternating layout)

Each pillar gets a full section with:

- Left: Text content (title, description, feature list with `check-item`)
- Right: Code example or screenshot
- Alternating left/right on desktop

**Pillar A: File-Based CMS**

- Markdown + JSON content
- Content collections with schema validation
- Dynamic routes from content
- No database, no admin panel, no security patches

**Pillar B: Reactive Framework**

- Signals-based state management
- Template expressions (`${state.x}`)
- Computed values, effects
- Web component compilation

**Pillar C: Visual Composer (Jx Studio)**

- Design mode: canvas, drag-drop, component palette, responsive preview
- Edit mode: JSON tree editor
- Script mode: behavior authoring
- Preview mode: responsive breakpoints

**Pillar D: Static Site Generator**

- File-based routing (`pages/` directory)
- Layouts and nesting
- Compile to directory or single-file
- Deploy anywhere

#### 3.3 Capability Grid

- "What you can build" — grid of use cases:
  - Marketing sites, Documentation, Blogs, Portfolios, Landing pages, Component libraries, Design systems, Email templates

#### 3.4 Performance Stats Section

- Lighthouse scores comparison chart (visual)
- Bundle size comparison
- Time-to-interactive comparison

---

## Phase 4: Pricing Page (`pages/pricing.json`)

### Section Breakdown

#### 4.1 Hero

- Section label: "PRICING"
- Headline: "Free. Forever. No catch."
- Subtitle: "Jx Suite is MIT licensed. You own everything."

#### 4.2 Pricing Columns (3 columns)

Using `pricing-column` component:

|           | Jx Suite (Open Source)      | Typical WordPress | Typical Webflow   |
| --------- | --------------------------- | ----------------- | ----------------- |
| Price     | $0/mo                       | $30-100/mo        | $20-40/mo         |
| Hosting   | Free (Netlify/Vercel/Pages) | $10-50/mo managed | Included (locked) |
| SSL       | Free (automatic)            | $0-10/mo          | Included          |
| Updates   | None needed                 | Weekly            | N/A               |
| Backups   | Git (free)                  | $5-20/mo plugin   | Included          |
| **Total** | **$0/mo**                   | **$50-180/mo**    | **$20-40/mo**     |

#### 4.3 "What You Get for Free" Section

- Check-list of everything included:
  - Visual IDE (Jx Studio)
  - Unlimited pages and components
  - Static site compilation
  - Reactive islands
  - Content collections
  - Image optimization
  - No vendor lock-in

#### 4.4 Studio Cloud Teaser (optional)

- "Coming soon" card for a potential hosted Studio offering
- Email signup / waitlist CTA

---

## Phase 5: Studio Page (`pages/studio.json`)

### Section Breakdown

#### 5.1 Hero

- Section label: "JX STUDIO"
- Headline: "Design in the browser. Ship from git."
- Subtitle: "A visual IDE built for developers and agencies — not drag-and-drop for beginners."
- CTA: Download Studio / Try Online

#### 5.2 Screenshot/Video Hero

- Full-width Studio screenshot (already have `/studio.png`)
- Bordered, with subtle shadow

#### 5.3 Four Modes (using `mode-card` component)

Grid or tabbed layout showing each mode:

1. **Design Mode** — Visual canvas, drag-and-drop, component palette, responsive preview
2. **Edit Mode** — JSON tree editor, property panel, live updates
3. **Script Mode** — Behavior authoring, state management, event handlers
4. **Preview Mode** — Full responsive preview, breakpoint switching, Lighthouse audit

#### 5.4 "Built for Agencies" Positioning

- Not a website builder for end-users
- Professional tooling for developers who want visual speed
- Git-native workflow: branch, PR, review, merge
- Component reuse across client projects

#### 5.5 Workflow Section

- How Studio fits into a professional workflow:
  1. Design components in Studio
  2. Author content in Markdown
  3. Push to git
  4. CI/CD deploys automatically

---

## Phase 6: Project Configuration Updates

### 6.1 `project.json` Changes

- No changes to design tokens needed (they're already comprehensive)
- May want to add OG image configuration later

### 6.2 `package.json` — no changes expected

---

## Component Design Details

### `section-header.json`

```
Props: label (monospace), title (h2), subtitle (paragraph), align (center|left)
```

Pattern: monospace uppercase label with letter-spacing above a large heading, with optional subtitle below. This pattern repeats on every section of every page.

### `stat-card.json`

```
Props: value (large text), label (small text), sublabel (optional)
```

Large monospace number, small sans-serif label below.

### `comparison-row.json`

```
Props: feature, jx (with checkmark styling), competitor (with x/neutral styling)
```

Table-row-like component for the comparison section.

### `pillar-card.json`

```
Props: icon, iconBg, iconColor, title, description, href
```

Like `feature-card` but larger, with a link/arrow indicator. Used for the four-pillars homepage section.

### `pricing-column.json`

```
Props: title, price, period, features (array rendered as check-items), cta, ctaHref, highlighted (boolean)
```

### `mode-card.json`

```
Props: name, description, features (array), screenshot (image path)
```

---

## File Creation Summary

### New Pages (3 files)

- `pages/features.json` — new
- `pages/pricing.json` — new
- `pages/studio.json` — new

### Rewritten Pages (1 file)

- `pages/index.md` — major rewrite of existing

### New Components (7 files)

- `components/section-header.json`
- `components/stat-card.json`
- `components/comparison-row.json`
- `components/pillar-card.json`
- `components/testimonial-card.json`
- `components/pricing-column.json`
- `components/mode-card.json`

### Modified Files (2 files)

- `components/site-toolbar.json` — add nav links for new pages
- `components/site-footer.json` — expand to multi-column

### Optional New Layout (1 file)

- `layouts/marketing.json` — only if needed for full-bleed sections

### Unchanged

- `pages/docs/[slug].json` — untouched
- `layouts/docs.json` — untouched
- `layouts/base.json` — untouched
- `components/docs-sidebar.json` — untouched
- `content/docs/*.md` — untouched
- `project.json` — untouched (tokens already correct)

---

## Implementation Order

1. **Shared components first** — `section-header`, `stat-card`, `pillar-card` (needed by homepage)
2. **Update toolbar** — add new nav links
3. **Homepage rewrite** — most impactful, validates component design
4. **Features page** — deepest content, reuses pillar pattern
5. **Studio page** — visual showcase
6. **Pricing page** — simplest structure
7. **Footer expansion** — polish pass
8. **QA pass** — responsive breakpoints, Lighthouse audit

---

## Design Principles for Implementation

1. **Token-first** — Never hard-code colors/spacing. Always use `var(--color-*)`, `var(--radius)`, etc.
2. **Responsive by convention** — Use `clamp()` for typography/spacing. Use `--md` and `--sm` breakpoint overrides in grid layouts.
3. **Component extraction** — If a pattern appears 3+ times, it becomes a component.
4. **Semantic sections** — Use named wrapper divs (e.g., `hero-section`, `comparison-section`) for clarity in source.
5. **Progressive enhancement** — All content readable without JS. Reactive features are optional enhancements.
6. **Content density** — Marketing pages should breathe. Large padding between sections (`clamp(4rem, 8vw, 7rem)`). Generous line-height on body copy.

---

## Key Risks and Mitigations

| Risk                                                          | Mitigation                                                                                          |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Markdown directive syntax may be limiting for complex layouts | Use JSON pages (`.json`) for Features/Pricing/Studio; keep Homepage as Markdown since it works well |
| No actual screenshots for Studio modes                        | Use the existing `studio.png` + styled placeholder boxes with labels                                |
| Comparison claims need to be defensible                       | Use ranges ("$30-100/mo") and cite typical stacks                                                   |
| Four new pages may bloat build                                | Static output is tiny; not a real concern                                                           |
| Mobile nav with more links                                    | Consider collapsible nav or keep it tight (Features, Studio, Docs, GitHub)                          |
