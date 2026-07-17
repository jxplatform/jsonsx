---
title: "Events panel"
description: "Make elements respond to clicks, typing, and form submits with the Events tab — bind functions, formulas, or inline handlers, and read event values."
code:
  - packages/studio/src/panels/events-panel.ts
---

# Events panel

Events is the right-panel tab where an element gets its behavior: what happens when it's clicked, typed into, submitted, or hovered. Select an element on the canvas, then click **Events** in the right panel — with nothing selected, the tab just asks you to select an element first.

<!-- TODO(screenshot): events-panel — the Events tab with an onclick binding in expression mode -->

## Add a binding

Click **Add Event**. Studio creates a binding on the first free event name and points it at your file's first function — or, if the file has no functions yet, starts an inline handler instead. Each binding row then has three controls:

- The **event name** — pick from `onclick`, `oninput`, `onchange`, `onsubmit`, `onkeydown`, `onkeyup`, `onfocus`, `onblur`, `onmouseenter`, and `onmouseleave`.
- The **mode** — one of the three ways to respond, below.
- A trash button that removes the binding.

## Three ways to respond

**$ref — call a named function.** A picker lists the functions declared in the **[State panel](/docs/studio/logic/state)**; pick one and the event runs it. This is the tidiest option when the same behavior is used in more than one place.

**$expression — an inline formula.** The event runs a single formula, edited right in the panel with live value badges — ideal for one-step reactions like `$count += 1`or`$menuOpen = true`. The full-screen icon opens it in the **[formula workspace](/docs/studio/logic/formula-workspace)**.

**inline — a handler written on the element itself.** A **Statements** / **Code** toggle picks how you write it: as visual **[statement](/docs/studio/logic/statements)** cards, or as JavaScript in a small text field with an **Open in editor** button for the real **[code editor](/docs/studio/logic/code)**.

Switching modes replaces the binding with a fresh start in the new mode; undo restores the previous one.

## Read values from the event

Handlers can read from the event that triggered them. In expression and statement editors on this panel, the value pickers offer `event#/` entries alongside your state:

- `event#/target/value` — what the visitor has typed into the field. The classic `oninput` pattern is one step: set `$searchText` to `event#/target/value`.
- `event#/detail` — the data a component sent along when it dispatched a custom event.

An `event#/` reference can point at any property of the event — `event#/key` for the pressed key, for example — by writing the reference in **[Code mode](/docs/studio/logic/code)**; the pickers offer the two common ones.

## Component events

When the open file is a component, a **Declared Events** section lists every event its functions declare they emit — the name, the function it comes from, and its payload type. That declaration is the component's contract: a page that uses the component reacts by handling the event and reading its payload as `event#/detail`. Declaring emits, and dispatching them, is covered in **[Statements](/docs/studio/logic/statements)**.

:::doc-note
A binding is stored on the element itself, as an `onclick` (etc.) key in the file's JSON — a `$ref` to a function, an `$expression`, or an inline function definition. The handler model is documented in **[Reactivity](/docs/framework/concepts/reactivity)**.
:::

## Next

- Declare the functions your events call in the **[State panel](/docs/studio/logic/state)**
- Watch state change as events fire, in the **[Data explorer](/docs/studio/logic/data-explorer)**
- Multi-step handlers read best as **[Statements](/docs/studio/logic/statements)**
