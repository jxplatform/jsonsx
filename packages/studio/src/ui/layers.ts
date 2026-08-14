/// <reference lib="dom" />
/**
 * The overlay layers — the only sanctioned way to open a popover, modal, dialog or toast in Studio.
 *
 * Everything renders into one of the four fixed hosts declared in index.html (#layer-popover,
 * #layer-modal, #layer-dialog, #layer-toast), bound once at boot by initLayers(). Native browser
 * dialogs (`prompt`, `confirm`, `alert`) are not permitted anywhere in Studio — use
 * `showPromptDialog`, `showConfirmDialog`, or `showSaveDiscardDialog`. See studio-ui-guidelines.md
 * §8.7.
 *
 * The toast host is the fourth layer (plan §3.2 ④, §7.1). It is a rendering of
 * `services/notify.ts`'s `toasts` array and owns exactly two things that array does not: the timer
 * that retires a resting toast, and the transition account {@link overlayIdleBlockers} publishes.
 */
import { html, render as litRender, nothing } from "lit-html";
import { ref } from "lit-html/directives/ref.js";
import { repeat } from "lit-html/directives/repeat.js";
import { overlayRegion, REGION_ATTR } from "./regions";
import { dismiss, toasts } from "../services/notify";
import { activeRegistry } from "../commands/active-registry";
import { effect, effectScope } from "../reactivity";
import type { Notification, Severity } from "../services/notify";
import type { EffectScope } from "@vue/reactivity";
import type { TemplateResult } from "lit-html";

/** The four fixed layer hosts, by name. Also the `kind` half of every overlay region id. */
export type LayerKind = "popover" | "modal" | "dialog" | "toast";

let _popoverLayer: HTMLElement;
let _modalLayer: HTMLElement;
let _dialogLayer: HTMLElement;
let _toastLayer: HTMLElement;

/** The host a layer kind renders into, falling back to `<body>` before `initLayers()` has run. */
function layerHost(kind: LayerKind): HTMLElement {
  const host =
    kind === "popover"
      ? _popoverLayer
      : kind === "modal"
        ? _modalLayer
        : kind === "toast"
          ? _toastLayer
          : _dialogLayer;
  return host || document.body;
}

export function initLayers() {
  _popoverLayer = document.querySelector("#layer-popover") as HTMLElement;
  _modalLayer = document.querySelector("#layer-modal") as HTMLElement;
  _dialogLayer = document.querySelector("#layer-dialog") as HTMLElement;
  _toastLayer = document.querySelector("#layer-toast") as HTMLElement;
  mountToastHost();
}

/** Anything in the modal/dialog layers that paints a viewport-wide underlay over the app. */
const UNDERLAID = "sp-dialog-wrapper[open], sp-underlay[open]";

/**
 * Whether a surface with an underlay is up — a dialog from {@link showDialog}, or an
 * {@link openModal} body that renders its own `sp-underlay`.
 *
 * Read by the app-level keyboard handlers, which must stand down while one is: an underlay swallows
 * every pointer event across the viewport, so leaving shortcuts live means <kbd>Delete</kbd>,
 * <kbd>Enter</kbd>, ⌘S and ⌘W keep hitting the document BEHIND a surface the author cannot even
 * click on. Derived from the live DOM rather than a registration counter, so the rule is simply
 * "whatever blocks the mouse blocks the keyboard" — no bookkeeping for a new modal to forget.
 */
export function isModalOpen(): boolean {
  return Boolean(_dialogLayer?.querySelector(UNDERLAID) || _modalLayer?.querySelector(UNDERLAID));
}

/** Focusable candidates in an overlay body, in the order a keyboard user would reach them. */
const BODY_FOCUSABLE =
  'a[href], input, textarea, select, button, sp-textfield, sp-button, sp-action-button, sp-picker, sp-checkbox, sp-menu-item, [tabindex]:not([tabindex="-1"])';

