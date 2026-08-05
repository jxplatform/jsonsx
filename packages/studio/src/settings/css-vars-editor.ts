/// <reference lib="dom" />
/**
 * The design-token editor — the token half of **Project Styles** (plan §9.4).
 *
 * Every token in the project's root `style` block, grouped by what it names, each editable in place
 * and each able to carry a different value in any **rendering context** the project declares. The
 * model — groups, tokens, contexts, overrides — lives in {@link file://../style/project-styles.ts}
 * so the catalogue, the canvas and this form all read the same vocabulary; this module is the form
 * over it.
 *
 * Three things it does NOT do, each on purpose:
 *
 * - **It does not define a context.** Breakpoints and colour schemes are declared once, in Project
 *   Settings › Contexts, and this level only overrides against them (§2 principle 5). Where nothing
 *   is declared it says so and routes there.
 * - **It does not change the file format.** Overrides are the same `"@--ctx": { "--token": … }`
 *   blocks the compiler already reads, and an emptied block is removed rather than left behind.
 * - **It does not re-render the canvas.** An edit is pushed to every live canvas in place through
 *   {@link pushProjectStylesToCanvas} — which is what makes "tune a token and watch the page
 *   change" true of the specimen canvas as well as the page one.
 */

import { html, render as litRender, nothing } from "lit-html";
import { ref } from "lit-html/directives/ref.js";
import { classMap } from "lit-html/directives/class-map.js";
import { errorMessage } from "@jxsuite/schema/parse";
import { notify } from "../services/notify";
import { projectState } from "../store";
import { getEffectiveMedia, updateSiteConfig } from "../site-context";
import {
  addableContexts,
  groupTokens,
  listTokenContexts,
  readTokenOverride,
  writeTokenOverride,
} from "../style/project-styles";
import { renderTokenChip, resolveTokenValue, tokenRefName } from "../style/token-ref";
import { pushProjectStylesToCanvas } from "../style/live-preview";
import { friendlyNameToVar } from "../utils/studio-utils";

import type { JxStyle } from "@jxsuite/schema/types";
import type { ProjectToken, TokenContext, TokenGroup, TokenGroupId } from "../style/project-styles";
import type { TemplateResult } from "lit-html";

/**
 * What each group's add row hints with — an example friendly name and an example value. These are
 * the form's illustrations, not the model's data: they teach the shape of an answer and are never
 * written anywhere.
 */
const ADD_ROW_HINTS: Readonly<Record<TokenGroupId, { name: string; value: string }>> = {
  color: { name: "Primary Blue", value: "#3b82f6" },
  font: { name: "Body Serif", value: "'Georgia', serif" },
  other: { name: "Custom Var", value: "value" },
  size: { name: "Spacing Large", value: "32px" },
};

/** The colour a `<input type="color">` shows when the token's value is not a hex literal. */
const COLOR_INPUT_FALLBACK = "#3b82f6";

/** The same, for an override row: a scheme override is usually a darker value than the base. */
const OVERRIDE_INPUT_FALLBACK = "#111111";

/** What one token row needs from the surrounding form — bound once per render, not per row. */
interface TokenFormCtx {
  /** The project's root style, mutated in place and persisted through {@link updateSiteConfig}. */
  rootStyle: JxStyle;
  /** Every declared rendering context, schemes first ({@link listTokenContexts}). */
  contexts: TokenContext[];
  /** Commit the current style without re-rendering the form. */
  save: () => void;
  /** Commit and re-render — for anything that changes which rows exist. */
  commit: () => void;
}

/**
 * Render the token editor into a container.
 *
 * @param {HTMLElement} container
 */
export function renderCssVarsEditor(container: HTMLElement) {
  const config = projectState?.projectConfig || {};
  const rootStyle = (config.style || {}) as JxStyle;
  const contexts = listTokenContexts(getEffectiveMedia(config.$media));
  const hasScheme = contexts.some((c) => c.kind === "scheme");

  const save = () => {
    void updateSiteConfig({ style: { ...rootStyle } });
    pushProjectStylesToCanvas();
  };

  const commit = () => {
    save();
    renderCssVarsEditor(container);
  };

  const ctx: TokenFormCtx = { commit, contexts, rootStyle, save };

  const addVar = (prefix: string, friendlyName: string, val: string) => {
    const varName = friendlyNameToVar(friendlyName, prefix);
    if (!varName || !val) {
      return;
    }
    rootStyle[varName] = val;
    commit();
  };

  /*
   * Without a declared scheme query there is nothing to override, so this section can only point at
   * the place a scheme is DEFINED. It used to define one itself — a button here appended
   * `'--dark': '(prefers-color-scheme: dark)'` to `$media` without ever using the word breakpoint,
   * which made this form the fourth and least discoverable definition site for a map whose other
   * three lived in the wizard, Overview and Properties › Media. The lazy import breaks the
   * css-vars-editor ↔ section-registry cycle.
   */
  const manageContexts = () => {
    void import("./section-registry")
      .then(({ setSettingsSection }) => setSettingsSection("contexts"))
      .catch((error: unknown) => {
        notify.error(`Could not open Settings › Contexts — ${errorMessage(error)}`, {
          source: "Settings",
        });
      });
  };

  const tpl = html`
    <div class="settings-section">
      <h3 class="settings-section-title">CSS Variables</h3>
      ${groupTokens(rootStyle).map(({ group, tokens }) =>
        group.id === "other" && tokens.length === 0
          ? nothing
          : renderGroup(group, tokens, ctx, hasScheme, addVar, manageContexts),
      )}
    </div>
  `;

  litRender(tpl, container);
}

