import { render as litRender, nothing, html } from "lit-html";

/** @type {HTMLElement} */
let _popoverLayer;
/** @type {HTMLElement} */
let _modalLayer;
/** @type {HTMLElement} */
let _dialogLayer;

export function initLayers() {
  _popoverLayer = /** @type {HTMLElement} */ (document.getElementById("layer-popover"));
  _modalLayer = /** @type {HTMLElement} */ (document.getElementById("layer-modal"));
  _dialogLayer = /** @type {HTMLElement} */ (document.getElementById("layer-dialog"));
}

/**
 * Show an ephemeral dialog. Returns a Promise that resolves when the dialog is dismissed.
 *
 * @template T
 * @param {(done: (value: T) => void) => import("lit-html").TemplateResult} templateFn
 * @returns {Promise<T>}
 */
export function showDialog(templateFn) {
  return new Promise((resolve) => {
    const slot = document.createElement("div");
    slot.style.pointerEvents = "auto";
    _dialogLayer.appendChild(slot);
    let resolved = false;
    const done = (/** @type {T} */ value) => {
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
export function showConfirmDialog(headline, message, opts = {}) {
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
export function openModal(template) {
  const slot = document.createElement("div");
  slot.style.pointerEvents = "auto";
  _modalLayer.appendChild(slot);
  litRender(template, slot);
  return {
    host: slot,
    /** @param {import("lit-html").TemplateResult} tpl */
    update(tpl) {
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
export function renderPopover(template, opts = {}) {
  const slot = document.createElement("div");
  slot.style.pointerEvents = "auto";
  const target =
    opts.layer === "modal" ? _modalLayer : opts.layer === "dialog" ? _dialogLayer : _popoverLayer;
  target.appendChild(slot);
  litRender(template, slot);

  /** @type {((e: MouseEvent) => void) | null} */
  let outsideClickHandler = null;
  if (opts.dismissOnOutsideClick !== false) {
    outsideClickHandler = (/** @type {MouseEvent} */ e) => {
      if (!slot.contains(/** @type {Node} */ (e.target))) {
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
    update(tpl) {
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

/** @type {Map<string, HTMLElement>} */
const _namedSlots = new Map();

/**
 * Get or create a named slot in a layer. Useful for persistent popovers like zoom indicator.
 *
 * @param {"popover" | "modal" | "dialog"} layer
 * @param {string} id
 * @returns {HTMLElement}
 */
export function getLayerSlot(layer, id) {
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
export function clearLayerSlot(layer, id) {
  const key = `${layer}:${id}`;
  const slot = _namedSlots.get(key);
  if (slot) {
    litRender(nothing, slot);
    slot.remove();
    _namedSlots.delete(key);
  }
}
