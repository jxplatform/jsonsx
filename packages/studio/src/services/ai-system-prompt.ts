/**
 * Ai-system-prompt.js — Dynamic system prompt builder for the Jx AI assistant
 *
 * Constructs the system prompt based on the current project context, open document,
 * and available components. The quality of AI output depends critically on this file.
 *
 * @license MIT
 */

import { VOID_ELEMENTS } from "../store.js";
import { flattenTree } from "../state.js";
import type { ComponentEntry } from "../files/components.js";
import type { JxMutableNode, ProjectConfig } from "@jxsuite/schema/types";

/** Options for {@link buildSystemPrompt}. */
interface BuildSystemPromptOptions {
  /** The currently open Jx document. */
  document?: JxMutableNode | undefined;
  /** The project.json config if available. */
  projectConfig?: ProjectConfig | undefined;
  /** Available components. */
  components?: ComponentEntry[] | undefined;
  /** Project root path. */
  projectRoot?: string | undefined;
  /** Whether a project is open. Defaults to `!!projectRoot` (kept explicit for tests). */
  hasProject?: boolean | undefined;
  /** Project-relative file paths for the inventory section (project modes; capped). */
  fileInventory?: string[] | undefined;
}

/** Max file paths embedded in the prompt's inventory section. */
const FILE_INVENTORY_CAP = 100;

// ─── Tool tiers (single source of truth for prompt AND gating) ──────────────

/** Studio state a tool tier requires. Used by the gating registry AND the prompt tool list. */
export type AiToolTier = "no-project" | "project" | "document";

export interface AiToolInfo {
  name: string;
  tier: AiToolTier;
  /** One-line signature + purpose shown in the system prompt's tool list. */
  blurb: string;
}

/**
 * Every assistant tool with its availability tier and prompt blurb. document-assistant.ts derives
 * the gating predicates from the same rows, so the advertised tool list and the executable tool
 * list cannot drift (a test asserts the names match the registered tools).
 */
export const AI_TOOL_TIERS: AiToolInfo[] = [
  // Bootstrap (no project open)
  {
    name: "create_project",
    tier: "no-project",
    blurb:
      "create_project(name, description?, template?, directory?, design?) — scaffold a new Jx project (project.json, conventional directories, starter pages) and open it in the studio.",
  },
  {
    name: "list_starters",
    tier: "no-project",
    blurb: "list_starters() — list the starter templates available for new projects.",
  },
  // Cross-file (project open, document optional)
  {
    name: "list_files",
    tier: "project",
    blurb: "list_files(dir?) — list the project's files recursively (build folders excluded).",
  },
  {
    name: "read_file",
    tier: "project",
    blurb: "read_file(path) — read any project file (Jx documents, markdown, CSS, data).",
  },
  {
    name: "write_file",
    tier: "project",
    blurb:
      "write_file(path, content) — create or overwrite a project file. Jx documents are schema-validated and render-checked BEFORE writing; refused while the file is open with unsaved changes. Not undoable.",
  },
  {
    name: "search_files",
    tier: "project",
    blurb: "search_files(query, extensions?) — find files by file NAME (not content).",
  },
  {
    name: "create_component",
    tier: "project",
    blurb: "create_component(path, content) — create a new .json component file on disk.",
  },
  {
    name: "create_page",
    tier: "project",
    blurb: "create_page(path, content) — create a new .json page file on disk.",
  },
  {
    name: "open_document",
    tier: "project",
    blurb:
      "open_document(path) — open a file on the canvas as the active document; the document tools then operate on it. Use when the user should SEE the page, or for iterative visual refinement.",
  },
  // Document (an active document on the canvas)
  {
    name: "read_document",
    tier: "document",
    blurb:
      'read_document(path?) — inspect the whole document or the subtree at a path. Paths are JSON arrays of keys/indices from the root, e.g. ["children", 0, "children", 1].',
  },
  {
    name: "set_property",
    tier: "document",
    blurb:
      "set_property(path, key, value) — set or remove a property on the node at path (tagName, textContent, className, style, attributes, $props…). Pass value: null to remove.",
  },
  {
    name: "set_style",
    tier: "document",
    blurb:
      'set_style(path, property, value) — set or remove a CSS style property (camelCase) on a node. Values as strings: "10px", "var(--color-accent)". Pass value: null to remove.',
  },
  {
    name: "set_text",
    tier: "document",
    blurb: 'set_text(path, value) — convenient alias for set_property with key: "textContent".',
  },
  {
    name: "add_child",
    tier: "document",
    blurb:
      "add_child(parentPath, index, node) — insert a new node into the children of parentPath at index.",
  },
  {
    name: "remove_node",
    tier: "document",
    blurb: "remove_node(path) — remove the node at path.",
  },
  {
    name: "move_node",
    tier: "document",
    blurb: "move_node(fromPath, toParentPath, toIndex) — move a node from one location to another.",
  },
  {
    name: "add_state",
    tier: "document",
    blurb:
      "add_state(key, value) — add a reactive state variable under the document's 'state' object. Value can be scalar, typed, computed, function, or data source.",
  },
  {
    name: "update_state",
    tier: "document",
    blurb: "update_state(key, value) — update or remove (value: null) an existing state variable.",
  },
];

