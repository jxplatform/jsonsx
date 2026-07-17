---
title: "Modes and the preview toggle"
description: "Edit, Design, Grid, Code, and Stylebook — what each canvas mode is for, which files offer which modes, and how the Preview toggle fits in."
code:
  - packages/studio/src/panels/toolbar.ts
  - packages/studio/src/tabs/tab.ts
  - packages/studio/src/panels/tab-bar.ts
---

# Modes and the preview toggle

The mode switcher on the right side of the toolbar changes how the canvas presents the open file: **Edit**, **Design**, **Grid**, **Code**, and **Stylebook**. A mode is a lens, not a different app — the same file underneath, shown the way that suits the job. Modes that don't apply to the current file are disabled, and every open file remembers its own mode as you switch between tabs.

## Edit

Edit is for writing. The canvas becomes the page itself — click any text and type, press `/` for blocks, fill in the page's metadata alongside. It reads like the finished page because it is the finished page. Full guide: **[Edit mode](/docs/studio/editing)**.

![Jx Studio editing markdown content inline with a WYSIWYG editor](/screenshots/mode-edit.png)

## Design

Design is for structure and style. The canvas shows a live panel per breakpoint — phone, tablet, desktop side by side — and the **Style** tab in the right panel becomes a full visual inspector for the selected element. Full guide: **[Design mode](/docs/studio/design)**.

![Jx Studio design canvas showing one component across four responsive breakpoints with a style inspector](/screenshots/mode-design.png)

## Grid

Grid is for tabular data. Files like CSV spreadsheets open as an editable table: click a cell to change it, and use the familiar copy, paste, and selection keys — they work on the table's rows and cells rather than the page. Cell edits collect in the tab until you **Save**, which writes them all back to the file at once.

## Code

Code shows the file as raw source in a full code editor with syntax highlighting — the same editor VS Code uses. It's the escape hatch when you want to see exactly what Studio wrote, and the **Export** button in the tab bar saves a copy of the file elsewhere. Everything you can do here you can also do visually; see **[Script & logic](/docs/studio/logic)** for where code fits in Studio.

## Stylebook

Stylebook is the catalog of your project's element defaults — every heading, button, and link rendered with its base style, so you set the look of each element type once for the whole site. Selecting Stylebook switches the right panel to the **Style** tab automatically. See **[Design mode](/docs/studio/design)** for how it fits into styling.

![Jx Studio Stylebook mode showing element defaults across breakpoints](/screenshots/stylebook.png)

## Which files offer which modes

Every file opens in its natural mode, and only sensible modes are enabled:

| File                               | Opens in      | Also available                                                  |
| ---------------------------------- | ------------- | --------------------------------------------------------------- |
| Markdown pages and content (`.md`) | **Edit**      | **Design**, **Code**, and the **Preview** toggle                |
| Components and pages (`.json`)     | **Edit**      | **Design**, **Code**, **Stylebook**, and the **Preview** toggle |
| Spreadsheets (`.csv`)              | **Grid**      | **Code**                                                        |
| The project file (`project.json`)  | **Stylebook** | **Code**                                                        |

Installed format extensions can add their own file types with their own mode lists, so this table can grow with your project.

## The Preview toggle

**Preview** is not a sixth mode — it's a toggle in the tab bar that layers onto Edit and Design. Switch it on and the canvas shows the page with its real data resolved: dynamic text filled in, repeated lists expanded, exactly what a visitor gets.

Alongside the toggle, the tab bar offers:

- For pages with dynamic addresses (a product page, a blog post), a picker per URL parameter so you choose which real record to preview.
- For components, a small field per component option so you can try test values.
- For pages that use a layout, a **Layout** toggle to show or hide the elements the layout contributes.

Switch Preview off to go back to editing — the mode switcher stays on Edit or Design the whole time.

## Next

- Learn the canvas itself — pan, zoom, selection, inserting — in **[The canvas](/docs/studio/interface/canvas)**
- See how each tab remembers its mode in **[Tabs and files](/docs/studio/interface/tabs)**
