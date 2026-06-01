import { render as litRender, nothing, html } from "lit-html";

let _popoverLayer: HTMLElement;
let _modalLayer: HTMLElement;
let _dialogLayer: HTMLElement;

export function initLayers() {
  _popoverLayer = document.getElementById("layer-popover") as HTMLElement;
  _modalLayer = document.getElementById("layer-modal") as HTMLElement;
  _dialogLayer = document.getElementById("layer-dialog") as HTMLElement;
}

/**
 * Show an ephemeral dialog. Returns a Promise that resolves when the dialog is dismissed.
 *
 * @template T
 * @param {(done: (value: T) => void) => import("lit-html").TemplateResult} templateFn
 * @returns {Promise<T>}
 */
export function showDialog<T>(
  templateFn: (done: (value: T) => void) => import("lit-html").TemplateResult,
): Promise<T> {
  return new Promise((resolve) => {
    const slot = document.createElement("div");
    slot.style.pointerEvents = "auto";
    _dialogLayer.appendChild(slot);
    let resolved = false;
    const done = (value: T) => {
      if (resolved) return;
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
  message: string | import("lit-html").TemplateResult,
  opts: { confirmLabel?: string; cancelLabel?: string; destructive?: boolean } = {},
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
 * Open a persistent modal. Returns a handle with update() and close() methods.
 *
 * @param {import("lit-html").TemplateResult} template
 */
export function openModal(template: import("lit-html").TemplateResult) {
  const slot = document.createElement("div");
  slot.style.pointerEvents = "auto";
  _modalLayer.appendChild(slot);
  litRender(template, slot);
  return {
    host: slot,
    /** @param {import("lit-html").TemplateResult} tpl */
    update(tpl: import("lit-html").TemplateResult) {
      litRender(tpl, slot);
    },
    close() {
      litRender(nothing, slot);
      slot.remove();
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
  template: import("lit-html").TemplateResult,
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
  target.appendChild(slot);
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
      if (outsideClickHandler) document.addEventListener("mousedown", outsideClickHandler, true);
    });
  }

  const handle = {
    host: slot,
    /** @param {import("lit-html").TemplateResult} tpl */
    update(tpl: import("lit-html").TemplateResult) {
      litRender(tpl, slot);
    },
    dismiss() {
      if (outsideClickHandler) {
        document.removeEventListener("mousedown", outsideClickHandler, true);
      }
      litRender(nothing, slot);
      slot.remove();
    },
  };
  return handle;
}

const _namedSlots: Map<string, HTMLElement> = new Map();

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
  if (slot && slot.parentElement) return slot;

  slot = document.createElement("div");
  slot.style.pointerEvents = "auto";
  const target =
    (layer === "popover" ? _popoverLayer : layer === "modal" ? _modalLayer : _dialogLayer) ||
    document.body;
  target.appendChild(slot);
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