/**
 * Whether a tier's tools are active for the given studio state. Shared semantics with the gating
 * registry: bootstrap tools vanish once a project opens; project tools need a project; document
 * tools need an active document (even in single-file mode without a project).
 */
export function tierActive(tier: AiToolTier, hasProject: boolean, hasDocument: boolean): boolean {
  if (tier === "no-project") {
    return !hasProject;
  }
  if (tier === "project") {
    return hasProject;
  }
  return hasDocument;
}

// ─── Jx Schema Reference (condensed) ────────────────────────────────────────

/**
 * Condensed reference of Jx document structure rules. Included inline in the system prompt so the
 * LLM understands the schema without consuming excessive tokens.
 */
const JX_SCHEMA_REFERENCE = `## Jx Document Format

A Jx document is a JSON object. Key top-level fields:

- "$id": Component name (e.g. "Counter", "UserCard")
- "tagName": HTML tag for the root element (e.g. "my-counter", "div")
- "children": Array of child element definitions. Each child has "tagName" and optional "style", "textContent", "attributes", "children".
- "state": Reactive variables. Entry shape determines behavior:
  * Scalar: "count": 0 — reactive value with initial value
  * Typed: "name": { "type": "string", "default": "" } — typed with default
  * Computed: "label": "\${state.count} items" — template expression
  * Function: "handle": { "$prototype": "Function", "body": "state.count++" } — inline handler
  * Data source: "posts": { "$prototype": "Data", "$src": "./data.json" } — external data
- "style": CSS property object at any level. Properties use camelCase (e.g. "backgroundColor", "fontSize").
- "$elements": Array of component imports: [{ "$ref": "../components/header.json" }]
- "$media": Responsive breakpoints: { "--md": "(max-width: 768px)" }

### Element Properties
Common properties: tagName, className, textContent, hidden, tabIndex, attributes (object of HTML attributes), onclick (handler $ref), children (array).

### Void Elements (cannot have children)
${[...VOID_ELEMENTS].join(", ")}

### Styling
- All CSS property names use camelCase: "backgroundColor", "fontSize", "borderRadius", "textAlign"
- CSS values are always strings: "10px", "center", "block"
- Use CSS custom properties where possible: "var(--color-accent)"
- Responsive styles via "$media" breakpoints at the document level

### State Binding
- Template expressions in strings: "\${state.count}" — auto-updates when count changes
- $ref for function binding: "onclick": { "$ref": "#/state/handleClick" }
- Computed values: "fullName": "\${state.first} \${state.last}"

### Component Rules
- Custom element tag names MUST contain a hyphen (e.g. "my-counter", "feature-card")
- Standard HTML elements use their standard tag names
- Components referenced in "$elements" become available as tag names`;

// ─── State Shape Decision Tree ───────────────────────────────────────────────

const STATE_SHAPE_DECISION_TREE = `## State Shape Decision Tree

When adding state to a component, choose the right shape:

1. **Simple reactive value** — use a scalar:
   "count": 0

2. **Typed reactive value** — add type + default:
   "name": { "type": "string", "default": "" }

3. **Derived/computed value** — use a template expression:
   "fullName": "\${state.first} \${state.last}"

4. **Boolean computed** — use a template comparison:
   "isActive": "\${state.status === 'active'}"

5. **Event handler** — use $prototype: "Function":
   "handleClick": { "$prototype": "Function", "body": "state.count++" }

6. **External data** — use $prototype: "Data":
   "posts": { "$prototype": "Data", "$src": "./posts.json" }`;

