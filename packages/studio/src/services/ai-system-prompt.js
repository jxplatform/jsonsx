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

### Card with configurable props (components/feature-card.json):
{
  "tagName": "feature-card",
  "state": {
    "icon": "",
    "iconBg": "rgba(59, 130, 246, 0.1)",
    "title": "",
    "description": ""
  },
  "children": [
    { "tagName": "div", "textContent": "\${state.icon}", "style": { "backgroundColor": "\${state.iconBg}", "width": "2.25rem", "height": "2.25rem", "borderRadius": "var(--radius)", "display": "flex", "alignItems": "center", "justifyContent": "center" } },
    { "tagName": "h3", "textContent": "\${state.title}", "style": { "fontSize": "0.9375rem", "fontWeight": "600" } },
    { "tagName": "p", "textContent": "\${state.description}", "style": { "color": "var(--color-text-secondary)", "fontSize": "0.875rem" } }
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
}`;

const CONTROL_FLOW_PATTERNS = `## Control Flow & Reactivity (signals, lists, conditionals)

State entries are reactive signals. Mutate them in event handlers and the DOM updates automatically.
Reference state in templates with \${state.x}; the value of the current item inside a list map is \${$map.item}.

### Reactive counter — signal + event handlers (state Function + onclick \$ref):
Buttons mutate a numeric signal. Define handlers as Function-prototype state and wire them with onclick: { "\$ref": "#/state/<name>" }.
{
  "tagName": "counter-widget",
  "state": {
    "count": { "type": "number", "default": 0 },
    "increment": { "\$prototype": "Function", "body": "state.count++" },
    "decrement": { "\$prototype": "Function", "body": "state.count--" }
  },
  "children": [
    { "tagName": "button", "textContent": "−", "onclick": { "\$ref": "#/state/decrement" } },
    { "tagName": "span", "textContent": "\${state.count}" },
    { "tagName": "button", "textContent": "+", "onclick": { "\$ref": "#/state/increment" } }
  ]
}

### List rendering — repeat children over an array (\$prototype: "Array" + map):
'children' becomes an OBJECT (not an array) with \$prototype "Array", an 'items' \$ref to the state array, and a 'map' node template. Use \${$map.item} for the current item.
{
  "tagName": "ul",
  "children": {
    "\$prototype": "Array",
    "items": { "\$ref": "#/state/items" },
    "map": { "tagName": "li", "textContent": "\${$map.item}" }
  }
}

### Conditional rendering — swap a subtree by a signal (\$switch + cases):
A \$switch node carries a wrapper "tagName" (usually "div"), a "\$switch" \$ref to a state value, and a "cases" object mapping each value to a node. The \$ref MUST point at state (#/state/...). Nest it as a normal child inside a children array.
{
  "tagName": "div",
  "\$switch": { "\$ref": "#/state/currentRoute" },
  "cases": {
    "home": { "tagName": "section", "textContent": "Home view" },
    "about": { "tagName": "section", "textContent": "About view" }
  }
}

To switch the active case, set the signal in a handler (e.g. state.currentRoute = "about").`;

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
export function buildSystemPrompt({ document, projectConfig, components, projectRoot } = {}) {
  // 1. Role & capabilities
  const sections = [
    `You are an expert Jx builder assistant embedded in Jx Studio. You help users build websites, components, pages, and layouts using the Jx JSON schema. The live jxsuite.com marketing site is built entirely with Jx — you can produce production-quality Jx code.

You have access to these tools that read and modify the live Jx document directly. Always prefer tool calls over describing changes in text:
- read_document(path?) — inspect the whole document or the subtree at a path. Paths are JSON arrays of keys/indices from the root, e.g. ["children", 0, "children", 1].
- set_property(path, key, value) — set or remove a property on the node at path (tagName, textContent, className, style, attributes, $props…). Pass value: null to remove.
- set_style(path, property, value) — set or remove a CSS style property (camelCase) on a node. Values as strings: "10px", "var(--color-accent)". Pass value: null to remove.
- set_text(path, value) — convenient alias for set_property with key: "textContent".
- add_child(parentPath, index, node) — insert a new node into the children of parentPath at index.
- remove_node(path) — remove the node at path.
- move_node(fromPath, toParentPath, toIndex) — move a node from one location to another.
- add_state(key, value) — add a reactive state variable under the document's 'state' object. Value can be scalar, typed, computed, function, or data source.
- update_state(key, value) — update or remove (value: null) an existing state variable.
- create_component(path, content) — create a new .json component file on disk.
- create_page(path, content) — create a new .json page file on disk.

When the user asks you to build or modify something:
1. Call read_document first if needed to discover the current structure and valid paths.
2. Plan your changes — think about which tools you'll need.
3. Execute the tools in the right order (e.g., add_child before set_property on the new node).
4. Summarize what you changed clearly.

Your edits apply to the live canvas immediately and are individually undoable. After each edit the document is schema-validated: if a tool returns { success: false } reporting schema errors, your change introduced them — issue a follow-up edit to fix them.

Be concise. Don't explain what Jx is unless asked. Just build.`,
  ];

  // 2. Jx schema reference
  // eslint-disable-next-line unicorn/no-immediate-mutation -- conditional section builder: later sections are pushed only when their context exists
  sections.push(JX_SCHEMA_REFERENCE);

  // 3. State shape decision tree
  sections.push(STATE_SHAPE_DECISION_TREE);

  // 4. Real-world patterns
  sections.push(REAL_WORLD_PATTERNS);

  // 4b. Control flow & reactivity — signals, list rendering ($map), conditionals ($switch)
  sections.push(CONTROL_FLOW_PATTERNS);

  // 5. Current document context
  if (document) {
    const summary = buildDocumentSummary(document);
    sections.push(`## Current Document\n\n${summary}`);
  }

  // 6. Project context
  if (projectConfig || components || projectRoot) {
    const projectSummary = buildProjectSummary({ projectConfig, components, projectRoot });
    if (projectSummary) {
      sections.push(`## Project Context\n\n${projectSummary}`);
    }
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
 * @param {import("../state.js").JxNode} doc
 * @returns {string}
 */
function buildDocumentSummary(doc) {
  const lines = [];
  const id = doc.$id || "(unnamed)";
  lines.push(`Document: ${id}`);

  // Element tree outline
  const flat = flattenTree(doc);
  lines.push(`\nElement tree (${flat.length} nodes):`);
  for (const item of flat) {
    const indent = "  ".repeat(item.depth);
    const label = item.id || item.tag;
    lines.push(`${indent}${label}`);
  }

  // State overview
  if (doc.state) {
    const stateKeys = Object.keys(doc.state);
    if (stateKeys.length > 0) {
      lines.push(`\nState keys (${stateKeys.length}): ${stateKeys.join(", ")}`);
      // Add type info for each state entry
      for (const key of stateKeys) {
        const entry = doc.state[key];
        let typeStr = "unknown";
        if (!entry || typeof entry !== "object") {
          typeStr = typeof entry;
        } else if (entry.$prototype === "Function") {
          typeStr = "Function";
        } else if (entry.$prototype === "Data") {
          typeStr = "Data source";
        } else if (typeof entry === "string" && entry.includes("${")) {
          typeStr = "Computed";
        } else if (entry.type) {
          typeStr = `Typed (${entry.type})`;
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
function buildProjectSummary({ projectConfig, components, projectRoot }) {
  const lines = [];

  if (projectConfig?.name) {
    lines.push(`Project: ${projectConfig.name}`);
  }

  if (projectRoot) {
    lines.push(`Root: ${projectRoot}`);
  }

  // Available components
  if (components && components.length > 0) {
    const names = components.map((c) => c.tag || c.name || c.path).join(", ");
    lines.push(`Available components: ${names}`);
  }

  // CSS custom properties from project config
  if (projectConfig?.style) {
    const customProps = Object.keys(projectConfig.style)
      .filter((k) => k.startsWith("--"))
      .slice(0, 15);
    if (customProps.length > 0) {
      lines.push(`Design tokens: ${customProps.join(", ")}`);
    }
  }

  // Breakpoints
  if (projectConfig?.$media) {
    const breakpoints = Object.entries(projectConfig.$media)
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");
    lines.push(`Breakpoints: ${breakpoints}`);
  }

  return lines.join("\n");
}
