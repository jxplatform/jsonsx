import { resolve } from "node:path";
import { getProjectRoot } from "./handlers";
import type { PackageInfo } from "./rpc-schema";

export async function addPackage(params: { name: string }): Promise<void> {
  const root = getProjectRoot();
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

export async function removePackage(params: { name: string }): Promise<void> {
  const root = getProjectRoot();
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

export async function listPackages(): Promise<PackageInfo[]> {
  const root = getProjectRoot();
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
