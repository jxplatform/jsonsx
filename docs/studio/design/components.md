---
title: "Working with components"
description: "Turn any selection into a reusable component in Jx Studio, wire its props in the Properties panel, add slots, and preview it with test values."
code:
  - packages/studio/src/editor/convert-to-component.ts
  - packages/studio/src/component-props.ts
  - packages/studio/src/panels/tab-bar.ts
  - packages/studio/src/panels/properties-panel.ts
---

# Working with components

A component is a piece of design you build once and use everywhere — a card, a header, a pricing row. Each use is an _instance_; edit the component and every instance follows. This page covers the component workflows on the Design canvas; the bigger picture of what belongs in a component lives in **[Pages, layouts, components](/docs/studio/projects/pages-layouts-components)**.

## Convert a selection into a component

The natural way to make a component is to design it in place first, then promote it:

1. Build the element on the canvas — structure, styles, content.
2. Right-click it (on the canvas or in [Layers](/docs/studio/design/layers)) and choose **Convert to Component**.
3. Give it a tag name — lowercase, with a hyphen, like `pricing-card` — and click **Convert**. Studio validates the name as you type and won't let you collide with an existing component.

![The Convert to Component dialog with a tag name filled in](/screenshots/convert-to-component.png)

Studio saves the component as its own file in the project's `components/` folder, swaps your selection for an instance of it, and adds it to the [Elements panel](/docs/studio/design/elements) — drop more instances anywhere from there. If the component's slots need attention, Studio says so in the status bar.

To open a component from an instance, right-click the instance and choose **Edit Component**, or click **→ Edit definition** under its props in the Properties panel.

## Props: the component's options

Props are the knobs an instance can turn — the card's title, its image, whether it's featured. A component's props come from its state: every plain value you declare in the component's **State** panel becomes a prop, with that value as its default. See **[Script & logic](/docs/studio/logic)** for declaring state.

On an instance, the [Properties panel](/docs/studio/design/properties) shows a **Component Props** section with a fitting control per prop — checkbox, number field, dropdown, media or color picker. Each prop can also be _bound_: click the mode button beside its label to switch the prop to a state binding (or a template) and point it at one of the page's state values, so the instance follows live data instead of a fixed setting.

## Slots: openings for content

By default an instance renders exactly what the component defines. A **slot** is a deliberate opening — add a `slot` element inside the component definition, and whatever an instance holds as children flows into that opening. Give slots names to offer several openings (a card with an icon slot and a body slot). In [Layers](/docs/studio/design/layers), slots show a **▣** badge; hover it for the slot's name. Layouts distribute page content the same way.

## Preview with test props

A component file open on its own renders with its defaults — but defaults are often empty. The tab bar shows one small field per prop; type a value to see the component render with it, live on the canvas at every breakpoint. Numbers, `true`/`false`, and lists in JSON form are understood as such; anything else counts as text.

Test values are a preview lens only — they're never saved into the component, and clearing a field returns the prop to its default. They pair with the **Preview** toggle described in **[Modes and preview](/docs/studio/interface/modes)**.

:::doc-note
A component is a plain file — `components/pricing-card.json` — and converting also records a reference to it in the page's `$elements` list. The format is described in **[Components](/docs/framework/concepts/components)**.
:::

## Next

- Repeat a component per item of a list — **[Repeaters](/docs/studio/design/repeaters)**
- Insert instances from the **[Elements panel](/docs/studio/design/elements)**