/**
 * One group: its heading, its token rows, its add row, and — for Colors with no scheme declared —
 * the sentence that says where a scheme comes from.
 *
 * @param {TokenGroup} group
 * @param {ProjectToken[]} tokens
 * @param {TokenFormCtx} ctx
 * @param {boolean} hasScheme
 * @param {(prefix: string, friendlyName: string, val: string) => void} addVar
 * @param {() => void} manageContexts
 */
function renderGroup(
  group: TokenGroup,
  tokens: ProjectToken[],
  ctx: TokenFormCtx,
  hasScheme: boolean,
  addVar: (prefix: string, friendlyName: string, val: string) => void,
  manageContexts: () => void,
): TemplateResult {
  return html`
    <div class="css-vars-group">
      <h4 class="css-vars-group-title">${group.title}</h4>
      ${tokens.map((token) => renderTokenRow(token, group, ctx))} ${renderAddRow(group, addVar)}
      ${
        group.id === "color" && !hasScheme
          ? html`
              <p class="settings-field-desc">
                No colour scheme is defined yet, so these tokens have one value each.
                <sp-action-button
                  size="s"
                  quiet
                  title="Define a colour scheme in Project Settings › Contexts"
                  @click=${manageContexts}
                >
                  Manage contexts…
                </sp-action-button>
              </p>
            `
          : nothing
      }
    </div>
  `;
}

/**
 * One token: its swatch (colours only), its name, its value field, the chip it wears when that
 * value follows another token, its delete button — then its font preview and its overrides.
 *
 * @param {ProjectToken} token
 * @param {TokenGroup} group
 * @param {TokenFormCtx} ctx
 */
function renderTokenRow(token: ProjectToken, group: TokenGroup, ctx: TokenFormCtx): TemplateResult {
  const { rootStyle } = ctx;
  const isColor = group.id === "color";
  const refName = tokenRefName(token.value);
  const resolved = resolveTokenValue(rootStyle, token.value);

  const updateVar = (val: string) => {
    rootStyle[token.name] = val;
    ctx.save();
  };
  const deleteVar = () => {
    delete rootStyle[token.name];
    ctx.commit();
  };

  return html`
    <div class="css-var-row">
      ${isColor ? renderSwatch(resolved, COLOR_INPUT_FALLBACK, updateVar) : nothing}
      <span class="css-var-name">${token.label}</span>
      <sp-textfield
        size="s"
        .value=${String(token.value)}
        @change=${(e: Event) => updateVar((e.target as HTMLInputElement).value)}
        style=${valueFieldStyle(group)}
      ></sp-textfield>
      ${refName ? renderTokenChip(refName, resolved, { swatch: isColor }) : nothing}
      <sp-action-button quiet size="s" title="Delete ${token.label}" @click=${deleteVar}>
        <sp-icon-delete slot="icon"></sp-icon-delete>
      </sp-action-button>
    </div>
    ${
      group.id === "font"
        ? html`<div class="css-var-font-preview" style="font-family:${String(token.value)}">
            The quick brown fox jumps over the lazy dog
          </div>`
        : nothing
    }
    ${renderOverrides(token, group, ctx)}
  `;
}

/**
 * How wide the value field is — colours and sizes are short values beside a swatch or a unit, fonts
 * and free-form tokens are long ones. The predecessor said the same thing four times.
 *
 * @param {TokenGroup} group
 */
function valueFieldStyle(group: TokenGroup): string {
  if (group.id === "color") {
    return "flex:1;max-width:160px";
  }
  if (group.id === "size") {
    return "max-width:120px";
  }
  return "flex:1";
}

/**
 * The colour well: a background showing the value the token RESOLVES to (so an alias token is not a
 * blank square) over a native colour input.
 *
 * @param {string | number | undefined} resolved
 * @param {string} fallback — what the native input shows when the value is not a hex literal
 * @param {(val: string) => void} onInput
 */
function renderSwatch(
  resolved: string | number | undefined,
  fallback: string,
  onInput: (val: string) => void,
): TemplateResult {
  const shown = resolved === undefined ? "transparent" : String(resolved);
  return html`
    <div class="css-var-swatch" style="background:${shown}">
      <input
        type="color"
        .value=${shown.startsWith("#") ? shown : fallback}
        @input=${(e: Event) => onInput((e.target as HTMLInputElement).value)}
      />
    </div>
  `;
}

