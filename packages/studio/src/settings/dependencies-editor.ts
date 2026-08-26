/// <reference lib="dom" />
/**
 * Dependencies settings section — a registry-aware table of the project's npm dependencies. Shows
 * current vs latest version, with per-row update/remove, an add-package field, "update all", and
 * reinstall.
 *
 * **Every row's Latest is that package's own newest version on npm.** Two assumptions used to sit
 * between this table and the registry, and both are gone:
 *
 * 1. `@jxsuite/*` rows targeted `VERSION`, the version this Studio build embeds — right only while the
 *    whole suite released as one number. The packages release on their own cadences now, so that
 *    proposed a version that may never have been published, for a package whose real latest the
 *    table had not looked at. The same correction `packages/jxsuite-update.ts` already made.
 * 2. The backend was asked for _outdated_ packages, so a package already at its latest arrived as an
 *    absence and the column read `—` — the registry's answer was known and thrown away. It now asks
 *    `platform.packageVersions()`, which reports every dependency's latest either way, and the
 *    comparison that decides whether an update button appears happens here.
 *
 * A row shows `—` only where there is genuinely nothing to show: a `workspace:`/`file:`/git spec, a
 * package the registry does not answer for, or a host with no registry lookup at all.
 */

import { html, render as litRender } from "lit-html";
import { getPlatform } from "../platform";
import { notify } from "../services/notify";
import { showProgressModal } from "../ui/progress-modal";
import { isUpgrade, stripRange } from "../packages/semver";
import type { PackageInfo } from "../types";

interface Update {
  name: string;
  version: string;
  dev: boolean;
}

let _container: HTMLElement | null = null;
let _packages: PackageInfo[] | null = null;
let _latest = new Map<string, string>();
let _busy = false;
let _addName = "";

/** This package's newest published version, or null when the registry did not answer for it. */
function latestFor(p: PackageInfo): string | null {
  return _latest.get(p.name) ?? null;
}

/**
 * The version a package can be updated TO, or null when it is current or ahead.
 *
 * `isUpgrade`, not "differs from latest": a project deliberately pinned ahead of the registry — a
 * prerelease, or a range bumped before the publish landed — would otherwise be offered a downgrade
 * with an update button.
 */
function upgradeFor(p: PackageInfo): string | null {
  const latest = latestFor(p);
  return latest && isUpgrade(p.version, latest) ? latest : null;
}

async function load() {
  const platform = getPlatform();
  try {
    _packages = await platform.listPackages();
  } catch {
    _packages = [];
  }
  _latest = new Map();
  if (platform.packageVersions) {
    try {
      for (const info of await platform.packageVersions()) {
        _latest.set(info.name, info.latest);
      }
    } catch {
      /* Registry lookups are best-effort */
    }
  }
  render();
}

async function withBusy(fn: () => Promise<void>) {
  if (_busy) {
    return;
  }
  _busy = true;
  render();
  const progress = showProgressModal({ status: "Running bun…", title: "Updating dependencies" });
  try {
    await fn();
    progress.done();
  } catch (error) {
    progress.fail(error instanceof Error ? error.message : String(error));
  } finally {
    _busy = false;
    await load();
  }
}

async function onAdd() {
  const name = _addName.trim();
  if (!name) {
    return;
  }
  await withBusy(async () => {
    await getPlatform().addPackage(name);
    _addName = "";
    notify.success(`Added ${name}.`);
  });
}

async function onRemove(p: PackageInfo) {
  await withBusy(async () => {
    await getPlatform().removePackage(p.name);
    notify.success(`Removed ${p.name}.`);
  });
}

async function onUpdate(p: PackageInfo, latest: string) {
  const platform = getPlatform();
  if (!platform.setPackageVersions) {
    return;
  }
  await withBusy(async () => {
    const target = stripRange(latest);
    const res = await platform.setPackageVersions!([
      { dev: Boolean(p.dev), name: p.name, version: `^${target}` },
    ]);
    if (!res.ok) {
      throw new Error(res.log ?? "Update failed");
    }
    notify.success(`Updated ${p.name} to ${target}.`);
  });
}

