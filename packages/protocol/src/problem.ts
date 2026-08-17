/**
 * RFC 9457 Problem Details — one failure shape for every Jx backend.
 *
 * Before this, each backend invented its own: `{error: "..."}` here, bare text there, a 200 with an
 * `upstreamError` field somewhere else. The cost landed on the client, which grew a separate reader
 * per shape, and on the user, who could get a failure with no detail at all because the reader that
 * ran was not the one for the shape that arrived.
 *
 * A problem is **data about one occurrence of one problem type**, and the type is a URI. Two
 * decisions follow from that and are worth stating, because both look arbitrary until they are
 * explained:
 *
 * - **`type` is absolute.** RFC 9457 permits a relative reference, resolved against the request
 *   URL — which on a dev server is `http://127.0.0.1:3000/problems/…` and serves nothing. An
 *   absolute `https://jxsuite.com/problems/…` means the same thing everywhere, which is the whole
 *   point of identifying a type by URI.
 * - **`instance` is never emitted.** It identifies the specific occurrence, and Jx has no
 *   per-occurrence resource to point at. A field whose only possible value is a fabricated URI is
 *   noise that looks like information.
 *
 * @license MIT
 */

/** The media type a problem response carries (RFC 9457 §3). */
export const PROBLEM_MEDIA_TYPE = "application/problem+json";

/** The namespace every Jx problem type lives under. Absolute, for the reason in the module note. */
export const PROBLEM_TYPE_BASE = "https://jxsuite.com/problems/";

/**
 * A problem document (RFC 9457 §3.1).
 *
 * `title` describes the **type** and must not vary between occurrences; `detail` describes **this**
 * occurrence and is the one a human reads. Conflating them is the standard's most common misuse and
 * the reason a client cannot group failures.
 */
export interface ProblemDetails {
  /** Absolute URI identifying the problem type. */
  type: string;
  /** Short, human-readable summary of the TYPE. Stable across occurrences. */
  title: string;
  /** The HTTP status the origin generated, repeated so a stored problem stays self-describing. */
  status: number;
  /** Human-readable explanation of THIS occurrence. */
  detail?: string;
  /**
   * Compatibility alias for `detail`, emitted for one release.
   *
   * Every existing Jx client reads `body.error`. Emitting both lets the server change shape without
   * a synchronized client release across ~160 call sites: the server lands alone, the clients
   * follow, and a third one-line change deletes this field. It is **not** part of RFC 9457 and no
   * new reader should be written against it.
   *
   * @deprecated Read `detail`. This field is removed once every client has migrated.
   */
  error?: string;
  /** Extension members (RFC 9457 §3.2) — anything the type documents. */
  [extension: string]: unknown;
}

/** The slug identifying a Jx problem type, i.e. the last segment of its `type` URI. */
export function problemSlug(type: unknown): string | null {
  if (typeof type !== "string" || !type.startsWith(PROBLEM_TYPE_BASE)) {
    return null;
  }
  const slug = type.slice(PROBLEM_TYPE_BASE.length);
  return slug === "" ? null : slug;
}

/** True when the value has the shape of a problem document. */
export function isProblemDetails(value: unknown): value is ProblemDetails {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<ProblemDetails>;
  return typeof candidate.type === "string" && typeof candidate.status === "number";
}

/**
 * The one line a failure body carries, or null when it carries none.
 *
 * The order is most-specific-first: `detail` describes THIS occurrence, the legacy `error` is the
 * same string under the pre-RFC-9457 name, and `title` describes the TYPE — useful, but the weaker
 * answer whenever a `detail` exists.
 *
 * Null rather than a generic string, because a caller usually knows a better fallback than any
 * generic one: "Failed to list connections" beats "Request failed (500)". Use {@link problemMessage}
 * when there is no such context.
 *
 * @param {unknown} body - A parsed response body, whatever shape it turned out to be
 * @returns {string | null}
 */
export function problemDetail(body: unknown): string | null {
  if (typeof body === "string") {
    return body.trim() === "" ? null : body;
  }
  if (!body || typeof body !== "object") {
    return null;
  }
  const candidate = body as { detail?: unknown; error?: unknown; title?: unknown };
  for (const value of [candidate.detail, candidate.error, candidate.title]) {
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
  }
  return null;
}

/**
 * The one line a human should be shown for a failure, from any shape a Jx backend has ever sent.
 *
 * This is the reader the client keeps — one, not five. It reads a problem's `detail`, then the
 * legacy `{error}` body, then the type's `title`, and finally falls back to the status. The order
 * is most-specific-first, because a `title` describes the type rather than the occurrence and is
 * the less useful of the two whenever a `detail` exists.
 *
 * @param {unknown} body - A parsed response body, whatever shape it turned out to be
 * @param {number} [status] - The response status, used only when the body says nothing
 * @returns {string}
 */
export function problemMessage(body: unknown, status?: number): string {
  return (
    problemDetail(body) ?? (status === undefined ? "Request failed" : `Request failed (${status})`)
  );
}
