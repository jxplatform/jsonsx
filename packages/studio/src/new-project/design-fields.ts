/**
 * The design-quickstart section of the New Project Parameters step: colors, fonts, logo, and
 * breakpoints. A trimmed-down, creation-time version of the settings modal — every field is
 * optional, and empty fields leave the template/starter defaults untouched (the backend applies
 * overrides best-effort against the starters' shared token conventions).
 */

import { html } from "lit-html";
import type { TemplateResult } from "lit-html";

/** Mirrors @jxsuite/create's DesignOptions (threaded through platform.createProject). */
export interface DesignSelection {
  accent?: string;
  background?: string;
  text?: string;
  bodyFont?: string;
  headingFont?: string;
  media?: Record<string, string>;
  logo?: { name: string; base64: string };
}

interface MediaRow {
  name: string;
  value: string;
}

let _accent = "";
let _background = "";
let _text = "";
let _bodyFont = "";
let _headingFont = "";
let _mediaRows: MediaRow[] = [];
let _mediaNote = "";
let _logo: { name: string; base64: string } | null = null;
let _logoError = "";

// Prefills are display defaults, not overrides: a value identical to its prefill is NOT sent, so
// An untouched form leaves the template/starter exactly as authored (a starter's registry accent
// Need not equal its --color-primary, and re-sending a template's own $media is just noise).
let _prefillAccent = "";
let _prefillMediaJson = "";

function mediaRowsJson(rows: MediaRow[]): string {
  return JSON.stringify(rows.map((r) => [r.name.trim(), r.value.trim()]));
}

export interface DesignPrefill {
  /** Prefilled accent color (a starter's registry accent). */
  accent?: string;
  /** Prefilled breakpoint rows (a template's $media preset). */
  media?: Record<string, string>;
  /** Shown under the breakpoints editor when it starts empty (starter sites). */
  mediaNote?: string;
}

/** Reset the section for a fresh modal pass, seeding prefills from the chosen source. */
export function resetDesignFields(prefill: DesignPrefill = {}) {
  _accent = prefill.accent ?? "";
  _background = "";
  _text = "";
  _bodyFont = "";
  _headingFont = "";
  _mediaRows = Object.entries(prefill.media ?? {}).map(([name, value]) => ({ name, value }));
  _mediaNote = prefill.mediaNote ?? "";
  _logo = null;
  _logoError = "";
  _prefillAccent = _accent;
  _prefillMediaJson = mediaRowsJson(_mediaRows);
}

/**
 * The design overrides to send with createProject, or undefined when everything was left at its
 * defaults (the payload then stays byte-identical to a plain create).
 */
export function collectDesign(): DesignSelection | undefined {
  const media: Record<string, string> = {};
  for (const row of _mediaRows) {
    if (row.name.trim() && row.value.trim()) {
      media[row.name.trim()] = row.value.trim();
    }
  }
  const accentChanged = _accent.trim() && _accent.trim() !== _prefillAccent;
  const mediaChanged =
    Object.keys(media).length > 0 && mediaRowsJson(_mediaRows) !== _prefillMediaJson;
  const design: DesignSelection = {
    ...(accentChanged ? { accent: _accent.trim() } : {}),
    ...(_background.trim() ? { background: _background.trim() } : {}),
    ...(_text.trim() ? { text: _text.trim() } : {}),
    ...(_bodyFont.trim() ? { bodyFont: _bodyFont.trim() } : {}),
    ...(_headingFont.trim() ? { headingFont: _headingFont.trim() } : {}),
    ...(mediaChanged ? { media } : {}),
    ...(_logo ? { logo: _logo } : {}),
  };
  return Object.keys(design).length > 0 ? design : undefined;
}

