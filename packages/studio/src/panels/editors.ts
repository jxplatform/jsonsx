/// <reference lib="dom" />
/**
 * The Logic dock's CODE surface — the Monaco function-body editor and its state-scope completions.
 *
 * It used to take over the canvas: `renderFunctionEditor` cleared `canvasWrap`, dropped every
 * canvas panel and mounted Monaco over the stage, so the page whose handler you were writing was
 * the one thing you could not see while writing it. It is a surface of the Bottom dock's **Logic**
 * tab now (plan §12 P8.5); `panels/formula-workspace.ts` owns that tab's record and calls the three
 * exports below — {@link functionEditorTemplate} for the container, {@link syncFunctionEditor} from
 * the panel's `afterRender`, and {@link closeFunctionEditor} for its Close. The canvas keeps
 * rendering the page underneath the dock; `canvas/canvas-render.ts` no longer knows this surface
 * exists.
 *
 * **The mount is driven by the DOM, not by a render call.** A dock tab's body is re-rendered by lit
 * whenever anything it reads changes, and lit will happily replace the container element out from
 * under a live Monaco instance (switching to the formula surface and back does exactly that). So
 * `syncFunctionEditor` asks the one question that matters — is the editor I hold still inside the
 * container I was just handed? — and rebuilds when the answer is no. Re-checking the target string
 * alone, which is all the takeover ever did, would have left a detached editor holding the user's
 * unsaved body.
 *
 * **The move changed the REPAINT rate, not just the teardown rate, and the repaint is the one that
 * runs with the user's hands on the keyboard.** The dock's `afterRender` effect tracks every badge
 * in the strip — Problems' count, Activity's running list, Source Control's file count, which git
 * polls every 30 seconds — so this module's sync runs on events that have nothing to do with the
 * code surface. Every write below therefore asks `services/monaco-buffer.ts` whether the buffer has
 * moved on first. Identity ("is this still the same editor?") is the OTHER question, still asked
 * where it applies, and it is passed by a repaint into a live editor mid-word.
 */

import type * as monaco from "monaco-editor";
import { loadMonaco, mountStillWanted } from "../services/monaco-lazy";
import { isJsonObject } from "@jxsuite/schema/guards";
import { html } from "lit-html";

import { getNodeAtPath, renderOnly, updateUi } from "../store";
import { activeTab, tabIsLive } from "../workspace/workspace";
import { mutateUpdateDef, mutateUpdateProperty, transactDoc } from "../tabs/transact";
import { view } from "../view";
import { codeService, getFunctionArgs, setLintMarkers } from "../services/code-services";
import {
  BUFFER_COMMIT,
  bufferIsLive,
  bufferMovedOn,
  bufferWrites,
  cancelBufferWrites,
  commitBufferWrites,
} from "../services/monaco-buffer";
import { globalEntries, namedFormulaEntries } from "../ui/formula-catalog";
import { notify } from "../services/notify";

import type { BufferWrites } from "../services/monaco-buffer";
import type { OxLintDiagnostic } from "../services/code-services";
import type { JxPrototypeDef } from "@jxsuite/schema/types";
import type { JxPath } from "../state";
import type { Tab } from "../tabs/tab";
import type { TemplateResult } from "lit-html";

type EditingTarget =
  | { type: "def"; defName: string }
  | { type: "event"; path: JxPath; eventKey: string };

/** The Monaco instance plus the four fields this module hangs off it (declared in `../view`). */
type FunctionEditor = NonNullable<typeof view.functionEditor>;

/**
 * The body `editing` names, read out of `tab`'s document.
 *
 * The tab is a PARAMETER, not `activeTab.value`. Every read and every write in this module is about
 * one document — the one whose editor is mounted — and the focused tab is only incidentally that
 * document.
 *
 * @param {Tab | null | undefined} tab
 * @param {EditingTarget | null | undefined} editing
 */
