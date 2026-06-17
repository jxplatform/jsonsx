import { resolve } from "node:path";
import { getProjectRoot } from "./handlers";
import type { PackageInfo } from "./rpc-schema";

/** Build package operations bound to one project session (its projectRoot is the package cwd). */
export function createPackageOps(session: { readonly projectRoot: string | null }) {
  async function addPackage(params: { name: string }): Promise<void> {
    const root = session.projectRoot;
    if (!root) {
      throw new Error("No project open");
    }
    const proc = Bun.spawn(["bun", "add", params.name], {
      cwd: root,
      stderr: "pipe",
      stdout: "pipe",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`Failed to add package: ${stderr.trim()}`);
    }
  }

  async function removePackage(params: { name: string }): Promise<void> {
    const root = session.projectRoot;
    if (!root) {
      throw new Error("No project open");
    }
    const proc = Bun.spawn(["bun", "remove", params.name], {
      cwd: root,
      stderr: "pipe",
      stdout: "pipe",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`Failed to remove package: ${stderr.trim()}`);
    }
  }

  async function listPackages(): Promise<PackageInfo[]> {
    const root = session.projectRoot;
    if (!root) {
      return [];
    }
    const pkgPath = resolve(root, "package.json");
    const file = Bun.file(pkgPath);
    if (!(await file.exists())) {
      return [];
    }

    const pkg = await file.json();
    const deps = pkg.dependencies || {};
    return Object.entries(deps).map(([name, version]) => ({
      name,
      version: version as string,
    }));
  }

  return { addPackage, removePackage, listPackages };
}

// ─── Legacy free functions (default process-global session via getProjectRoot) ──

const _legacy = createPackageOps({
  get projectRoot() {
    return getProjectRoot();
  },
});

export const { addPackage } = _legacy;
export const { removePackage } = _legacy;
export const { listPackages } = _legacy;
