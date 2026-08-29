/**
 * Two files a site is expected to publish and nothing generates: `manifest.webmanifest` and
 * `.well-known/security.txt`.
 *
 * Both are pure functions of `project.json` plus what the build already knows about the site, which
 * is the reason they belong here rather than in `public/` — an author copying either between
 * projects also copies the values that were right for the other one.
 *
 * @docs framework/site/deployment
 */

import { siteBasePath, withBase } from "@jxsuite/schema/asset-paths";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalizeLocale } from "@jxsuite/schema/locale";
import type { ManifestConfig, ProjectConfig, SecurityTxtConfig } from "@jxsuite/schema/types";

/** The two sizes a browser wants before it will offer to install a site. */
const INSTALL_ICON_SIZES = [192, 512];

export interface GeneratedFile {
  /** Path relative to `outDir`. */
  path: string;
  content: string;
}

export interface WellKnownOutput {
  files: GeneratedFile[];
  errors: string[];
  warnings: string[];
}

/**
 * Build `manifest.webmanifest` from the `manifest` section, falling back to what the project
 * already says about itself.
 *
 * `name` and `start_url` are not asked for twice: a project has a `name`, and `start_url` is the
 * site root unless the author says otherwise. Everything else is theirs.
 *
 * @param {ProjectConfig} projectConfig
 * @returns {WellKnownOutput}
 */
export function buildManifest(projectConfig: ProjectConfig): WellKnownOutput {
  const config: ManifestConfig | undefined = projectConfig.manifest;
  const errors: string[] = [];
  const warnings: string[] = [];
  if (config === undefined || config.enabled === false) {
    return { errors, files: [], warnings };
  }

  const name = config.name ?? projectConfig.name ?? "Jx Site";
  /*
   * Every URL in a manifest is fetched or navigated to by the browser, so all three carry the
   * deployment base (`base-path.ts`). `scope` is the one that fails loudly — a scope the manifest's
   * own URL is not inside makes the manifest invalid and the site uninstallable — while a
   * `start_url` at the old root just opens the wrong page from the home screen.
   */
  const base = siteBasePath(projectConfig.url);
  const icons = [];
  for (const icon of config.icons ?? []) {
    icons.push(typeof icon.src === "string" ? { ...icon, src: withBase(base, icon.src) } : icon);
  }
  const manifest: Record<string, unknown> = {
    display: config.display ?? "standalone",
    icons,
    name,
    short_name: config.shortName ?? name,
    start_url: withBase(base, config.startUrl ?? "/"),
    ...(config.description === undefined ? {} : { description: config.description }),
    ...(config.themeColor === undefined ? {} : { theme_color: config.themeColor }),
    ...(config.backgroundColor === undefined ? {} : { background_color: config.backgroundColor }),
    ...(config.scope === undefined ? {} : { scope: withBase(base, config.scope) }),
    ...(config.orientation === undefined ? {} : { orientation: config.orientation }),
    ...(config.lang === undefined ? {} : { lang: config.lang }),
    ...(config.dir === undefined ? {} : { dir: config.dir }),
    ...(config.categories === undefined ? {} : { categories: config.categories }),
  };

  /*
   * A warning, not an error. The manifest is valid and useful without these — it still supplies
   * the name and theme colour a browser shows — but a site cannot be *installed* without an icon
   * at each size, and that is the whole reason most people add one.
   */
  const declared = new Set(
    icons.flatMap((icon) =>
      (icon.sizes ?? "").split(/\s+/).map((size) => Math.trunc(Number(size.split("x")[0]))),
    ),
  );
  const missing = INSTALL_ICON_SIZES.filter((size) => !declared.has(size));
  if (missing.length > 0) {
    warnings.push(
      `manifest: no ${missing.join("px and no ")}px icon declared — browsers will not offer to ` +
        "install the site without one at each size.",
    );
  }

  return {
    errors,
    files: [{ content: `${JSON.stringify(manifest, null, 2)}\n`, path: "manifest.webmanifest" }],
    warnings,
  };
}

/** The `<head>` entries a generated manifest needs to be found and to look right when installed. */
export function manifestHeadEntries(
  projectConfig: ProjectConfig,
): { tagName: string; attributes: Record<string, string> }[] {
  const config = projectConfig.manifest;
  if (config === undefined || config.enabled === false) {
    return [];
  }
  const entries: { tagName: string; attributes: Record<string, string> }[] = [
    { attributes: { href: "/manifest.webmanifest", rel: "manifest" }, tagName: "link" },
  ];
  if (config.themeColor !== undefined) {
    entries.push({
      attributes: { content: config.themeColor, name: "theme-color" },
      tagName: "meta",
    });
  }
  return entries;
}