/** The body's focusables that can actually take the caret right now. */
function focusablesIn(slot: HTMLElement): HTMLElement[] {
  return [...slot.querySelectorAll<HTMLElement>(BODY_FOCUSABLE)].filter(
    (el) => !el.hasAttribute("disabled") && el.getAttribute("aria-hidden") !== "true",
  );
}

/**
 * Hand the keyboard to a freshly opened overlay.
 *
 * `sp-dialog-wrapper` only throws focus into itself when an `<sp-overlay>` drives it. Opened
 * directly through its `open` attribute — Studio's pattern, because this layer stack owns stacking
 * rather than Spectrum's overlay system — NOTHING does, so focus stays on whatever sits behind the
 * underlay: the surface is unreachable by keyboard, <kbd>Escape</kbd> never reaches it, and
 * keystrokes keep landing in the app the underlay is blocking.
 *
 * Prefers the first focusable in the BODY (a bespoke form's opening field), else the wrapper's own
 * cancel button — DialogWrapper renders cancel → secondary → confirm, so the first shadow button is
 * the least destructive landing spot — else the slot itself, which carries `tabindex="-1"` so a
 * body made only of static content (a progress spinner) still receives <kbd>Escape</kbd>. A body
 * that already claimed focus ({@link showPromptDialog}'s field) is left alone.
 */
function focusOverlay(slot: HTMLElement): void {
  // Deferred a frame: the wrapper's buttons live in a shadow root Spectrum renders asynchronously.
  requestAnimationFrame(() => {
    if (!slot.isConnected || slot.contains(document.activeElement)) {
      return;
    }
    const wrapper = slot.querySelector("sp-dialog-wrapper");
    const target =
      focusablesIn(slot)[0] ?? wrapper?.shadowRoot?.querySelector<HTMLElement>("sp-button") ?? slot;
    target.focus();
  });
}

/**
 * Keep <kbd>Tab</kbd> inside the overlay: cycle through the body's focusables, wrapping at both
 * ends. With no focusable body at all the caret stays on the slot — tabbing out of a surface the
 * mouse cannot leave either would strand the keyboard behind the underlay.
 */
function trapTab(slot: HTMLElement, e: KeyboardEvent): void {
  e.preventDefault();
  const items = focusablesIn(slot);
  if (items.length === 0) {
    return;
  }
  const at = items.indexOf(document.activeElement as HTMLElement);
  const next = e.shiftKey
    ? items[at <= 0 ? items.length - 1 : at - 1]
    : items[at === -1 || at === items.length - 1 ? 0 : at + 1];
  next?.focus();
}

/** How an overlay slot behaves once it is up. */
interface OverlaySlotOptions {
  /** Layer host the slot is appended to. */
  layer: HTMLElement;
  /** Which layer this is, for the slot's region id. */
  kind: LayerKind;
  /**
   * Optional instance name, making the slot `overlay.<instance>:<id>` instead of the bare
   * `overlay.<instance>`. A surface that can be open alongside another one of its kind wants this.
   */
  regionId?: string | undefined;
  /** Handle <kbd>Escape</kbd> pressed inside the slot; the callback owns `preventDefault`. */
  onEscape?: (e: KeyboardEvent, slot: HTMLElement) => void;
  /** Cycle <kbd>Tab</kbd> within the slot instead of letting it walk into the app behind. */
  trapFocus?: boolean;
}

/**
 * Open a slot in a layer with the full overlay keyboard contract: focus in on open, focus back to
 * the opener on close, centralised <kbd>Escape</kbd>, and (optionally) a Tab trap.
 *
 * Both {@link showDialog} and {@link openModal} are thin wrappers over this — one contract, one
 * implementation, so no surface can ship without the machinery.
 */
