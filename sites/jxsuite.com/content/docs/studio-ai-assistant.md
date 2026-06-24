---
title: "AI Assistant — Jx Suite"
description: "Learn how to use the JX Studio AI Assistant to build and edit components with natural language. The AI reads, creates, and modifies JX documents on the live canvas."
---

# AI Assistant

The AI Assistant lets you describe what you want in plain English and builds it directly on the live canvas. Every change is undoable. Every edit is visible. You're always in control.

## Getting Started

### 1. Set up your API key

Click the key button in the AI Assistant toolbar. Enter an OpenAI-compatible API key (any provider works: OpenAI, Anthropic via compatible endpoint, local models via Ollama). Choose your model. The key is stored locally in your browser — never sent anywhere except to your chosen endpoint through the Studio proxy.

### 2. Open the AI Assistant

The AI Assistant lives in the right panel as a tab. Click the AI icon in the inspector tabs, or press `Ctrl+L`. Make sure the mode toggle is set to "Assistant" (not "Dev Agent").

### 3. Start building

Type what you want to build. The AI reads your current document, plans the changes, and applies them directly to the canvas. You can see every change happen in real-time.

## What the AI Can Do

- **Read Document** — The AI can read any part of your document — the whole thing, a subtree at a specific path, or individual properties. It discovers what's there before making changes.
- **Set Properties** — Change tagName, textContent, className, style properties, attributes, event handlers — any property on any element. Can also remove properties by setting them to null.
- **Add & Remove Elements** — Add new child elements at any position in the tree. Remove existing elements. The AI handles nesting, void element rules, and hyphen requirements automatically.
- **Schema Validation** — After every change, the AI validates against the JX schema. If it introduces errors, it reports them and self-corrects. You'll never see invalid JSON on the canvas.
- **Token-First Styling** — The AI knows your project's design tokens and preferentially uses `var(--token)` references. It warns when you use hardcoded values that have token equivalents.
- **Undo Everything** — Every AI change goes through `transactDoc()` — the same undo system as manual edits. Press `Ctrl+Z` to undo any AI change. All changes from one message are batched into a single undo step.

## Example Prompts

- **"Build a hero section with a heading, subtitle, and two CTA buttons"** — The AI creates a styled section with an h1, paragraph, and button group — using your project's design tokens and responsive breakpoints.
- **"Make this card responsive — 3 columns on desktop, 2 on tablet, 1 on mobile"** — The AI adds `@--md` and `@--sm` responsive overrides to the grid layout, using your project's existing breakpoint names.
- **"Add a counter with increment and decrement buttons"** — The AI creates state with count, a computed label, two button event handlers, and a span bound to `${state.count}`.
- **"Change all colors to use design tokens instead of hardcoded hex values"** — The AI reads your project's token palette and replaces hardcoded colors with the closest `var(--token)` equivalents.
- **"Create a nav component with logo, links, and a mobile hamburger menu"** — The AI builds a full nav component with state for mobile menu toggle, responsive styles, and proper semantic HTML structure.

## How It Works

The AI Assistant uses a tool-calling architecture:

1. **You send a message** — The AI receives your message along with a system prompt containing the JX schema reference, your project's design tokens, and a structural summary of your current document.
2. **The AI plans** — It reads the relevant parts of your document, then calls tools (read_document, set_property, add_child, remove_node) to make changes.
3. **Changes apply live** — Each tool call modifies the document through `transactDoc()`. The canvas re-renders immediately via Vue reactivity.
4. **Validation runs** — After each change, the JX schema validator checks the document. New errors are reported back to the AI for self-correction.
5. **The AI responds** — It tells you what it did, what changed, and any issues it encountered. If something failed, it tries again (up to 5 rounds of self-correction).
