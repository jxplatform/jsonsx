/**
 * Ui/layers — showDialog/showConfirmDialog resolution, openModal handle, renderPopover dismissal
 * (outside click, layer targeting), and named layer slots.
 */
import { flush } from "./harness";
import { beforeAll, describe, expect, mock, test } from "bun:test";
import { html } from "lit-html";
import {
  clearLayerSlot,
  getLayerSlot,
  initLayers,
  isModalOpen,
  openModal,
  renderPopover,
  showConfirmDialog,
  showDialog,
  showPromptDialog,
  showSaveDiscardDialog,
} from "../src/ui/layers";

function layer(id: string): HTMLElement {
  return document.querySelector(`#layer-${id}`) as HTMLElement;
}

describe("getLayerSlot before initLayers", () => {
  test("falls back to document.body when layers are not initialized", () => {
    document.body.innerHTML = "";
    const slot = getLayerSlot("popover", "pre-init");
    expect(slot.parentElement).toBe(document.body);
    clearLayerSlot("popover", "pre-init");
    expect(slot.parentElement).toBeNull();
  });
});

describe("layers after init", () => {
  beforeAll(() => {
    document.body.innerHTML = `
      <div id="layer-popover"></div>
      <div id="layer-modal"></div>
      <div id="layer-dialog"></div>
    `;
    initLayers();
  });

  describe("showDialog", () => {
    test("resolves with the done() value and removes the slot", async () => {
      const promise = showDialog<string>(
        (done) => html`<button
          id="dlg-btn"
          @click=${() => {
            done("picked");
          }}
        >
          pick
        </button>`,
      );
      expect(layer("dialog").querySelector("#dlg-btn")).not.toBeNull();
      (layer("dialog").querySelector("#dlg-btn") as HTMLElement).click();
      expect(await promise).toBe("picked");
      expect(layer("dialog").querySelector("#dlg-btn")).toBeNull();
    });

    test("second done() call is ignored", async () => {
      let doneFn: ((v: number) => void) | null = null;
      const promise = showDialog<number>((done) => {
        doneFn = done;
        return html`<span>x</span>`;
      });
      doneFn!(1);
      doneFn!(2);
      expect(await promise).toBe(1);
    });

    test("takes the keyboard on open and hands focus back on close", async () => {
      const opener = document.createElement("button");
      document.body.append(opener);
      opener.focus();
      expect(document.activeElement).toBe(opener);

      let doneFn: ((v: string) => void) | null = null;
      const promise = showDialog<string>((done) => {
        doneFn = done;
        return html`<sp-dialog-wrapper open><input id="dlg-field" /></sp-dialog-wrapper>`;
      });
      // Focus lands a frame later — the wrapper's own buttons live in a shadow root Spectrum
      // Renders asynchronously.
      await flush();
      expect(document.activeElement).toBe(layer("dialog").querySelector("#dlg-field"));

      doneFn!("x");
      await promise;
      expect(document.activeElement).toBe(opener);
      opener.remove();
    });

    test("does not steal focus from a body that already claimed it", async () => {
      let doneFn: ((v: string) => void) | null = null;
      const promise = showDialog<string>((done) => {
        doneFn = done;
        return html`<sp-dialog-wrapper open
          ><input id="first" /><input id="second"
        /></sp-dialog-wrapper>`;
      });
      (layer("dialog").querySelector("#second") as HTMLElement).focus();
      await flush();
      expect((document.activeElement as HTMLElement).id).toBe("second");
      doneFn!("x");
      await promise;
    });

    test("Escape fires the wrapper's close event (each helper maps its own cancel value)", async () => {
      const promise = showConfirmDialog("Hm", "really?");
      const dlg = layer("dialog").querySelector("sp-dialog-wrapper") as HTMLElement;
      dlg.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
      expect(await promise).toBe(false);
      expect(layer("dialog").children).toHaveLength(0);
    });

    test("Escape in a bespoke body with no wrapper is left to the body", async () => {
      let doneFn: ((v: string) => void) | null = null;
      const promise = showDialog<string>((done) => {
        doneFn = done;
        return html`<div id="bespoke">no wrapper here</div>`;
      });
      const body = layer("dialog").querySelector("#bespoke") as HTMLElement;
      body.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
      expect(layer("dialog").querySelector("#bespoke")).not.toBeNull();
      doneFn!("still here");
      expect(await promise).toBe("still here");
    });
  });

  describe("isModalOpen", () => {
    test("false when the layers are empty", () => {
      expect(isModalOpen()).toBe(false);
    });

    test("true while a dialog is up, false once it resolves", async () => {
      const promise = showConfirmDialog("Blocking?", "yes");
      expect(isModalOpen()).toBe(true);
      (layer("dialog").querySelector("sp-dialog-wrapper") as HTMLElement).dispatchEvent(
        new Event("close"),
      );
      await promise;
      expect(isModalOpen()).toBe(false);
    });

    test("true for an openModal body that paints its own underlay", () => {
      const handle = openModal(
        html`<sp-underlay open></sp-underlay>
          <div>settings</div>`,
        { label: "Settings" },
      );
      expect(isModalOpen()).toBe(true);
      handle.close();
      expect(isModalOpen()).toBe(false);
    });

    test("false for a modal-layer body with no underlay (the mouse still gets through)", () => {
      const handle = openModal(html`<div class="progress">working…</div>`, { label: "Working" });
      expect(isModalOpen()).toBe(false);
      handle.close();
    });
  });

  describe("showConfirmDialog", () => {
    test("confirm resolves true with custom labels", async () => {
      const promise = showConfirmDialog("Delete?", "Sure?", {
        cancelLabel: "Keep",
        confirmLabel: "Nuke",
        destructive: true,
      });
      const dlg = layer("dialog").querySelector("sp-dialog-wrapper") as HTMLElement;
      expect(dlg.getAttribute("headline")).toBe("Delete?");
      expect(dlg.getAttribute("confirm-label")).toBe("Nuke");
      expect(dlg.getAttribute("cancel-label")).toBe("Keep");
      expect(dlg.classList.contains("dialog-destructive")).toBe(true);
      dlg.dispatchEvent(new Event("confirm"));
      expect(await promise).toBe(true);
    });

    test("close event resolves false; defaults are non-destructive", async () => {
      const promise = showConfirmDialog("Hm", "really?");
      const dlg = layer("dialog").querySelector("sp-dialog-wrapper") as HTMLElement;
      expect(dlg.getAttribute("confirm-label")).toBe("Confirm");
      expect(dlg.classList.contains("dialog-destructive")).toBe(false);
      dlg.dispatchEvent(new Event("close"));
      expect(await promise).toBe(false);
    });
  });

  describe("showSaveDiscardDialog", () => {
    test("confirm resolves 'save' with the given labels", async () => {
      const promise = showSaveDiscardDialog("Unsaved Changes", `"c.json" has unsaved changes.`);
      const dlg = layer("dialog").querySelector("sp-dialog-wrapper") as HTMLElement;
      expect(dlg.getAttribute("headline")).toBe("Unsaved Changes");
      expect(dlg.getAttribute("confirm-label")).toBe("Save");
      expect(dlg.getAttribute("secondary-label")).toBe("Discard");
      expect(dlg.getAttribute("cancel-label")).toBe("Cancel");
      dlg.dispatchEvent(new Event("confirm"));
      expect(await promise).toBe("save");
    });

    test("secondary resolves 'discard'", async () => {
      const promise = showSaveDiscardDialog("Unsaved Changes", "msg");
      const dlg = layer("dialog").querySelector("sp-dialog-wrapper") as HTMLElement;
      dlg.dispatchEvent(new Event("secondary"));
      expect(await promise).toBe("discard");
    });

    test("cancel and close both resolve 'cancel'", async () => {
      const p1 = showSaveDiscardDialog("H", "m");
      (layer("dialog").querySelector("sp-dialog-wrapper") as HTMLElement).dispatchEvent(
        new Event("cancel"),
      );
      expect(await p1).toBe("cancel");
      const p2 = showSaveDiscardDialog("H", "m");
      (layer("dialog").querySelector("sp-dialog-wrapper") as HTMLElement).dispatchEvent(
        new Event("close"),
      );
      expect(await p2).toBe("cancel");
    });
  });

  describe("showPromptDialog", () => {
    function wrapper(): HTMLElement {
      return layer("dialog").querySelector("sp-dialog-wrapper") as HTMLElement;
    }
    function field(): HTMLElement {
      return layer("dialog").querySelector("sp-textfield") as HTMLElement;
    }
    /** Type into the field the way the sp-textfield input event reaches the handler. */
    function type(text: string): void {
      (field() as unknown as { value: string }).value = text;
      field().dispatchEvent(new Event("input", { bubbles: true }));
    }
    /** Give the field a shadow-root <input> so the focus rAF has something to select. */
    function stubShadowInput(value: string): { input: HTMLInputElement; ranges: number[][] } {
      const tf = field();
      const shadow = tf.shadowRoot ?? tf.attachShadow({ mode: "open" });
      const input = document.createElement("input");
      input.value = value;
      const ranges: number[][] = [];
      input.select = () => {
        ranges.push([0, -1]);
      };
      input.setSelectionRange = (start, end) => {
        ranges.push([start ?? 0, end ?? 0]);
      };
      shadow.append(input);
      return { input, ranges };
    }

    test("confirm resolves the trimmed value; defaults render OK/Cancel", async () => {
      const promise = showPromptDialog("Name it");
      expect(wrapper().getAttribute("headline")).toBe("Name it");
      expect(wrapper().getAttribute("confirm-label")).toBe("OK");
      expect(wrapper().getAttribute("cancel-label")).toBe("Cancel");
      // No message option → no explanatory paragraph.
      expect(wrapper().querySelector("p")).toBeNull();

      type("  spaced  ");
      wrapper().dispatchEvent(new Event("confirm"));
      expect(await promise).toBe("spaced");
      expect(layer("dialog").querySelector("sp-dialog-wrapper")).toBeNull();
    });

    test("cancel and close both resolve null", async () => {
      const cancelled = showPromptDialog("A");
      wrapper().dispatchEvent(new Event("cancel"));
      expect(await cancelled).toBeNull();

      const closed = showPromptDialog("B");
      wrapper().dispatchEvent(new Event("close"));
      expect(await closed).toBeNull();
    });

    test("Enter in the field confirms; other keys do not", async () => {
      const promise = showPromptDialog("C", { value: "seed" });
      field().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "a" }));
      expect(layer("dialog").querySelector("sp-dialog-wrapper")).not.toBeNull();
      field().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
      expect(await promise).toBe("seed");
    });

    test("a blank value blocks confirm and shows the default help text", async () => {
      const promise = showPromptDialog("D");
      wrapper().dispatchEvent(new Event("confirm"));
      expect(layer("dialog").querySelector("sp-dialog-wrapper")).not.toBeNull();
      expect(field().getAttribute("invalid")).not.toBeNull();
      expect(layer("dialog").querySelector("sp-help-text")?.textContent).toContain(
        "Enter a value.",
      );

      // Typing something valid clears the error in place, then confirm goes through.
      type("ok");
      expect(layer("dialog").querySelector("sp-help-text")).toBeNull();
      wrapper().dispatchEvent(new Event("confirm"));
      expect(await promise).toBe("ok");
    });

    test("a custom validate() message blocks confirm until it passes", async () => {
      const promise = showPromptDialog("E", {
        confirmLabel: "Create",
        message: "Pick a slug",
        validate: (v) => (v.startsWith("x") ? "" : "Must start with x."),
        value: "nope",
      });
      expect(wrapper().querySelector("p")?.textContent).toContain("Pick a slug");
      expect(wrapper().getAttribute("confirm-label")).toBe("Create");

      wrapper().dispatchEvent(new Event("confirm"));
      expect(layer("dialog").querySelector("sp-help-text")?.textContent).toContain(
        "Must start with x.",
      );

      type("xyz");
      wrapper().dispatchEvent(new Event("confirm"));
      expect(await promise).toBe("xyz");
    });

    test("input that leaves the error state unchanged does not re-render", async () => {
      const promise = showPromptDialog("F");
      const before = field();
      type("aa");
      type("bb");
      // Still valid throughout, so lit never rebuilt the tree.
      expect(field()).toBe(before);
      expect(field().getAttribute("value")).toBe("");
      wrapper().dispatchEvent(new Event("confirm"));
      expect(await promise).toBe("bb");
    });

    test("select:'all' selects the whole value once the rAF fires", async () => {
      const promise = showPromptDialog("G", { value: "hello" });
      const { ranges } = stubShadowInput("hello");
      await flush();
      expect(ranges).toEqual([[0, -1]]);

      // The focus ref only fires once — a re-render must not re-select mid-edit.
      type("");
      await flush();
      expect(ranges).toEqual([[0, -1]]);

      wrapper().dispatchEvent(new Event("cancel"));
      await promise;
    });

    test("select:'stem' stops at the last dot, and falls back to the full value without one", async () => {
      const dotted = showPromptDialog("H", { select: "stem", value: "note.md" });
      const withDot = stubShadowInput("note.md");
      await flush();
      expect(withDot.ranges).toEqual([[0, 4]]);
      wrapper().dispatchEvent(new Event("cancel"));
      await dotted;

      const bare = showPromptDialog("H", { select: "stem", value: "README" });
      const noDot = stubShadowInput("README");
      await flush();
      expect(noDot.ranges).toEqual([[0, 6]]);
      wrapper().dispatchEvent(new Event("cancel"));
      await bare;

      // A leading dot is an extension-less dotfile, not a stem boundary.
      const dotfile = showPromptDialog("H", { select: "stem", value: ".env" });
      const leading = stubShadowInput(".env");
      await flush();
      expect(leading.ranges).toEqual([[0, 4]]);
      wrapper().dispatchEvent(new Event("cancel"));
      await dotfile;
    });

    test("select:'none' focuses without selecting", async () => {
      const promise = showPromptDialog("I", { select: "none", value: "keep" });
      const { ranges } = stubShadowInput("keep");
      await flush();
      expect(ranges).toEqual([]);
      wrapper().dispatchEvent(new Event("cancel"));
      await promise;
    });

    test("a textfield with no shadow input is tolerated", async () => {
      const promise = showPromptDialog("J", { placeholder: "type here", value: "v" });
      expect(field().getAttribute("placeholder")).toBe("type here");
      await flush();
      expect(layer("dialog").querySelector("sp-dialog-wrapper")).not.toBeNull();
      wrapper().dispatchEvent(new Event("cancel"));
      expect(await promise).toBeNull();
    });
  });

  describe("openModal", () => {
    /** Dispatch a bubbling key on an element inside the modal body. */
    function key(el: Element, k: string, shiftKey = false): KeyboardEvent {
      const event = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: k,
        shiftKey,
      });
      el.dispatchEvent(event);
      return event;
    }

    test("renders into the modal layer, updates, and closes", () => {
      const handle = openModal(html`<div id="modal-a">one</div>`, { label: "A" });
      expect(layer("modal").querySelector("#modal-a")).not.toBeNull();
      expect(handle.host.style.pointerEvents).toBe("auto");
      handle.update(html`<div id="modal-b">two</div>`);
      expect(layer("modal").querySelector("#modal-a")).toBeNull();
      expect(layer("modal").querySelector("#modal-b")).not.toBeNull();
      handle.close();
      expect(layer("modal").querySelector("#modal-b")).toBeNull();
      expect(handle.host.parentElement).toBeNull();
    });

    test("the wrapper carries role/aria-modal/label so no body can forget them", () => {
      const handle = openModal(html`<div>body</div>`, { label: "Manage Files" });
      expect(handle.host.getAttribute("role")).toBe("dialog");
      expect(handle.host.getAttribute("aria-modal")).toBe("true");
      expect(handle.host.getAttribute("aria-label")).toBe("Manage Files");
      handle.close();
    });

    test("takes the keyboard on open and hands it back to the opener on close", async () => {
      const opener = document.createElement("button");
      document.body.append(opener);
      opener.focus();

      const handle = openModal(
        html`<button id="modal-first">first</button><button id="modal-second">second</button>`,
        { label: "Focus" },
      );
      await flush();
      expect(document.activeElement).toBe(layer("modal").querySelector("#modal-first"));

      handle.close();
      expect(document.activeElement).toBe(opener);
      opener.remove();
    });

    test("a body with no focusable content still owns the keyboard", async () => {
      const handle = openModal(html`<div class="progress">working…</div>`, { label: "Working" });
      await flush();
      expect(document.activeElement).toBe(handle.host);
      // Nothing to cycle to: Tab is swallowed rather than walking into the app behind.
      expect(key(handle.host, "Tab").defaultPrevented).toBe(true);
      handle.close();
    });

    test("Tab and Shift+Tab cycle within the modal", async () => {
      const handle = openModal(html`<button id="trap-a">a</button><button id="trap-b">b</button>`, {
        label: "Trap",
      });
      await flush();
      const a = layer("modal").querySelector("#trap-a") as HTMLElement;
      const b = layer("modal").querySelector("#trap-b") as HTMLElement;
      expect(document.activeElement).toBe(a);

      expect(key(a, "Tab").defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(b);
      // Last → wraps to first.
      key(b, "Tab");
      expect(document.activeElement).toBe(a);
      // First → wraps backwards to last.
      key(a, "Tab", true);
      expect(document.activeElement).toBe(b);
      key(b, "Tab", true);
      expect(document.activeElement).toBe(a);
      handle.close();
    });

    test("disabled controls are skipped by the trap", async () => {
      const handle = openModal(
        html`<button id="skip-a">a</button><button id="skip-off" disabled>off</button
          ><button id="skip-b">b</button>`,
        { label: "Skip" },
      );
      await flush();
      const a = layer("modal").querySelector("#skip-a") as HTMLElement;
      key(a, "Tab");
      expect((document.activeElement as HTMLElement).id).toBe("skip-b");
      handle.close();
    });

    test("Escape closes by default and stops the app behind seeing it", async () => {
      const handle = openModal(html`<button id="esc-btn">x</button>`, { label: "Escapable" });
      await flush();
      const event = key(layer("modal").querySelector("#esc-btn") as Element, "Escape");
      expect(event.defaultPrevented).toBe(true);
      expect(layer("modal").querySelector("#esc-btn")).toBeNull();
      expect(handle.host.parentElement).toBeNull();
    });

    test("Escape runs onDismiss when the call site keeps its own bookkeeping", async () => {
      const onDismiss = mock(() => {});
      const handle = openModal(html`<button id="esc-hook">x</button>`, {
        label: "Hooked",
        onDismiss,
      });
      await flush();
      key(layer("modal").querySelector("#esc-hook") as Element, "Escape");
      expect(onDismiss).toHaveBeenCalledTimes(1);
      // The hook owns closing — the wrapper does not close behind its back.
      expect(handle.host.parentElement).not.toBeNull();
      handle.close();
    });

    test("dismissible:false ignores Escape", async () => {
      const handle = openModal(html`<button id="esc-no">x</button>`, {
        dismissible: false,
        label: "Blocking",
      });
      await flush();
      const event = key(layer("modal").querySelector("#esc-no") as Element, "Escape");
      expect(event.defaultPrevented).toBe(false);
      expect(handle.host.parentElement).not.toBeNull();
      handle.close();
    });
  });

  describe("renderPopover", () => {
    test("defaults to the popover layer and dismisses on outside mousedown", async () => {
      const onDismiss = mock(() => {});
      renderPopover(html`<div id="pop-a">pop</div>`, { onDismiss });
      expect(layer("popover").querySelector("#pop-a")).not.toBeNull();
      // Outside-click handler attaches on the next animation frame.
      await flush();
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      expect(layer("popover").querySelector("#pop-a")).toBeNull();
      expect(onDismiss).toHaveBeenCalledTimes(1);
    });

    test("mousedown inside the popover does not dismiss", async () => {
      const handle = renderPopover(html`<div id="pop-in">pop</div>`);
      await flush();
      const inner = layer("popover").querySelector("#pop-in") as HTMLElement;
      inner.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      expect(layer("popover").querySelector("#pop-in")).not.toBeNull();
      handle.dismiss();
      expect(layer("popover").querySelector("#pop-in")).toBeNull();
    });

    test("dismissOnOutsideClick:false leaves the popover; update() swaps content", async () => {
      const handle = renderPopover(html`<div id="pop-stay">stay</div>`, {
        dismissOnOutsideClick: false,
      });
      await flush();
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      expect(layer("popover").querySelector("#pop-stay")).not.toBeNull();
      handle.update(html`<div id="pop-stay2">two</div>`);
      expect(layer("popover").querySelector("#pop-stay2")).not.toBeNull();
      handle.dismiss();
    });

    test("layer option targets modal and dialog layers", () => {
      const m = renderPopover(html`<div id="pop-m"></div>`, {
        dismissOnOutsideClick: false,
        layer: "modal",
      });
      const d = renderPopover(html`<div id="pop-d"></div>`, {
        dismissOnOutsideClick: false,
        layer: "dialog",
      });
      expect(layer("modal").querySelector("#pop-m")).not.toBeNull();
      expect(layer("dialog").querySelector("#pop-d")).not.toBeNull();
      m.dismiss();
      d.dismiss();
    });

    test("dismiss before the rAF tick does not attach a stale listener", async () => {
      const fired: string[] = [];
      const early = renderPopover(html`<div id="pop-fast"></div>`, {
        onDismiss: () => fired.push("pop-fast"),
      });
      early.dismiss();
      await new Promise((resolve) => {
        requestAnimationFrame(() => resolve(null));
      });

      /* What must be observed is NOT that #pop-fast is gone — `dismiss()` removed it either way,
         so asserting only that says nothing about the arming. It is that the corpse's listener was
         never armed: a popover opened afterwards must survive a mousedown INSIDE itself, and the
         dead popover's `onDismiss` must not run. Otherwise the corpse answers that mousedown by
         nulling its owner's handle field, and the live popover is stranded with nothing left that
         can dismiss it. */
      const live = renderPopover(html`<div id="pop-live"></div>`, {
        onDismiss: () => fired.push("pop-live"),
      });
      await new Promise((resolve) => {
        requestAnimationFrame(() => resolve(null));
      });
      (live.host.querySelector("#pop-live") as HTMLElement).dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true }),
      );
      await flush();

      expect(fired).toEqual([]);
      expect(layer("popover").querySelector("#pop-fast")).toBeNull();
      expect(layer("popover").querySelector("#pop-live")).not.toBeNull();
      live.dismiss();
    });
  });

  describe("named layer slots", () => {
    test("getLayerSlot creates once and reuses while attached", () => {
      const slot1 = getLayerSlot("popover", "zoom");
      const slot2 = getLayerSlot("popover", "zoom");
      expect(slot1).toBe(slot2);
      expect(slot1.parentElement).toBe(layer("popover"));
    });

    test("recreates the slot if it was detached", () => {
      const slot = getLayerSlot("modal", "thing");
      slot.remove();
      const fresh = getLayerSlot("modal", "thing");
      expect(fresh).not.toBe(slot);
      expect(fresh.parentElement).toBe(layer("modal"));
    });

    test("dialog layer slots and clearLayerSlot removal", () => {
      const slot = getLayerSlot("dialog", "confirm");
      expect(slot.parentElement).toBe(layer("dialog"));
      clearLayerSlot("dialog", "confirm");
      expect(slot.parentElement).toBeNull();
      // Clearing again is a no-op
      clearLayerSlot("dialog", "confirm");
    });
  });
});