function openOverlaySlot(opts: OverlaySlotOptions): { slot: HTMLElement; release: () => void } {
  const slot = document.createElement("div");
  slot.style.pointerEvents = "auto";
  slot.setAttribute(REGION_ATTR, overlayRegion(opts.kind, opts.regionId));
  // Focusable as a last resort, so a body with no controls still owns the keyboard (focusOverlay).
  slot.tabIndex = -1;
  // The slot is a zero-height wrapper around fixed-position bodies, so its own focus ring would
  // Paint as a stray line across the top of the layer.
  slot.style.outline = "none";
  opts.layer.append(slot);
  // Whoever held focus before the overlay took it, so it can be handed back (a dialog opened from a
  // Toolbar button returns the caret to that button, not to <body>).
  const restoreTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const onKeydown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      opts.onEscape?.(e, slot);
      return;
    }
    if (e.key === "Tab" && opts.trapFocus) {
      trapTab(slot, e);
    }
  };
  slot.addEventListener("keydown", onKeydown);
  return {
    release() {
      slot.removeEventListener("keydown", onKeydown);
      litRender(nothing, slot);
      slot.remove();
      if (restoreTo?.isConnected) {
        restoreTo.focus();
      }
    },
    slot,
  };
}

/**
 * Show an ephemeral dialog. Returns a Promise that resolves when the dialog is dismissed.
 *
 * Takes the keyboard on open ({@link focusOverlay}) and hands it back to the previously focused
 * element on close. <kbd>Escape</kbd> dismisses by firing the wrapper's `close` event, so each
 * helper's own `@close` binding decides what "dismissed" resolves to; a bespoke body with no
 * `sp-dialog-wrapper` owns its own keys.
 *
 * @template T
 * @param {(done: (value: T) => void) => import("lit-html").TemplateResult} templateFn
 * @returns {Promise<T>}
 */
