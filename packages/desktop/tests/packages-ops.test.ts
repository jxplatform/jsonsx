// oxlint-disable typescript/await-thenable -- bun test .rejects matchers are typed `void` but return real Promises at runtime; the await is required.
import { beforeEach, describe, expect, mock, test } from "bun:test";

interface Call {
  fn: string;
  args: unknown[];
}

const calls: Call[] = [];
let opResult: { ok: boolean; log?: string } = { ok: true };

function record(fn: string, value: () => unknown) {
  return (...args: unknown[]) => {
    calls.push({ args, fn });
    return value();
  };
}

void mock.module("@jxsuite/server/packages", () => ({
  addPackage: record("addPackage", () => Promise.resolve(opResult)),
  dependenciesNeedInstall: record("dependenciesNeedInstall", () => true),
  installDependencies: record("installDependencies", () => Promise.resolve(opResult)),
  listPackages: record("listPackages", () => Promise.resolve([{ name: "x", version: "^1" }])),
  packageVersions: record("packageVersions", () =>
    Promise.resolve([{ current: "^1", latest: "2.0.0", name: "x" }]),
  ),
  removePackage: record("removePackage", () => Promise.resolve(opResult)),
  setPackageVersions: record("setPackageVersions", () => Promise.resolve(opResult)),
}));

const { createPackageOps } = await import("../src/packages");

const ROOT = "/tmp/jx-proj";
const withRoot = createPackageOps({
  get projectRoot() {
    return ROOT;
  },
});
const noRoot = createPackageOps({
  get projectRoot() {
    return null;
  },
});

beforeEach(() => {
  calls.length = 0;
  opResult = { ok: true };
});

describe("createPackageOps wrapper", () => {
  test("addPackage delegates with the root and throws on failure / no root", async () => {
    await withRoot.addPackage({ name: "y" });
    expect(calls).toContainEqual({ args: [ROOT, "y"], fn: "addPackage" });

    opResult = { log: "boom", ok: false };
    await expect(withRoot.addPackage({ name: "y" })).rejects.toThrow("Failed to add package: boom");
    await expect(noRoot.addPackage({ name: "y" })).rejects.toThrow("No project open");
  });

  test("removePackage delegates and throws on failure / no root", async () => {
    await withRoot.removePackage({ name: "y" });
    expect(calls).toContainEqual({ args: [ROOT, "y"], fn: "removePackage" });

    opResult = { ok: false };
    await expect(withRoot.removePackage({ name: "y" })).rejects.toThrow("Failed to remove package");
    await expect(noRoot.removePackage({ name: "y" })).rejects.toThrow("No project open");
  });

  test("listPackages delegates with root, returns [] without root", async () => {
    expect(await withRoot.listPackages()).toEqual([{ name: "x", version: "^1" }]);
    expect(await noRoot.listPackages()).toEqual([]);
  });

  test("installDependencies delegates / rejects without root", async () => {
    expect(await withRoot.installDependencies()).toEqual({ ok: true });
    expect(calls).toContainEqual({ args: [ROOT], fn: "installDependencies" });
    await expect(noRoot.installDependencies()).rejects.toThrow("No project open");
  });

  test("dependenciesNeedInstall delegates / false without root", async () => {
    expect(await withRoot.dependenciesNeedInstall()).toBe(true);
    expect(await noRoot.dependenciesNeedInstall()).toBe(false);
  });

  test("packageVersions delegates / [] without root", async () => {
    expect(await withRoot.packageVersions()).toEqual([
      { current: "^1", latest: "2.0.0", name: "x" },
    ]);
    expect(await noRoot.packageVersions()).toEqual([]);
  });

  test("setPackageVersions delegates with root + updates / rejects without root", async () => {
    const updates = [{ name: "x", version: "^2" }];
    expect(await withRoot.setPackageVersions({ updates })).toEqual({ ok: true });
    expect(calls).toContainEqual({ args: [ROOT, updates], fn: "setPackageVersions" });
    await expect(noRoot.setPackageVersions({ updates })).rejects.toThrow("No project open");
  });
});