/** Base64-encode a small file (logos) without blowing the call stack on spread. */
async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const CHUNK = 32_768;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCodePoint(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function colorRow(
  label: string,
  value: string,
  set: (v: string) => void,
  rerender: () => void,
): TemplateResult {
  const onText = (e: Event) => {
    set((e.target as HTMLInputElement).value);
    rerender();
  };
  return html`
    <div class="new-project-color-row">
      <span class="new-project-label">${label}</span>
      <div class="css-var-swatch" style="background:${value || "transparent"}">
        <input type="color" .value=${value || "#888888"} @input=${onText} />
      </div>
      <sp-textfield placeholder="Keep default" .value=${value} @input=${onText}></sp-textfield>
    </div>
  `;
}

export function renderDesignFields(ctx: { rerender: () => void }): TemplateResult {
  const { rerender } = ctx;

  const onLogoChange = async (e: Event) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) {
      return;
    }
    if (!/\.(svg|png|jpe?g|webp|gif|ico)$/i.test(file.name)) {
      _logoError = "Use an SVG, PNG, JPEG, WebP, GIF, or ICO image";
      _logo = null;
      rerender();
      return;
    }
    _logoError = "";
    _logo = { base64: await fileToBase64(file), name: file.name };
    rerender();
  };

  const setRow = (index: number, field: "name" | "value") => (e: Event) => {
    const row = _mediaRows[index];
    if (row) {
      row[field] = (e.target as HTMLInputElement).value;
    }
  };

  return html`
    <div class="new-project-design-section">
      <div class="new-project-design-heading">Colors</div>
      ${colorRow("Accent", _accent, (v) => (_accent = v), rerender)}
      ${colorRow("Background", _background, (v) => (_background = v), rerender)}
      ${colorRow("Text", _text, (v) => (_text = v), rerender)}
    </div>

    <div class="new-project-design-section">
      <div class="new-project-design-heading">Fonts</div>
      <label class="new-project-field">
        <span class="new-project-label">Body Font</span>
        <sp-textfield
          placeholder="Keep default (e.g. 'Inter', system-ui, sans-serif)"
          .value=${_bodyFont}
          @input=${(e: Event) => (_bodyFont = (e.target as HTMLInputElement).value)}
          style="width: 100%"
        ></sp-textfield>
      </label>
      <label class="new-project-field">
        <span class="new-project-label">Heading Font</span>
        <sp-textfield
          placeholder="Keep default"
          .value=${_headingFont}
          @input=${(e: Event) => (_headingFont = (e.target as HTMLInputElement).value)}
          style="width: 100%"
        ></sp-textfield>
      </label>
    </div>

    <div class="new-project-design-section">
      <div class="new-project-design-heading">Logo</div>
      <div class="new-project-logo-row">
        <input type="file" accept=".svg,.png,.jpg,.jpeg,.webp,.gif,.ico" @change=${onLogoChange} />
        ${
          _logo
            ? html`
                <span class="new-project-logo-name">
                  ${_logo.name} → public/${_logo.name}
                  <sp-action-button
                    quiet
                    size="s"
                    title="Remove logo"
                    @click=${() => {
                      _logo = null;
                      rerender();
                    }}
                  >
                    ✕
                  </sp-action-button>
                </span>
              `
            : html`<span class="new-project-tab-intro"
                >Copied into the project's public/ folder.</span
              >`
        }
      </div>
      ${_logoError ? html`<div class="new-project-error">${_logoError}</div>` : ""}
    </div>

    <div class="new-project-design-section">
      <div class="new-project-design-heading">Breakpoints</div>
      ${
        _mediaRows.length === 0 && _mediaNote
          ? html`<div class="new-project-tab-intro">${_mediaNote}</div>`
          : ""
      }
      ${_mediaRows.map(
        (row, index) => html`
          <div class="new-project-media-row">
            <sp-textfield
              class="new-project-media-name"
              placeholder="--md"
              .value=${row.name}
              @input=${setRow(index, "name")}
            ></sp-textfield>
            <sp-textfield
              class="new-project-media-value"
              placeholder="(max-width: 768px)"
              .value=${row.value}
              @input=${setRow(index, "value")}
            ></sp-textfield>
            <sp-action-button
              quiet
              size="s"
              title="Remove breakpoint"
              @click=${() => {
                _mediaRows.splice(index, 1);
                rerender();
              }}
            >
              ✕
            </sp-action-button>
          </div>
        `,
      )}
      <sp-button
        variant="secondary"
        size="s"
        @click=${() => {
          _mediaRows.push({ name: "", value: "" });
          rerender();
        }}
      >
        Add Breakpoint
      </sp-button>
    </div>
  `;
}