// ─── Real-World Patterns ─────────────────────────────────────────────────────

const REAL_WORLD_PATTERNS = `## Real-World Jx Patterns (from jxsuite.com production site)

### Simple component with props (components/cta-button.json):
{
  "tagName": "cta-button",
  "state": {
    "href": "/",
    "label": "Click",
    "variant": "primary",
    "isPrimary": "\${state.variant === 'primary'}"
  },
  "children": [{
    "tagName": "a",
    "attributes": { "href": "\${state.href}" },
    "style": {
      "backgroundColor": "\${state.isPrimary ? 'var(--color-accent)' : 'transparent'}",
      "color": "\${state.isPrimary ? 'white' : 'var(--color-text-secondary)'}",
      "display": "inline-flex",
      "padding": "0.6875rem 1.75rem",
      "borderRadius": "var(--radius)",
      "textDecoration": "none",
      "fontWeight": "600"
    },
    "textContent": "\${state.label}"
  }]
}

### Premium: stat card with layered surface (components/stat-card.json):
Note: surface elevation via --color-bg-surface on --color-bg-primary; accent only on the value; muted mono label; on-scale spacing.
{
  "tagName": "stat-card",
  "state": { "value": "0", "label": "Description" },
  "style": {
    "display": "flex", "flexDirection": "column", "gap": "0.5rem",
    "padding": "2rem", "borderRadius": "var(--radius-lg)",
    "border": "1px solid var(--color-border)",
    "backgroundColor": "var(--color-bg-surface)"
  },
  "children": [
    { "tagName": "div", "textContent": "\${state.value}", "style": { "fontSize": "2.5rem", "fontWeight": "700", "letterSpacing": "-0.03em", "lineHeight": "1", "color": "var(--color-accent)" } },
    { "tagName": "div", "textContent": "\${state.label}", "style": { "fontFamily": "var(--font-mono)", "fontSize": "0.75rem", "letterSpacing": "0.08em", "textTransform": "uppercase", "color": "var(--color-text-muted)" } }
  ]
}

### Premium: step card with centered layout (components/step-card.json):
Note: restraint — no background, no border, just centered content with a circular badge; accent only on the number; secondary text for description.
{
  "tagName": "step-card",
  "state": { "number": "1", "title": "", "description": "" },
  "style": { "display": "block", "textAlign": "center", "padding": "2rem 1.5rem" },
  "children": [
    { "tagName": "div", "textContent": "\${state.number}", "style": { "width": "3rem", "height": "3rem", "borderRadius": "50%", "border": "2px solid var(--color-border)", "display": "flex", "alignItems": "center", "justifyContent": "center", "margin": "0 auto 1.25rem", "fontFamily": "var(--font-mono)", "fontSize": "0.875rem", "fontWeight": "700", "color": "var(--color-accent)" } },
    { "tagName": "h3", "textContent": "\${state.title}", "style": { "fontSize": "1.0625rem", "fontWeight": "600", "margin": "0 0 0.5rem" } },
    { "tagName": "p", "textContent": "\${state.description}", "style": { "color": "var(--color-text-secondary)", "fontSize": "0.875rem", "margin": "0", "lineHeight": "1.6" } }
  ]
}

### Layout with slots (layouts/base.json):
{
  "tagName": "div",
  "$elements": [
    { "$ref": "../components/site-toolbar.json" },
    { "$ref": "../components/site-footer.json" }
  ],
  "children": [
    { "tagName": "site-toolbar" },
    { "tagName": "main", "style": { "flex": "1" }, "children": [{ "tagName": "slot" }] },
    { "tagName": "site-footer" }
  ]
}

### Site config with design tokens (project.json):
{
  "style": {
    "--color-bg-primary": "#0a0a0a",
    "--color-bg-secondary": "#111111",
    "--color-accent": "#3b82f6",
    "--color-text-primary": "#fafafa",
    "--color-text-secondary": "#a1a1aa",
    "--font-mono": "'JetBrains Mono', 'SF Mono', Consolas, monospace",
    "--radius": "8px",
    "--max-width": "1200px"
  },
  "$media": {
    "--": "1280px",
    "--lg": "(max-width: 1024px)",
    "--md": "(max-width: 768px)",
    "--sm": "(max-width: 640px)"
  }
}

### Responsive Styles (per-node @breakpoint overrides)

When the project defines $media breakpoints (e.g. "--md": "(max-width: 768px)"), apply responsive styles with @--breakpoint keys inside any node's style object. These override the base styles at the matching breakpoint:

{
  "tagName": "div",
  "style": {
    "display": "grid",
    "gridTemplateColumns": "repeat(3, 1fr)",
    "gap": "1.5rem",
    "@--md": { "gridTemplateColumns": "repeat(2, 1fr)" },
    "@--sm": { "gridTemplateColumns": "1fr" }
  }
}

Always use @--breakpoint responsive overrides for "responsive" or "mobile-friendly" requests when the project has $media breakpoints. Check the Project Context for available breakpoints.`;

