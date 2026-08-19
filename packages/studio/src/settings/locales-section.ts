/// <reference lib="dom" />
/**
 * Locales — the project's languages, its default, and how a locale appears in a URL.
 *
 * `project.json`'s `i18n` block was authorable only by hand: every other i18n surface in Studio
 * (the parity panel, the pane's locale companion, the translation verbs) reads a locale list
 * nothing in the app could write, so a project became multilingual in a text editor and only then
 * grew any of the affordances that make it worth being.
 *
 * **One write, two doors.** {@link addProjectLocale} is the whole of "declare a language" and the
 * `i18n.addLocale` command calls this function rather than repeating the patch — a second spelling
 * of the same merge is how the command and the form would come to disagree about what happens to
 * `defaultLocale` when the first locale is added.
 *
 * @docs studio/projects/settings
 */

import { html, render as litRender, nothing } from "lit-html";
import { canonicalizeLocale, isWellFormedLocale, localeLabel } from "@jxsuite/schema/locale";
import { errorMessage } from "@jxsuite/schema/parse";
import { notify } from "../services/notify";
import { projectState } from "../store";
import { updateSiteConfig } from "../site-context";
import type { LocaleRouting } from "@jxsuite/schema/locale";
import type { ProjectConfig } from "@jxsuite/schema/types";

/**
 * The last failed write per rendered section container.
 *
 * Keyed by container so two mounted copies (and two tests) never share a message — the same shape
 * `project-sections.ts` and `general-settings.ts` use, and for the same reason: these sections save
 * on change, so a silent rejection would read as "my edit just vanished".
 */
const errors = new WeakMap<HTMLElement, string>();

/** Drop a parked error and re-render. */
function clearError(container: HTMLElement): void {
  errors.delete(container);
}

/** The error line for a section, if its last write failed. */
function errorLine(container: HTMLElement) {
  const message = errors.get(container);
  return message === undefined
    ? nothing
    : html`<p class="settings-field-error" role="alert">${message}</p>`;
}

/**
 * Persist a patch, surfacing the rejection instead of swallowing it.
 *
 * `updateSiteConfig` rejects on a failed write and the chokepoint has already filed the Problem, so
 * all that is left here is to keep the form honest about what is on disk. A bare `void
 * updateSiteConfig(...)` would drop the rejection and the field would silently snap back to the
 * value the file still holds.
 *
 * @param {HTMLElement} container
 * @param {Partial<ProjectConfig>} patch
 * @param {() => void} rerender
 */
async function persist(
  container: HTMLElement,
  patch: Partial<ProjectConfig>,
  rerender: () => void,
): Promise<void> {
  try {
    await updateSiteConfig(patch);
    clearError(container);
  } catch (error) {
    errors.set(container, `Could not save project.json — ${errorMessage(error)}`);
  }
  rerender();
}

/** The live project configuration, or an empty one before a project is open. */
function config(): ProjectConfig {
  return (projectState?.projectConfig ?? {}) as ProjectConfig;
}

/**
 * The patch that removes the whole `i18n` block.
 *
 * `undefined` survives the object spread inside `updateSiteConfig` and `JSON.stringify` then drops
 * the key, so removing the last locale leaves a project with no `i18n` at all rather than one
 * declaring an empty list — which `resolveI18n` reports as "declared with no usable locale", a
 * build error for a state the author reached by deleting things. The cast is the price of
 * `exactOptionalPropertyTypes`, the same one `general-settings.ts`'s `CLEAR_URL` pays.
 */
const CLEAR_I18N = { i18n: undefined } as unknown as Partial<ProjectConfig>;

/** The routing modes, with the sentence that says what each does to a URL. */
export const LOCALE_ROUTINGS: readonly { value: LocaleRouting; label: string }[] = [
  { label: "Prefix every locale but the default", value: "prefix-except-default" },
  { label: "Prefix every locale", value: "prefix-always" },
];

/**
 * The tags as the author wrote them, not as `resolveI18n` reports them.
 *
 * Reading the resolved list back would rewrite the file on the next save: `resolveI18n` unshifts a
 * `defaultLocale` that is missing from `locales` and canonicalizes the case of every entry, so a
 * patch built from it edits lines the author did not touch.
 */
