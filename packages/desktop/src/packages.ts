import {
  addPackage as addPkg,
  dependenciesNeedInstall as needInstall,
  installDependencies as install,
  listPackages as list,
  outdatedPackages as outdated,
  removePackage as removePkg,
  setPackageVersions as setVersions,
} from "@jxsuite/server/packages";
import { getProjectRoot } from "./handlers";
import type { OutdatedInfo, PackageInfo, PackageOpResult } from "./rpc-schema";

/** Build package operations bound to one project session (its projectRoot is the package cwd). */
export function createPackageOps(session: { readonly projectRoot: string | null }) {
  function requireRoot(): string {
    const root = session.projectRoot;
    if (!root) {
      throw new Error("No project open");
    }
    return root;
  }

  async function addPackage(params: { name: string }): Promise<void> {
    const res = await addPkg(requireRoot(), params.name);
    if (!res.ok) {
      throw new Error(`Failed to add package: ${res.log ?? "bun add failed"}`);
    }
  }

  async function removePackage(params: { name: string }): Promise<void> {
    const res = await removePkg(requireRoot(), params.name);
    if (!res.ok) {
      throw new Error(`Failed to remove package: ${res.log ?? "bun remove failed"}`);
    }
  }

  async function listPackages(): Promise<PackageInfo[]> {
    const root = session.projectRoot;
    if (!root) {
      return [];
    }
    return list(root);
  }

  async function installDependencies(): Promise<PackageOpResult> {
    return install(requireRoot());
  }

  async function dependenciesNeedInstall(): Promise<boolean> {
    const root = session.projectRoot;
    if (!root) {
      return false;
    }
    return needInstall(root);
  }

  async function outdatedPackages(): Promise<OutdatedInfo[]> {
    const root = session.projectRoot;
    if (!root) {
      return [];
    }
    return outdated(root);
  }

  async function setPackageVersions(params: {
    updates: { name: string; version: string; dev?: boolean }[];
  }): Promise<PackageOpResult> {
    return setVersions(requireRoot(), params.updates);
  }

  return {
    addPackage,
    dependenciesNeedInstall,
    installDependencies,
    listPackages,
    outdatedPackages,
    removePackage,
    setPackageVersions,
  };
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
