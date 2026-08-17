/**
 * The RFC 8252 loopback redirect with RFC 7636 PKCE: the authorization request's shape, the
 * callback's state handling, and the token exchange.
 *
 * Three of these are not "coverage" but the security contract itself — the literal `127.0.0.1`, the
 * `S256`-only challenge, and a `state` that is single-use and short-lived — so each is asserted
 * against the value that would be wrong, not just the value that is right.
 */

import { describe, expect, test } from "bun:test";
import {
  createLoopbackAuthorizer,
  createPkce,
  exchangeCode,
  LOOPBACK_ADDRESS,
  loopbackRedirectUri,
  OAUTH_CALLBACK_PATH,
} from "../src/oauth-loopback.ts";

const REQUEST = {
  authorizationEndpoint: "https://github.com/login/oauth/authorize",
  clientId: "Ov23liEXAMPLE",
  scope: "repo",
};

function callbackUrl(params: Record<string, string>): URL {
  const url = new URL(`http://${LOOPBACK_ADDRESS}:4321${OAUTH_CALLBACK_PATH}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url;
}

/**
 * The message a rejecting promise produces, or "" when it resolves.
 *
 * Written out rather than using `expect(...).rejects`, whose matcher the type-aware lint reads as
 * synchronous for this return type — and an unawaited assertion in a file full of promises that
 * settle on a later turn is exactly the flake worth not having.
 */
async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe("createPkce", () => {
  test("is S256 over the verifier, and never plain", async () => {
    const pkce = await createPkce();
    expect(pkce.method).toBe("S256");
    // `plain` would put the verifier in the authorization request, which defeats the exchange bind.
    expect(pkce.challenge).not.toBe(pkce.verifier);

    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pkce.verifier));
    const expected = btoa(String.fromCodePoint(...new Uint8Array(digest)))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
    expect(pkce.challenge).toBe(expected);
  });

  test("the verifier is base64url and long enough for RFC 7636 §4.1", async () => {
    const { verifier } = await createPkce();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(verifier).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  test("two calls do not share a verifier", async () => {
    const [a, b] = await Promise.all([createPkce(), createPkce()]);
    expect(a.verifier).not.toBe(b.verifier);
  });
});

describe("loopbackRedirectUri", () => {
  test("is the literal address, never the name", () => {
    /*
     * RFC 8252 §8.3. `localhost` is a name and a name resolves: a hosts entry can point it at
     * another machine, and the authorization code would be delivered there.
     */
    expect(loopbackRedirectUri(4321)).toBe(`http://127.0.0.1:4321${OAUTH_CALLBACK_PATH}`);
    expect(loopbackRedirectUri(4321)).not.toContain("localhost");
  });
});

describe("begin", () => {
  test("builds an authorization request carrying every required parameter", async () => {
    const authorizer = createLoopbackAuthorizer();
    const pending = await authorizer.begin(4321, {
      ...REQUEST,
      extraParams: { prompt: "consent" },
    });
    const params = new URL(pending.authorizationUrl).searchParams;

    expect(params.get("client_id")).toBe(REQUEST.clientId);
    expect(params.get("response_type")).toBe("code");
    expect(params.get("redirect_uri")).toBe(pending.redirectUri);
    expect(params.get("state")).toBe(pending.state);
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("code_challenge")).not.toBe(pending.verifier);
    expect(params.get("scope")).toBe("repo");
    expect(params.get("prompt")).toBe("consent");
    // No client secret: a desktop app cannot keep one (RFC 8252 §8.5).
    expect(pending.authorizationUrl).not.toContain("client_secret");

    pending.cancel();
  });

  test("two authorizations do not share a state", async () => {
    const authorizer = createLoopbackAuthorizer();
    const [a, b] = [await authorizer.begin(1, REQUEST), await authorizer.begin(2, REQUEST)];
    expect(a.state).not.toBe(b.state);
    expect(authorizer.pending()).toBe(2);
    authorizer.stop();
  });
});