function declaredLocales(): string[] {
  const raw = config().i18n?.locales;
  return Array.isArray(raw) ? raw.filter((tag): tag is string => typeof tag === "string") : [];
}

/** Whether `tag` names a language the project already declares, whatever case it was written in. */
function alreadyDeclared(tag: string): boolean {
  const canonical = canonicalizeLocale(tag);
  return declaredLocales().some((declared) => canonicalizeLocale(declared) === canonical);
}

/**
 * Add one tag to `i18n.locales` — the one write both this section and `i18n.addLocale` make.
 *
 * The patch spreads `config().i18n` because `commitProjectConfig` merges at the TOP LEVEL only: `{
 * i18n: { locales } }` replaces the block wholesale and takes `defaultLocale` and `routing` with
 * it, so a project that declared a default would silently lose it the first time a language was
 * added.
 *
 * Refusals are notified rather than thrown: the palette reports a rejected `run` to the console and
 * nowhere else, so a thrown refusal is one the author never sees. The form disables Add for both of
 * them before it gets here, with the reason under the field.
 *
 * @param {string} tag - A BCP 47 language tag, in any case.
 * @throws {Error} Whatever `updateSiteConfig` rejects with — the caller decides where a failed
 *   write shows.
 */
export async function addProjectLocale(tag: string): Promise<void> {
  const canonical = canonicalizeLocale(tag);
  if (canonical === null) {
    notify.error(`"${tag}" is not a well-formed language tag.`, {
      detail:
        "Languages are BCP 47 tags — a language, optionally a script and a region: `fr`, " +
        "`pt-BR`, `zh-Hant`. Underscores and spaces are not part of the grammar.",
      source: "Languages",
    });
    return;
  }
  if (alreadyDeclared(canonical)) {
    notify.info(`${localeLabel(canonical)} is already one of this project's languages.`, {
      source: "Languages",
    });
    return;
  }
  await updateSiteConfig({
    i18n: { ...config().i18n, locales: [...declaredLocales(), canonical] },
  });
}

/** Pending tag per container, so typing survives the section re-rendering. */
const pendingTag = new WeakMap<HTMLElement, string>();

/**
 * Why the pending tag cannot be added, or `""` when it can.
 *
 * Both refusals are stated while the author is typing rather than after the Add: a language tag is
 * the one field in this section whose value the author cannot check by looking at it, and "nothing
 * happened" is what a silently refused Add looks like.
 */
function pendingRefusal(container: HTMLElement): string {
  const tag = (pendingTag.get(container) ?? "").trim();
  if (tag === "") {
    return "";
  }
  if (!isWellFormedLocale(tag)) {
    return `"${tag}" is not a well-formed language tag. Try \`fr\`, \`pt-BR\` or \`zh-Hant\`.`;
  }
  return alreadyDeclared(tag) ? `${localeLabel(tag)} is already declared.` : "";
}

/**
 * The project's languages, its default, and how a locale is spelled in a URL.
 *
 * Every handler re-reads `config()` instead of closing over the render's values: `projectState` is
 * a plain module binding replaced wholesale on a project switch, and an extension or the raw JSON
 * editor can write `i18n` between this render and the click that follows it.
 *
 * @param {HTMLElement} container
 */
