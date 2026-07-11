/**
 * Authorize — the pure permission evaluator implementing the connector's auth contract
 * (specs/extensions.md §11, @jxsuite/connector/types).
 *
 * The data mount resolves each request's rule (declared permissions over the defaults: reads
 * public, writes closed), handles `public`/`none` itself, and hands every other rule to
 * `ctx.auth.authorize` — this function. Grants may carry `setColumns` (owner id forced onto
 * insert/update payloads) and `whereOwner` (row scoping for owner reads/writes/deletes). Unknown
 * rules fail closed. No I/O: the session was already resolved by `getSession`.
 */

import type {
  AuthorizeDecision,
  AuthorizeInput,
  PermissionRule,
  SessionInfo,
} from "@jxsuite/connector/types";

/** A 401/403 denial with a wire-friendly message. */
function deny(session: SessionInfo | null, error: string, status?: number): AuthorizeDecision {
  return { allow: false, error, status: status ?? (session ? 403 : 401) };
}

/**
 * A grant for a session-backed rule. Declaring an `ownerField` makes that column authoritative:
 * EVERY session-granted insert stamps it with the user id (not just `owner`-rule inserts) —
 * otherwise an `insert: "authenticated"` table would accept payload-forged owner ids, poisoning
 * later owner-scoped reads and writes.
 */
function grant(input: AuthorizeInput, session: SessionInfo): AuthorizeDecision {
  const { action, ownerField } = input;
  if (action === "insert" && ownerField) {
    return { allow: true, setColumns: { [ownerField]: session.userId } };
  }
  return { allow: true };
}

/** The role a rule requires, or null for non-role rules. */
export function ruleRole(rule: PermissionRule): string | null {
  return rule.startsWith("role:") ? rule.slice("role:".length) : null;
}

/**
 * Evaluate one permission rule against a resolved session (pure, synchronous).
 *
 * @param {AuthorizeInput} input - Table, action, resolved rule, session, and optional ownerField
 * @returns {AuthorizeDecision} The grant (with setColumns/whereOwner for owner rules) or denial
 */
export function evaluatePermission(input: AuthorizeInput): AuthorizeDecision {
  const { table, action, rule, session } = input;

  if (rule === "public") {
    return { allow: true };
  }
  if (rule === "none") {
    return deny(session, `${action} is disabled for "${table}"`, 403);
  }
  if (rule === "authenticated") {
    return session
      ? grant(input, session)
      : deny(session, `${action} on "${table}" requires authentication`);
  }
  if (rule === "owner") {
    const { ownerField } = input;
    if (!ownerField) {
      // Configuration error: an owner rule is unenforceable without an ownerField column.
      return deny(
        session,
        `"${table}" uses an "owner" rule for ${action} but declares no ownerField`,
        403,
      );
    }
    if (!session) {
      return deny(session, `${action} on "${table}" requires authentication`);
    }
    if (action === "insert") {
      return grant(input, session);
    }
    return { allow: true, whereOwner: { field: ownerField, value: session.userId } };
  }
  const role = ruleRole(rule);
  if (role !== null) {
    if (!session) {
      return deny(session, `${action} on "${table}" requires authentication`);
    }
    return session.role === role
      ? grant(input, session)
      : deny(session, `${action} on "${table}" requires the "${role}" role`, 403);
  }
  // Fail closed on rules this evaluator does not understand.
  return deny(session, `Unknown permission rule "${String(rule)}" for "${table}"`, 403);
}
