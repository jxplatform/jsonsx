---
title: "Problems and progress"
description: "How Studio tells you what happened: toasts that retire themselves, Problems that stay until fixed, Activity for long operations, and errors at the field."
spec: studio.md#16
code:
  - packages/studio/src/services/notify.ts
  - packages/studio/src/panels/bottom-dock.ts
  - packages/studio/src/panels/problems-panel.ts
  - packages/studio/src/panels/formula-workspace.ts
  - packages/studio/src/panels/activity-panel.ts
  - packages/studio/src/ui/progress-modal.ts
  - packages/studio/src/ui/field-row.ts
  - packages/studio/src/panels/statusbar.ts
---

# Problems and progress

Studio has three ways of telling you something happened, and which one it uses depends on what you have to do about it:

| What you see        | How long it lasts        | What it's for                                   |
| ------------------- | ------------------------ | ----------------------------------------------- |
| A **toast**         | A few seconds            | Something worked, or something you can undo     |
| A **Problem**       | Until it's fixed         | Something that needs you                        |
| An **inline error** | As long as the bad value | A value you just typed that Studio can't accept |

## Toasts

:::doc-note
**Everything Studio reports is also spoken.** A screen reader is told about every notification the moment it is posted: errors interrupt whatever is being read, and everything else waits for a pause. That matters most for failures, which live in **Problems** instead of a passing toast: before this, a failure was shown in a panel and announced nowhere, so a reader who was not looking at that panel had no way to know anything had gone wrong. The message is prefixed with where it came from, since a listener has none of the visual grouping the panel's own column provides.
:::

A toast is one line in the bottom-right corner of the window: an icon, the message, and a **×** to send it away early. It never covers the canvas and never takes the keyboard, so you can keep working while it's up.

**It retires itself.** A success or an informational note rests for about four seconds; a warning gets about eight, because it's the one you're most likely to have looked away from. At most four are on screen at once. The oldest steps aside to make room for a new one.

Some toasts carry a button, and the button is a real Studio command: it wears that command's own name, and if the command isn't available right now the button is disabled with a tooltip saying what it needs.

Toasts are for outcomes you don't have to act on. Anything you _do_ have to act on becomes a Problem instead, so it can't disappear while you're looking somewhere else.

## Problems

A Problem is something that must be fixed, kept on a list until it is. Failed saves, validation errors, a render that didn't work and a push that was refused all land here with the file they came from.

Open the list two ways, both showing the same rows:

- The **⚠ n** count in the status bar, whenever it is above zero. Click it and the list opens on the problem.
- The **Problems** tab of the Bottom dock (:kbd[⌘J] / :kbd[Ctrl+J]).

The count only appears when there is something to count, so an empty project says nothing about problems at all.

Each row gives you:

- an icon and color for how bad it is;
- the message;
- **the file it came from**, as a button that opens it;
- **a detail** you can unfold, when there's captured output behind the message (a validator's report, a command's log);
- **a recovery button** when there's something to run, either a **Retry** or a **Fix**, again labeled with the command's own name. A Problem with nothing to run shows no button at all;
- a **×** that dismisses that row alone.

Rows are grouped under where they came from (**Save**, **Source Control**, **Canvas**, **Assistant**) in the order they arrived, so a new Problem never shuffles the ones you're reading. Something that keeps failing replaces its own row instead of stacking up sixty copies of itself. **Clear n** at the top of the list empties it.

:::doc-note
Problems belong to the project you have open. Closing the project clears them, so a failure never follows you into a different repository.
:::

## The Bottom dock

:kbd[⌘J] / :kbd[Ctrl+J] opens a dock across the bottom of the working area. It sits **under the canvas and the panes only**, so opening it never narrows the Navigator or the Inspector, and it starts out closed, because an empty list shouldn't spend a fifth of your canvas saying nothing. The **×** at the right of its tab strip closes it again.

Its tab strip is **Problems** and **Activity**, with **Logic** between them whenever a formula or a function is open.

## Logic

**Logic** holds the two editors that compute values: the **[formula workspace](/docs/studio/logic/formula-workspace)** for a structured `$expression`, and the **[function editor](/docs/studio/logic/code)** for a JavaScript body. Open either one, from the Data panel or from an event binding in the Inspector's Logic tab, and the dock reveals itself on this tab.