const DESIGN_PRINCIPLES = `## Design Principles (premium component output)

When building components, pages, or layouts, follow these rules to produce polished output:

### Tokens first
Reference the project's design tokens via var(--token) for ALL colors, radii, fonts, and max-widths. Never hard-code a hex color or px radius that a token already covers. Check the Project Context for available tokens.

### Spacing rhythm
Use a consistent step scale: 0.25 / 0.5 / 0.75 / 1 / 1.5 / 2 / 3 / 4rem. Never use arbitrary values like 13px or 7px. Padding and gaps should feel proportional.

### Type scale
Use these sizes for hierarchy: 0.875rem (small/caption) → 1rem (body) → 1.125rem (large body) → 1.25rem (h4) → 1.5rem (h3) → 2rem (h2) → 2.5–3rem (h1/hero). Use fontWeight (400/500/600/700) to reinforce hierarchy — not just size.

### Color & elevation
Layer surfaces: content panels use var(--color-bg-surface) on top of var(--color-bg-primary). Borders use var(--color-border) or var(--color-border-subtle). Secondary text uses var(--color-text-secondary), muted text uses var(--color-text-muted). Use var(--color-accent) sparingly — CTAs and key interactive elements only.

### Layout
Use generous padding (1.5–3rem sections, 1–1.5rem cards). Constrain content width with var(--max-width). For multi-column layouts, always add @--md and @--sm responsive overrides that stack to fewer/single columns.

### Restraint
Limit to 2–3 colors per component. Prefer whitespace over decoration. No gradients or heavy shadows unless specifically requested. One accent color, used sparingly.`;

