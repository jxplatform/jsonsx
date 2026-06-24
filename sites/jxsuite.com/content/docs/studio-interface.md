---
title: "Studio Interface — Jx Suite"
description: "A detailed visual walkthrough of every panel in JX Studio: activity bar, layers, files, canvas, toolbar, inspector, and status bar."
---

# Interface Walkthrough

A panel-by-panel tour of the JX Studio interface. Learn what each panel does, how to navigate between them, and which keyboard shortcuts to use.

## Activity Bar (Left Sidebar)

The narrow vertical strip on the far left. Each icon switches the left panel to a different view. Click an icon to activate it, click again to collapse the left panel.

- **Layers** — Tree view of every element in the document. Click to select, drag to reorder, right-click for context menu. Shows tagName for each node. The root element is at the top.
- **Files** — Project file explorer. Browse pages/, components/, layouts/, content/, public/. Open any .json file by clicking. Create new files and folders. Drag files to reorder.
- **Imports** — Lists all registered components, classes, and modules. Shows what's available via `$elements` and what's been imported. Double-click to open the source.
- **Source Control** — Built-in git panel. Stage, unstage, commit, push, pull. View diffs. Switch branches. See changed files with status indicators.
- **Data Explorer** — Browse web platform API data: HTML elements, attributes, CSS properties, ARIA roles. Reference material for building standards-compliant components.
- **Settings** — Project configuration. AI provider settings (API key, model, endpoint). Component registry. Format class management.

## Canvas & Toolbar (Center)

The canvas is a live render of your component using @jxsuite/runtime — the same engine that compiles your site. What you see on the canvas is exactly what ships.

- **Canvas Area** — Live rendered preview. Click elements to select them. Hover to see outlines. Pan with middle-click drag or Space+drag. Zoom with Ctrl+scroll or toolbar controls.
- **Toolbar** — Mode switcher (Design/Stylebook/Preview/Source/Content), zoom controls, media breakpoint tabs, component name display, and viewport controls at the top of the canvas area.
- **Media Breakpoints** — When a project has `$media` breakpoints defined, tabs appear in the toolbar to preview each breakpoint. Click to resize the canvas viewport and see responsive behavior.
- **Selection Overlay** — Selected elements show a blue border overlay with padding/margin indicators. Hovered elements show a subtle gray overlay. Click the overlay handles to select children.

### Canvas Modes

- **Design** — Default mode. Interactive editing with selection overlays, hover highlights, drag-and-drop, and inline text editing. Full WYSIWYG experience.
- **Stylebook** — Design token management. View all CSS custom properties, edit their values, and see a component gallery showing every component in context.
- **Preview** — Clean preview without any editing chrome. No selection overlays, no hover highlights. See exactly what the end user will see.
- **Source** — Raw JSON view with Monaco editor. Full syntax highlighting, code completion, and validation. Edit the document as plain JSON and see changes reflected on the canvas.
- **Content** — Inline text editing mode for Markdown content. Click any text to edit directly on the canvas. Supports Markdown formatting shortcuts and slash commands.

## Inspector (Right Panel)

The inspector shows detailed information about the currently selected element. It's tabbed — each tab edits a different aspect of the element.

- **Properties** — Edit element properties: tagName, textContent, className, hidden, tabIndex, attributes. Each property has its own input field with type-appropriate controls.
- **Style** — Visual CSS property editor. Organized by category (Layout, Typography, Background, Border, Spacing). Supports all camelCase CSS properties. Responsive overrides per breakpoint.
- **Signals** — View and edit the document's state entries. Add new signals, change types, edit default values. See computed dependencies. Inspect function bodies with Monaco.
- **Events** — View and edit event handlers (onclick, oninput, etc.). Shows which state functions are bound to which events. Edit function bodies inline with Monaco.
- **AI Assistant** — Chat interface for the AI document assistant. Use natural language to build and modify components. Changes are applied live to the canvas with full undo support.

## Status Bar (Bottom)

The status bar at the bottom of the window shows contextual information about the current state.

- **Selection Info** — Shows the tag name and path of the currently selected element. Click to copy the path. Shows element count in the document.
- **Save Status** — Indicates whether the document has unsaved changes (dirty indicator). Shows last save time. Auto-save can be configured.
- **Zoom Level** — Current canvas zoom percentage. Click to reset to 100%. Shows the viewport dimensions of the current media breakpoint.

---

**Next:** [Building Components](/docs/studio-components)
