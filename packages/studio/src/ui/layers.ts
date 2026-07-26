/// <reference lib="dom" />
/**
 * The overlay layers — the only sanctioned way to open a popover, modal, or dialog in Studio.
 *
 * Everything renders into one of the three fixed hosts declared in index.html (#layer-popover,
 * #layer-modal, #layer-dialog), bound once at boot by initLayers(). Native browser dialogs
 * (`prompt`, `confirm`, `alert`) are not permitted anywhere in Studio — use `showPromptDialog`,
 * `showConfirmDialog`, or `showSaveDiscardDialog`. See studio-ui-guidelines.md §8.7.
 */
import { html, render as litRender, nothing } from "lit-html";
import { ref } from "lit-html/directives/ref.js";
import type { TemplateResult } from "lit-html";

let _popoverLayer: HTMLElement;
let _modalLayer: HTMLElement;
let _dialogLayer: HTMLElement;

export function initLayers() {
  _popoverLayer = document.querySelector("#layer-popover") as HTMLElement;
  _modalLayer = document.querySelector("#layer-modal") as HTMLElement;
  _dialogLayer = document.querySelector("#layer-dialog") as HTMLElement;
}

/**
 * Show an ephemeral dialog. Returns a Promise that resolves when the dialog is dismissed.
 *
 * @template T
 * @param {(done: (value: T) => void) => import("lit-html").TemplateResult} templateFn
 * @returns {Promise<T>}
 */
export function showDialog<T>(
  templateFn: (done: (value: T) => void) => TemplateResult,
): Promise<T> {
  return new Promise((resolve) => {
    const slot = document.createElement("div");
    slot.style.pointerEvents = "auto";
    _dialogLayer.append(slot);
    let resolved = false;
    const done = (value: T) => {
      if (resolved) {
        return;
      }
      resolved = true;
      litRender(nothing, slot);
      slot.remove();
      resolve(value);
    };
    litRender(templateFn(done), slot);
  });
}

/**
 * Show a confirm/cancel dialog. Returns true if confirmed, false otherwise.
 *
 * @param {string} headline
 * @param {string | import("lit-html").TemplateResult} message
 * @param {{ confirmLabel?: string; cancelLabel?: string; destructive?: boolean }} [opts]
 * @returns {Promise<boolean>}
 */
export function showConfirmDialog(
  headline: string,
  message: string | TemplateResult,
  opts: {
    confirmLabel?: string;
    cancelLabel?: string;
    destructive?: boolean;
  } = {},
) {
  const { confirmLabel = "Confirm", cancelLabel = "Cancel", destructive = false } = opts;
  return showDialog(
    (done) => html`
      <sp-dialog-wrapper
        open
        underlay
        headline=${headline}
        confirm-label=${confirmLabel}
        cancel-label=${cancelLabel}
        size="s"
        @confirm=${() => done(true)}
        @cancel=${() => done(false)}
        @close=${() => done(false)}
        class=${destructive ? "dialog-destructive" : ""}
      >
        <p>${message}</p>
      </sp-dialog-wrapper>
    `,
  );
}

/**
 * Show a three-way Save / Discard / Cancel dialog. Resolves "save", "discard", or "cancel"
 * (dismiss/close counts as cancel).
 *
 * @param {string} headline
 * @param {string | import("lit-html").TemplateResult} message
 * @param {{ saveLabel?: string; discardLabel?: string; cancelLabel?: string }} [opts]
 * @returns {Promise<"save" | "discard" | "cancel">}
 */
export function showSaveDiscardDialog(
  headline: string,
  message: string | TemplateResult,
  opts: {
    saveLabel?: string;
    discardLabel?: string;
    cancelLabel?: string;
  } = {},
): Promise<"save" | "discard" | "cancel"> {
  const { saveLabel = "Save", discardLabel = "Discard", cancelLabel = "Cancel" } = opts;
  return showDialog<"save" | "discard" | "cancel">(
    (done) => html`
      <sp-dialog-wrapper
        open
        underlay
        headline=${headline}
        confirm-label=${saveLabel}
        secondary-label=${discardLabel}
        cancel-label=${cancelLabel}
        size="s"
        @confirm=${() => done("save")}
        @secondary=${() => done("discard")}
        @cancel=${() => done("cancel")}
        @close=${() => done("cancel")}
      >
        <p>${message}</p>
      </sp-dialog-wrapper>
    `,
  );
}