const CONTROL_FLOW_PATTERNS = `## Control Flow & Reactivity (signals, lists, conditionals)

State entries are reactive signals. Mutate them in event handlers and the DOM updates automatically.
Reference state in templates with \${state.x}; the value of the current item inside a list map is \${$map.item}.

### Reactive counter — signal + event handlers (state Function + onclick $ref):
Buttons mutate a numeric signal. Define handlers as Function-prototype state and wire them with onclick: { "$ref": "#/state/<name>" }.
{
  "tagName": "counter-widget",
  "state": {
    "count": { "type": "number", "default": 0 },
    "increment": { "$prototype": "Function", "body": "state.count++" },
    "decrement": { "$prototype": "Function", "body": "state.count--" }
  },
  "children": [
    { "tagName": "button", "textContent": "−", "onclick": { "$ref": "#/state/decrement" } },
    { "tagName": "span", "textContent": "\${state.count}" },
    { "tagName": "button", "textContent": "+", "onclick": { "$ref": "#/state/increment" } }
  ]
}

### List rendering — repeat children over an array ($prototype: "Array" + map):
'children' becomes an OBJECT (not an array) with $prototype "Array", an 'items' $ref to the state array, and a 'map' node template. Use \${$map.item} for the current item and \${$map.index} for its index.
{
  "tagName": "ul",
  "children": {
    "$prototype": "Array",
    "items": { "$ref": "#/state/items" },
    "map": { "tagName": "li", "textContent": "\${$map.item}" }
  }
}

Inside a $map handler's Function body, the current item's index is available as state.$map?.index and the item as state.$map?.item. Use these to mutate the backing array:
"deleteItem": { "$prototype": "Function", "body": "const i = state.$map?.index ?? -1; if (i >= 0) state.items.splice(i, 1);" }

### Todo list with per-item delete — full pattern (state array + $map + handlers):
{
  "tagName": "todo-list",
  "state": {
    "items": { "type": "array", "default": [] },
    "newText": { "type": "string", "default": "" },
    "updateText": { "$prototype": "Function", "parameters": ["event"], "body": "state.newText = event.target.value;" },
    "addItem": { "$prototype": "Function", "body": "const t = state.newText.trim(); if (!t) return; state.items.push(t); state.newText = '';" },
    "deleteItem": { "$prototype": "Function", "body": "const i = state.$map?.index ?? -1; if (i >= 0) state.items.splice(i, 1);" }
  },
  "children": [
    { "tagName": "div", "style": { "display": "flex", "gap": "0.5em" }, "children": [
      { "tagName": "input", "value": { "$ref": "#/state/newText" }, "oninput": { "$ref": "#/state/updateText" }, "attributes": { "type": "text", "placeholder": "Add item…" } },
      { "tagName": "button", "textContent": "Add", "onclick": { "$ref": "#/state/addItem" } }
    ]},
    { "tagName": "ul", "children": {
      "$prototype": "Array",
      "items": { "$ref": "#/state/items" },
      "map": { "tagName": "li", "children": [
        { "tagName": "span", "textContent": "\${$map.item}" },
        { "tagName": "button", "textContent": "×", "onclick": { "$ref": "#/state/deleteItem" } }
      ]}
    }}
  ]
}

### Conditional rendering — swap a subtree by a signal ($switch + cases):
A $switch node carries a wrapper "tagName" (usually "div"), a "$switch" $ref to a state value, and a "cases" object mapping each value to a node. The $ref MUST point at state (#/state/...). Nest it as a normal child inside a children array.
{
  "tagName": "div",
  "$switch": { "$ref": "#/state/currentRoute" },
  "cases": {
    "home": { "tagName": "section", "textContent": "Home view" },
    "about": { "tagName": "section", "textContent": "About view" }
  }
}

To switch the active case, set the signal in a handler (e.g. state.currentRoute = "about").

### Tab switcher — full pattern (onclick handlers + $switch):
{
  "tagName": "tab-panel",
  "state": {
    "activeTab": { "type": "string", "default": "tab1" },
    "showTab1": { "$prototype": "Function", "body": "state.activeTab = 'tab1';" },
    "showTab2": { "$prototype": "Function", "body": "state.activeTab = 'tab2';" },
    "showTab3": { "$prototype": "Function", "body": "state.activeTab = 'tab3';" }
  },
  "children": [
    { "tagName": "div", "style": { "display": "flex", "gap": "0.5rem" }, "children": [
      { "tagName": "button", "textContent": "Tab 1", "onclick": { "$ref": "#/state/showTab1" } },
      { "tagName": "button", "textContent": "Tab 2", "onclick": { "$ref": "#/state/showTab2" } },
      { "tagName": "button", "textContent": "Tab 3", "onclick": { "$ref": "#/state/showTab3" } }
    ]},
    { "tagName": "div", "$switch": { "$ref": "#/state/activeTab" }, "cases": {
      "tab1": { "tagName": "section", "textContent": "Content for Tab 1" },
      "tab2": { "tagName": "section", "textContent": "Content for Tab 2" },
      "tab3": { "tagName": "section", "textContent": "Content for Tab 3" }
    }}
  ]
}`;

// ─── Multi-Page Patterns ────────────────────────────────────────────────────

