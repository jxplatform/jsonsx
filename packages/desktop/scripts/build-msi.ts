import { $ } from "bun";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { copyFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  WINDOWS_RUNTIME_FILES,
  describeRuntimeSearch,
  resolveWindowsRuntime,
} from "./electrobun-runtime.ts";
import hutchConfig from "../hutch.config.ts";

if (process.platform !== "win32") {
  console.log("[build-msi] Skipping MSI build (not Windows)");
  process.exit(0);
}

const desktopDir = resolve(import.meta.dir, "..");
const distDir = join(desktopDir, "dist");
const artifactsDir = join(desktopDir, "artifacts");
await mkdir(distDir, { recursive: true });
await mkdir(artifactsDir, { recursive: true });

const buildDir = join(desktopDir, "build", "production-win-x64", "JxStudio");
if (!existsSync(buildDir)) {
  console.error(
    "[build-msi] Build dir not found. Run 'hutch electrobun build --env=production' first.",
  );
  process.exit(1);
}

// Electrobun 2 keeps no runtime in node_modules; Hutch caches it per pinned version. The pin is
// Read from hutch.config.ts so this cannot drift from what the build actually used. See
// Scripts/electrobun-runtime.ts for the cache layout and the fallback search.
const { dir: electrobunDist, searched } = resolveWindowsRuntime(hutchConfig.electrobun.version);
if (!electrobunDist) {
  console.error(`[build-msi] ${describeRuntimeSearch(searched)}`);
  process.exit(1);
}

// --- Step 1: Decompress tar.zst if needed ---
const resourcesDir = join(buildDir, "Resources");
if (existsSync(resourcesDir) && !existsSync(join(resourcesDir, "app"))) {
  const files = readdirSync(resourcesDir);
  const tarZstFile = files.find((f) => f.endsWith(".tar.zst"));
  if (tarZstFile) {
    const zstdPath = join(electrobunDist, "zig-zstd.exe");
    const tarZstPath = join(resourcesDir, tarZstFile);
    const tarPath = tarZstPath.replace(".zst", "");
    console.log(`[build-msi] Decompressing: ${tarZstFile}`);
    await $`${zstdPath} decompress -i ${tarZstPath} -o ${tarPath}`;
    await $`C:\\Windows\\System32\\tar.exe -xf ${tarPath} -C ${join(buildDir, "..")}`;
    unlinkSync(tarPath);
    unlinkSync(tarZstPath);
  }
}

// --- Step 2: Place runtime executables and DLLs ---
const binDir = join(buildDir, "bin");
if (!existsSync(binDir)) {
  mkdirSync(binDir, { recursive: true });
}

// The MSI installs the app's own Bun runtime alongside the shared set; the MSIX build instead
// Compiles a patched launcher into its own bun.exe, which is why that name is not shared.
const filesToCopy = [...WINDOWS_RUNTIME_FILES, "bun.exe"];
for (const file of filesToCopy) {
  const src = join(electrobunDist, file);
  const dest = join(binDir, file);
  if (existsSync(src) && !existsSync(dest)) {
    copyFileSync(src, dest);
  }
}

// Copy CEF files if present
const cefSrcDir = join(electrobunDist, "cef");
if (existsSync(cefSrcDir) && !existsSync(join(binDir, "cef"))) {
  console.log("[build-msi] Copying CEF runtime files...");
  await cp(cefSrcDir, join(binDir, "cef"), { recursive: true });
}

// Remove extensionless launcher (Linux artifact) and other cross-platform junk
const extensionlessLauncher = join(binDir, "launcher");
if (existsSync(extensionlessLauncher)) {
  unlinkSync(extensionlessLauncher);
}
const junkFiles = ["Info.plist"];
for (const name of junkFiles) {
  const p = join(buildDir, name);
  if (existsSync(p)) {
    unlinkSync(p);
  }
}

// --- Step 3: Apply icon to launcher.exe ---
const iconPath = resolve(desktopDir, "icon.ico");
if (existsSync(iconPath)) {
  const launcherExe = join(binDir, "launcher.exe");
  try {
    const { rcedit } = await import("rcedit");
    await rcedit(launcherExe, { icon: iconPath });
    console.log("[build-msi] Applied icon to launcher.exe");
  } catch (error) {
    console.warn(`[build-msi] rcedit failed: ${error}. Continuing without icon.`);
  }
}

// --- Step 4: Build MSI with WiX v7 ---
const pkg = JSON.parse(await readFile(join(desktopDir, "package.json"), "utf8"));
const appName = "Jx Studio";
const installDir = "JxStudio";
const manufacturer = "Avunu LLC";
const upgradeCode = "7c9863ff-c2cd-5555-89b5-0dfb32058702";

const wxsPath = join(import.meta.dir, "wix-template.wxs");
const msiOutput = join(distDir, "JxStudio.msi");

await $`wix build ${wxsPath} -arch x64 -o ${msiOutput} -d AppName=${appName} -d AppVersion=${pkg.version} -d Manufacturer=${manufacturer} -d UpgradeCode=${upgradeCode} -d InstallDir=${installDir} -d IconPath=${iconPath} -d AppSource=${buildDir}`;
console.log(`[build-msi] Created: ${msiOutput}`);

// --- Step 5: Generate update metadata ---
const msiBuffer = await Bun.file(msiOutput).arrayBuffer();
const sha256 = createHash("sha256").update(Buffer.from(msiBuffer)).digest("hex");
const baseUrl = "https://github.com/jxsuite/jx/releases/download/";
// The release tag is component-scoped (`desktop-v<version>`), passed in from CI.
// Fall back to reconstructing it for local builds.
const releaseTag = process.env.DESKTOP_RELEASE_TAG ?? `desktop-v${pkg.version}`;
const updateMetadata = {
  date: new Date().toISOString(),
  sha256,
  url: `${baseUrl}${releaseTag}/JxStudio.msi`,
  version: pkg.version,
};
await writeFile(join(distDir, "latest.json"), JSON.stringify(updateMetadata, null, 2));

// --- Step 6: Copy artifacts ---
const distFiles = new Bun.Glob("*.{msi,json}");
for await (const file of distFiles.scan(distDir)) {
  await cp(join(distDir, file), join(artifactsDir, file));
  console.log(`[build-msi] Copied ${file} → artifacts/`);
}
