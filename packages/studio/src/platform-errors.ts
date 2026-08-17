/**
 * Structured platform errors. Backend routes attach machine-readable fields to failures (e.g.
 * project creation blocked by missing GitHub App installation access → `code:
 * "needs_installation_access"` + `installUrl`); adapters preserve them on the thrown Error via
 * `Object.assign`, and UI surfaces recover them here to render actions (an install link) instead of
 * plain text.
 *
 * **RFC 9457 reconciles cleanly with this, because a problem's `type` IS the code.** A backend
 * answering `type: "https://jxsuite.com/problems/needs-installation-access"` is saying exactly what
 * `code: "needs_installation_access"` said; `problemSlug` derives the one from the other, and
 * `installUrl` is the extension member (§3.2) that type documents. So this module reads both, and
 * every surface above it keeps branching on `code` without knowing which shape arrived.
 */

import { problemSlug } from "@jxsuite/protocol";

export interface PlatformErrorInfo {
  code?: string;
  installUrl?: string;
}

/**
 * The slug spelling of a code, so a hyphenated problem type and an underscored legacy code compare
 * equal. The two spellings exist because the type is a URI path segment and the code was a JS-ish
 * identifier; neither is worth migrating the other to while both are on the wire.
 */
function normalizeCode(value: string): string {
  return value.replaceAll("_", "-");
}

/** Machine-readable fields carried by a thrown platform error (empty object when none). */
export function platformErrorInfo(error: unknown): PlatformErrorInfo {
  if (!error || typeof error !== "object") {
    return {};
  }
  const { code, installUrl, type } = error as {
    code?: unknown;
    installUrl?: unknown;
    type?: unknown;
  };
  // A problem type wins over a legacy code: it is the shape the backend is migrating toward.
  const derived = problemSlug(type) ?? (typeof code === "string" ? normalizeCode(code) : null);
  return {
    ...(derived === null ? {} : { code: derived }),
    ...(typeof installUrl === "string" ? { installUrl } : {}),
  };
}

/** The GitHub-App install link when the error is the structured needs-installation 403. */
export function installUrlOf(error: unknown): string | null {
  const info = platformErrorInfo(error);
  return info.code === "needs-installation-access" && info.installUrl ? info.installUrl : null;
}
