import { $ } from "bun";
import { cp, mkdir, readFile, writeFile } from "fs/promises";
import { join, resolve } from "path";
import { existsSync, readdirSync, unlinkSync, mkdirSync, copyFileSync } from "fs";
import { createHash } from "crypto";

if (process.platform !== "win32") {
  console.log("[build-msi] Skipping MSI build (not Windows)");
  process.exit(0);
}

const desktopDir = resolve(import.meta.dir, "..");
const distDir = join(desktopDir, "dist");
const artifactsDir = join(desktopDir, "artifacts");
await mkdir(distDir, { recursive: true });
await mkdir(artifactsDir, { recursive: true });

const buildDir = join(desktopDir, "build", "stable-win-x64", "JxStudio");
if (!existsSync(buildDir)) {
  console.error("[build-msi] Build dir not found. Run 'bunx electrobun build --env=stable' first.");
  process.exit(1);
}

// Resolve electrobun dist
const localDist = join(desktopDir, "node_modules", "electrobun", "dist-win-x64");
const rootDist = join(desktopDir, "..", "..", "node_modules", "electrobun", "dist-win-x64");
const electrobunDist = existsSync(localDist) ? localDist : rootDist;
if (!existsSync(electrobunDist)) {
  console.error("[build-msi] Cannot find electrobun/dist-win-x64.");
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
if (!existsSync(binDir)) mkdirSync(binDir, { recursive: true });

const filesToCopy = [
  "launcher.exe",
  "bun.exe",
  "libNativeWrapper.dll",
  "WebView2Loader.dll",
  "d3dcompiler_47.dll",
  "webgpu_dawn.dll",
  "process_helper.exe",
];
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
if (existsSync(extensionlessLauncher)) unlinkSync(extensionlessLauncher);
const junkFiles = ["Info.plist"];
for (const name of junkFiles) {
  const p = join(buildDir, name);
  if (existsSync(p)) unlinkSync(p);
}

// --- Step 3: Apply icon to launcher.exe ---
const iconPath = resolve(desktopDir, "icon.ico");
if (existsSync(iconPath)) {
  const launcherExe = join(binDir, "launcher.exe");
  try {
    const { rcedit } = await import("rcedit");
    await rcedit(launcherExe, { icon: iconPath });
    console.log("[build-msi] Applied icon to launcher.exe");
  } catch (e) {
    console.warn(`[build-msi] rcedit failed: ${e}. Continuing without icon.`);
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
const updateMetadata = {
  version: pkg.version,
  url: `${baseUrl}v${pkg.version}/JxStudio.msi`,
  sha256,
  date: new Date().toISOString(),
};
await writeFile(join(distDir, "latest.json"), JSON.stringify(updateMetadata, null, 2));

// --- Step 6: Copy artifacts ---
const distFiles = new Bun.Glob("*.{msi,json}");
for await (const file of distFiles.scan(distDir)) {
  await cp(join(distDir, file), join(artifactsDir, file));
  console.log(`[build-msi] Copied ${file} → artifacts/`);
}
