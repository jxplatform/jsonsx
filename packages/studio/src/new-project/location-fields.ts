/**
 * The destination section of the New Project Parameters step — where the project is written.
 *
 * Two shapes, chosen by the platform's `createDestination` (specs/desktop.md §4.5):
 *
 * - `"path"` (desktop, dev server): a required **Location** (absolute parent directory) plus the
 *   folder name. Desktop backs the Browse… button with the native dialog via `pickDirectory`; the
 *   dev server has no dialog, so the path is typed. Nothing is ever written to a directory the user
 *   did not name.
 * - `"repo"` (cloud): the repository location — owner (personal account or organization), the
 *   repository name, and its visibility.
 *
 * This module owns the destination fields AND the name-derived slug they share, so the field order
 * reads naturally in both shapes (Location → Directory, versus Owner → Repository → Visibility).
 *
 * @docs studio/projects/create
 */

import { html, nothing } from "lit-html";
import { getPlatform } from "../platform";
import type { TemplateResult } from "lit-html";
import type { CreateProjectDestination, RepoInfo } from "../types";

/** Absolute POSIX (`/…`) or Windows (`C:\…` / `C:/…`) path. */
const ABSOLUTE_PATH = /^(?:[a-zA-Z]:[/\\]|\/)/;

let _parent = "";
let _owner = "";
let _private = true;
/** Owner logins offered in the repo-mode picker (empty until loaded / when unavailable). */
let _owners: string[] = [];
/** Repositories already owned, for the name-collision hint. Null until loaded. */
let _repos: RepoInfo[] | null = null;
/** Inline validation error shown under the destination fields. */
let _error = "";
let _browsing = false;

/** Reset the section for a fresh modal pass. */
export function resetLocationFields() {
  _parent = "";
  _owner = "";
  _private = true;
  _owners = [];
  _repos = null;
  _error = "";
  _browsing = false;
}

/**
 * Load the repo-mode owner candidates (and the repo list behind the collision hint) in the
 * background. No-op on `"path"` platforms. Failures are non-fatal — the owner field falls back to
 * free text, exactly as it behaves before the lists arrive.
 */
export function loadLocationOptions(rerender: () => void) {
  const platform = getPlatform();
  if (platform.createDestination !== "repo") {
    return;
  }
  const owners = new Set<string>();
  void Promise.allSettled([
    platform.getAccountStatus?.().then((status) => {
      for (const install of status?.installations ?? []) {
        if (install.account) {
          owners.add(install.account);
        }
      }
    }),
    platform.listRepos?.().then((repos) => {
      _repos = repos;
      for (const repo of repos) {
        owners.add(repo.owner);
      }
    }),
  ]).then(() => {
    _owners = [...owners].toSorted((a, b) => a.localeCompare(b));
    _owner ||= _owners[0] ?? "";
    rerender();
  });
}

/** The label for the shared slug field — it names a folder on disk, or a repository. */
export function slugFieldLabel(): string {
  return getPlatform().createDestination === "repo" ? "Repository" : "Directory";
}

/**
 * The destination to send with createProject, or null when the fields are incomplete/invalid (the
 * reason is then in `locationError()` and rendered inline).
 */
export function collectDestination(slug: string): CreateProjectDestination | null {
  _error = "";
  if (getPlatform().createDestination === "repo") {
    if (!_owner.trim()) {
      _error = "Choose an owner for the repository";
      return null;
    }
    if (!slug.trim()) {
      _error = "Repository name is required";
      return null;
    }
    return { kind: "repo", owner: _owner.trim(), private: _private, repo: slug.trim() };
  }
  const parent = _parent.trim();
  if (!parent) {
    _error = "Choose a location for the project folder";
    return null;
  }
  if (!ABSOLUTE_PATH.test(parent)) {
    _error = "Location must be an absolute path";
    return null;
  }
  if (!slug.trim()) {
    _error = "Directory name is required";
    return null;
  }
  return { kind: "path", parent: trimTrailingSep(parent) };
}

/** The inline validation message from the last `collectDestination`, if any. */
export function locationError(): string {
  return _error;
}

/** Drop trailing separators, but never reduce a filesystem root (`/`, `C:\`) to nothing. */
function trimTrailingSep(parent: string): string {
  const trimmed = parent.replace(/[/\\]+$/, "");
  return trimmed || parent;
}

/**
 * Join a parent directory and a folder name with the parent's own separator, so a Windows path
 * stays a Windows path. Shared by the preview and the resolved destination — the string the user
 * reads must be the string that gets created.
 */
function joinPath(parent: string, name: string): string {
  const sep = parent.includes("\\") && !parent.includes("/") ? "\\" : "/";
  return parent.endsWith("/") || parent.endsWith("\\")
    ? `${parent}${name}`
    : `${parent}${sep}${name}`;
}

/**
 * The destination as the import pipeline names it: `importSite` takes a plain `directory` string
 * rather than a destination object, so the modal flattens one here.
 *
 * Both shapes, because both platforms import now. A `"path"` destination flattens to the absolute
 * folder it writes; a `"repo"` one to `owner/repo`, which is what a backend that commits the
 * emitted project into a git tree can act on — there is no directory for it to name.
 */
export function destinationPath(destination: CreateProjectDestination, slug: string): string {
  if (destination.kind === "repo") {
    return `${destination.owner}/${destination.repo || slug.trim()}`;
  }
  return joinPath(destination.parent, slug.trim());
}