function getFunctionBody(tab: Tab | null | undefined, editing: EditingTarget | null | undefined) {
  const document = tab?.doc.document;
  // Read body off any object-shaped def (covers legacy entries without $prototype).
  const bodyOf = (def: unknown) =>
    isJsonObject(def) && typeof def.body === "string" ? def.body : "";
  if (editing?.type === "def") {
    return bodyOf(document?.state?.[editing.defName]);
  } else if (editing?.type === "event") {
    const node = getNodeAtPath(document!, editing.path);
    return node ? bodyOf(node[editing.eventKey]) : "";
  }
  return "";
}

/** Where Monaco goes inside the Logic tab. Empty on purpose — the editor fills it imperatively. */
export function functionEditorTemplate(): TemplateResult {
  return html`<div class="fw-code"></div>`;
}

/**
 * Create, re-target or tear down the Monaco instance for the Logic tab's current body.
 *
 * The panel's `afterRender` hook, so it runs against the DOM lit has just painted.
 *
 * @param {HTMLElement} host The panel body element the Logic tab was rendered into.
 */
export function syncFunctionEditor(host: HTMLElement): void {
  const tab = activeTab.value;
  const editing = tab?.session.ui.editingFunction as EditingTarget | null | undefined;
  const container = editing && tab ? host.querySelector<HTMLElement>(".fw-code") : null;
  if (!container || !tab || !editing) {
    // Either nothing is open in the code surface, or the formula surface is showing: whichever
    // Monaco instance we hold is detached DOM, and holding it leaks a model plus its listeners.
    disposeFunctionEditor();
    return;
  }

  const current = view.functionEditor;
  const attached = Boolean(current && container.contains(current.getDomNode() as Node | null));
  /* THE TAB IS HALF OF THE IDENTITY, and the half that used to be missing.
     `_editingTarget` is a JSON string built from the target alone, and the ordinary target
     `{"eventKey":"onclick","path":["children",0],"type":"event"}` is the SAME string for the first
     button on any two pages. Two tabs whose strings match would take this branch across a tab
     switch, keeping an editor whose buffer holds the OTHER document's handler — and, once the
     buffer is ahead, keeping it without even re-syncing. Comparing the tab by identity turns that
     into the rebuild it always was. */
  if (
    current &&
    attached &&
    current._editingTab === tab &&
    current._editingTarget === JSON.stringify(editing)
  ) {
    /* THE RE-SYNC, and the one thing it is not allowed to do.
       This branch exists for the edit that arrives from somewhere else — an undo, a collaborator,
       a rename that rewrote the body — and its job is to show it. The comparison it makes is
       "buffer ≠ document", which is ALSO true of every keystroke between a keypress and the 500ms
       commit; resolving that in the document's favour reverts what is being typed. And because the
       dock repaints on Problems counts, Activity and a 30-second git poll, that window is hit by
       events the author never connected to their editor: the word half-finished under the cursor
       jumps back to what it was a moment ago, for no reason they can see.
       `bufferMovedOn` is the difference between the two cases. An edit from elsewhere lands while
       the buffer is settled; a keystroke does not. */
    const body = getFunctionBody(tab, editing);
    if (!bufferMovedOn(current) && current.getValue() !== body) {
      current._ignoreNextChange = true;
      current.setValue(body);
      // The buffer just took the DOCUMENT's text, so the two agree again. Declared rather than
      // Inferred: clause 3 is a fact the writer owns, and this write is the one that clears it.
      current._writes?.markSettled();
    }
    return;
  }

  disposeFunctionEditor();
  container.textContent = "";
  const body = getFunctionBody(tab, editing);
  const args = getFunctionArgs(editing, tab.doc.document);
  void mountFunctionEditor(container, tab, editing, body, args);
}

