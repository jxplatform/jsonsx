---
title: "Hover states and selectors"
description: "Style hover, focus, and other states in Jx Studio with the selector menu in the Style inspector — plus custom selectors of your own."
code:
  - packages/studio/src/panels/style-panel.ts
  - packages/studio/src/store.ts
---

# Hover states and selectors

Buttons darken on hover, inputs glow on focus, disabled controls fade — those are the same element in a different _state_, and each state can carry its own styles. In Studio you style states with the selector menu in the [Style inspector](/docs/studio/design/style-inspector)'s toolbar, next to the breakpoint tabs.

![The Style inspector's selector menu open, listing built-in states and existing selectors](/screenshots/selector-menu.png)

## Style a state

1. Select the element and open the **Style** tab.
2. Open the selector menu — it reads **(base)** when you're styling the element's normal look.
3. Pick a state, say **:hover**.
4. Edit styles as usual. Everything you set now applies only in that state.

The full inspector works here — every section, the set-dots, even the breakpoint tabs, so a hover effect can differ between desktop and phone. Values the state inherits from the element's base styles show as dimmed placeholders. Switch the menu back to **(base)** to return to the normal styles.

## The built-in states

The menu offers the common ones: **:hover**, **:focus**, **:active**, **:focus-within**, **:focus-visible**, **:disabled**, **:first-child**, **:last-child**, and the **::before**, **::after**, and **::placeholder** extras. A **●** after an entry means the element already has styles there — your map of where to look when something styles unexpectedly.

They mean what they mean on the web: `:hover` while the pointer is over the element, `:focus` while it holds keyboard focus, `:first-child` / `:last-child` when it's the first or last among its siblings, `::placeholder` for an input's hint text.

## Add your own selector

Choose **+ Add custom…** at the bottom of the menu, type a selector, and press :kbd[Enter]:

- `:nth-child(2)` — any state or position selector beyond the built-ins.
- `.featured` — only when the element has that class.
- `&.active` — only when the element itself carries the `active` class.
- `[disabled]` — only when the element has that attribute.

A custom selector must start with `:`, `.`, `&`, or `[`. Once created it joins the menu for that element, marked with **●** while it has styles. Rules for elements _inside_ the selection are the inspector's **Relative Styling** section instead — clicking a rule there drills into it through this same selector context.

## Remove state styles

Switch the menu to the state and clear its values with their dots — property by property, or a whole section from its header dot. When a state has no values left, it drops out of the menu's marked entries.

:::doc-note
Each state is saved as a nested rule inside the element's `style` object — real CSS pseudo-classes that behave natively on the published page. The format is described in **[Styling](/docs/framework/concepts/styling)**.
:::

## Next

- Combine states with screen sizes in **[Breakpoints](/docs/studio/design/breakpoints)**
- Give every link and button a default hover in the **[Stylebook](/docs/studio/design/stylebook)**