/** The destination the user has chosen so far, rendered for the preview line. */
function previewOf(slug: string): string {
  const name = slug.trim() || "…";
  if (getPlatform().createDestination === "repo") {
    return `${_owner.trim() || "…"}/${name}`;
  }
  const parent = trimTrailingSep(_parent.trim());
  return parent ? joinPath(parent, name) : `…/${name}`;
}

/** True when a repo of this name already exists under the chosen owner. */
function repoExists(slug: string): boolean {
  const full = `${_owner.trim()}/${slug.trim()}`.toLowerCase();
  return (_repos ?? []).some((r) => r.fullName.toLowerCase() === full);
}

function slugFieldTpl(slug: string, onSlugInput: (e: Event) => void): TemplateResult {
  return html`
    <label class="new-project-field">
      <span class="new-project-label">${slugFieldLabel()}</span>
      <sp-textfield
        class="new-project-slug"
        placeholder="my-site"
        .value=${slug}
        @input=${onSlugInput}
        style="width: 100%"
      ></sp-textfield>
    </label>
  `;
}

function pathFieldsTpl(ctx: {
  rerender: () => void;
  slug: string;
  onSlugInput: (e: Event) => void;
}): TemplateResult {
  const platform = getPlatform();

  const browse = async () => {
    if (!platform.pickDirectory || _browsing) {
      return;
    }
    _browsing = true;
    ctx.rerender();
    try {
      const picked = await platform.pickDirectory();
      if (picked) {
        _parent = picked;
        _error = "";
      }
    } finally {
      _browsing = false;
      ctx.rerender();
    }
  };

  return html`
    <label class="new-project-field">
      <span class="new-project-label">Location *</span>
      <div class="new-project-location-row">
        <sp-textfield
          class="new-project-location"
          placeholder=${
            platform.pickDirectory
              ? "Choose a folder to create the project in"
              : "/absolute/path/to/your/projects"
          }
          .value=${_parent}
          @input=${(e: Event) => {
            _parent = (e.target as HTMLInputElement).value;
            _error = "";
            ctx.rerender();
          }}
          style="width: 100%"
        ></sp-textfield>
        ${
          platform.pickDirectory
            ? html`
                <sp-button
                  variant="secondary"
                  ?disabled=${_browsing}
                  @click=${() => {
                    // `void`, as a STATEMENT: `browse()` is async and nothing here awaits it, so
                    // Dropping the marker turns a deliberate discard into a floating promise.
                    void browse();
                  }}
                >
                  ${_browsing ? "Choosing…" : "Browse…"}
                </sp-button>
              `
            : nothing
        }
      </div>
    </label>
    ${slugFieldTpl(ctx.slug, ctx.onSlugInput)}
  `;
}

function repoFieldsTpl(ctx: {
  rerender: () => void;
  slug: string;
  onSlugInput: (e: Event) => void;
}): TemplateResult {
  const ownerField =
    _owners.length > 0
      ? html`
          <sp-picker
            class="new-project-owner"
            .value=${_owner}
            @change=${(e: Event) => {
              _owner = (e.target as HTMLElement & { value: string }).value;
              _error = "";
              ctx.rerender();
            }}
            style="width: 100%"
          >
            ${_owners.map((owner) => html`<sp-menu-item value=${owner}>${owner}</sp-menu-item>`)}
          </sp-picker>
        `
      : html`
          <sp-textfield
            class="new-project-owner"
            placeholder="your-account-or-org"
            .value=${_owner}
            @input=${(e: Event) => {
              _owner = (e.target as HTMLInputElement).value;
              _error = "";
              ctx.rerender();
            }}
            style="width: 100%"
          ></sp-textfield>
        `;

  return html`
    <label class="new-project-field">
      <span class="new-project-label">Owner *</span>
      ${ownerField}
    </label>
    ${slugFieldTpl(ctx.slug, ctx.onSlugInput)}
    ${
      repoExists(ctx.slug)
        ? html`<div class="new-project-error new-project-error--destination">
            ${_owner}/${ctx.slug} already exists — choose another name.
          </div>`
        : nothing
    }
    <label class="new-project-field">
      <span class="new-project-label">Visibility</span>
      <sp-picker
        class="new-project-visibility"
        .value=${_private ? "private" : "public"}
        @change=${(e: Event) => {
          _private = (e.target as HTMLElement & { value: string }).value !== "public";
          ctx.rerender();
        }}
        style="width: 100%"
      >
        <sp-menu-item value="private">Private</sp-menu-item>
        <sp-menu-item value="public">Public</sp-menu-item>
      </sp-picker>
    </label>
  `;
}

/**
 * The destination fields (including the shared slug), branched on the platform's
 * `createDestination`, followed by a live preview of where the project will land.
 */
export function renderLocationFields(ctx: {
  rerender: () => void;
  slug: string;
  onSlugInput: (e: Event) => void;
}): TemplateResult {
  const isRepo = getPlatform().createDestination === "repo";
  return html`
    ${isRepo ? repoFieldsTpl(ctx) : pathFieldsTpl(ctx)}
    <div class="new-project-destination-preview">
      ${isRepo ? "Repository" : "Creates"}: <code>${previewOf(ctx.slug)}</code>
    </div>
    ${
      _error
        ? html`<div class="new-project-error new-project-error--destination">${_error}</div>`
        : nothing
    }
  `;
}
