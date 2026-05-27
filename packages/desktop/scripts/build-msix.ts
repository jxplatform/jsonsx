import { $ } from "bun";
import { cp, mkdir, readFile, writeFile, rm, copyFile } from "fs/promises";
import { join, resolve } from "path";
import { existsSync, readdirSync, unlinkSync } from "fs";

if (process.platform !== "win32") {
  console.log("[build-msix] Skipping MSIX build (not Windows)");
  process.exit(0);
}

const desktopDir = resolve(import.meta.dir, "..");
const certPath = join(desktopDir, "certs", "jx-studio-dev.pfx");
const certPassword = "dev-cert-password";

const distDir = join(desktopDir, "dist");
const artifactsDir = join(desktopDir, "artifacts");
await mkdir(distDir, { recursive: true });
await mkdir(artifactsDir, { recursive: true });

const buildDir = join(desktopDir, "build", "stable-win-x64", "JxStudio");
if (!existsSync(buildDir)) {
  console.error(
    "[build-msix] Build dir not found. Run 'bunx electrobun build --env=stable' first.",
  );
  process.exit(1);
}

// Resolve electrobun dist (may be hoisted to workspace root in monorepos)
const localDist = join(desktopDir, "node_modules", "electrobun", "dist-win-x64");
const rootDist = join(desktopDir, "..", "..", "node_modules", "electrobun", "dist-win-x64");
const electrobunDist = existsSync(localDist) ? localDist : rootDist;
if (!existsSync(electrobunDist)) {
  console.error("[build-msix] Cannot find electrobun/dist-win-x64.");
  process.exit(1);
}

// --- Step 1: Decompress tar.zst archive if needed ---
const resourcesDir = join(buildDir, "Resources");
if (existsSync(resourcesDir) && !existsSync(join(resourcesDir, "app"))) {
  const files = readdirSync(resourcesDir);
  const tarZstFile = files.find((f) => f.endsWith(".tar.zst"));
  if (tarZstFile) {
    const zstdPath = join(electrobunDist, "zig-zstd.exe");
    const tarZstPath = join(resourcesDir, tarZstFile);
    const tarPath = tarZstPath.replace(".zst", "");
    console.log(`[build-msix] Decompressing: ${tarZstFile}`);
    await $`${zstdPath} decompress -i ${tarZstPath} -o ${tarPath}`;
    await $`C:\\Windows\\System32\\tar.exe -xf ${tarPath} -C ${join(buildDir, "..")}`;
    unlinkSync(tarPath);
    unlinkSync(tarZstPath);
  }
}

// --- Step 2: Place runtime files from electrobun dist ---
const binDir = join(buildDir, "bin");
const runtimeFiles = [
  "launcher.exe",
  "libNativeWrapper.dll",
  "WebView2Loader.dll",
  "d3dcompiler_47.dll",
  "webgpu_dawn.dll",
  "process_helper.exe",
];
for (const file of runtimeFiles) {
  const src = join(electrobunDist, file);
  if (existsSync(src)) await copyFile(src, join(binDir, file));
}

// Copy CEF files if present (bundleCEF: true)
const cefSrcDir = join(electrobunDist, "cef");
if (existsSync(cefSrcDir)) {
  console.log("[build-msix] Copying CEF runtime files...");
  await cp(cefSrcDir, join(binDir, "cef"), { recursive: true });
}

// --- Step 3: Patch main.js and compile into standalone exe ---
// MSIX Workers get EPERM reading files from C:\Program Files\WindowsApps.
// We patch the flat-files branch to copy the app entrypoint to %TEMP% before
// spawning the Worker, then compile the patched main.js into bun.exe.
const mainJsPath = join(buildDir, "Resources", "main.js");
let mainJsSrc = await readFile(mainJsPath, "utf8");

const flatFilesOriginal = `} else {
    console.log(\`[LAUNCHER] Loading app code from flat files\`);
    appEntrypointPath = join(appFolderPath, "bun", "index.js");
  }`;

const flatFilesPatched = `} else {
    console.log(\`[LAUNCHER] Loading app code from flat files\`);
    const __flatEntry = join(appFolderPath, "bun", "index.js");
    const __appData = __require("fs").readFileSync(__flatEntry, "utf8");
    const __tmpName = \`electrobun-\${Date.now()}-\${Math.random().toString(36).substring(7)}.js\`;
    appEntrypointPath = join(tmpdir(), __tmpName);
    writeFileSync(appEntrypointPath, __appData);
    console.log(\`[LAUNCHER] Copied app entrypoint to: \${appEntrypointPath}\`);
  }`;

if (mainJsSrc.includes("Loading app code from flat files")) {
  mainJsSrc = mainJsSrc.replace(flatFilesOriginal, flatFilesPatched);
  await writeFile(mainJsPath, mainJsSrc, "utf8");
  console.log("[build-msix] Patched main.js (flat-files → temp copy for MSIX Worker EPERM fix)");
} else {
  console.log("[build-msix] Warning: Could not find flat-files pattern in main.js, skipping patch");
}

