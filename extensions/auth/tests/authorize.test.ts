/**
 * Authorize.test.ts — the pure permission evaluator (plan Part 4b): the full rule × session matrix
 * of the connector contract, including the owner setColumns/whereOwner grants, the
 * missing-ownerField configuration error, and fail-closed handling of unknown rules.
 */

import { describe, expect, test } from "bun:test";
import { evaluatePermission, ruleRole } from "../src/authorize";
import type { AuthorizeInput, SessionInfo } from "@jxsuite/connector/types";

const user: SessionInfo = { role: "editor", userId: "u1" };
const plain: SessionInfo = { userId: "u2" };

function input(overrides: Partial<AuthorizeInput>): AuthorizeInput {
  return { action: "read", rule: "public", session: null, table: "comments", ...overrides };
}

describe("evaluatePermission", () => {
  test("public always allows; none always denies with 403", () => {
    expect(evaluatePermission(input({ rule: "public" }))).toEqual({ allow: true });
    expect(evaluatePermission(input({ rule: "public", session: user }))).toEqual({ allow: true });

    const denied = evaluatePermission(input({ action: "delete", rule: "none", session: user }));
    expect(denied.allow).toBe(false);
    expect(denied.status).toBe(403);
    expect(denied.error).toContain("delete is disabled");
  });

  test("authenticated: session required, 401 for anonymous", () => {
    expect(evaluatePermission(input({ rule: "authenticated", session: plain }))).toEqual({
      allow: true,
    });
    const denied = evaluatePermission(input({ action: "insert", rule: "authenticated" }));
    expect(denied).toMatchObject({ allow: false, status: 401 });
    expect(denied.error).toContain("requires authentication");
  });

  test("any session-granted insert stamps a declared ownerField (no forged owner ids)", () => {
    for (const rule of ["authenticated", "role:editor"] as const) {
      const granted = evaluatePermission(
        input({ action: "insert", ownerField: "author_id", rule, session: user }),
      );
      expect(granted).toEqual({ allow: true, setColumns: { author_id: "u1" } });
    }
    // Non-insert actions under "authenticated" stay unscoped even with an ownerField.
    expect(
      evaluatePermission(
        input({ action: "update", ownerField: "author_id", rule: "authenticated", session: user }),
      ),
    ).toEqual({ allow: true });
  });

  test("owner inserts set the owner column from the session", () => {
    const granted = evaluatePermission(
      input({ action: "insert", ownerField: "author_id", rule: "owner", session: user }),
    );
    expect(granted.allow).toBe(true);
    expect(granted.setColumns).toEqual({ author_id: "u1" });
    expect(granted.whereOwner).toBeUndefined();
  });

  test("owner reads/updates/deletes scope to the owner's rows", () => {
    for (const action of ["read", "update", "delete"] as const) {
      const granted = evaluatePermission(
        input({ action, ownerField: "author_id", rule: "owner", session: plain }),
      );
      expect(granted.allow).toBe(true);
      expect(granted.whereOwner).toEqual({ field: "author_id", value: "u2" });
      expect(granted.setColumns).toBeUndefined();
    }
  });

  test("owner without a session is 401; without an ownerField it is a 403 config error", () => {
    const anonymous = evaluatePermission(
      input({ action: "update", ownerField: "author_id", rule: "owner" }),
    );
    expect(anonymous).toMatchObject({ allow: false, status: 401 });

    // Misconfiguration must deny even for signed-in users — and even anonymously it is 403, not
    // 401, because signing in cannot fix it.
    for (const session of [user, null]) {
      const broken = evaluatePermission(input({ action: "update", rule: "owner", session }));
      expect(broken).toMatchObject({ allow: false, status: 403 });
      expect(broken.error).toContain("no ownerField");
    }
  });

  test("role rules match the session role exactly", () => {
    expect(evaluatePermission(input({ rule: "role:editor", session: user }))).toEqual({
      allow: true,
    });
    const wrongRole = evaluatePermission(input({ rule: "role:admin", session: user }));
    expect(wrongRole).toMatchObject({ allow: false, status: 403 });
    expect(wrongRole.error).toContain('"admin" role');
    const noRole = evaluatePermission(input({ rule: "role:admin", session: plain }));
    expect(noRole).toMatchObject({ allow: false, status: 403 });
    const anonymous = evaluatePermission(input({ rule: "role:admin" }));
    expect(anonymous).toMatchObject({ allow: false, status: 401 });
  });

  test("unknown rules fail closed with 403", () => {
    const denied = evaluatePermission(input({ rule: "sometimes" as never, session: user }));
    expect(denied).toMatchObject({ allow: false, status: 403 });
    expect(denied.error).toContain('Unknown permission rule "sometimes"');
  });
});

describe("ruleRole", () => {
  test("extracts the role name from role rules only", () => {
    expect(ruleRole("role:admin")).toBe("admin");
    expect(ruleRole("role:")).toBe("");
    expect(ruleRole("owner")).toBeNull();
    expect(ruleRole("public")).toBeNull();
  });
});
