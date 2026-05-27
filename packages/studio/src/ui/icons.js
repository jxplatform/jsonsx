// packages/studio/icons.js
// Icon templates for style sidebar button groups.
// Uses Spectrum workflow icons where available; custom SVGs for flex-specific concepts.

import { html } from "lit";

// Helper for custom filled-rect icons (alignment/justify diagrams) where no Spectrum match exists
const _R = (/** @type {import("lit").TemplateResult} */ d) =>
  html`<svg
    xmlns="http://www.w3.org/2000/svg"
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="currentColor"
    stroke="none"
  >
    ${d}
  </svg>`;

// Helper for custom stroke icons
const _S = (/** @type {import("lit").TemplateResult} */ d) =>
  html`<svg
    xmlns="http://www.w3.org/2000/svg"
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    ${d}
  </svg>`;

const icons = {
  // ─── Arrows — flexDirection ───
  "arrow-right": html`<sp-icon-arrow-right slot="icon"></sp-icon-arrow-right>`,
  "arrow-left": html`<sp-icon-arrow-left slot="icon"></sp-icon-arrow-left>`,
  "arrow-down": html`<sp-icon-arrow-down slot="icon"></sp-icon-arrow-down>`,
  "arrow-up": html`<sp-icon-arrow-up slot="icon"></sp-icon-arrow-up>`,

  // ─── Text align — textAlign ───
  "text-align-left": html`<sp-icon-text-align-left slot="icon"></sp-icon-text-align-left>`,
  "text-align-center": html`<sp-icon-text-align-center slot="icon"></sp-icon-text-align-center>`,
  "text-align-right": html`<sp-icon-text-align-right slot="icon"></sp-icon-text-align-right>`,
  "text-align-justify": html`<sp-icon-text-align-justify slot="icon"></sp-icon-text-align-justify>`,

  // ─── flexWrap ───
  "wrap-text": html`<sp-icon-flip-vertical slot="icon"></sp-icon-flip-vertical>`,

  // ─── alignItems / alignSelf — vertical alignment within container ───
  "align-start-v": html`<sp-icon-align-top slot="icon"></sp-icon-align-top>`,
  "align-end-v": html`<sp-icon-align-bottom slot="icon"></sp-icon-align-bottom>`,
  "align-center-v": html`<sp-icon-align-middle slot="icon"></sp-icon-align-middle>`,
  "align-stretch-v": html`<sp-icon-distribute-vertically
    slot="icon"
  ></sp-icon-distribute-vertically>`,
  "align-baseline": html`<sp-icon-text-baseline-shift slot="icon"></sp-icon-text-baseline-shift>`,

  // ─── justifyContent — horizontal distribution within container ───
  "justify-start": html`<sp-icon-align-left slot="icon"></sp-icon-align-left>`,
  "justify-end": html`<sp-icon-align-right slot="icon"></sp-icon-align-right>`,
  "justify-center": html`<sp-icon-align-center slot="icon"></sp-icon-align-center>`,
  "justify-between": html`<sp-icon-distribute-space-horiz
    slot="icon"
  ></sp-icon-distribute-space-horiz>`,
  "justify-around": html`<sp-icon-distribute-horizontally
    slot="icon"
  ></sp-icon-distribute-horizontally>`,
  "justify-evenly": html`<sp-icon-distribute-horizontal-center
    slot="icon"
  ></sp-icon-distribute-horizontal-center>`,

  // ─── display mode icons ───
  "display-flex": html`<sp-icon-view-column slot="icon"></sp-icon-view-column>`,
  "display-grid": html`<sp-icon-view-grid slot="icon"></sp-icon-view-grid>`,
  "display-block": html`<sp-icon-box slot="icon"></sp-icon-box>`,
  "display-inline": html`<sp-icon-remove slot="icon"></sp-icon-remove>`,
  "display-none": html`<sp-icon-visibility-off slot="icon"></sp-icon-visibility-off>`,
};

export default icons;