export function showDialog<T>(
  templateFn: (done: (value: T) => void) => TemplateResult,
  opts: { region?: string } = {},
): Promise<T> {
  return new Promise((resolve) => {
    const { release, slot } = openOverlaySlot({
      kind: "dialog",
      // `layerHost`, not the raw binding: it is the one that falls back to `<body>`, and reading
      // The binding directly threw before `initLayers()` had run — which is any test that stands up
      // A shell without the four layer hosts, and the boot window before layers are bound.
      layer: layerHost("dialog"),
      regionId: opts.region,
      onEscape(e, host) {
        const wrapper = host.querySelector("sp-dialog-wrapper");
        if (!wrapper) {
          return;
        }
        // Stop it ALSO reaching the app behind (which clears the canvas selection on Escape).
        e.preventDefault();
        e.stopPropagation();
        wrapper.dispatchEvent(new Event("close", { bubbles: true }));
      },
      // No Tab trap: the wrapper's action buttons live in a shadow root a light-DOM cycle cannot
      // Enumerate, so trapping here would strand the caret on the body and never reach Cancel.
    });
    let resolved = false;
    const done = (value: T) => {
      if (resolved) {
        return;
      }
      resolved = true;
      release();
      resolve(value);
    };
    litRender(templateFn(done), slot);
    focusOverlay(slot);
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
  // Explicit, because `done(true)` gives the generic nothing to infer from and it landed on
  // `unknown` — which every caller happened to survive by using the answer in a truthy position.
  return showDialog<boolean>(
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
            ${
              error
                ? html`<sp-help-text slot="negative-help-text">${error}</sp-help-text>`
                : nothing
            }
          </sp-textfield>
        </sp-dialog-wrapper>
      `;
    }

    return buildTpl();
  });
}

/** Options accepted by {@link openModal}. */
export interface ModalOptions {
  /**
   * Accessible name for the modal, applied as `aria-label` on the wrapper. Required: it is the only
   * name assistive tech gets, and a per-modal opt-in would be forgotten.
   */
  label: string;
  /**
   * Whether <kbd>Escape</kbd> dismisses. `false` for modals that must not vanish mid-flight (a
   * running operation, a step that has to be confirmed).
   */
  dismissible?: boolean;
  /**
   * What <kbd>Escape</kbd> runs. Defaults to the handle's own `close()`; pass the call site's close
   * function when it keeps bookkeeping of its own (a module-level handle to clear).
   */
  onDismiss?: () => void;
  /**
   * Instance name for this modal's region — `overlay.dialog:settings`.
   *
   * Optional because one modal at a time is the norm and `overlay.dialog` addresses it. A modal
   * that can be open beside another, or that a command needs to move focus back into by name,
   * declares one.
   */
  region?: string;
}

/**
 * Open a persistent modal. Returns a handle with update() and close() methods.
 *
 * The wrapper — not the body — owns the modal contract, so no surface can ship without it: the slot
 * is the `role="dialog"` element, carries `aria-modal` and the caller's label, takes the keyboard
 * on open, cycles <kbd>Tab</kbd> within itself, dismisses on <kbd>Escape</kbd>, and hands focus
 * back to the opener on close. Bodies render content only.
 *
 * @param {import("lit-html").TemplateResult} template
 * @param {ModalOptions} opts
 */
export function openModal(template: TemplateResult, opts: ModalOptions) {
  const { release, slot } = openOverlaySlot({
    kind: "modal",
    layer: layerHost("modal"),
    onEscape(e) {
      if (opts.dismissible === false) {
        return;
      }
      // Stop it ALSO reaching the app behind (which clears the canvas selection on Escape).
      e.preventDefault();
      e.stopPropagation();
      (opts.onDismiss ?? handle.close)();
    },
    regionId: opts.region,
    trapFocus: true,
  });
  slot.setAttribute("role", "dialog");
  slot.setAttribute("aria-modal", "true");
  slot.setAttribute("aria-label", opts.label);

  const handle = {
    close() {
      release();
    },
    host: slot,
    /** @param {import("lit-html").TemplateResult} tpl */
    update(tpl: TemplateResult) {
      litRender(tpl, slot);
    },
  };
  litRender(template, slot);
  focusOverlay(slot);
  return handle;
}

/**
 * Render a popover into a layer.
 *
 * @param {import("lit-html").TemplateResult} template
 * @param {{
 *   dismissOnOutsideClick?: boolean;
 *   onDismiss?: () => void;
 *   layer?: LayerKind;
 *   region?: string;
 * }} [opts]
 */
export function renderPopover(
  template: TemplateResult,
  opts: {
    dismissOnOutsideClick?: boolean;
    onDismiss?: () => void;
    layer?: LayerKind;
    /** Instance name for this popover's region — `overlay.menu:blockbar`. */
    region?: string;
  } = {},
) {
  const kind = opts.layer ?? "popover";
  const slot = document.createElement("div");
  slot.style.pointerEvents = "auto";
  slot.setAttribute(REGION_ATTR, overlayRegion(kind, opts.region));
  layerHost(kind).append(slot);
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
        /* Disarm the PENDING arming too, not just the armed listener. The `addEventListener` above
           is deferred a frame so the click that opened this popover cannot immediately close it —
           so a popover dismissed within that frame (open the same menu twice in one frame, which a
           double-click does) would otherwise be armed AFTER its own death: a document-wide capture
           listener on a detached slot, never removed, that answers the next mousedown by calling
           its owner's `onDismiss`. Owners null their handle field there, so the corpse's callback
           cleared the pointer to the LIVE popover and stranded it on screen, un-dismissable. The
           `if` in the rAF was always written for this; nothing had ever nulled the variable. */
        outsideClickHandler = null;
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
 * Get or create a named slot in a layer. Useful for persistent popovers like the zoom indicator.
 *
 * The `${layer}:${id}` key this already builds IS the slot's region: it is stamped as
 * `overlay.<instance>:<id>`, so naming a slot names its region and every persistent overlay becomes
 * addressable for free. That also settles a latent ambiguity — two open popovers used to be
 * indistinguishable to anything matching on `sp-popover[open]`, and each now answers to its own
 * id.
 *
 * @param {LayerKind} layer
 * @param {string} id
 * @returns {HTMLElement}
 */
/**
 * The layer a transient popover must use to appear ABOVE the surface that opened it.
 *
 * The four layer hosts are sibling stacking contexts (`index.html`): popover 1000, modal 2000,
 * dialog 3000, toast 4000. So a popover anchored to a control INSIDE a modal — the media picker's
 * Browse button in Search appearance, say — renders into a layer that paints entirely beneath the
 * modal body, and the author clicks Browse and sees nothing happen. Putting it in the modal's own
 * layer makes it a later sibling of the modal body instead, which is exactly the relationship it
 * should have: above the surface that opened it, below any dialog.
 *
 * @param {Element | null} anchor The control the popover is anchored to.
 * @returns {LayerKind}
 */
export function popoverLayerFor(anchor: Element | null): LayerKind {
  if (anchor?.closest("#layer-dialog")) {
    return "dialog";
  }
  return anchor?.closest("#layer-modal") ? "modal" : "popover";
}

export function getLayerSlot(layer: LayerKind, id: string) {
  const key = `${layer}:${id}`;
  let slot = _namedSlots.get(key);
  if (slot && slot.parentElement) {
    return slot;
  }

  slot = document.createElement("div");
  slot.style.pointerEvents = "auto";
  slot.setAttribute(REGION_ATTR, overlayRegion(layer, id));
  layerHost(layer).append(slot);
  _namedSlots.set(key, slot);
  return slot;
}

/**
 * Clear a named layer slot (remove from DOM and map).
 *
 * @param {LayerKind} layer
 * @param {string} id
 */
export function clearLayerSlot(layer: LayerKind, id: string) {
  const key = `${layer}:${id}`;
  const slot = _namedSlots.get(key);
  if (slot) {
    litRender(nothing, slot);
    slot.remove();
    _namedSlots.delete(key);
  }
}

// ─── The toast host — the fourth layer ───────────────────────────────────────

/**
 * How long a toast is settling into place, in ms.
 *
 * Published to {@link overlayIdleBlockers} rather than kept private, because "the shell has stopped
 * moving" is a question `services/idle.ts` answers on behalf of the screenshot runner and the
 * verify skill, and a toast sliding in is exactly the half-painted frame a capture must not catch.
 */
export const TOAST_ENTER_MS = 180;

/** The severity glyphs. One character each: the toast's job is a line of text, not an illustration. */
const TOAST_ICON: Readonly<Record<Severity, string>> = {
  error: "✕",
  info: "ℹ",
  success: "✓",
  warn: "!",
};

let _toastScope: EffectScope | null = null;
/** Toast id → its retirement timer, so a re-render never schedules a second one. */
const _toastTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Toast id → when it started settling in. Cleared by its own timer. */
const _toastEntering = new Set<string>();

/**
 * Whether the reader has asked for less movement.
 *
 * Read per call rather than cached: §13.3 clause 6 says the app must HONOUR this rather than have
 * the runner inject a freeze stylesheet, which means the answer has to be able to change.
 */
function reducedMotion(): boolean {
  return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/**
 * **The one listed exception to §13.3 clause 6** — the only behaviour in Studio that differs under
 * `?automation=1` beyond installing the hook, pinning the clock and selecting a profile.
 *
 * A toast is the single surface in the app whose lifetime is a TIMER rather than a state. Every
 * other surface a shot can photograph is there because the app is in a state, and it stays there
 * until a command changes it; a toast retires itself between the step that raised it and the frame
 * that captures it, so a shot of one is a race the manifest has no way to express. Holding it open
 * is the smaller lie: the picture then shows a toast that a human reader would also have seen, for
 * as long as they cared to look, instead of showing the toast that happened to still be there.
 *
 * The gate is re-derived from `location.search` rather than imported from `services/automation.ts`
 * deliberately: §13.3 requires the scripting surface to be absent from the desktop and cloud
 * bundles (`check-bundle-budget.ts`'s next assertion), and importing it from a module every layer
 * pulls in would ship it everywhere. One line of duplication, on purpose.
 */
export function toastsAreHeld(): boolean {
  try {
    return new URLSearchParams(globalThis.location?.search ?? "").get("automation") === "1";
  } catch {
    // Intentionally ignored: no location (a bare test realm) means no automation.
    return false;
  }
}

/**
 * What is still moving in the overlay layers, as `services/idle.ts` phrases it.
 *
 * Empty when every toast has settled — a RESTING toast is not a blocker, which is the property that
 * lets {@link toastsAreHeld} hold one open forever without `probeIdle()` waiting forever with it.
 */
export function overlayIdleBlockers(): readonly string[] {
  return [..._toastEntering].map((id) => `overlay: toast ${id} settling in`);
}

/** Take a toast away, cancelling any timer it still owns. */
function retireToast(id: string): void {
  const timer = _toastTimers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    _toastTimers.delete(id);
  }
  _toastEntering.delete(id);
  dismiss(id);
}

/**
 * Give a newly-arrived toast its timers: the settle window the idle account reads, and (unless
 * held) the rest period after which it retires itself.
 */
function scheduleToast(record: Notification): void {
  if (_toastTimers.has(record.id) || _toastEntering.has(record.id)) {
    return;
  }
  const settle = reducedMotion() ? 0 : TOAST_ENTER_MS;
  if (settle > 0) {
    _toastEntering.add(record.id);
    setTimeout(() => _toastEntering.delete(record.id), settle);
  }
  const rest = record.timeoutMs ?? 0;
  if (rest <= 0 || toastsAreHeld()) {
    return;
  }
  _toastTimers.set(
    record.id,
    setTimeout(() => retireToast(record.id), rest),
  );
}

/** The recovery button, or `nothing` when the record named no command or the command is hidden. */
function toastActionTpl(record: Notification) {
  const registry = record.action === undefined ? null : activeRegistry();
  const id = record.action;
  if (!registry || id === undefined || !registry.get(id) || !registry.isVisible(id)) {
    return nothing;
  }
  const command = registry.get(id)!;
  const reason = registry.disabledReason(id);
  return html`
    <button
      class="toast-action"
      ?disabled=${reason !== undefined}
      title=${reason === undefined ? command.title : `${command.title} — requires ${reason}`}
      @click=${() => {
        retireToast(record.id);
        void registry.run(id, record.actionArgs);
      }}
    >
      ${command.title}
    </button>
  `;
}

/** One toast. `role="status"` lives on the HOST, so a stack of them is announced as one region. */
function toastTpl(record: Notification) {
  return html`
    <div class="toast toast--${record.severity}">
      <span class="toast-icon" aria-hidden="true">${TOAST_ICON[record.severity]}</span>
      <span class="toast-message">${record.message}</span>
      ${toastActionTpl(record)}
      <button
        class="toast-dismiss"
        title="Dismiss"
        aria-label="Dismiss notification"
        @click=${() => retireToast(record.id)}
      >
        <span aria-hidden="true">×</span>
      </button>
    </div>
  `;
}

/** The whole stack, newest at the bottom — the reading order of a log, not of a menu. */
export function toastStackTemplate() {
  return html`
    <div class="toast-stack">
      ${repeat(
        toasts,
        (record) => record.id,
        (record) => toastTpl(record),
      )}
    </div>
  `;
}

/**
 * Subscribe the toast layer to `notify`'s store.
 *
 * Called by {@link initLayers}, so no bootstrap has to remember it, and idempotent so a second call
 * replaces the effect rather than stacking a second renderer on the same host.
 */
export function mountToastHost(): void {
  unmountToastHost();
  if (!_toastLayer) {
    return;
  }
  _toastScope = effectScope();
  _toastScope.run(() => {
    effect(() => {
      // Tracked: the array itself (arrivals and retirements) and the registry holder, so a toast
      // Raised before the bootstrap composed the registry grows its Retry button when it lands.
      void toasts.length;
      void activeRegistry();
      for (const record of toasts) {
        scheduleToast(record);
      }
      litRender(toastStackTemplate(), _toastLayer);
    });
  });
}

/** Release the effect and every pending timer. Tests and a window teardown both need this. */
export function unmountToastHost(): void {
  _toastScope?.stop();
  _toastScope = null;
  for (const timer of _toastTimers.values()) {
    clearTimeout(timer);
  }
  _toastTimers.clear();
  _toastEntering.clear();
  if (_toastLayer) {
    litRender(nothing, _toastLayer);
  }
}