export function renderLocalesSection(container: HTMLElement): void {
  const rerender = () => renderLocalesSection(container);
  const locales = declaredLocales();
  const { i18n } = config();
  const pending = pendingTag.get(container) ?? "";
  const refusal = pendingRefusal(container);

  const add = () => {
    const tag = (pendingTag.get(container) ?? "").trim();
    if (tag === "" || pendingRefusal(container) !== "") {
      return;
    }
    pendingTag.delete(container);
    void persist(
      container,
      { i18n: { ...config().i18n, locales: [...declaredLocales(), canonicalizeLocale(tag)!] } },
      rerender,
    );
  };

  const remove = (tag: string) => {
    const kept = declaredLocales().filter((declared) => declared !== tag);
    if (kept.length === 0) {
      /* The last language leaves with the block. An `i18n` holding an empty `locales` is a build
         error (`resolveI18n`: "declared with no usable locale"), so removing the last row would
         otherwise break the build of a project that is once again ordinary and monolingual. */
      void persist(container, CLEAR_I18N, rerender);
      return;
    }
    const current = config().i18n;
    /* A `defaultLocale` naming a locale that is no longer declared does not go away — `resolveI18n`
       puts it BACK at the head of the list, so deleting the default row without this would delete
       nothing and reorder the rest. */
    const orphaned =
      current?.defaultLocale !== undefined &&
      canonicalizeLocale(current.defaultLocale) === canonicalizeLocale(tag);
    void persist(
      container,
      { i18n: { ...current, ...(orphaned ? { defaultLocale: kept[0]! } : {}), locales: kept } },
      rerender,
    );
  };

  const onDefaultChange = (e: Event) => {
    void persist(
      container,
      { i18n: { ...config().i18n, defaultLocale: (e.target as HTMLInputElement).value } },
      rerender,
    );
  };

  const onRoutingChange = (e: Event) => {
    void persist(
      container,
      {
        i18n: {
          ...config().i18n,
          routing: (e.target as HTMLInputElement).value as LocaleRouting,
        },
      },
      rerender,
    );
  };

  const tpl = html`
    <div class="settings-section">
      <h3 class="settings-section-title">Locales</h3>
      <p class="settings-field-desc">
        The languages this site is written in. A translation is a file under the locale's directory
        — pages/fr/about.json beside pages/about.json — so declaring a language here is what makes
        that directory mean something to the build and to Studio.
      </p>
      ${errorLine(container)}
      <div class="settings-field">
        <label class="settings-field-label">Languages</label>
        <div class="settings-list-panel">
          ${
            locales.length === 0
              ? html`<div class="settings-empty-state">No languages declared.</div>`
              : locales.map(
                  (tag) => html`
                    <div class="settings-row">
                      <span class="settings-row-name">${localeLabel(tag)}</span>
                      <span class="settings-locale-tag">${tag}</span>
                      <sp-action-button
                        size="xs"
                        quiet
                        title=${`Remove ${tag}`}
                        @click=${() => remove(tag)}
                      >
                        <sp-icon-delete slot="icon"></sp-icon-delete>
                      </sp-action-button>
                    </div>
                  `,
                )
          }
          <div class="settings-inline-form">
            <sp-textfield
              size="s"
              class="settings-locale-name"
              placeholder="fr-CA"
              .value=${pending}
              @input=${(e: Event) => {
                const before = pendingRefusal(container);
                pendingTag.set(container, (e.target as HTMLInputElement).value);
                /* Re-render only when the VERDICT changes, not per keystroke: redrawing on every
                   character would push `.value` back into a field the author is typing in, and
                   never redrawing would leave the refusal below it describing an older tag. */
                if (pendingRefusal(container) !== before) {
                  rerender();
                }
              }}
              @keydown=${(e: KeyboardEvent) => {
                if (e.key === "Enter") {
                  add();
                }
              }}
            ></sp-textfield>
            <sp-action-button size="s" @click=${add}>Add</sp-action-button>
          </div>
        </div>
        ${refusal === "" ? nothing : html`<p class="settings-field-error">${refusal}</p>`}
      </div>
      <div class="settings-field">
        <label class="settings-field-label">Default Language</label>
        <p class="settings-field-desc">
          The language a page is written in when its file carries no locale directory.
        </p>
        <sp-picker
          size="s"
          label="Default Language"
          class="settings-default-locale"
          .value=${i18n?.defaultLocale ?? locales[0] ?? ""}
          ?disabled=${locales.length === 0}
          @change=${onDefaultChange}
        >
          ${locales.map(
            (tag) => html`<sp-menu-item value=${tag}>${localeLabel(tag)}</sp-menu-item>`,
          )}
        </sp-picker>
      </div>
      <div class="settings-field">
        <label class="settings-field-label">URL Routing</label>
        <p class="settings-field-desc">
          Whether the default language owns the unprefixed URLs, or every language is named in its
          own.
        </p>
        <sp-picker
          size="s"
          label="URL Routing"
          class="settings-locale-routing"
          .value=${i18n?.routing ?? "prefix-except-default"}
          ?disabled=${locales.length === 0}
          @change=${onRoutingChange}
        >
          ${LOCALE_ROUTINGS.map(
            (routing) => html`<sp-menu-item value=${routing.value}>${routing.label}</sp-menu-item>`,
          )}
        </sp-picker>
      </div>
    </div>
  `;

  litRender(tpl, container);
}
