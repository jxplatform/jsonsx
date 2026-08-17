/**
 * The Jx problem-type registry — the failure counterpart of `STUDIO_ROUTES`.
 *
 * A problem type is a URI a client can key on, and a URI nobody wrote down is a string each backend
 * spells differently. So the types live here, in one table, in the same idiom as the route table:
 * declared once, exported as data, rendered into the docs by the same generator, and checked by the
 * same drift machinery.
 *
 * **What belongs here.** A type is a *class* of failure a client might handle differently — not a
 * message. "The project root was refused" is a type; "root /x/y was refused" is a `detail`. If two
 * entries would only ever differ in their wording, they are one type.
 *
 * @license MIT
 */

import { PROBLEM_TYPE_BASE } from "./problem.ts";
import type { ProblemDetails } from "./problem.ts";

/** One declared problem type: what it means, and the status it is generated with. */
export interface ProblemType {
  /** Absolute `type` URI. */
  type: string;
  /** Short, human-readable summary of the type. Stable across occurrences. */
  title: string;
  /** The HTTP status this type is generated with. */
  status: number;
  /** Extension members this type documents, if any. */
  extensions?: readonly string[];
}

const problem = (
  slug: string,
  status: number,
  title: string,
  extensions?: readonly string[],
): ProblemType => ({
  status,
  title,
  type: `${PROBLEM_TYPE_BASE}${slug}`,
  ...(extensions === undefined ? {} : { extensions }),
});

/**
 * Every problem type a Jx backend may answer with, keyed by a stable name.
 *
 * Grouped by what went wrong rather than by which route emitted it: the same bad request is the
 * same problem whether it arrived at `/__studio/files` or `/__studio/data/rows`, and a client that
 * handles `invalid-request` handles both.
 */
export const PROBLEM_TYPES = {
  // ─── The request ──────────────────────────────────────────────────────────
  invalidRequest: problem("invalid-request", 400, "The request was malformed or incomplete"),
  notFound: problem("not-found", 404, "The requested resource does not exist"),
  methodNotAllowed: problem("method-not-allowed", 405, "That method is not allowed on this route"),
  conflict: problem("conflict", 409, "The request conflicts with the current state", ["conflicts"]),
  payloadTooLarge: problem("payload-too-large", 413, "The request body is too large"),

  // ─── Access ───────────────────────────────────────────────────────────────
  /*
   * 401 and 403 are separate types because they ask the client for different things: 401 means
   * "authenticate and try again", 403 means "no". Collapsing them would make a missing API key
   * indistinguishable from a refused project root.
   */
  unauthorized: problem("unauthorized", 401, "Credentials are missing or not accepted"),
  forbidden: problem("forbidden", 403, "The request was refused"),
  /*
   * Distinct from `forbidden` because the client does something different with it: it renders an
   * install link. That is the test for whether a type earns its own entry.
   */
  needsInstallationAccess: problem(
    "needs-installation-access",
    403,
    "The GitHub App is not installed for that account",
    ["installUrl"],
  ),
  pathOutsideProject: problem(
    "path-outside-project",
    403,
    "The path resolves outside the active project",
  ),

  // ─── Backend state ────────────────────────────────────────────────────────
  noActiveProject: problem("no-active-project", 409, "No project is active on this backend"),
  capabilityUnavailable: problem(
    "capability-unavailable",
    501,
    "This backend does not provide that capability",
  ),
  upstreamFailure: problem("upstream-failure", 502, "An upstream service failed", ["upstream"]),
  internalError: problem("internal-error", 500, "The backend failed to complete the request"),
} as const satisfies Record<string, ProblemType>;

/** A stable problem-type name in {@link PROBLEM_TYPES}. */
export type ProblemTypeName = keyof typeof PROBLEM_TYPES;

/**
 * Build a problem document for one occurrence of a declared type.
 *
 * `detail` is duplicated into the deprecated `error` member so existing clients keep working while
 * they migrate; see the note on {@link ProblemDetails.error}.
 *
 * @param {ProblemTypeName} name - A declared type
 * @param {string} [detail] - What happened THIS time
 * @param {Record<string, unknown>} [extensions] - Extension members this type documents
 * @returns {ProblemDetails}
 */
export function problemDetails(
  name: ProblemTypeName,
  detail?: string,
  extensions: Record<string, unknown> = {},
): ProblemDetails {
  const declared = PROBLEM_TYPES[name];
  return {
    ...extensions,
    status: declared.status,
    title: declared.title,
    type: declared.type,
    ...(detail === undefined || detail === "" ? {} : { detail, error: detail }),
  };
}

/** The declared type a `type` URI names, or null when it is not one of ours. */
export function problemTypeByUri(type: unknown): ProblemType | null {
  if (typeof type !== "string") {
    return null;
  }
  return Object.values(PROBLEM_TYPES).find((declared) => declared.type === type) ?? null;
}