/**
 * Build `.well-known/security.txt` (RFC 9116).
 *
 * `.well-known` only. §3 makes that the canonical location, and a second copy at the root is a
 * second thing to forget to update.
 *
 * @param {ProjectConfig} projectConfig
 * @param {Date} now - Evaluated against `Expires`; injected so the check is testable
 * @returns {WellKnownOutput}
 */
export function buildSecurityTxt(projectConfig: ProjectConfig, now: Date): WellKnownOutput {
  const config: SecurityTxtConfig | undefined = projectConfig.securityTxt;
  const errors: string[] = [];
  const warnings: string[] = [];
  if (config === undefined || config.enabled === false) {
    return { errors, files: [], warnings };
  }

  const contact = config.contact ?? [];
  if (contact.length === 0) {
    errors.push("securityTxt: at least one `contact` is required (RFC 9116 §2.5.3).");
  }

  /*
   * `Expires` is required by §2.5.5, and it is the field everyone forgets. A past date is worse
   * than a missing file: it advertises a reporting channel while telling the reporter the
   * information is stale, so both cases fail the build rather than emitting something misleading.
   */
  if (config.expires === undefined) {
    errors.push(
      "securityTxt: `expires` is required (RFC 9116 §2.5.5) — a security.txt with no expiry " +
        "never goes stale visibly, which is how they end up pointing at people who left.",
    );
  } else {
    const expires = new Date(config.expires);
    if (Number.isNaN(expires.getTime())) {
      errors.push(`securityTxt: \`expires\` is not a valid date: "${config.expires}".`);
    } else if (expires.getTime() <= now.getTime()) {
      errors.push(
        `securityTxt: \`expires\` is in the past (${expires.toISOString()}) — an expired ` +
          "security.txt tells a reporter not to trust what it says.",
      );
    }
  }

  const languages: string[] = [];
  for (const tag of config.preferredLanguages ?? []) {
    const canonical = canonicalizeLocale(tag);
    if (canonical === null) {
      errors.push(`securityTxt.preferredLanguages: "${tag}" is not a well-formed language tag.`);
    } else {
      languages.push(canonical);
    }
  }

  if (errors.length > 0) {
    return { errors, files: [], warnings };
  }

  const lines: string[] = [
    "# Generated by @jxsuite/compiler — configure via securityTxt in project.json.",
    ...contact.map((value) => `Contact: ${value}`),
    `Expires: ${new Date(config.expires as string).toISOString().replace(/\.\d{3}Z$/, "Z")}`,
    ...(config.encryption ?? []).map((value) => `Encryption: ${value}`),
    ...(config.acknowledgments ?? []).map((value) => `Acknowledgments: ${value}`),
    ...(languages.length > 0 ? [`Preferred-Languages: ${languages.join(", ")}`] : []),
    ...(config.canonical === undefined ? [] : [`Canonical: ${config.canonical}`]),
    ...(config.policy ?? []).map((value) => `Policy: ${value}`),
    ...(config.hiring ?? []).map((value) => `Hiring: ${value}`),
  ];

  return {
    errors,
    files: [{ content: `${lines.join("\n")}\n`, path: ".well-known/security.txt" }],
    warnings,
  };
}

/**
 * Write generated files under `outDir`, skipping any the author already supplied.
 *
 * The skip is the point: `public/.well-known/security.txt` is copied before this runs, and a
 * hand-placed file there is how an author ships a **clearsigned** one — which needs a private key
 * at build time and is therefore not something the build can do. Deferring costs zero code.
 *
 * @param {readonly GeneratedFile[]} files
 * @param {string} outDir
 * @param {(path: string) => boolean} exists
 * @returns {{ written: number; skipped: string[] }}
 */
export function writeWellKnown(
  files: readonly GeneratedFile[],
  outDir: string,
  exists: (path: string) => boolean,
): { written: number; skipped: string[] } {
  let written = 0;
  const skipped: string[] = [];
  for (const file of files) {
    const target = join(outDir, file.path);
    if (exists(target)) {
      skipped.push(file.path);
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content, "utf8");
    written += 1;
  }
  return { skipped, written };
}