/**
 * Drop the function editor, its model, and the debounced work armed over it. Safe to call when
 * there is nothing to drop.
 *
 * **What happens to the armed commit is the whole correctness of the teardown.** Monaco's
 * `dispose()` runs `_detachModel()`, and `CodeEditorWidget.getValue()` opens with `if
 * (!this._modelData) return "";`. A disposed editor therefore answers the EMPTY STRING, not the
 * buffer it was holding. The mount arms a 500ms timer that reads `getValue()` and writes it into
 * the document, so every surviving timer was a scheduled deletion of the user's handler:
 *
 * - Type, then click Problems / the dock's × / ⌘\ to another pane — `syncFunctionEditor` disposes
 *   synchronously, and half a second later the body is `""` and the tab is dirty.
 * - Worse, click **Close** — `closeFunctionEditor` minifies, writes the correct body, disposes, and
 *   the orphan timer overwrites that correct write with `""`. The action that exists to save the
 *   work was the one that destroyed it.
 *
 * The takeover never saw this because it was torn down by exactly one thing (closing it, which
 * happened to be slower than the debounce). A dock tab is torn down by five, four of them new in
 * P8. Handling it here rather than guarding inside each callback is deliberate: a guard on "is this
 * still the current editor?" is passed by a timer that fires after a REMOUNT.
 *
 * **But cancelling alone is the same loss with the alarm switched off.** The armed commit IS the
 * last half-second of typing; dropping it means the pre-typing body survives instead of an empty
 * one, and `doc.dirty` stays `false`, so nothing anywhere says an edit went missing. Five ways out
 * of the surface measured as silent loss — switching the dock tab, opening another target, opening
 * a formula through `openLogicTarget`, collapsing the dock, and a same-target switch to another
 * TAB. {@link commitBufferWrites} reads the buffer while it is still alive, writes it to the tab it
 * was mounted for, and only then drops what is left. The order is the fix, not the call.
 *
 * **Seven, and the last two are not this function's.** ⌘W / the tab × and quitting destroy the TAB:
 * `closeTab` deletes it from `workspace.tabs` before any repaint reaches this disposer, so the
 * commit flushed here finds `tabIsLive(tab) === false` and correctly writes nothing. Those two are
 * fixed at the gate that decides — `services/monaco-buffer.ts`'s `commitTabBuffers` runs the commit
 * while the tab is still open, and `tabBufferUnsaved` answers for typing no commit could land.
 *
 * **AND THE COMMIT IS ALLOWED TO FAIL, at which point this is a deletion.** The collab freeze
 * refuses the body write outright; a collaborator deleting the element the handler hangs off leaves
 * `editing.path` resolving to nothing. Either way `commitBufferWrites` returns false, and the very
 * next line detaches the model — so `buffersForTab` stops finding the buffer and `tabBufferUnsaved`
 * goes back to answering "nothing to lose" about text that no longer exists anywhere.
 *
 * Refusing the teardown is not on offer here, which is why the answer is a message rather than a
 * bail-out: every caller is a repaint or a mode transition that has ALREADY replaced the container
 * (the dock's `afterRender`, `closeFunctionEditor`'s tail), so keeping the instance would keep a
 * live Monaco bound to detached DOM — the leak `syncFunctionEditor` exists to close, and an editor
 * the author cannot see or reach is not a rescued edit. `closeFunctionEditor` is where a refusal
 * DOES keep the surface, because it is a gesture and the surface is still standing.
 */
export function disposeFunctionEditor(): void {
  const editor = view.functionEditor;
  if (editor) {
    commitBufferWrites(editor, "logic");
    editor.dispose();
    view.functionEditor = null;
  }
}

