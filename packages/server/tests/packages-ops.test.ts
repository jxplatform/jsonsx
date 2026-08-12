import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  addPackage,
  bunExecutable,
  dependenciesNeedInstall,
  fetchLatestVersion,
  installDependencies,
  isRegistryRange,
  listPackages,
  outdatedPackages,
  removePackage,
  setPackageVersions,
  stripRange,
} from "../src/packages";

const BUN = bunExecutable();

let dir: string;

function writePkg(content: object) {
  writeFileSync(join(dir, "package.json"), JSON.stringify(content, null, 2));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jx-pkg-ops-"));
});

afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

// ─── pure helpers ─────────────────────────────────────────────────────────────

describe("stripRange / isRegistryRange", () => {
  test("strips range prefixes to base version", () => {
    expect(stripRange("^0.19.0")).toBe("0.19.0");
    expect(stripRange("~1.2.3")).toBe("1.2.3");
    expect(stripRange(">=2.0.0")).toBe("2.0.0");
    expect(stripRange("1.0.0")).toBe("1.0.0");
  });

  test("flags only plain registry semver ranges", () => {
    expect(isRegistryRange("^1.2.3")).toBe(true);
    expect(isRegistryRange("1.0.0")).toBe(true);
    expect(isRegistryRange("workspace:^")).toBe(false);
    expect(isRegistryRange("file:../x")).toBe(false);
    expect(isRegistryRange("*")).toBe(false);
    expect(isRegistryRange("latest")).toBe(false);
  });
});

describe("bunExecutable", () => {
  test("resolves to the bun running this process (not a bare PATH lookup)", () => {
    // Packaged desktop apps have no system `bun`; we must spawn the bundled one via execPath.
    expect(BUN).toBe(process.execPath);
    expect(BUN).not.toBe("bun");
  });
});

// ─── listPackages / dependenciesNeedInstall ─────────────────────────────────────

describe("listPackages", () => {
  test("merges dependencies and devDependencies, tagging dev", async () => {
    writePkg({
      dependencies: { hono: "^4" },
      devDependencies: { "@jxsuite/compiler": "^0.19.0" },
    });
    const pkgs = await listPackages(dir);
    expect(pkgs).toContainEqual({ name: "hono", version: "^4" });
    expect(pkgs).toContainEqual({ dev: true, name: "@jxsuite/compiler", version: "^0.19.0" });
  });

  test("returns [] with no package.json and tolerates broken json", async () => {
    expect(await listPackages(dir)).toEqual([]);
    writeFileSync(join(dir, "package.json"), "{broken");
    expect(await listPackages(dir)).toEqual([]);
  });
});

describe("dependenciesNeedInstall", () => {
  test("true only when package.json present and node_modules missing", () => {
    expect(dependenciesNeedInstall(dir)).toBe(false); // No package.json
    writePkg({ dependencies: {} });
    expect(dependenciesNeedInstall(dir)).toBe(true);
    mkdirSync(join(dir, "node_modules"));
    expect(dependenciesNeedInstall(dir)).toBe(false);
  });
});

// ─── fetchLatestVersion / outdatedPackages (fetch injected) ─────────────────────

describe("fetchLatestVersion", () => {
  test("returns version from an ok response", async () => {
    const f = async () => Response.json({ version: "1.2.3" }, { status: 200 });
    expect(await fetchLatestVersion("pkg", f)).toBe("1.2.3");
  });

  test("asks for a format the VERSION endpoint actually serves", async () => {
    /*
     * It asked for `application/vnd.npm.install-v1+json`, which is the abbreviated PACKUMENT
     * format. On `/<name>/latest` the registry answers that with an empty body for most packages —
     * `@jxsuite/schema`, `@jxsuite/parser` and `lit` all return nothing, while `wrangler` happens to
     * answer normally. `res.json()` then throws, the catch turns it into `null`, and `null` reads
     * as "nothing newer": every outdated dependency went unreported and it looked like a quiet
     * registry rather than a broken request.
     *
     * A fetch-injecting test cannot see that — it answers whatever the header says. So this pins
     * the DECISION instead, with the reason, which is the part a future edit would otherwise undo.
     */
    let seen: HeadersInit | undefined;
    await fetchLatestVersion("pkg", async (_url, init) => {
      seen = init?.headers;
      return Response.json({ version: "1.2.3" }, { status: 200 });
    });
    expect((seen as Record<string, string>).accept).toBe("application/json");
  });

  test("returns null on non-ok and on throw", async () => {
    const notOk = async () => new Response("no", { status: 404 });
    expect(await fetchLatestVersion("pkg", notOk)).toBeNull();
    const boom = async (): Promise<Response> => {
      throw new Error("network");
    };
    expect(await fetchLatestVersion("pkg", boom)).toBeNull();
  });
});

