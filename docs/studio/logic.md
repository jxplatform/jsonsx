---
title: "Logic"
description: "Make pages interactive in Jx Studio — where the State, Data, Logic, and Code surfaces fit together, with a 60-second counter to see it working."
code:
  - packages/studio/src/panels/signals-panel.ts
  - packages/studio/src/panels/events-panel.ts
  - packages/studio/src/panels/data-explorer.ts
---

# Logic

There is no single "logic mode" in Studio. Interactivity comes from a few focused surfaces you move between, and each one answers a different question:

- **[State](/docs/studio/logic/state)** — a Navigator panel, opened by name from the palette. _What does this page or component know?_ Declare values, computed entries, data sources, and functions here.
- **[Data](/docs/studio/logic/data-explorer)** — the Navigator rail's :kbd[⌘7]. _What are those values right now?_ It shows the resolved data as the page runs. Fetches wait for a **Refresh** or for preview rather than re-running on every edit.
- **[The Logic tab](/docs/studio/logic/events)** — the Inspector's third tab, :kbd[⌘⇧3]. _How does this element behave?_ Events, repeating lists, conditions, and a custom element's outward contract all live here, because they are one job: wiring the selected element to something.
- **[Formulas](/docs/studio/logic/formulas)** — not a place but an affordance. _How is this value computed rather than typed?_ A state entry can be a formula, an event can run one, and every operand inside one can be another, with live previews of the real result as you build. A **[formula workspace](/docs/studio/logic/formula-workspace)** opens in the Bottom dock when a formula outgrows an inline field — under the page, not over it, so you can watch the value it computes change as you edit it.
- **[Code](/docs/studio/logic/code)** — the escape hatch. A real code editor for function bodies, and a **Code** canvas mode that shows any file as raw source.

![Jx Studio State panel listing a component's state and functions](../images/state-panel.png)

Together they cover the whole range: most interactions never need code, and the ones that do get a proper editor rather than a cramped text box.

## A counter in 60 seconds

Here is the shape of the workflow, end to end:

1. Open a component, press :kbd[⌘K] and run **Show State**. Choose _+ Add… > Value_, name it `$count`, set its **Type** to `integer` and its **Default** to `0`. The component now knows a number.
2. Add a button to the canvas and set its text to show `$count` — click the **value source** chip beside **Text Content** on the Content tab, pick **From data…**, and choose `$count`.
3. With the button selected, open the Inspector's **Logic** tab and click **Add Event**. Set the event to `onclick`, choose the **Expression** mode, and build the one-step formula `$count += 1`.
4. Pick **Preview** in the **View** control on the context bar and click the button. The number climbs — and in the **Data** panel (:kbd[⌘7]) you can watch `$count` change in real time.

No files were written by hand: Studio stored the value, the binding, and the handler inside the component's own JSON file.

## When each surface applies

- Reach for **State** first — every other surface refers back to what you declare there.
- Use the Inspector's **Logic** tab whenever behavior belongs to one element ("this button submits", "this list repeats per product", "this field filters the list").
- Use **formulas** for values that are calculated rather than typed, and **[statements](/docs/studio/logic/statements)** when a handler needs several steps in order.
- Prefer the plainest value source a field will accept. A signal (**From data…**) is easier to read and to revisit than a formula that only fetches one value.
- Open **Data** whenever something looks wrong — it shows what the page actually sees, not what you hoped it sees.
- Drop into **Code** when a function outgrows the structured editors, or when you want to read exactly what Studio wrote.

## Next

- Declare your first values in the **[State panel](/docs/studio/logic/state)**
- Wire data in from files, APIs, and the browser with **[Data sources](/docs/studio/logic/data-sources)**
- The reactive model underneath it all is documented in **[Reactivity](/docs/framework/concepts/reactivity)**
