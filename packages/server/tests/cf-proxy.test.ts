/**
 * /__studio/cf/proxy: the stateless allowlisted Cloudflare API passthrough behind the publish
 * surface's cfApi (token in X-CF-Token, never stored).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { handleStudioApi } from "../src/studio-api";

const ROOT = import.meta.dir;
const ACCOUNT = "0123456789abcdef0123456789abcdef";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

interface UpstreamCall {
  url: string;
  init?: RequestInit;
}

function stubUpstream(status = 200, body?: unknown) {
  const payload = body ?? { success: true, result: [] };
  const calls: UpstreamCall[] = [];
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), ...(init === undefined ? {} : { init }) });
    return Response.json(payload, { status });
  }) as typeof fetch;
  return calls;
}

async function proxy(payload: unknown, headers: Record<string, string> = {}) {
  const urlStr = "http://localhost/__studio/cf/proxy";
  const req = new Request(urlStr, {
    body: JSON.stringify(payload),
    headers: { "Content-Type": "application/json", ...headers },
    method: "POST",
  });
  const res = await handleStudioApi(req, new URL(urlStr), ROOT);
  if (!res) {
    throw new Error("No response from handleStudioApi");
  }
  return res;
}

describe("/__studio/cf/proxy", () => {
  test("rejects requests without a token", async () => {
    stubUpstream();
    const res = await proxy({ path: "/accounts" });
    expect(res.status).toBe(401);
  });

  test("rejects paths outside the allowlist", async () => {
    stubUpstream();
    for (const path of [
      "/user/tokens",
      `/accounts/${ACCOUNT}/workers/scripts`,
      "/zones",
      `/accounts/${ACCOUNT}/pages/projects/../../../user`,
    ]) {
      const res = await proxy({ path }, { "X-CF-Token": "cf_tok" });
      expect(res.status).toBe(403);
    }
  });

  test("forwards allowlisted calls with the bearer token", async () => {
    const calls = stubUpstream();
    const res = await proxy(
      { path: `/accounts/${ACCOUNT}/pages/projects`, method: "POST", body: { name: "site" } },
      { "X-CF-Token": "cf_tok" },
    );
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/pages/projects`,
    );
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer cf_tok");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ name: "site" });
  });

  test("passes upstream status and body through", async () => {
    stubUpstream(404, { success: false, errors: [{ code: 8_000_007, message: "not found" }] });
    const res = await proxy(
      { path: `/accounts/${ACCOUNT}/pages/projects/missing` },
      { "X-CF-Token": "cf_tok" },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(false);
  });

  test("rejects malformed JSON bodies", async () => {
    stubUpstream();
    const urlStr = "http://localhost/__studio/cf/proxy";
    const req = new Request(urlStr, {
      body: "{not json",
      headers: { "Content-Type": "application/json", "X-CF-Token": "cf_tok" },
      method: "POST",
    });
    const res = await handleStudioApi(req, new URL(urlStr), ROOT);
    expect(res?.status).toBe(400);
  });
});
