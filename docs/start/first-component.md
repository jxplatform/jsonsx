---
title: "Tutorial: your first interactive component"
description: "Build a live counter card in Jx Studio, click by click — declare state, bind text to it, wire up a button's click event, and watch the value update."
---

# Tutorial: your first interactive component

In this tutorial you build a `counter-card` component: a button and a line of text that counts the clicks, live. Small as it is, it walks the whole loop every interactive piece of a Jx site is made from — elements on the canvas, a state value, a binding, and an event — without writing any code.

![The finished counter card on the canvas with Preview on, showing a count of 3](../images/counter-finished.png)

**About 15 minutes.** Before you start:

- Have Jx Studio running — see **[Install Jx Studio](/docs/start/install)**.
- If Studio is completely new to you, skim **[Your first project](/docs/start/first-project)** first — this tutorial starts where it ends, with a project open.

## 1. Open a project

Any project works. If you already have one from [Your first project](/docs/start/first-project), open it with **Open Project**. Otherwise choose **New Project…**, scroll to the **Start from scratch** card at the end of the starter gallery, click **Next**, name the project (say, "Counter Demo"), and click **Create Project**. Every step of the wizard is explained in **[Create a project](/docs/studio/projects/create)**.

![The New Project dialog with the starter gallery and the Start from scratch card](../images/new-project-modal.png)

You should now see your project open on the canvas.

## 2. Create the component

1. Click **Manage** in the toolbar.
2. Click **New** and choose **Component**.
3. Type `counter-card` and confirm.

![Jx Studio Manage Files modal with live previews of every project file](../images/mode-manage.png)

Studio writes `components/counter-card.json` and opens it in a new tab — an empty canvas, ready to fill. (When to reach for a component versus a page or layout is covered in **[Pages, layouts, and components](/docs/studio/projects/pages-layouts-components)**.)

## 3. Switch to Design mode

Component files open in **Edit** mode. In the mode switcher on the right side of the toolbar, click **Design**.

![Jx Studio design canvas showing one component across four responsive breakpoints with a style inspector](../images/mode-design.png)

The canvas now shows your component once per breakpoint — empty for the moment — and the right panel offers the **Properties**, **Events**, and **Style** tabs. Modes are just lenses on the same file; see **[Modes and the preview toggle](/docs/studio/interface/modes)**.

## 4. Add a button and a text line

1. Click **Elements** in the activity bar to open the palette.
2. With nothing selected, click the **button** card. The button is added to the empty component.
3. Press :kbd[Esc] to clear the selection — otherwise the next element would land _inside_ the button — then click the **p** card to add a paragraph.
4. Select the button, open the **Properties** tab, and type `Add one` into **Text Content**.

![The design canvas with a button labeled Add one and an empty paragraph below it](../images/counter-elements.png)

You should now see a button labeled **Add one** with an empty paragraph after it, at every breakpoint. The other ways to insert — dragging cards, the **+** affordance between elements — are covered in **[The canvas](/docs/studio/interface/canvas)** and the **[Elements panel](/docs/studio/design/elements)**.

## 5. Declare the count

The component needs somewhere to keep its number. That's a state entry:

1. Click **State** (the brackets icon) in the activity bar.
2. Click the **+ Add…** picker at the bottom of the panel and choose **Value**. The new entry appears with a placeholder name and its editor open.
3. Rename it first: type `count` into the **Name** field and press :kbd[Enter].
4. Set **Type** to `integer` and leave **Default** at `0`.