const compiledExe = join(binDir, "bun.exe");
await $`bun build ${mainJsPath} --compile --outfile ${compiledExe}`;
console.log("[build-msix] Compiled main.js → bun.exe (standalone)");

// --- Step 4: Stage flat directory for MSIX ---
const msixStageDir = join(distDir, "msix-stage");
if (existsSync(msixStageDir)) await rm(msixStageDir, { recursive: true });
await cp(buildDir, msixStageDir, { recursive: true });

// Remove build tools, cross-platform artifacts, and unused libs
const junkFiles = ["zig-zstd.exe", "bspatch.exe", "Info.plist", "libasar.dll", "libasar-arm64.dll"];
for (const name of junkFiles) {
  for (const dir of [join(msixStageDir, "bin"), msixStageDir]) {
    const p = join(dir, name);
    if (existsSync(p)) unlinkSync(p);
  }
}
const extensionlessLauncher = join(msixStageDir, "bin", "launcher");
if (existsSync(extensionlessLauncher)) unlinkSync(extensionlessLauncher);

// --- Step 5: Copy pre-generated asset PNGs ---
const assetsDir = join(msixStageDir, "Assets");
await mkdir(assetsDir, { recursive: true });
for (const file of readdirSync(join(desktopDir, "msix-assets"))) {
  await copyFile(join(desktopDir, "msix-assets", file), join(assetsDir, file));
}

// --- Step 6: Generate AppxManifest.xml ---
const pkg = JSON.parse(await readFile(join(desktopDir, "package.json"), "utf8"));
const version = pkg.version;
const quadVersion = version.split(".").length === 3 ? `${version}.0` : version;

const manifest = `<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
         xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
         xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities">

  <Identity Name="AvunuLLC.JxStudio"
            Publisher="CN=118A192A-BE3D-4B35-A22B-EA889CD1D0B4"
            Version="${quadVersion}"
            ProcessorArchitecture="x64" />

  <Properties>
    <DisplayName>Jx Studio</DisplayName>
    <PublisherDisplayName>Avunu LLC</PublisherDisplayName>
    <Logo>Assets\\StoreLogo.png</Logo>
  </Properties>

  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.17763.0" MaxVersionTested="10.0.26100.0" />
  </Dependencies>

  <Resources>
    <Resource Language="en-US" />
  </Resources>

  <Applications>
    <Application Id="App" Executable="bin\\launcher.exe" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements DisplayName="Jx Studio"
                          Description="Jx Studio"
                          BackgroundColor="transparent"
                          Square150x150Logo="Assets\\Square150x150Logo.png"
                          Square44x44Logo="Assets\\Square44x44Logo.png">
        <uap:DefaultTile Wide310x150Logo="Assets\\Wide310x150Logo.png" />
        <uap:SplashScreen Image="Assets\\SplashScreen.png" />
      </uap:VisualElements>
    </Application>
  </Applications>

  <Capabilities>
    <Capability Name="internetClient" />
    <rescap:Capability Name="runFullTrust" />
  </Capabilities>
</Package>
`;

await writeFile(join(msixStageDir, "AppxManifest.xml"), manifest, "utf8");
console.log("[build-msix] Generated AppxManifest.xml");

// --- Step 7: Run makeappx ---
function findSdkTool(name: string): string {
  const kitsDir = "C:\\Program Files (x86)\\Windows Kits\\10\\bin";
  if (existsSync(kitsDir)) {
    const versions = readdirSync(kitsDir)
      .filter((d) => d.startsWith("10."))
      .sort()
      .reverse();
    for (const ver of versions) {
      const p = join(kitsDir, ver, "x64", `${name}.exe`);
      if (existsSync(p)) return p;
    }
  }
  return name;
}

const makeappx = findSdkTool("makeappx");
const outputMsix = join(distDir, `JxStudio_${quadVersion}_x64.msix`);
await $`${makeappx} pack /d ${msixStageDir} /p ${outputMsix} /o`;
console.log(`[build-msix] Created: ${outputMsix}`);

// --- Step 8: Sign if certificate exists ---
if (existsSync(certPath)) {
  const signtool = findSdkTool("signtool");
  try {
    await $`${signtool} sign /f ${certPath} /p ${certPassword} /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 ${outputMsix}`;
    console.log("[build-msix] Signed MSIX");
  } catch {
    console.error("[build-msix] Signing failed. Continuing without signature.");
  }
} else {
  console.log("[build-msix] No certificate found, skipping signing.");
}

// --- Step 9: Copy artifacts ---
const msixName = `JxStudio_${quadVersion}_x64.msix`;
await cp(outputMsix, join(artifactsDir, msixName));
console.log(`[build-msix] Done → artifacts/${msixName}`);