/**
 * A token's per-context values: one row per context it is overridden in, plus — for a colour, once
 * a scheme exists — a row per scheme whether or not it carries a value, because "what is this
 * colour in dark mode" is a question a palette is always answering. Then the add affordance.
 *
 * The add affordance is the change. Before it, a row appeared only for a token that already had an
 * `@media` block, so the first override for any token could only be written by hand in
 * `project.json` — the form could edit an override it could not create.
 *
 * @param {ProjectToken} token
 * @param {TokenGroup} group
 * @param {TokenFormCtx} ctx
 */
function renderOverrides(
  token: ProjectToken,
  group: TokenGroup,
  ctx: TokenFormCtx,
): TemplateResult | typeof nothing {
  const { contexts, rootStyle } = ctx;
  const isColor = group.id === "color";
  const shown = contexts.filter(
    (context) =>
      (isColor && context.kind === "scheme") ||
      readTokenOverride(rootStyle, context, token.name) !== undefined,
  );
  /*
   * A token with no value has nothing to give a context, so the picker is not offered rather than
   * offered and silently inert — writing an empty override is how one is CLEARED.
   */
  const addable =
    String(token.value) === "" ? [] : addableContexts(rootStyle, contexts, token.name, shown);

  if (shown.length === 0 && addable.length === 0) {
    return nothing;
  }

  const setOverride = (context: TokenContext, val: string) => {
    writeTokenOverride(rootStyle, context, token.name, val);
    ctx.commit();
  };

  return html`
    <div class="css-var-media-overrides">
      ${shown.map((context) => renderOverrideRow(token, context, isColor, rootStyle, setOverride))}
      ${
        addable.length === 0
          ? nothing
          : html`
              <div class="css-var-override-add">
                <sp-picker
                  size="s"
                  quiet
                  label="Add override"
                  placeholder="Add override…"
                  title="Give ${token.label} a different value in one rendering context"
                  @change=${(e: Event) => {
                    const name = (e.target as HTMLInputElement).value;
                    const context = addable.find((c) => c.name === name);
                    if (context) {
                      setOverride(context, String(token.value));
                    }
                  }}
                >
                  ${addable.map(
                    (context) =>
                      html`<sp-menu-item value=${context.name}>${context.label}</sp-menu-item>`,
                  )}
                </sp-picker>
              </div>
            `
      }
    </div>
  `;
}

/**
 * One override row. Empty means "inherits the base value", and clearing a row removes the override
 * (and the block, once it empties) — one write path for a scheme and a breakpoint alike.
 *
 * @param {ProjectToken} token
 * @param {TokenContext} context
 * @param {boolean} isColor
 * @param {JxStyle} rootStyle
 * @param {(context: TokenContext, val: string) => void} setOverride
 */
function renderOverrideRow(
  token: ProjectToken,
  context: TokenContext,
  isColor: boolean,
  rootStyle: JxStyle,
  setOverride: (context: TokenContext, val: string) => void,
): TemplateResult {
  const current = readTokenOverride(rootStyle, context, token.name);
  return html`
    <div
      class=${classMap({
        "css-var-media-row": true,
        "css-var-scheme-row": context.kind === "scheme",
      })}
    >
      <span class="css-var-media-label">${context.label}</span>
      ${
        isColor
          ? renderSwatch(resolveTokenValue(rootStyle, current), OVERRIDE_INPUT_FALLBACK, (val) =>
              setOverride(context, val),
            )
          : nothing
      }
      <sp-textfield
        size="s"
        placeholder="inherits"
        .value=${current === undefined ? "" : String(current)}
        @change=${(e: Event) => setOverride(context, (e.target as HTMLInputElement).value)}
        style=${isColor ? "flex:1;max-width:160px" : "max-width:120px"}
      ></sp-textfield>
    </div>
  `;
}

/**
 * The group's "add a token" row: a friendly name, a value, and the button that slugs the one into a
 * variable name under the group's prefix.
 *
 * @param {TokenGroup} group
 * @param {(prefix: string, friendlyName: string, val: string) => void} addVar
 */
function renderAddRow(
  group: TokenGroup,
  addVar: (prefix: string, friendlyName: string, val: string) => void,
): TemplateResult {
  let nameEl: HTMLInputElement | null = null;
  let valEl: HTMLInputElement | null = null;
  const hint = ADD_ROW_HINTS[group.id];

  return html`
    <div class="css-var-add-row">
      <sp-textfield
        size="s"
        placeholder=${hint.name}
        ${ref((el) => {
          if (el) {
            nameEl = el as HTMLInputElement;
          }
        })}
      ></sp-textfield>
      <sp-textfield
        size="s"
        placeholder=${hint.value}
        ${ref((el) => {
          if (el) {
            valEl = el as HTMLInputElement;
          }
        })}
      ></sp-textfield>
      <sp-action-button
        size="s"
        @click=${() => {
          if (nameEl && valEl) {
            addVar(group.prefix, nameEl.value, valEl.value);
          }
        }}
        >Add</sp-action-button
      >
    </div>
  `;
}