![Jx Studio State panel listing a component's state and functions](../images/state-panel.png)

The panel now shows a **State** section with one row: an **S** badge and the name `count`. Everything the panel can hold — computed values, data sources, functions — is covered in **[State panel](/docs/studio/logic/state)**.

## 6. Bind the text to the count

Now point the paragraph at the value instead of typing fixed text:

1. Select the paragraph on the canvas.
2. In the **Properties** tab, find the **Text Content** row. Beside its label sits a small mode button reading **abc** — the sign that the value is static.
3. Click the button until it reads **${}** — the template mode. Each click steps to the next mode; the tooltip names the one a click will switch to.
4. Studio pre-fills the field with your first state entry: `${state.count}`. Keep it, or mix in words: `Clicked ${state.count} times`.

![The Text Content row in template mode holding ${state.count}, with the mode button accent-colored](../images/counter-text-binding.png)

The mode button takes on the accent color: this value is now dynamic, and the paragraph will always show the current count. The full ladder of dynamic values — **abc**, **$ref**, **${}**, **fx** — is explained in **[Formulas and expressions](/docs/studio/logic/formulas)**.

## 7. Make the button count

1. Select the button and click **Events** in the right panel.
2. Click **Add Event**. A binding appears on `onclick` — and since the file has no functions yet, it starts as an inline handler.
3. Switch the binding's mode to **Expression**, the mode for one-step reactions.
4. In the formula editor, set the **Operator** to `+=`, point the **Target** at `count` (a **$ref**), and type `1` as the **Value**.

![The Events tab with an onclick binding in expression mode incrementing count](../images/counter-onclick.png)

The formula reads `$count += 1` in the chip strip, and green badges beside the operands show live values evaluated against the running page. The three ways an event can respond — a named function, an expression, an inline handler — are covered in **[Events panel](/docs/studio/logic/events)**.

## 8. Try it in Preview

Switch on the **Preview** toggle in the tab bar. The paragraph now shows `0` — the real, resolved value. Click **Add one** a few times.

![The canvas with Preview on, the paragraph showing the climbed count](../images/counter-preview.png)

You should see the number climb with every click. That's the whole reactive loop: the event writes to `count`, and everything bound to `count` updates by itself.

## 9. Watch the value in the Data explorer

Click **Data** in the activity bar. It lists the same entries as the State panel, but with what each one is worth _right now_ — your `count` row shows the current number. Keep Preview on, click **Add one**, and watch the row change; **Refresh** re-renders the canvas and reads the values again.

![The Data activity with the count entry showing its live value](../images/counter-data-explorer.png)

When a page ever looks wrong, this panel is where you find out what it actually sees — see **[Data explorer](/docs/studio/logic/data-explorer)**.

## 10. Try a test value

Because `count` is a plain state value on a component, it's also one of the component's _props_ — an option a page can set when it uses the card. The tab bar shows a small field named after each prop:

1. Type `100` into the **count** field in the tab bar.
2. The canvas re-renders with the count starting at 100, at every breakpoint.
3. Clear the field to return to the default of `0`.

![The tab bar's count field holding a test value, the canvas rendering with it](../images/counter-test-prop.png)

Test values are a preview lens only — they're never saved into the component. Props and test values are covered in **[Working with components](/docs/studio/design/components)**.

## 11. Save your work

The tab shows a **●** dot for unsaved changes. Press :kbd[⌘S] (macOS) / :kbd[Ctrl+S] (Windows/Linux) — or click the **Save** button in the toolbar — and the status bar confirms with "Saved".

You should see the dot disappear. When you're ready to publish, **Source Control** takes it from here — see **[Source control](/docs/studio/publish/source-control)**.

## What you built

A working, reusable component — and every piece of the interactive toolkit in one pass:

- A **state entry** (`count`) — the component's memory, and automatically its prop.
- A **template binding** (`${state.count}`) — text that follows the value wherever it goes.
- An **event expression** (`$count += 1`) — behavior without a line of code.
- **Preview**, the **Data explorer**, and **test values** — three ways to watch it run.

:::doc-note
Everything landed in one plain file, `components/counter-card.json`: the entry in its `state` object, the paragraph's text as a `${}` template, and the button's `onclick` as an `$expression`. The formats are documented in **[State](/docs/framework/concepts/state)** and **[Reactivity](/docs/framework/concepts/reactivity)**.
:::

## Next steps

- Drop the card onto any page from the **[Elements panel](/docs/studio/design/elements)** — your components appear at the top of the palette.
- Style it — spacing, color, hover states — with the **[Style inspector](/docs/studio/design/style-inspector)**.
- When one step isn't enough, build multi-step handlers as **[statements](/docs/studio/logic/statements)**.
- Keep going: **[Tutorial: a blog with content collections](/docs/start/first-collection)**.