/**
 * The one way a body is written into a document, bound to the tab and target it is for.
 *
 * Two callers used to carry their own copy of this def/event branch — the 500ms commit and the
 * Close — and each resolved the tab it wrote to at CALL time, through `activeTab.value`. That is
 * "whatever is focused now", which is the tab the buffer came from only when nothing happened in
 * between. Bound here instead, at mount, so the two cannot answer differently and neither can
 * answer with a document the buffer was never filled from.
 *
 * `tabIsLive` rather than "is it active": the write belongs to its tab whether or not that tab is
 * the one on screen, and a tab that has been CLOSED is the one case where the write must not happen
 * at all — nothing would ever read it, and `transactDoc` would still push history and dirty a
 * document the user has already dismissed.
 *
 * **A WRITE IS ALLOWED TO BE REFUSED, and the buffer has to hear about it.** `transactDoc` consults
 * the collab gate, which under the source-canonical freeze blocks every structural edit including
 * the lock holder's own — so this returns having changed nothing. Settling the buffer anyway told
 * `tabBufferUnsaved` (and therefore `shouldWarnOnClose` and `hasUnsavedTabs`) that the document had
 * been given the author's text when it had not, and every subsequent close discarded it without a
 * word. So the settle is conditional on the write LANDING, and the answer is handed back to the
 * caller: the debounce has nothing useful to do with it (the gate raises its own keyed toast on
 * every refusal), but the Close does — see {@link closeFunctionEditor} — and so does every
 * disposer, through `commitBufferWrites`.
 *
 * **Three ways it does not land, not one.** The tab is gone; the collab gate refuses; or the node
 * `editing.path` names has been deleted out from under the open editor, in which case there is no
 * coordinate to write to at all.
 *
 * @param {Tab} tab The document this buffer was filled from.
 * @param {EditingTarget} editing The def or event binding inside it.
 * @param {BufferWrites} [writes] The buffer's debounce holder, when there is a buffer: a completed
 *   write is precisely what settles clause 3.
 * @returns {(body: string) => boolean} True when the body reached the document.
 */
function bodyWriter(tab: Tab, editing: EditingTarget, writes?: BufferWrites) {
  return (newBody: string): boolean => {
    if (!tabIsLive(tab)) {
      return false;
    }
    let wrote = false;
    if (editing.type === "def") {
      wrote = transactDoc(tab, (t) => mutateUpdateDef(t, editing.defName, { body: newBody }));
    } else if (editing.type === "event") {
      const node = getNodeAtPath(tab.doc.document, editing.path);
      /* THE ELEMENT THE HANDLER HANGS OFF CAN GO WHILE THE EDITOR IS OPEN — a collaborator's
         delete arriving over the wire, or the author's own ⌘Z. `editing.path` then resolves to
         nothing, and `mutateUpdateProperty` read `getNodeAtPath(...)[key]` straight through it:
         `undefined is not an object`, thrown out of the 500ms commit and, through
         `commitBufferWrites`, out of the dock panel's `afterRender`.
         There is no coordinate left to write the body to, so the honest answer is that the write
         did not happen. Reporting it as a success would settle the buffer and tell every close
         gate the document had been given text that has nowhere to be. */
      if (!node) {
        return false;
      }
      const current = node[editing.eventKey] || {};
      wrote = transactDoc(tab, (t) =>
        mutateUpdateProperty(t, editing.path, editing.eventKey, {
          ...(current as object),
          $prototype: "Function",
          body: newBody,
        }),
      );
    }
    // The document now holds what the buffer holds — clause 3 is cleared by the write that made it
    // True, not by a timer expiring, and never by a write that was refused.
    if (wrote) {
      writes?.markSettled();
    }
    return wrote;
  };
}