async function onUpdateAll() {
  const platform = getPlatform();
  if (!platform.setPackageVersions) {
    return;
  }
  const updates = (_packages ?? [])
    .map((p): Update | null => {
      const target = upgradeFor(p);
      return target
        ? { dev: Boolean(p.dev), name: p.name, version: `^${stripRange(target)}` }
        : null;
    })
    .filter((u): u is Update => u !== null);
  if (updates.length === 0) {
    return;
  }
  await withBusy(async () => {
    const res = await platform.setPackageVersions!(updates);
    if (!res.ok) {
      throw new Error(res.log ?? "Update failed");
    }
    notify.success(`Updated ${updates.length} package(s).`);
  });
}

async function onReinstall() {
  const platform = getPlatform();
  if (!platform.installDependencies) {
    return;
  }
  await withBusy(async () => {
    const res = await platform.installDependencies!();
    if (!res.ok) {
      throw new Error(res.log ?? "Install failed");
    }
    notify.success("Dependencies reinstalled.");
  });
}

function row(p: PackageInfo) {
  const latest = latestFor(p);
  const upgrade = upgradeFor(p);
  return html`
    <sp-table-row>
      <sp-table-cell>
        ${p.name}${
          p.dev ? html`<span style="color:var(--fg-dim);font-size:10px"> · dev</span>` : ""
        }
      </sp-table-cell>
      <sp-table-cell>${p.version}</sp-table-cell>
      <sp-table-cell>${latest ?? "—"}</sp-table-cell>
      <sp-table-cell>
        ${
          upgrade
            ? html`<sp-action-button
                size="s"
                quiet
                ?disabled=${_busy}
                title="Update to ${upgrade}"
                @click=${() => onUpdate(p, upgrade)}
              >
                <sp-icon-refresh slot="icon"></sp-icon-refresh>
              </sp-action-button>`
            : ""
        }
        <sp-action-button
          size="s"
          quiet
          ?disabled=${_busy}
          title="Remove"
          @click=${() => onRemove(p)}
        >
          <sp-icon-delete slot="icon"></sp-icon-delete>
        </sp-action-button>
      </sp-table-cell>
    </sp-table-row>
  `;
}

function render() {
  if (!_container) {
    return;
  }
  const pkgs = _packages ?? [];
  const hasUpdates = pkgs.some((p) => upgradeFor(p) !== null);

  const tpl = html`
    <div class="settings-section">
      <h3 class="settings-section-title">Packages</h3>
      <p class="settings-field-desc">Manage this project's npm dependencies.</p>

      <div style="display:flex;gap:8px;margin-bottom:12px;align-items:center">
        <sp-textfield
          size="s"
          placeholder="package-name"
          .value=${_addName}
          ?disabled=${_busy}
          @input=${(e: Event) => {
            _addName = (e.target as HTMLInputElement).value;
          }}
        ></sp-textfield>
        <sp-action-button size="s" ?disabled=${_busy} @click=${onAdd}>
          <sp-icon-add slot="icon"></sp-icon-add>
          Add
        </sp-action-button>
        <span style="flex:1"></span>
        ${
          hasUpdates
            ? html`<sp-action-button size="s" ?disabled=${_busy} @click=${onUpdateAll}>
                Update all
              </sp-action-button>`
            : ""
        }
        <sp-action-button
          size="s"
          quiet
          ?disabled=${_busy}
          title="Reinstall (bun install)"
          @click=${onReinstall}
        >
          <sp-icon-refresh slot="icon"></sp-icon-refresh>
          Reinstall
        </sp-action-button>
      </div>

      ${
        _packages === null
          ? html`<p class="about-muted">Loading…</p>`
          : pkgs.length === 0
            ? html`<p class="about-muted">No dependencies.</p>`
            : html`
                <sp-table size="s">
                  <sp-table-head>
                    <sp-table-head-cell>Package</sp-table-head-cell>
                    <sp-table-head-cell>Current</sp-table-head-cell>
                    <sp-table-head-cell>Latest</sp-table-head-cell>
                    <sp-table-head-cell></sp-table-head-cell>
                  </sp-table-head>
                  <sp-table-body> ${pkgs.map((p) => row(p))} </sp-table-body>
                </sp-table>
              `
      }
    </div>
  `;

  litRender(tpl, _container);
}

/** @param {HTMLElement} container */
export function renderDependenciesEditor(container: HTMLElement) {
  _container = container;
  _packages = null;
  _addName = "";
  render();
  void load();
}