describe("handleCallback", () => {
  test("resolves the code for a matching state, and says so inertly", async () => {
    const authorizer = createLoopbackAuthorizer();
    const pending = await authorizer.begin(4321, REQUEST);

    const response = authorizer.handleCallback(
      callbackUrl({ code: "abc123", state: pending.state }),
    );
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    // The code is in this request's query; nothing may carry that URL onward.
    expect(response!.headers.get("referrer-policy")).toBe("no-referrer");
    const body = await response!.text();
    expect(body).not.toContain("abc123");
    expect(body).not.toContain("<script");

    expect(await pending.code).toBe("abc123");
    expect(authorizer.pending()).toBe(0);
  });

  test("a state is single-use: the replay finds nothing", async () => {
    const authorizer = createLoopbackAuthorizer();
    const pending = await authorizer.begin(4321, REQUEST);
    authorizer.handleCallback(callbackUrl({ code: "abc123", state: pending.state }));
    await pending.code;

    const replay = authorizer.handleCallback(callbackUrl({ code: "evil", state: pending.state }));
    expect(await replay!.text()).toContain("could not be completed");
  });

  test("an unknown state is refused, and refused identically to an expired one", async () => {
    /*
     * This is the CSRF the parameter exists to catch: any local page can navigate a browser to the
     * callback. Distinguishing "expired" from "never existed" would tell an attacker whether they
     * guessed a live state.
     */
    const authorizer = createLoopbackAuthorizer();
    const unknown = authorizer.handleCallback(callbackUrl({ code: "x", state: "not-a-state" }));
    expect(await unknown!.text()).toContain("did not match a sign-in started by this app");

    const expiring = createLoopbackAuthorizer({ ttlMs: 0 });
    const pending = await expiring.begin(4321, REQUEST);
    const late = expiring.handleCallback(callbackUrl({ code: "x", state: pending.state }));
    expect(await late!.text()).toContain("did not match a sign-in started by this app");
    expect(await rejection(pending.code)).toContain("took too long");
  });

  test("a callback with no state at all is refused", async () => {
    const authorizer = createLoopbackAuthorizer();
    const pending = await authorizer.begin(4321, REQUEST);
    const response = authorizer.handleCallback(callbackUrl({ code: "x" }));
    expect(await response!.text()).toContain("could not be completed");
    expect(authorizer.pending()).toBe(1);
    pending.cancel();
    expect(await rejection(pending.code)).toContain("cancelled");
  });

  test("a provider refusal rejects with the provider's own reason", async () => {
    const authorizer = createLoopbackAuthorizer();
    const pending = await authorizer.begin(4321, REQUEST);
    const response = authorizer.handleCallback(
      callbackUrl({
        error: "access_denied",
        error_description: "The user denied the request",
        state: pending.state,
      }),
    );
    expect(await response!.text()).toContain("not completed");
    expect(await rejection(pending.code)).toContain("The user denied the request");
  });

  test("a refusal with no description falls back to the error code", async () => {
    const authorizer = createLoopbackAuthorizer();
    const pending = await authorizer.begin(4321, REQUEST);
    authorizer.handleCallback(callbackUrl({ error: "server_error", state: pending.state }));
    expect(await rejection(pending.code)).toContain("server_error");
  });

  test("a matching state with no code is a failure, not a hang", async () => {
    const authorizer = createLoopbackAuthorizer();
    const pending = await authorizer.begin(4321, REQUEST);
    const response = authorizer.handleCallback(callbackUrl({ state: pending.state }));
    expect(await response!.text()).toContain("could not be completed");
    expect(await rejection(pending.code)).toContain("without an authorization code");
  });

  test("another path is not this route's business", async () => {
    const authorizer = createLoopbackAuthorizer();
    expect(authorizer.handleCallback(new URL("http://127.0.0.1:4321/elsewhere"))).toBeNull();
  });

  test("stopping the server abandons every outstanding sign-in", async () => {
    const authorizer = createLoopbackAuthorizer();
    const pending = await authorizer.begin(4321, REQUEST);
    authorizer.stop();
    expect(authorizer.pending()).toBe(0);
    expect(await rejection(pending.code)).toContain("stopped before the sign-in completed");
  });
});

describe("exchangeCode", () => {
  const BASE = {
    clientId: "Ov23liEXAMPLE",
    code: "abc123",
    redirectUri: loopbackRedirectUri(4321),
    tokenEndpoint: "https://github.com/login/oauth/access_token",
    verifier: "v".repeat(43),
  };

  test("posts the verifier and the exact redirect_uri, and no client secret", async () => {
    let seen: URLSearchParams | null = null;
    const result = await exchangeCode({
      ...BASE,
      fetchImpl: async (_input, init) => {
        seen = new URLSearchParams(String(init?.body));
        return Response.json({ access_token: "gho_x", scope: "repo", token_type: "bearer" });
      },
    });

    const body = seen as unknown as URLSearchParams;
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code_verifier")).toBe(BASE.verifier);
    // §4.1.3 requires the same value the authorization request carried, verbatim.
    expect(body.get("redirect_uri")).toBe(BASE.redirectUri);
    expect(body.get("client_secret")).toBeNull();
    expect(result).toEqual({ accessToken: "gho_x", scope: "repo", tokenType: "bearer" });
  });

  test("carries the optional members through when the provider sends them", async () => {
    const result = await exchangeCode({
      ...BASE,
      fetchImpl: async () =>
        Response.json({
          access_token: "gho_x",
          expires_in: 28_800,
          refresh_token: "ghr_y",
          token_type: "bearer",
        }),
    });
    expect(result.expiresIn).toBe(28_800);
    expect(result.refreshToken).toBe("ghr_y");
  });

  test("a provider error is reported with the provider's description", async () => {
    // GitHub answers 200 with an `error` body, so the status alone would call this a success.
    const refused = exchangeCode({
      ...BASE,
      fetchImpl: async () =>
        Response.json({
          error: "bad_verification_code",
          error_description: "The code passed is incorrect or expired.",
        }),
    });
    expect(await rejection(refused)).toContain("The code passed is incorrect or expired.");
  });

  test("an error with no description names the error code", async () => {
    const refused = exchangeCode({
      ...BASE,
      fetchImpl: async () => Response.json({ error: "unauthorized" }),
    });
    expect(await rejection(refused)).toContain("unauthorized");
  });

  test("a non-JSON or token-less answer fails rather than yielding undefined", async () => {
    const serverError = exchangeCode({
      ...BASE,
      fetchImpl: async () => new Response("nope", { status: 500 }),
    });
    expect(await rejection(serverError)).toContain("HTTP 500");

    const noToken = exchangeCode({ ...BASE, fetchImpl: async () => Response.json({}) });
    expect(await rejection(noToken)).toContain("token exchange failed");
  });

  test("token_type defaults to bearer when the provider omits it", async () => {
    const result = await exchangeCode({
      ...BASE,
      fetchImpl: async () => Response.json({ access_token: "gho_x" }),
    });
    expect(result.tokenType).toBe("bearer");
  });
});