/**
 * Close the code surface: minify what is in the buffer, write it back, and clear the target.
 *
 * The write is the reason the Close is a real one rather than a tab switch. It lived in `studio.ts`
 * beside the pane context bar's crumb, which was its only caller; the Logic tab's Close is the
 * second, and a body-saving routine that two surfaces call belongs beside the editor whose buffer
 * it reads.
 *
 * **The minify is an await, and a retarget fits inside it.** The buffer and the target are both
 * read BEFORE it; the teardown after it acts on whatever is mounted then. Open A, click Close, and
 * while `minify` is in flight click "Open in code editor" on B: the write still belongs to A and
 * still lands on A, but the dispose-and-clear would have killed B's live editor and closed a
 * document position the user had just asked for. So the write is unconditional and the TEARDOWN is
 * conditional — they answer to different moments in time and only one of them is still A's.
 *
 * **But that is TWO obligations, and only one of them is the editor's.** Guarding the whole tail on
 * `view.functionEditor === editor` conflated them, and the case it got wrong is the ordinary one:
 * an editor torn down inside the minify and NOT retargeted — collapse the dock, select Problems, ⌘\
 * to another pane — leaves `view.functionEditor` null, so the guard bailed and `editingFunction`
 * was never cleared. Nothing else clears it, so the Logic tab stayed on the strip pointing at a
 * body the user had just dismissed, and re-opening the dock restored the editor they closed.
 * Disposing belongs to the instance; clearing the target belongs to the TARGET, and the only thing
 * with a claim on the target is a retarget that already replaced it.
 *
 * **The write goes through the editor's own `_commitBody`, not through the focused tab.** That
 * writer was bound at mount to the tab and target this buffer belongs to, so the Close and the
 * debounce cannot land in different places. An editor handle this module did not mount carries no
 * writer, and then the only meaning the gesture has left is its own tab and its own target — the
 * same {@link bodyWriter}, bound to those.
 *
 * **AND THE WRITE CAN BE REFUSED, in which case there is nothing left to close over.** Under the
 * source-canonical freeze the collab gate blocks the body commit, and this used to carry on:
 * minify, refused write, `cancelBufferWrites` (the armed commit gone too), dispose, target cleared.
 * The Close button — the one action whose entire purpose is to save the body — destroyed it, and
 * the standing "frozen" chip in the presence strip does not say that a button just did nothing. A
 * refusal therefore keeps the surface exactly as it is (the text stays on screen, the target stays
 * open) and says why, once, through the same Problems/toast channel every other failed write uses.
 * Nothing is re-armed: the buffer is still marked typed, so the close and quit gates already know
 * the work exists.
 */
export async function closeFunctionEditor(): Promise<void> {
  const tab = activeTab.value;
  const editing = tab?.session.ui.editingFunction as EditingTarget | null | undefined;
  if (!tab || !editing) {
    return;
  }
  const editor = view.functionEditor;
  if (editor) {
    const currentCode = editor.getValue();
    const minResult = await codeService("minify", { code: currentCode });
    /* Cancelled AFTER the round trip, not before it. Either position stops the armed commit from
       replaying raw text over the minified body, but cancelling first means a minify that REJECTS
       takes the user's last keystrokes with it — there would be no armed commit left to write them.
       Left armed, the worst case is that the timer fires mid-await and writes the same text to the
       same target a moment before the minified version lands on top of it. */
    cancelBufferWrites(editor);
    const write = editor._commitBody ?? bodyWriter(tab, editing);
    if (!write(minResult?.code ?? currentCode)) {
      notify.warn(
        "The handler could not be saved — source editing holds this document. Your code is still in the editor.",
        {
          key: "logic.close-refused",
          source: "Logic",
          ...(tab.documentPath ? { path: tab.documentPath } : {}),
        },
      );
      return;
    }
    if (view.functionEditor !== null && view.functionEditor !== editor) {
      return;
    }
    // A no-op when the teardown already happened, which is the whole point: the clear below still
    // Runs, because a target with no editor is precisely the state nothing else resolves.
    disposeFunctionEditor();
  }
  updateUi("editingFunction", null);
}

/**
 * Whether the mount started for `container` / `tab` / `editing` is still the one the app wants.
 *
 * The three clauses `services/monaco-lazy.ts` states, spelled for this surface: the container is
 * still in the document, no other mount has already produced the editor, and the dock still wants
 * exactly this tab and this target. Asked AFTER the Monaco load, because that load is a cold
 * dynamic import of 12.6 MB and the user has hundreds of milliseconds to close the surface,
 * retarget it or switch tabs inside it — each of which used to end with a live editor nobody could
 * reach, assigned to `view.functionEditor` where the next sync would overwrite the handle rather
 * than dispose it.
 *
 * `activeTab.value === tab` covers the tab having been closed as well as merely left: a closed tab
 * is nobody's active tab, and the dock only ever shows the active one's target.
 */
