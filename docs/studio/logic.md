---
title: "Logic"
description: "Make pages interactive in Jx Studio — where the State, Data, Events, and Code surfaces fit together, with a 60-second counter to see it working."
code:
  - packages/studio/src/panels/signals-panel.ts
  - packages/studio/src/panels/events-panel.ts
  - packages/studio/src/panels/data-explorer.ts
---

# Logic

There is no single "logic mode" in Studio. Interactivity comes from a few focused surfaces you move between, and each one answers a different question:

- **[State](/docs/studio/logic/state)** — an activity in the left panel. _What does this page or component know?_ Declare values, computed entries, data sources, and functions here.
- **[Data](/docs/studio/logic/data-explorer)** — the activity right below it. _What are those values right now?_ It shows the live, resolved data as the page runs.
- **[Events](/docs/studio/logic/events)** — a tab in the right panel. _What happens when a visitor clicks or types?_ Bind behavior to the selected element here.
- **[Formulas](/docs/studio/logic/formulas)** — not a place but an affordance: almost any value field carries an **fx** menu that turns a fixed value into a computed one, with live previews as you build it. A **[full-screen workspace](/docs/studio/logic/formula-workspace)** opens when a formula deserves the whole canvas.
- **[Code](/docs/studio/logic/code)** — the escape hatch. A real code editor for function bodies, and a **Code** canvas mode that shows any file as raw source.

![Jx Studio State panel listing a component's state and functions](../images/state-panel.png)

Together they cover the whole range: most interactions never need code, and the ones that do get a proper editor rather than a cramped text box.

## A counter in 60 seconds

Here is the shape of the workflow, end to end:

1. Open a component and click **State** in the activity bar. Choose _+ Add… > State Signal_, name it `$count`, set its **Type** to `integer` and its **Default** to `0`. The component now knows a number.
2. Add a button to the canvas and set its text to show `$count` — any text field's **fx** menu can point at a state value.
3. With the button selected, open the **Events** tab and click **Add Event**. Set the event to `onclick`, choose the **$expression** mode, and build the one-step formula `$count += 1`.
4. Toggle **Preview** on and click the button. The number climbs — and if you open the **Data** activity, you can watch `$count` change in real time.

No files were written by hand: Studio stored the value, the binding, and the handler inside the component's own JSON file.

## When each surface applies

- Reach for **State** first — every other surface refers back to what you declare there.
- Use **Events** whenever behavior belongs to one element ("this button submits", "this field filters the list").
- Use **formulas** for values that are calculated rather than typed, and **[statements](/docs/studio/logic/statements)** when a handler needs several steps in order.
- Open **Data** whenever something looks wrong — it shows what the page actually sees, not what you hoped it sees.
- Drop into **Code** when a function outgrows the structured editors, or when you want to read exactly what Studio wrote.

## Next

- Declare your first values in the **[State panel](/docs/studio/logic/state)**
- Wire data in from files, APIs, and the browser with **[Data sources](/docs/studio/logic/data-sources)**
- The reactive model underneath it all is documented in **[Reactivity](/docs/framework/concepts/reactivity)**
