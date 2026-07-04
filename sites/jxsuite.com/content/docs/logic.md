---
title: "Script & logic — Jx Suite"
description: "Add state, data sources, and event handlers in Jx Studio — the State, Data, Events, and Code surfaces that make components interactive."
---

# Script & logic

There's no single "script mode" in Studio — interactivity comes from a few focused surfaces you move between: **State**, **Data**, **Events**, and **Code**. Together they let you build a calculator, a form, or a live data feed without ejecting to a codebase.

## State

The State panel is where you declare what a component knows. Add a plain value, or one of the built-in kinds:

- **Computed** — a value derived from other state, recomputed automatically.
- **Data sources** — `Request` (fetch over HTTP), `LocalStorage`, `SessionStorage`, `Cookie`, `IndexedDB`, `FormData`, and content sources like `ContentCollection`.
- **Function** — a reusable piece of behavior.

![Jx Studio State panel listing a component's state and functions](/screenshots/state-panel.png)

## Data

The Data explorer shows the live, resolved values of your state as the component runs — the actual array your fetch returned, the current count, the parsed form data. It's your window into what the component is thinking.

## Events

Bind behavior to interaction. The Events panel lists handlers — `onclick`, `oninput`, `onchange`, `onsubmit`, `onkeydown`, and more — and a structured expression editor lets you assign, increment, toggle, or call functions without writing raw code. Point an event at a state function and you're done.

## Code

When a handler needs real JavaScript, open it in the **Monaco** editor — full syntax highlighting, the same editor as VS Code. And when you'd rather see the whole document as raw JSON, **Code** mode gives you that too.

![Jx Studio editing a component state function in the Monaco code editor](/screenshots/mode-script.png)

## Next

- The reactivity model behind all of this is documented in **[Reactivity](/docs/reactivity)**
- Ship your work in **[Git & publish](/docs/git-publish)**