function functionMountWanted(container: HTMLElement, tab: Tab, editing: EditingTarget): boolean {
  return mountStillWanted(container, view.functionEditor, () => {
    const current = activeTab.value;
    return (
      current === tab &&
      JSON.stringify(current.session.ui.editingFunction ?? null) === JSON.stringify(editing)
    );
  });
}

/**
 * Create the function-body editor once Monaco has loaded.
 *
 * The container is in the DOM when this is called and the target is current — but neither is still
 * guaranteed on the far side of the `await`, which is why {@link functionMountWanted} is asked
 * again there. Nothing else covers it: `syncFunctionEditor` runs from the dock's `afterRender`, so
 * it cannot see a mount that has not produced an editor yet.
 *
 * **`tab` is captured here and never re-read.** Everything below — the commit, the format
 * continuation, the lint continuations — names THIS tab, because a buffer belongs to the document
 * it was filled from and to no other. Resolving through `activeTab.value` at callback time meant
 * the 500ms commit addressed whatever tab was focused when the timer fired: open `a.json`, Edit
 * Event Handler on `children[0].onclick`, open `b.json`, same handler, type one character in A and
 * click B's tab inside the window, and B's handler was replaced by A's buffer while A never
 * received the edit at all.
 */
async function mountFunctionEditor(
  editorContainer: HTMLElement,
  tab: Tab,
  editing: EditingTarget,
  body: string,
  args: string[],
): Promise<void> {
  const monacoNs = await loadMonaco();
  if (!functionMountWanted(editorContainer, tab, editing)) {
    return;
  }
  // Completions used to register at studio startup, which would now await the lazy load and undo it.
  // The editor is the only surface they serve, and the registration is idempotent.
  void registerFunctionCompletions();
  const editor: FunctionEditor = monacoNs.editor.create(editorContainer, {
    automaticLayout: true,
    fontFamily: "'JetBrains Mono', 'SF Mono', 'Fira Code', 'Consolas', monospace",
    fontSize: 12,
    language: "javascript",
    lineNumbers: "on",
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    tabSize: 2,
    theme: "vs-dark",
    value: body,
    wordWrap: "on",
  });
  editor._editingTarget = JSON.stringify(editing);
  editor._editingTab = tab;
  const writes = bufferWrites(editor);

  // The writer this buffer will use for the rest of its life, bound to the tab and target it was
  // Mounted for. The debounce below and `closeFunctionEditor` both go through it.
  editor._commitBody = bodyWriter(tab, editing, writes);
  view.functionEditor = editor;

  let lintGen = 0;

  // Format on open — show pretty-printed code, then run initial lint.
  //
  // Both continuations address `editor`, not `view.functionEditor`. That handle is a variable, and
  // A code service round-trip is long enough to retarget twice: it names whatever is mounted NOW,
  // So answering a stale request through it wrote one def's formatted body into another def's
  // Editor. `editor` is the instance the request was made FOR, and the identity check is how a
  // Request that outlived it says nothing at all.
  //
  // Identity is where that reasoning STOPPED, and the common case is the one it misses: no
  // Retarget happened, so the guard passes — and a cold format round trip is long enough to type
  // Into. What lands is the formatting of the body as it was BEFORE those keystrokes, on top of
  // Them. `body` is what the request was computed from, so passing it as `expected` is the whole
  // Difference between "still the same editor" and "still the same text".
  void codeService("format", { args, code: body }).then((result) => {
    if (
      result?.code != null &&
      view.functionEditor === editor &&
      tabIsLive(tab) &&
      !bufferMovedOn(editor, body)
    ) {
      editor._ignoreNextChange = true;
      editor.setValue(result.code);
      /* AND SAY SO, or the next repaint un-formats it in front of the author.
         This text did not come from the document and is deliberately never committed to it, so the
         buffer is now ahead. Inferred from the debounce it would read as "settled" — `setValue`
         sets `_ignoreNextChange`, the change handler returns before it can arm anything — and the
         re-sync branch would resolve the difference in the document's favour. With the dock
         repainting on the Problems badge, on Activity and on a 30-second git poll, "Format on open"
         visibly undid itself within seconds of every open. */
      writes.markAhead();
    }
  });
  void codeService("lint", { args, code: body }).then((result) => {
    if (
      result?.diagnostics &&
      view.functionEditor === editor &&
      tabIsLive(tab) &&
      bufferIsLive(editor)
    ) {
      setLintMarkers(editor, result.diagnostics as OxLintDiagnostic[]);
    }
  });

  editor.onDidChangeModelContent(() => {
    if (editor._ignoreNextChange) {
      editor._ignoreNextChange = false;
      return;
    }

    // A keystroke. The buffer is ahead of the document from this instant until the commit lands —
    // Stated as a fact rather than left to be read off the timer, because the timer is only ONE of
    // The ways a buffer gets ahead and the other one is invisible to it. `markTyped` rather than
    // `markAhead`: this text is the AUTHOR'S, so it is also the text a close would destroy, and
    // Format-on-open's (below) is not.
    writes.markTyped();

    writes.arm(BUFFER_COMMIT, 500, () => {
      editor._commitBody?.(editor.getValue());
      renderOnly("leftPanel");
    });

    writes.arm("lint", 750, () => {
      const gen = (lintGen += 1);
      const currentCode = editor.getValue();
      void codeService("lint", { args, code: currentCode }).then((result) => {
        // `lintGen` is per-MOUNT, so it can only order this editor's own requests; a remount
        // Starts a fresh generation that a stale closure's `gen` still matches. The identity check
        // Is the half that spans mounts, and the tab is the half that spans documents.
        if (
          gen !== lintGen ||
          view.functionEditor !== editor ||
          !tabIsLive(tab) ||
          !bufferIsLive(editor)
        ) {
          return;
        }
        if (result?.diagnostics) {
          setLintMarkers(editor, result.diagnostics as OxLintDiagnostic[]);
        }
      });
    });
  });
}