Being a dock tab rather than a full-screen surface is the whole point: **the page stays on the stage while you author its logic**, so the value you are computing and the element that shows it are on screen together. The rest follows from that:

- The tab is there while something is open in it and **leaves the strip when you close it**. **Close**, in the editor's own header, is the only thing that clears it. Collapsing the dock, switching to Problems and coming back, or leaving the document and returning all keep your place.
- The target belongs to the **document**, so each open document has its own: switch documents and Logic goes with them.
- The dock reveals itself **once per thing you open**. Close the dock over an open formula and it stays closed until you open another.

:::doc-note
There is no **Diff** tab here. Reviewing a change is a **Diff** editor on a document at full pane size. See [Source control](/docs/studio/publish/source-control).
:::

## Activity

**Activity** is where a long operation lives while it runs: an install, a clone, a publish, an import. Each one is a row showing:

- what it is, who's running it, and how long it's taken;
- **a status line** of what it's doing right now;
- **its steps**, in order, each ticked off as it completes;
- **its log**, the same output the operation printed, behind a **Show log** disclosure;
- **Cancel**, when the operation can honestly be stopped. An operation that can't be stopped doesn't offer a button that pretends otherwise.

The tab also carries the **[Deploy checklist](/docs/studio/publish)** above the run log. A deploy is a long operation with a log, so it belongs with the others, and the checklist is readable before anything has started because its job is to say what is missing _first_.

**A finished operation stays on the list**, with its log, so "what did that import actually do?" is a question you can answer long after the run ends. **Clear n finished** tidies them away; anything still running is kept.

When an operation fails, the row records the failure and **raises a Problem carrying the log**, so the account of what went wrong outlives the operation and can carry a Retry.

### What still blocks

Almost nothing does. The one operation that puts a dialog in front of the whole app is **installing dependencies**, and even there you're not trapped:

- **Run in the background** hands the app back and keeps the install running in Activity, where you can watch it. Pressing :kbd[Escape] does the same thing: it stops the blocking, not the work.
- **Cancel** stops it, when it's stoppable.

Either way the operation leaves an Activity entry behind, so dismissing the dialog never throws away the record.

## Errors at the field

When you type a value Studio won't accept, the reason appears **directly under that control**, in red, and stays there as long as the value does. You never have to look somewhere else in the window to find out what was wrong with something you typed here.

- **Checked when you commit, not while you type.** A field waits until you leave it or press :kbd[Enter] before it objects, so nothing goes red in the middle of a word.
- **A form you haven't touched shows nothing.** Opening a panel never paints its empty required fields red.
- **A repeat is counted.** Refuse the same value twice and a small **×2** joins the message, so "it just said no again" is distinguishable from "that message is still there from last time".

Some forms hold the old value while you fix the new one; others apply what you type and report afterward. Whichever it is, the message is at the field.

:::doc-tip
If a panel is showing a yellow **New changes** strip, that's Studio waiting: something changed elsewhere while your cursor was in one of that panel's fields, and it would rather let you finish your sentence than rewrite the box under your hands. Click out of the field and the panel catches up.
:::

## What the status bar does instead

The status bar along the bottom carries **ambient state only**, three fields in scope order: your project, then the document, then the selection. It's the project name and branch, how many people are editing alongside you, the document's path and save state. Every item is clickable and runs a command: the peer count opens what's happening in this document, the problem count opens the list.

The selection field carries what an address can't state: **3 selected** when more than one element is picked, or the style rule the Style panel is editing. Where you are (the element and the chain above it) is the [jump bar](/docs/studio/interface#the-jump-bar)'s job, one line above the pane, and it names the _primary_ element, the one the Inspector and the block action bar are pointed at. The count is what stops that address reading as though it described everything you have selected.

**No message ever flashes past down there.** Outcomes go to toasts and Problems, which are readable for as long as you need and can be acted on; the status bar answers "where am I and what state is this in?", which stays true until something changes it.

## Related

- **[The workspace](/docs/studio/interface)**: every region of the Studio window
- **[Keyboard shortcuts](/docs/studio/interface/shortcuts)**: the full generated list
- **[Dependencies and imports](/docs/studio/projects/dependencies)**: the one operation that still blocks
- **[Source control](/docs/studio/publish/source-control)**: where a failed commit or push sends you back to
