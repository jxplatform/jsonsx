/// <reference lib="dom" />
/**
 * Value Selector — Dual-mode styled combobox custom element.
 *
 * Renders as sp-picker when the current value matches a predefined option, or as a textfield +
 * dropdown overlay (manual combobox) when it doesn't. Both modes share identical styled menu items,
 * ensuring visual consistency.
 *
 * Usage: html`<jx-value-selector size="s" .value=${"italic"} placeholder="normal" .options=${[{
 * value: "italic", label: "Italic", style: "font-style: italic" }]} @change=${handler}
 * @input=${handler}
 *
 * > </jx-value-selector>`
 *
 * Options format: { value: string, label: string, style?: string } — menu item { divider: true } —
 * menu divider
 */

import { LitElement, html } from "lit";
import { live } from "lit/directives/live.js";

type ComboOption = { value: string; label: string; style?: string } | { divider: true };

export class JxValueSelector extends LitElement {
  static override properties = {
    options: { attribute: false },
    placeholder: { type: String },
    size: { type: String },
    value: { type: String },
  };

  declare value: string;
  declare placeholder: string;
  declare size: string;
  declare options: ComboOption[];
  declare _menuId: string;

  constructor() {
    super();
    this.value = "";
    this.placeholder = "";
    this.size = "s";
    this.options = [];
    this._menuId = `jx-combo-${Math.random().toString(36).slice(2, 8)}`;
  }

  /** No shadow DOM — render directly into light DOM */
  override createRenderRoot() {
    return this;
  }

  /** Check if current value matches a predefined option */
  get _isPicker() {
    return (
      Boolean(this.value) &&
      this.options.some((o: ComboOption) => !("divider" in o) && o.value === this.value)
    );
  }

  /** Get the selected option's style string for the picker button preview */
  get _selectedStyle() {
    if (!this._isPicker) {
      return "";
    }
    const opt = this.options.find((o: ComboOption) => !("divider" in o) && o.value === this.value);
    return (opt as { value: string; label: string; style?: string } | undefined)?.style || "";
  }

  /** Render menu items from options array */
  _renderMenuItems() {
    return this.options.map((opt: ComboOption) =>
      "divider" in opt
        ? html`<sp-menu-divider></sp-menu-divider>`
        : html`<sp-menu-item value=${opt.value} style=${opt.style || ""}
            >${opt.label}</sp-menu-item
          >`,
    );
  }

  /** Picker mode: sp-picker @change handler */
  _handlePickerChange(e: Event) {
    e.stopPropagation();
    this.value = (e.target as HTMLInputElement).value;
    this.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  }

  /** Combobox mode: sp-menu @change handler */
  _handleMenuChange(e: Event) {
    e.stopPropagation();
    if (!(e.target as HTMLInputElement).value) {
      return;
    }
    this.value = (e.target as HTMLInputElement).value;
    this.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  }

  /** Combobox mode: textfield @input handler */
  _handleInput(e: Event) {
    e.stopPropagation();
    this.value = (e.target as HTMLInputElement).value;
    this.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  }

  /** Set popover min-width to match trigger width (replicates sp-picker behavior) */
  _setPopoverWidth(e: Event) {
    const group = this.querySelector(".jx-combobox-group");
    const w = group ? (group as HTMLElement).offsetWidth : 0;
    const popover = (e.target as HTMLElement).querySelector("sp-popover");
    if (popover && w) {
      (popover as HTMLElement).style.minWidth = `${w}px`;
    }
  }

  override render() {
    if (this._isPicker) {
      return html`
        <sp-picker
          class="jx-combobox-picker"
          size=${this.size}
          style=${this._selectedStyle}
          .value=${live(this.value)}
          @change=${this._handlePickerChange}
        >
          ${this._renderMenuItems()}
        </sp-picker>
      `;
    }

    return html`
      <div class="jx-combobox-group" id=${this._menuId}>
        <sp-textfield
          size=${this.size}
          placeholder=${this.placeholder}
          .value=${live(this.value || "")}
          @input=${this._handleInput}
          @click=${(e: Event) => e.stopPropagation()}
        ></sp-textfield>
        <sp-picker-button size=${this.size}></sp-picker-button>
        <sp-overlay
          trigger="${this._menuId}@click"
          placement="bottom-start"
          type="auto"
          @sp-opened=${this._setPopoverWidth}
        >
          <sp-popover class="jx-combobox-popover">
            <sp-menu size=${this.size} @change=${this._handleMenuChange}>
              ${this._renderMenuItems()}
            </sp-menu>
          </sp-popover>
        </sp-overlay>
      </div>
    `;
  }
}