// Register Monaco JS completion provider for state scope variables (once)
export async function registerFunctionCompletions() {
  if (view._completionRegistered) {
    return;
  }
  view._completionRegistered = true;
  const monacoNs = await loadMonaco();
  monacoNs.languages.registerCompletionItemProvider("javascript", {
    provideCompletionItems(model, position) {
      if (!activeTab.value) {
        return { suggestions: [] };
      }
      const defs = activeTab.value.doc.document?.state || {};
      const word = model.getWordUntilPosition(position);
      const range = {
        endColumn: word.endColumn,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        startLineNumber: position.lineNumber,
      };

      // Named-formula catalog metadata enriches their completions with documentation.
      const formulaDocs = new Map(namedFormulaEntries(defs).map((e) => [e.name, e.description]));

      const suggestions: monaco.languages.CompletionItem[] = Object.entries(defs).map(
        ([key, def]) => {
          let kind = monacoNs.languages.CompletionItemKind.Variable;
          if (
            (def as JxPrototypeDef)?.$prototype === "Function" ||
            (def as Record<string, unknown>)?.$handler ||
            formulaDocs.has(key)
          ) {
            kind = monacoNs.languages.CompletionItemKind.Function;
          } else if ((def as JxPrototypeDef)?.$prototype) {
            kind = monacoNs.languages.CompletionItemKind.Property;
          }
          const item: monaco.languages.CompletionItem = {
            insertText: `state.${key}`,
            kind,
            label: `state.${key}`,
            range,
          };
          const documentation = formulaDocs.get(key);
          if (documentation) {
            item.documentation = documentation;
          }
          return item;
        },
      );

      // Blessed pure globals from the formula catalog (Math.*, JSON.*, Object.*, …).
      for (const entry of globalEntries()) {
        suggestions.push({
          documentation: entry.description,
          insertText: `window.${entry.label}`,
          kind: monacoNs.languages.CompletionItemKind.Function,
          label: entry.label,
          range,
        });
      }
      return { suggestions };
    },
    triggerCharacters: ["."],
  });
}
