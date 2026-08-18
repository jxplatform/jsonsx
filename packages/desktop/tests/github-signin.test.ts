/**
 * The desktop's RFC 8252 sign-in and the 0600 credential store behind it.
 *
 * `node:os` is mocked to a temp home BEFORE the store (and env-paths, which captures homedir at
 * module load) is imported, matching settings-store.test.ts. `./utils` is mocked because handing a
 * URL to the OS is the one thing this flow does that a test must not actually do.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const HOME = mkdtempSync(join(process.env.TMPDIR || "/tmp", "jx-credentials-"));
process.env.XDG_CONFIG_HOME = join(HOME, ".config");

void mock.module("node:os", () => {
  const homedir = () => HOME;
  const tmpdir = () => "/tmp";
  return { default: { homedir, tmpdir }, homedir, tmpdir };
});

/** URLs the flow tried to hand to the OS, and whether the handoff "worked". */
const opened: string[] = [];
let openSucceeds = true;
void mock.module("../src/utils", () => ({
  openExternal: (url: string) => {
    opened.push(url);
    return openSucceeds;
  },
}));

const { readCredential, writeCredential } = await import("../src/credential-store");
const { configFile } = await import("../src/user-config");
const { GITHUB_CREDENTIAL, githubSignIn, githubSignOut, githubTokenStatus, setAuthorizationHost } =
  await import("../src/github-signin");
const { createLoopbackAuthorizer } = await import("@jxsuite/server/oauth-loopback");

function storePath(): string {
  return configFile("credentials.json");
}

beforeEach(() => {
  rmSync(dirname(storePath()), { force: true, recursive: true });
  opened.length = 0;
  openSucceeds = true;
  setAuthorizationHost(null);
});

afterAll(() => {
  rmSync(HOME, { force: true, recursive: true });
});

describe("the credential store", () => {
  test("round-trips a value and forgets it on null", async () => {
    expect(await readCredential("x")).toBeNull();
    await writeCredential("x", "secret");
    expect(await readCredential("x")).toBe("secret");
    await writeCredential("x", null);
    expect(await readCredential("x")).toBeNull();
  });

  test("the file is owner-only", async () => {
    await writeCredential("x", "secret");
    if (process.platform !== "win32") {
      // 0600. A token protected only by filesystem permissions must at least have those.
      // oxlint-disable-next-line no-bitwise -- mode bits are a bitfield
      expect(statSync(storePath()).mode & 0o777).toBe(0o600);
    }
  });

  test("a corrupt store reads as empty rather than throwing", async () => {
    await Bun.write(storePath(), "{ not json");
    expect(await readCredential("x")).toBeNull();
    // And it is writable again afterwards.
    await writeCredential("x", "y");
    expect(await readCredential("x")).toBe("y");
  });

  /*
   * Valid JSON that is not an object of entries — an array, a bare string, `null`. The parse
   * succeeds, so the corrupt-file guard never fires, and `Object.entries` on a non-object would
   * silently yield a store with the wrong shape.
   */
  test("a store that parses but is not an object reads as empty", async () => {
    for (const contents of ["[1,2,3]", '"a string"', "null", "42"]) {
      await Bun.write(storePath(), contents);
      expect({ contents, value: await readCredential("x") }).toEqual({ contents, value: null });
    }
    // Still writable afterwards, so a bad file is never a permanent state.
    await writeCredential("x", "y");
    expect(await readCredential("x")).toBe("y");
  });

  test("non-string entries are dropped", async () => {
    await Bun.write(storePath(), JSON.stringify({ n: 5, s: "ok" }));
    expect(await readCredential("n")).toBeNull();
    expect(await readCredential("s")).toBe("ok");
  });
});

describe("githubTokenStatus and githubSignOut", () => {
  test("report and clear whether a token exists — never the token itself", async () => {
    expect(await githubTokenStatus()).toEqual({ stored: false });
    await writeCredential(GITHUB_CREDENTIAL, "gho_stored");
    expect(await githubTokenStatus()).toEqual({ stored: true });
    expect(await githubSignOut()).toEqual({ ok: true });
    expect(await githubTokenStatus()).toEqual({ stored: false });
  });
});

describe("githubSignIn", () => {
  test("returns the stored token without sending anyone to a browser", async () => {
    await writeCredential(GITHUB_CREDENTIAL, "gho_stored");
    expect(await githubSignIn()).toEqual({ token: "gho_stored" });
    expect(opened).toEqual([]);
  });

  test("says so when no loopback server hosts the redirect", async () => {
    // Better than opening a browser at a redirect URI nothing is listening on.
    expect(githubSignIn()).rejects.toThrow("no loopback server to redirect to");
  });

  test("opens the provider's own page, at a literal 127.0.0.1 redirect", async () => {
    const authorizer = createLoopbackAuthorizer();
    setAuthorizationHost({ authorizer, port: 4321 });

    const signIn = githubSignIn({ force: true });
    // Let begin() reach openExternal.
    await Bun.sleep(1);

    expect(opened).toHaveLength(1);
    const authorizeUrl = new URL(opened[0]!);
    expect(authorizeUrl.origin).toBe("https://github.com");
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:4321/__jx_oauth__/callback",
    );
    expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizeUrl.searchParams.get("scope")).toBe("repo");

    authorizer.stop();
    expect(signIn).rejects.toThrow("stopped before the sign-in completed");
  });

  test("a browser that will not open abandons the authorization rather than hanging", async () => {
    const authorizer = createLoopbackAuthorizer();
    setAuthorizationHost({ authorizer, port: 4321 });
    openSucceeds = false;

    expect(githubSignIn({ force: true })).rejects.toThrow("Could not open a browser");
    await Bun.sleep(5);
    // The state is not left behind for a callback that can never arrive.
    expect(authorizer.pending()).toBe(0);
  });
});