const MULTI_PAGE_PATTERNS = `## Multi-Page Site Building

### File-based routing
Create pages under the pages/ directory — routes are automatic:
- pages/index.json → /
- pages/about.json → /about/
- pages/blog/index.json → /blog/
- pages/blog/[slug].json → /blog/:slug (dynamic route)

### Layout inheritance
Pages can reference a shared layout via "$layout":
{ "$layout": "./layouts/base.json", "children": [{ "tagName": "section", "textContent": "Page content" }] }

A layout uses { "tagName": "slot" } as the insertion point for page content:
{
  "tagName": "div",
  "$elements": [{ "$ref": "../components/site-toolbar.json" }, { "$ref": "../components/site-footer.json" }],
  "children": [
    { "tagName": "site-toolbar" },
    { "tagName": "main", "style": { "flex": "1" }, "children": [{ "tagName": "slot" }] },
    { "tagName": "site-footer" }
  ]
}

### Navigation between pages
Use standard anchor links: { "tagName": "a", "attributes": { "href": "/about" }, "textContent": "About" }

### Page metadata
"$head" is an ARRAY of element definitions for <head> entries (title, meta, link tags):
{ "$head": [{ "tagName": "title", "textContent": "About Us" }, { "tagName": "meta", "attributes": { "name": "description", "content": "Learn about our team" } }] }

### Multi-page workflow
When asked to build a site with multiple pages:
1. Create the layout first (layouts/base.json) with navigation and footer slots
2. Create shared components (nav bar, footer) and import them in the layout
3. Create each page with "$layout" referencing the layout
4. Use open_document to switch between files and refine each one
5. Ensure navigation links match the actual page paths`;

// ─── System prompt builder ───────────────────────────────────────────────────

/**
 * Build a dynamic system prompt for the AI assistant.
 *
 * @param {object} opts
 * @param {import("../state.js").JxNode} [opts.document] - The currently open Jx document
 * @param {object} [opts.projectConfig] - The project.json config if available
 * @param {import("../files/components.js").ComponentEntry[]} [opts.components] - Available
 *   components
 * @param {string} [opts.projectRoot] - Project root path
 * @returns {string}
 */