/** Options accepted by {@link showPromptDialog}. */
export interface PromptDialogOptions {
  /** Label on the confirming button. */
  confirmLabel?: string;
  /** Label on the dismissing button. */
  cancelLabel?: string;
  /** Explanatory copy rendered above the text field. */
  message?: string | TemplateResult;
  /** Placeholder shown while the field is empty. */
  placeholder?: string;
  /** How much of the pre-filled value to select once the field takes focus. */
  select?: "all" | "stem" | "none";
  /**
   * Validate the raw field value. Return an empty string when valid, or a message to show as
   * negative help text (which also blocks confirmation). Defaults to "must not be blank".
   */
  validate?: (value: string) => string;
  /** Pre-filled value. */
  value?: string;
}

/**
 * Show a single-field text-entry dialog — the Spectrum replacement for `window.prompt()`.
 *
 * Resolves the trimmed value, or `null` when cancelled/dismissed. Confirming with an invalid value
 * keeps the dialog open and surfaces the validation message as negative help text.
 *
 * @param {string} headline
 * @param {PromptDialogOptions} [opts]
 * @returns {Promise<string | null>}
 */
export function showPromptDialog(
  headline: string,
  opts: PromptDialogOptions = {},
): Promise<string | null> {
  const {
    cancelLabel = "Cancel",
    confirmLabel = "OK",
    message,
    placeholder = "",
    select = "all",
    validate,
    value: initialValue = "",
  } = opts;

  const check = (candidate: string) =>
    validate ? validate(candidate) : candidate.trim() ? "" : "Enter a value.";

  let value = initialValue;
  let error = "";
  let wrapperEl: HTMLElement | null = null;
  let focusRequested = false;

  return showDialog<string | null>((done) => {
    function rerender() {
      // Resolved lazily: lit commits element refs before inserting the fragment, so the host is
      // Only reachable once the first render has landed.
      const host = wrapperEl?.parentElement;
      if (host) {
        litRender(buildTpl(), host);
      }
    }

    function confirm() {
      error = check(value);
      if (error) {
        rerender();
        return;
      }
      done(value.trim());
    }

    function onInput(e: Event) {
      value = (e.target as HTMLInputElement).value || "";
      const next = check(value);
      if (next !== error) {
        error = next;
        rerender();
      }
    }

    function onKeydown(e: KeyboardEvent) {
      if (e.key === "Enter") {
        confirm();
      }
    }

    /** Capture the dialog element so validation errors can re-render in place. */
    function onWrapperRef(el?: Element) {
      if (el) {
        wrapperEl = el as HTMLElement;
      }
    }

    /** Focus (and optionally select) the field once, on first render only. */
    function onFieldRef(el?: Element) {
      if (!el || focusRequested) {
        return;
      }
      focusRequested = true;
      const field = el as HTMLElement;
      requestAnimationFrame(() => {
        field.focus();
        const input = field.shadowRoot?.querySelector("input");
        if (!input || select === "none") {
          return;
        }
        if (select === "stem") {
          const dot = input.value.lastIndexOf(".");
          input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
          return;
        }
        input.select();
      });
    }

    function buildTpl() {
      return html`
        <sp-dialog-wrapper
          open
          underlay
          headline=${headline}
          confirm-label=${confirmLabel}
          cancel-label=${cancelLabel}
          size="s"
          @confirm=${confirm}
          @cancel=${() => done(null)}
          @close=${() => done(null)}
          ${ref(onWrapperRef)}
        >
          ${
            // Spectrum resets <p> margins to 0, so without this the copy sits flush on the field.
            message ? html`<p style="margin:0 0 8px">${message}</p>` : nothing
          }
          <sp-textfield
            style="width:100%"
            placeholder=${placeholder}
            value=${value}
            ?invalid=${Boolean(error)}
            @input=${onInput}
            @keydown=${onKeydown}
            ${ref(onFieldRef)}
          >
            ${error
              ? html`<sp-help-text slot="negative-help-text">${error}</sp-help-text>`
              : nothing}
          </sp-textfield>
        </sp-dialog-wrapper>
      `;
    }

    return buildTpl();
  });
}

