/**
 * Structured platform errors. Backend routes attach machine-readable fields to failures (e.g.
 * project creation blocked by missing GitHub App installation access → `code:
 * "needs_installation_access"` + `installUrl`); adapters preserve them on the thrown Error via
 * `Object.assign`, and UI surfaces recover them here to render actions (an install link) instead of
 * plain text.
 */

export interface PlatformErrorInfo {
  code?: string;
  installUrl?: string;
}

/** Machine-readable fields carried by a thrown platform error (empty object when none). */
export function platformErrorInfo(error: unknown): PlatformErrorInfo {
  if (!error || typeof error !== "object") {
    return {};
  }
  const { code, installUrl } = error as { code?: unknown; installUrl?: unknown };
  return {
    ...(typeof code === "string" ? { code } : {}),
    ...(typeof installUrl === "string" ? { installUrl } : {}),
  };
}

/** The GitHub-App install link when the error is the structured needs-installation 403. */
export function installUrlOf(error: unknown): string | null {
  const info = platformErrorInfo(error);
  return info.code === "needs_installation_access" && info.installUrl ? info.installUrl : null;
}