describe("outdatedPackages", () => {
  test("reports deps with a newer latest and skips non-registry specs", async () => {
    writePkg({
      dependencies: { hono: "^4.0.0", local: "file:../x", ws: "workspace:^" },
      devDependencies: { "@jxsuite/compiler": "^0.19.0" },
    });
    const latestByName: Record<string, string> = {
      "@jxsuite/compiler": "0.30.1",
      hono: "4.0.0",
    };
    const f = async (input: string) => {
      const name = decodeURIComponent(
        input.replace("https://registry.npmjs.org/", "").replace("/latest", ""),
      );
      return Response.json({ version: latestByName[name] ?? "0.0.0" }, { status: 200 });
    };

    const out = await outdatedPackages(dir, f);
    const names = out.map((o) => o.name);
    expect(names).toContain("@jxsuite/compiler"); // 0.19.0 -> 0.30.1
    expect(names).not.toContain("hono"); // Already at latest base
    expect(names).not.toContain("local"); // Skipped (file: spec)
    expect(names).not.toContain("ws"); // Skipped (workspace: spec)
    const jx = out.find((o) => o.name === "@jxsuite/compiler");
    expect(jx?.latest).toBe("0.30.1");
    expect(jx?.dev).toBe(true);
  });
});

// ─── installDependencies / setPackageVersions (Bun.spawn stubbed) ───────────────

describe("install / set-versions with stubbed spawn", () => {
  let origSpawn: typeof Bun.spawn;
  let spawned: string[][];

  beforeEach(() => {
    origSpawn = Bun.spawn;
    spawned = [];
    (Bun as unknown as { spawn: unknown }).spawn = (cmd: string[]) => {
      spawned.push(cmd);
      return { exited: Promise.resolve(0), stderr: "", stdout: "done" };
    };
  });

  afterEach(() => {
    (Bun as unknown as { spawn: unknown }).spawn = origSpawn;
  });

  test("installDependencies runs `bun install` and reports ok", async () => {
    const res = await installDependencies(dir);
    expect(res.ok).toBe(true);
    expect(spawned[0]).toEqual([BUN, "install"]);
  });

  test("addPackage runs `bun add`, with -d for dev deps", async () => {
    await addPackage(dir, "hono");
    expect(spawned.at(-1)).toEqual([BUN, "add", "hono"]);
    await addPackage(dir, "vitest", true);
    expect(spawned.at(-1)).toEqual([BUN, "add", "-d", "vitest"]);
  });

  test("removePackage runs `bun remove`", async () => {
    await removePackage(dir, "hono");
    expect(spawned.at(-1)).toEqual([BUN, "remove", "hono"]);
  });

  test("setPackageVersions fails on an unparseable package.json", async () => {
    writeFileSync(join(dir, "package.json"), "{broken");
    const res = await setPackageVersions(dir, [{ name: "x", version: "^1" }]);
    expect(res.ok).toBe(false);
    expect(spawned.length).toBe(0);
  });

  test("setPackageVersions preserves placement, adds new to deps, then reinstalls", async () => {
    writePkg({
      dependencies: { hono: "^4" },
      devDependencies: { "@jxsuite/compiler": "^0.19.0" },
    });
    const res = await setPackageVersions(dir, [
      { name: "@jxsuite/compiler", version: "^0.30.1" },
      { name: "hono", version: "^4.5.0" },
      { dev: false, name: "new-dep", version: "^1.0.0" },
    ]);
    expect(res.ok).toBe(true);
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    expect(pkg.devDependencies["@jxsuite/compiler"]).toBe("^0.30.1"); // Stayed in devDeps
    expect(pkg.dependencies.hono).toBe("^4.5.0"); // Stayed in deps
    expect(pkg.dependencies["new-dep"]).toBe("^1.0.0"); // New -> deps
    expect(spawned.at(-1)).toEqual([BUN, "install"]);
  });

  test("setPackageVersions no-ops on empty updates and fails without package.json", async () => {
    const empty = await setPackageVersions(dir, []);
    expect(empty.ok).toBe(true);
    expect(spawned.length).toBe(0);

    const missing = await setPackageVersions(dir, [{ name: "x", version: "^1" }]);
    expect(missing.ok).toBe(false);
  });
});