export function buildSystemPrompt({
  document,
  projectConfig,
  components,
  projectRoot,
  hasProject = Boolean(projectRoot),
  fileInventory,
}: BuildSystemPromptOptions = {}) {
  const hasDocument = Boolean(document);

  // 1. Role, state-appropriate workflow, and the tool list for the current state.
  const toolList = AI_TOOL_TIERS.filter((t) => tierActive(t.tier, hasProject, hasDocument))
    .map((t) => `- ${t.blurb}`)
    .join("\n");

  const role = `You are an expert Jx builder assistant embedded in Jx Studio. You help users build websites, components, pages, and layouts using the Jx JSON schema. The live jxsuite.com marketing site is built entirely with Jx — you can produce production-quality Jx code.`;

  let workflow: string;
  if (!hasProject && !hasDocument) {
    workflow = `No project is open yet. Your first job is to bootstrap one:
1. Gather what the user wants (site type, name, look) — ask briefly only if essential details are missing.
2. Call create_project with a fitting name, template, and design quickstart (colors/fonts) derived from the request.
3. After it succeeds the studio opens the project, and the file and document tools become available in the next round — continue building pages, components, and layouts with them without waiting to be asked.

Tools available right now:
${toolList}`;
  } else if (!hasDocument) {
    workflow = `A project is open, but no document is on the canvas. Work across the project's files directly — you do not need to open documents to develop:
1. Discover with list_files / search_files, inspect with read_file.
2. Create or modify files with write_file / create_page / create_component. Jx documents are validated before writing; fix reported errors and retry.
3. Use open_document only when the user should see a page on the canvas, or when you want the finer-grained document tools for iterative edits.

Tools available right now:
${toolList}`;
  } else {
    workflow = `You have tools that read and modify the live Jx document directly, plus project-wide file tools. Always prefer tool calls over describing changes in text:
${toolList}

When the user asks you to build or modify something:
1. Call read_document first if needed to discover the current structure and valid paths.
2. Plan your changes — think about which tools you'll need.
3. Execute the tools in the right order (e.g., add_child before set_property on the new node).
4. For changes spanning OTHER files, use read_file/write_file directly instead of opening each one.
5. Summarize what you changed clearly.

Your document edits apply to the live canvas immediately and are individually undoable (file writes are not). After each edit the document is schema-validated: if a tool returns { success: false } reporting schema errors, your change introduced them — issue a follow-up edit to fix them.`;
  }

  const closing = `You have a limited number of tool-call rounds per message. On vague or open-ended prompts ("make it look better", "improve this"), prefer a small number of targeted, high-impact changes over attempting to rebuild the entire page. Explain what you changed and offer to do more.

Be concise. Don't explain what Jx is unless asked. Just build.`;

  const sections = [`${role}\n\n${workflow}\n\n${closing}`];

  // eslint-disable-next-line unicorn/no-immediate-mutation -- conditional section builder: later sections are pushed only when their context exists
  sections.push(
    // 2. Jx schema reference — kept in ALL modes (pre-project the model plans starter content)
    JX_SCHEMA_REFERENCE,
    // 3. State shape decision tree
    STATE_SHAPE_DECISION_TREE,
    // 4. Real-world patterns
    REAL_WORLD_PATTERNS,
    // 4a. Design principles — spacing, type, color, layout, restraint
    DESIGN_PRINCIPLES,
    // 4b. Control flow & reactivity — signals, list rendering ($map), conditionals ($switch)
    CONTROL_FLOW_PATTERNS,
    // 4c. Multi-page site building — layouts, file-based routing, navigation
    MULTI_PAGE_PATTERNS,
  );

  // 5. Current document context
  if (document) {
    const summary = buildDocumentSummary(document);
    sections.push(`## Current Document\n\n${summary}`);
  }

  // 6. Project context
  if (hasProject && (projectConfig || components || projectRoot)) {
    const projectSummary = buildProjectSummary({ projectConfig, components, projectRoot });
    if (projectSummary) {
      sections.push(`## Project Context\n\n${projectSummary}`);
    }
  }

  // 6a. File inventory — a compact map of the project for cross-file work
  if (hasProject && fileInventory && fileInventory.length > 0) {
    const capped = fileInventory.slice(0, FILE_INVENTORY_CAP);
    const more =
      fileInventory.length > capped.length
        ? `\n… and ${fileInventory.length - capped.length} more (use list_files)`
        : "";
    sections.push(`## Project Files\n\n${capped.join("\n")}${more}`);
  }

  // 7. Error recovery guidance
  sections.push(`## Error Recovery

If a tool call fails (returns { success: false }):
1. Read the error message carefully — it includes a "→ Fix:" hint telling you exactly how to correct the error.
2. Each error points to a specific path in the document and a specific rule violation.
3. Apply the suggested fix using set_property, remove_node, or add_child as appropriate.
4. Do NOT re-issue the exact same tool call with the same arguments — you must CHANGE something.
5. If you see the SAME error after 2 attempts, try a completely different approach (e.g., remove and re-add the node instead of patching it).

### Common validation errors and their fixes:

| Error pattern | What happened | How to fix |
|---|---|---|
| "must NOT have additional property" in style | You used a non-camelCase CSS property (e.g. "background-color") or put an HTML attribute directly on the element. | Use camelCase: "backgroundColor". Put aria-*, data-*, role, and other non-IDL attributes inside the "attributes" object: { "attributes": { "aria-label": "..." } } |
| "must match pattern" on tagName | A custom element tag name doesn't contain a hyphen. | Add a hyphen: "newsletter-form" not "newsletter". Standard HTML elements use their exact name ("div", "p", "input"). |
| "must be string" | A value is an unquoted number, boolean, or bare word. | Wrap the value in quotes: "10px" not 10px. All CSS values and text must be strings. |
| "must be number" / "must be integer" | A numeric field (like index, tabIndex) is wrapped in quotes. | Remove the quotes: use 0 not "0". |
| "must have required property" | A required field is missing from the node. | Add the missing property. Every element must have "tagName". |
| "must be object" | A field that expects an object (like style or attributes) received a string or other type. | Use {} not a string. |
| "No node exists at path" | The path you provided doesn't point to an existing node. | Call read_document first to see the current structure and valid paths, then use the correct path. |

### If you keep getting errors:
- Call read_document again — the document may have changed since you last read it.
- Remove the problematic node entirely with remove_node, then re-create it correctly with add_child.
- If the error message points to a different path than you expected, the node might have moved due to previous edits.`);

  return sections.join("\n\n---\n\n");
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a structural summary of a Jx document — element tree outline without full property values.
 * This keeps the system prompt small even for large documents.
 *
 * @param {JxMutableNode} doc
 * @returns {string}
 */
function buildDocumentSummary(doc: JxMutableNode) {
  const lines: string[] = [];
  const id = doc.$id || "(unnamed)";
  lines.push(`Document: ${id}`);

  // Element tree outline
  const flat = flattenTree(doc);
  lines.push(`\nElement tree (${flat.length} nodes):`);
  for (const item of flat) {
    const indent = "  ".repeat(item.depth);
    const row = item as typeof item & { id?: string; tag?: string };
    const label = row.id || row.tag;
    lines.push(`${indent}${label}`);
  }

  // State overview
  if (doc.state) {
    const stateKeys = Object.keys(doc.state);
    if (stateKeys.length > 0) {
      lines.push(`\nState keys (${stateKeys.length}): ${stateKeys.join(", ")}`);
      // Add type info for each state entry
      for (const key of stateKeys) {
        const entry: unknown = doc.state[key];
        const entryObj = entry as Record<string, unknown>;
        let typeStr = "unknown";
        if (!entry || typeof entry !== "object") {
          typeStr = typeof entry;
        } else if (entryObj.$prototype === "Function") {
          typeStr = "Function";
        } else if (entryObj.$prototype === "Data") {
          typeStr = "Data source";
        } else if (typeof entry === "string" && (entry as string).includes("${")) {
          typeStr = "Computed";
        } else if (entryObj.type) {
          typeStr = `Typed (${entryObj.type})`;
        } else {
          typeStr = "Scalar";
        }
        lines.push(`  ${key}: ${typeStr}`);
      }
    }
  }

  // Imported elements
  if (doc.$elements && doc.$elements.length > 0) {
    const refs = doc.$elements
      .map((e) => (typeof e === "string" ? e : e.$ref || "(unknown)"))
      .join(", ");
    lines.push(`\nImported elements: ${refs}`);
  }

  return lines.join("\n");
}

/**
 * Build a project context summary.
 *
 * @param {object} opts
 * @returns {string}
 */
function buildProjectSummary({
  projectConfig,
  components,
  projectRoot,
}: Omit<BuildSystemPromptOptions, "document">) {
  const lines: string[] = [];

  if (projectConfig?.name) {
    lines.push(`Project: ${projectConfig.name}`);
  }

  if (projectRoot) {
    lines.push(`Root: ${projectRoot}`);
  }

  // Available components — tag + purpose so the model can reuse them
  if (components && components.length > 0) {
    lines.push(`Available components (reuse these instead of rebuilding):`);
    for (const c of components) {
      const entry = c as ComponentEntry & { tag?: string; name?: string };
      const tag = entry.tagName || entry.tag || entry.name || entry.path;
      const label = c.$id ? ` — ${c.$id}` : "";
      lines.push(`  <${tag}>${label}${c.path ? ` (${c.path})` : ""}`);
    }
  }

  // Design tokens — name → value pairs, grouped by prefix
  if (projectConfig?.style) {
    const tokens = Object.entries(projectConfig.style).filter(([k]) => k.startsWith("--"));
    if (tokens.length > 0) {
      lines.push(
        `Design tokens (always use var(--token) — never hard-code a color, radius, or font that a token defines):`,
      );
      type TokenEntry = (typeof tokens)[number];
      const groups: { color: TokenEntry[]; font: TokenEntry[]; other: TokenEntry[] } = {
        color: [],
        font: [],
        other: [],
      };
      for (const [k, v] of tokens) {
        if (k.startsWith("--color")) {
          groups.color.push([k, v]);
        } else if (k.startsWith("--font")) {
          groups.font.push([k, v]);
        } else {
          groups.other.push([k, v]);
        }
      }
      const fmt = (entries: TokenEntry[]) => entries.map(([k, v]) => `  ${k}: ${v}`).join("\n");
      if (groups.color.length > 0) {
        lines.push(fmt(groups.color));
      }
      if (groups.font.length > 0) {
        lines.push(fmt(groups.font));
      }
      if (groups.other.length > 0) {
        lines.push(fmt(groups.other));
      }
    }
  }

  // Breakpoints — surfaced prominently so the model uses @--breakpoint responsive overrides
  if (projectConfig?.$media) {
    const breakpoints = Object.entries(projectConfig.$media)
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");
    lines.push(
      `Responsive breakpoints (use @${Object.keys(projectConfig.$media)[0]} etc. in style objects): ${breakpoints}`,
    );
  }

  return lines.join("\n");
}