/**
 * Open a persistent modal. Returns a handle with update() and close() methods.
 *
 * @param {import("lit-html").TemplateResult} template
 */
export function openModal(template: TemplateResult) {
  const slot = document.createElement("div");
  slot.style.pointerEvents = "auto";
  _modalLayer.append(slot);
  litRender(template, slot);
  return {
    close() {
      litRender(nothing, slot);
      slot.remove();
    },
    host: slot,
    /** @param {import("lit-html").TemplateResult} tpl */
    update(tpl: TemplateResult) {
      litRender(tpl, slot);
    },
  };
}

/**
 * Render a popover into a layer.
 *
 * @param {import("lit-html").TemplateResult} template
 * @param {{
 *   dismissOnOutsideClick?: boolean;
 *   onDismiss?: () => void;
 *   layer?: "popover" | "modal" | "dialog";
 * }} [opts]
 */
export function renderPopover(
  template: TemplateResult,
  opts: {
    dismissOnOutsideClick?: boolean;
    onDismiss?: () => void;
    layer?: "popover" | "modal" | "dialog";
  } = {},
) {
  const slot = document.createElement("div");
  slot.style.pointerEvents = "auto";
  const target =
    opts.layer === "modal" ? _modalLayer : opts.layer === "dialog" ? _dialogLayer : _popoverLayer;
  target.append(slot);
  litRender(template, slot);

  let outsideClickHandler: ((e: MouseEvent) => void) | null = null;
  if (opts.dismissOnOutsideClick !== false) {
    outsideClickHandler = (e: MouseEvent) => {
      if (!slot.contains(e.target as Node)) {
        handle.dismiss();
        opts.onDismiss?.();
      }
    };
    requestAnimationFrame(() => {
      if (outsideClickHandler) {
        document.addEventListener("mousedown", outsideClickHandler, true);
      }
    });
  }

  const handle = {
    dismiss() {
      if (outsideClickHandler) {
        document.removeEventListener("mousedown", outsideClickHandler, true);
      }
      litRender(nothing, slot);
      slot.remove();
    },
    host: slot,
    /** @param {import("lit-html").TemplateResult} tpl */
    update(tpl: TemplateResult) {
      litRender(tpl, slot);
    },
  };
  return handle;
}

const _namedSlots = new Map<string, HTMLElement>();

/**
 * Get or create a named slot in a layer. Useful for persistent popovers like zoom indicator.
 *
 * @param {"popover" | "modal" | "dialog"} layer
 * @param {string} id
 * @returns {HTMLElement}
 */
export function getLayerSlot(layer: "popover" | "modal" | "dialog", id: string) {
  const key = `${layer}:${id}`;
  let slot = _namedSlots.get(key);
  if (slot && slot.parentElement) {
    return slot;
  }

  slot = document.createElement("div");
  slot.style.pointerEvents = "auto";
  const target =
    (layer === "popover" ? _popoverLayer : layer === "modal" ? _modalLayer : _dialogLayer) ||
    document.body;
  target.append(slot);
  _namedSlots.set(key, slot);
  return slot;
}

/**
 * Clear a named layer slot (remove from DOM and map).
 *
 * @param {"popover" | "modal" | "dialog"} layer
 * @param {string} id
 */
export function clearLayerSlot(layer: "popover" | "modal" | "dialog", id: string) {
  const key = `${layer}:${id}`;
  const slot = _namedSlots.get(key);
  if (slot) {
    litRender(nothing, slot);
    slot.remove();
    _namedSlots.delete(key);
  }
}
