/**
 * Minimal semver helpers for comparing dependency versions in the UI. Deliberately tiny — we only
 * need range stripping and ordering of `x.y.z` triples, not full semver range satisfaction, so we
 * avoid pulling in a dependency.
 */

/** Strip a range prefix to its base version: "^0.19.0" → "0.19.0", "~1.2.3" → "1.2.3". */
export function stripRange(range: string): string {
  const base = range.replace(/^[\^~>=<v\s]+/, "").trim();
  return base.split(/\s+/)[0] ?? "";
}

/**
 * Whether a spec is a comparable registry semver (a plain `x.y.z` range), as opposed to
 * `workspace:`, `file:`, `link:`, a git/URL spec, or a wildcard like `*`/`latest`.
 */
export function isComparable(spec: string): boolean {
  if (spec.includes(":")) {
    return false;
  }
  return /^\d+\.\d+/.test(stripRange(spec));
}

/** Parse a version into numeric [major, minor, patch], ignoring any pre-release/build suffix. */
function parts(version: string): [number, number, number] {
  const core = stripRange(version).split(/[-+]/)[0] ?? "";
  const [major = 0, minor = 0, patch = 0] = core.split(".").map((n) => Math.trunc(Number(n)) || 0);
  return [major, minor, patch];
}

/**
 * Compare two versions (range prefixes tolerated). Returns -1 if a < b, 1 if a > b, 0 if equal.
 * Pre-release/build metadata is ignored.
 */
export function compareSemver(a: string, b: string): number {
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) {
      return da < db ? -1 : 1;
    }
  }
  return 0;
}

/** Whether `latest` is strictly newer than the base version of `current` (both comparable). */
export function isUpgrade(current: string, latest: string): boolean {
  if (!isComparable(current) || !isComparable(latest)) {
    return false;
  }
  return compareSemver(latest, current) > 0;
}
