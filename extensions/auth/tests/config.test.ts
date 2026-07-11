/**
 * Config.test.ts — the auth section → BetterAuthOptions mapping: connection defaulting, the
 * fail-closed secret lookup (env NAMES only, specs/extensions.md §13), social-provider env
 * resolution with derived defaults, the roles → user.additionalFields.role wiring, and the
 * SessionInfo mapping shared by server and client paths.
 */

import { describe, expect, test } from "bun:test";
import {
  AUTH_BASE_PATH,
  buildAuthOptions,
  DEFAULT_SECRET_ENV,
  resolveAuthConnectionName,
  resolveAuthSecret,
  resolveSocialProviders,
  toSessionInfo,
} from "../src/config";

describe("resolveAuthConnectionName", () => {
  test("prefers the declared connection, else the first-declared one", () => {
    const config = { connections: { first: { provider: "sqlite" }, second: { provider: "d1" } } };
    expect(resolveAuthConnectionName({ connection: "second" }, config)).toBe("second");
    expect(resolveAuthConnectionName({}, config)).toBe("first");
  });

  test("no connections at all is a clear error", () => {
    expect(() => resolveAuthConnectionName({}, {})).toThrow(/declares none/);
  });
});

describe("resolveAuthSecret", () => {
  test("reads env[secretEnv] with the BETTER_AUTH_SECRET default", () => {
    expect(DEFAULT_SECRET_ENV).toBe("BETTER_AUTH_SECRET");
    expect(resolveAuthSecret({}, { BETTER_AUTH_SECRET: "s3cret" })).toBe("s3cret");
    expect(resolveAuthSecret({ secretEnv: "MY_SECRET" }, { MY_SECRET: "other" })).toBe("other");
  });

  test("fails closed naming the missing env var", () => {
    expect(() => resolveAuthSecret({}, {})).toThrow(/BETTER_AUTH_SECRET/);
    expect(() => resolveAuthSecret({ secretEnv: "MY_SECRET" }, { MY_SECRET: "" })).toThrow(
      /MY_SECRET/,
    );
  });
});

describe("resolveSocialProviders", () => {
  test("resolves declared env names and derives <ID>_CLIENT_ID defaults", () => {
    const section = {
      providers: {
        github: {},
        google: { clientIdEnv: "G_ID", clientSecretEnv: "G_SECRET" },
      },
    };
    const env = {
      G_ID: "google-id",
      G_SECRET: "google-secret",
      GITHUB_CLIENT_ID: "gh-id",
      GITHUB_CLIENT_SECRET: "gh-secret",
    };
    expect(resolveSocialProviders(section, env)).toEqual({
      github: { clientId: "gh-id", clientSecret: "gh-secret" },
      google: { clientId: "google-id", clientSecret: "google-secret" },
    });
  });

  test("omits providers with unresolved credentials (fail-closed)", () => {
    const section = { providers: { github: {}, google: {} } };
    expect(resolveSocialProviders(section, { GITHUB_CLIENT_ID: "id-only" })).toEqual({});
    expect(resolveSocialProviders({}, {})).toEqual({});
  });
});

describe("buildAuthOptions", () => {
  test("maps methods, providers, roles, trustedOrigins, database, and secret", () => {
    const section = {
      methods: { emailPassword: true },
      providers: { github: {} },
      roles: ["admin"],
      trustedOrigins: ["https://example.com"],
    };
    const env = { GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "sec" };
    const database = { dialect: {}, type: "sqlite" };
    const options = buildAuthOptions(section, env, { database, secret: "shh" });

    expect(options.basePath).toBe(AUTH_BASE_PATH);
    expect(options.emailAndPassword).toEqual({ enabled: true });
    expect(options.socialProviders).toEqual({ github: { clientId: "id", clientSecret: "sec" } });
    expect(options.user).toEqual({
      additionalFields: { role: { input: false, required: false, type: "string" } },
    });
    expect(options.trustedOrigins).toEqual(["https://example.com"]);
    expect(options.database).toBe(database);
    expect(options.secret).toBe("shh");
  });

  test("BETTER_AUTH_URL pins the base URL when present", () => {
    expect(buildAuthOptions({}, { BETTER_AUTH_URL: "https://site.test" }).baseURL).toBe(
      "https://site.test",
    );
    expect(buildAuthOptions({}, {})).not.toHaveProperty("baseURL");
  });

  test("email/password defaults on; empty extras stay absent", () => {
    const options = buildAuthOptions({}, {});
    expect(options.emailAndPassword).toEqual({ enabled: true });
    expect(options).not.toHaveProperty("socialProviders");
    expect(options).not.toHaveProperty("user");
    expect(options).not.toHaveProperty("trustedOrigins");
    expect(options).not.toHaveProperty("database");
    expect(options).not.toHaveProperty("secret");

    const disabled = buildAuthOptions({ methods: { emailPassword: false } }, {});
    expect(disabled.emailAndPassword).toEqual({ enabled: false });
  });
});

describe("toSessionInfo", () => {
  test("maps user id, role, and payload; keeps the raw user and session", () => {
    const data = {
      session: { token: "t" },
      user: { email: "kevin@example.com", id: "u1", role: "admin" },
    };
    const info = toSessionInfo(data)!;
    expect(info.userId).toBe("u1");
    expect(info.role).toBe("admin");
    expect(info.user).toEqual(data.user);
    expect(info.session).toEqual(data.session);
  });

  test("null/malformed payloads and role-less users normalize cleanly", () => {
    expect(toSessionInfo(null)).toBeNull();
    expect(toSessionInfo("nope")).toBeNull();
    expect(toSessionInfo({})).toBeNull();
    expect(toSessionInfo({ user: { name: "no id" } })).toBeNull();

    const info = toSessionInfo({ user: { id: "u2", role: null } })!;
    expect(info.userId).toBe("u2");
    expect(info.role).toBeUndefined();
    expect(info).not.toHaveProperty("session");
  });
});
