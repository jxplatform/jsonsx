/** General settings section — favicon, platform adapter, breakpoints, and other site-wide config. */

import { html, render as litRender, nothing } from "lit-html";
import { projectState } from "../store.js";
import { updateSiteConfig } from "../site-context.js";
import { getPlatform } from "../platform.js";
import { openFileInTab } from "../files/files.js";
import { closeSettingsModal } from "./settings-modal.js";

/** @param {HTMLElement} container */
export function renderGeneralSettings(container) {
  const config = /** @type {ProjectConfig} */ (projectState?.projectConfig || {});

  const onFaviconUpload = async () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*,.ico,.svg";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const platform = getPlatform();
      await platform.uploadFile("public/favicon.ico", file);
      await updateSiteConfig({ favicon: "/favicon.ico" });
      renderGeneralSettings(container);
    };
    input.click();
  };

  const onAdapterChange = (/** @type {Event & { target: { value: string } }} */ e) => {
    updateSiteConfig({ build: { ...config.build, adapter: e.target.value } });
  };

  const onEditGlobalStyles = () => {
    closeSettingsModal();
    openFileInTab("project.json");
  };

  // ─── Breakpoints ($media) ───────────────────────────────────────────────────

  const media = /** @type {Record<string, string>} */ (config.$media || {});
  const mediaEntries = Object.entries(media);

  const onMediaValueChange =
    (/** @type {string} */ key) => (/** @type {Event & { target: { value: string } }} */ e) => {
      const updated = { ...media, [key]: e.target.value };
      updateSiteConfig({ $media: updated });
    };

  const onMediaNameChange =
    (/** @type {string} */ oldKey) => (/** @type {Event & { target: { value: string } }} */ e) => {
      const rawName = e.target.value.trim();
      const newKey = rawName.startsWith("--") ? rawName : `--${rawName}`;
      if (newKey === oldKey) return;
      const updated = /** @type {Record<string, string>} */ ({});
      for (const [k, v] of Object.entries(media)) {
        updated[k === oldKey ? newKey : k] = v;
      }
      updateSiteConfig({ $media: updated });
      renderGeneralSettings(container);
    };

  const onRemoveBreakpoint = (/** @type {string} */ key) => () => {
    const updated = { ...media };
    delete updated[key];
    updateSiteConfig({ $media: updated });
    renderGeneralSettings(container);
  };

  const onAddBreakpoint = () => {
    const updated = { ...media, "--new": "(max-width: 480px)" };
    updateSiteConfig({ $media: updated });
    renderGeneralSettings(container);
  };

  const currentFavicon = config.favicon;

  const tpl = html`
    <div class="settings-section">
      <h3 class="settings-section-title">General</h3>

      <div class="settings-field">
        <label class="settings-field-label">Favicon</label>
        <p class="settings-field-desc">Upload an image to use as the site favicon.</p>
        <div style="display:flex;align-items:center;gap:12px">
          ${currentFavicon
            ? html`<img
                src=${currentFavicon}
                alt="Current favicon"
                style="width:32px;height:32px;object-fit:contain;border:1px solid var(--border);border-radius:4px;padding:2px"
              />`
            : html`<div
                style="width:32px;height:32px;border:1px dashed var(--border);border-radius:4px;display:flex;align-items:center;justify-content:center;color:var(--fg-dim);font-size:11px"
              >
                —
              </div>`}
          <sp-action-button size="s" @click=${onFaviconUpload}> Upload Favicon </sp-action-button>
          ${currentFavicon
            ? html`<span style="font-size:11px;color:var(--fg-dim)">${currentFavicon}</span>`
            : nothing}
        </div>
      </div>

      <div class="settings-field">
        <label class="settings-field-label">Platform Adapter</label>
        <p class="settings-field-desc">Build adapter for deployment target.</p>
        <sp-picker
          size="s"
          label="Platform Adapter"
          .value=${config.build?.adapter || "static"}
          @change=${onAdapterChange}
        >
          <sp-menu-item value="static">Static</sp-menu-item>
          <sp-menu-item value="bun">Bun</sp-menu-item>
          <sp-menu-item value="node">Node</sp-menu-item>
          <sp-menu-item value="cloudflare-workers">Cloudflare Workers</sp-menu-item>
          <sp-menu-item value="cloudflare-pages">Cloudflare Pages</sp-menu-item>
        </sp-picker>
      </div>

      <div class="settings-field">
        <label class="settings-field-label">Breakpoints</label>
        <p class="settings-field-desc">
          Responsive breakpoints for canvas panels and media query styles.
        </p>
        <div class="settings-media-list">
          ${mediaEntries.map(([key, value]) => {
            const isBase = key === "--";
            return html`
              <div class="settings-media-row">
                ${isBase
                  ? html`<span class="settings-media-name-fixed">Base</span>`
                  : html`<sp-textfield
                      size="s"
                      class="settings-media-name"
                      .value=${key.replace(/^--/, "")}
                      placeholder="name"
                      @change=${onMediaNameChange(key)}
                    ></sp-textfield>`}
                <sp-textfield
                  size="s"
                  class="settings-media-value"
                  .value=${value}
                  placeholder=${isBase ? "1280px" : "(max-width: 768px)"}
                  @change=${onMediaValueChange(key)}
                ></sp-textfield>
                ${isBase
                  ? nothing
                  : html`<sp-action-button
                      size="s"
                      quiet
                      title="Remove breakpoint"
                      @click=${onRemoveBreakpoint(key)}
                    >
                      ×
                    </sp-action-button>`}
              </div>
            `;
          })}
        </div>
        <sp-action-button size="s" style="margin-top:8px" @click=${onAddBreakpoint}>
          + Add Breakpoint
        </sp-action-button>
      </div>

      <div class="settings-field">
        <label class="settings-field-label">Global Styles</label>
        <p class="settings-field-desc">Edit default element styles that apply across all pages.</p>
        <sp-action-button size="s" @click=${onEditGlobalStyles}>
          Edit Global Styles
        </sp-action-button>
      </div>
    </div>
  `;

  litRender(tpl, container);
}
