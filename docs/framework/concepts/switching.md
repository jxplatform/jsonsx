---
title: "Dynamic switching"
description: "Swap whole components in and out of the page from state with $switch and cases: client-side views, wizards, and routing in pure JSON."
spec:
  - spec.md#14
---

# Dynamic switching

> **Studio writes this format for you.** Add the node in the [Code editor](/docs/studio/logic/code); from then on the Inspector's **[Logic tab](/docs/studio/logic/events)** (:kbd[⌘⇧3]) shows a **Condition** section for it, holding the value it switches on and a row per case.

A `$switch` node swaps what renders in one spot based on a state value: the node binds `$switch` to a [reference](/docs/framework/concepts/references), and `cases` maps each possible value to what should render. When the state changes, the old case is torn down and the new one renders in its place. That covers view switching, wizard steps, and a client-side router, in pure JSON.

```json
{
  "tagName": "main",
  "children": [
    {
      "$switch": { "$ref": "#/state/currentRoute" },
      "cases": {
        "home": { "$ref": "./views/home.json" },
        "about": { "$ref": "./views/about.json" },
        "profile": { "$ref": "./views/profile.json" }
      }
    }
  ]
}
```

## External cases

A case value that is a `$ref` to a `.json` file loads that [document](/docs/framework/concepts/documents) on demand, so a case is fetched only when its key first becomes active, so unvisited views cost nothing up front. Each external case is an independent component with its own `state` scope.

## Inline cases

A case value may also be an inline element definition. Inline cases render in the surrounding document's scope, so they can bind its state directly:

```json
{
  "$switch": { "$ref": "#/state/status" },
  "cases": {
    "loading": { "tagName": "p", "textContent": "Loading…" },
    "error": { "tagName": "p", "textContent": "${state.errorMessage}" },
    "success": { "$ref": "./views/results.json" }
  }
}
```

## Driving the switch

The selector is ordinary state, so anything that writes state switches the view: an event handler, an [expression](/docs/framework/concepts/expressions), or a data source:

```json
{
  "state": { "currentRoute": "home" },
  "children": [
    {
      "tagName": "button",
      "textContent": "About",
      "onclick": {
        "$expression": {
          "operator": "=",
          "target": { "$ref": "#/state/currentRoute" },
          "value": "about"
        }
      }
    }
  ]
}
```

## How it works

The runtime renders the `$switch` node as a container element (its `tagName`, or `div` when none is given) and watches the bound reference inside a reactive effect. On every change it clears the container and renders the matching case: inline cases render immediately with the current scope; external cases are fetched, their scope is built, and the result is appended, with stale responses discarded if the key changed again mid-load. A key with no matching case renders nothing.

## In Studio

Select the node and open the **[Logic tab](/docs/studio/logic/events)** (:kbd[⌘⇧3]). Its **Condition** section is the node's two halves:

- **Expression** is what the node switches on. Its value-source chip offers **From data…** (a signal) and **Mixed text**; there is no fixed-value rung, because a literal `$switch` does not render.
- **Cases** is one row per key. Edit a row's text to rename that case, click **→** to select what it renders, click the dot on its label to remove it, and **+ Add case** appends another.

The section is drawn for a node that already carries a `$switch`, so the node itself is added in the [Code editor](/docs/studio/logic/code). The [Outline](/docs/studio/design/layers) lists the cases as child rows of the node, and each case is selectable there.

On the canvas, **Edit** mode stands in the first case so the node has something to show. An external first case draws a dashed `[$switch: home | about]` marker naming the keys instead. Switch the canvas to **Preview** to watch the real selector drive it.

## Rules

- `$switch` must be a `$ref`, typically `#/state/...`. A literal value is meaningless and does not render.
- Case keys are matched against the resolved value as strings; there is no default case, and an unmatched value renders an empty container.
- External cases have isolated scope; to share data with a case, make it an inline element, or lift shared state to `window#/` globals.
- Switching fully tears down the outgoing case: its DOM and reactive bindings are disposed, and per-component state re-initializes on the next visit.
- For URL-driven pages prefer file-based [routing](/docs/framework/site/routing); `$switch` is for switching _within_ a page.

## Related

- [References](/docs/framework/concepts/references): the `$ref` schemes `$switch` binds
- [State](/docs/framework/concepts/state): declaring the selector value
- [Props and scope](/docs/framework/concepts/props-and-scope): why external cases are isolated
- [Routing](/docs/framework/site/routing): URL-based page selection for sites
- [Logic tab](/docs/studio/logic/events): the **Condition** section that edits a `$switch` and its cases
- [Code editing](/docs/studio/logic/code): where the node itself is added
