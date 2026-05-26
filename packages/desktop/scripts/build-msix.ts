import { cp, mkdir, rm, rename, writeFile } from "fs/promises";
import { existsSync, cpSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import { execSync } from "child_process";
import { generateUpdateMetadata } from "electrobun-builder-for-windows/dist/update.js";
import { loadConfig } from "electrobun-builder-for-windows/dist/config.js";
import { checkDependencies } from "electrobun-builder-for-windows/dist/utils/deps.js";
import sharp from "sharp";

if (process.platform !== "win32") {
  console.log("[build-msix] Skipping MSIX build (not Windows)");
  process.exit(0);
}

const projectRoot = join(import.meta.dir, "..");
const config = await loadConfig(projectRoot);

await checkDependencies("msix", false);

const distDir = join(projectRoot, "dist");
const stageDir = join(distDir, "msix-stage");

if (existsSync(stageDir)) await rm(stageDir, { recursive: true });
mkdirSync(stageDir, { recursive: true });

const appName = config.name || "ElectrobunApp";
const version = config.version || "1.0.0";
const quadVersion = version.split(".").length === 3 ? `${version}.0` : version;
const winConfig = config.windows;
const msixConfig = winConfig?.msix;
const identifier =
  config.id ||
  msixConfig?.identityName ||
  `com.example.${appName.toLowerCase().replace(/\s/g, "")}`;
const publisher = msixConfig?.publisher || "CN=Electrobun";
const publisherDisplayName =
  msixConfig?.publisherDisplayName || config.author || "Electrobun Developer";

// 1. Copy app files into staging directory
const appFolderName = winConfig?.installDir || appName;
const buildRootDir = join(projectRoot, "build", "stable-win-x64");
const appSourceDir = join(buildRootDir, appFolderName);
const sourceDir = existsSync(appSourceDir) ? appSourceDir : buildRootDir;

console.log(`[build-msix] Copying app files from ${sourceDir}`);
cpSync(sourceDir, stageDir, { recursive: true });

// 2. Ensure launcher is renamed to <AppName>.exe at staging root
const launcherInBin = join(stageDir, "bin", "launcher");
const launcherExe = join(stageDir, "bin", "launcher.exe");
const targetExe = join(stageDir, `${appName}.exe`);

if (existsSync(launcherInBin)) {
  await rename(launcherInBin, targetExe);
  console.log(`[build-msix] Moved bin/launcher → ${appName}.exe`);
} else if (existsSync(launcherExe)) {
  await rename(launcherExe, targetExe);
  console.log(`[build-msix] Moved bin/launcher.exe → ${appName}.exe`);
}

// 3. Generate MSIX assets from icon
const assetsDir = join(stageDir, "Assets");
mkdirSync(assetsDir, { recursive: true });

const iconPath = winConfig?.icon ? resolve(projectRoot, winConfig.icon) : null;
const assets = [
  { name: "StoreLogo.png", size: 50 },
  { name: "Square150x150Logo.png", size: 150 },
  { name: "Square44x44Logo.png", size: 44 },
  { name: "Wide310x150Logo.png", size: [310, 150] as [number, number] },
  { name: "SplashScreen.png", size: [620, 300] as [number, number] },
];

for (const asset of assets) {
  const assetPath = join(assetsDir, asset.name);
  if (iconPath && existsSync(iconPath)) {
    const s = sharp(iconPath);
    if (Array.isArray(asset.size)) {
      await s
        .resize(asset.size[0], asset.size[1], {
          fit: "contain",
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .toFile(assetPath);
    } else {
      await s.resize(asset.size, asset.size).toFile(assetPath);
    }
  }
}

// 4. Generate AppxManifest.xml
const capabilities = msixConfig?.capabilities
  ? msixConfig.capabilities.map((c: string) => `    <Capability Name="${c}" />`).join("\n")
  : "";

const manifest = `<?xml version="1.0" encoding="utf-8"?>
<Package
  xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities">

  <Identity
    Name="${identifier}"
    Publisher="${publisher}"
    Version="${quadVersion}"
    ProcessorArchitecture="x64" />

  <Properties>
    <DisplayName>${appName}</DisplayName>
    <PublisherDisplayName>${publisherDisplayName}</PublisherDisplayName>
    <Logo>Assets\\StoreLogo.png</Logo>
  </Properties>

  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.17763.0" MaxVersionTested="10.0.26100.0" />
  </Dependencies>

  <Resources>
    <Resource Language="en-US" />
  </Resources>

  <Applications>
    <Application Id="App" Executable="${appName}.exe" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements
        DisplayName="${appName}"
        Description="${appName}"
        BackgroundColor="#000000"
        Square150x150Logo="Assets\\Square150x150Logo.png"
        Square44x44Logo="Assets\\Square44x44Logo.png">
        <uap:DefaultTile Wide310x150Logo="Assets\\Wide310x150Logo.png" />
        <uap:SplashScreen Image="Assets\\SplashScreen.png" />
      </uap:VisualElements>
    </Application>
  </Applications>

  <Capabilities>
    <rescap:Capability Name="runFullTrust" />
    ${capabilities}
  </Capabilities>
</Package>`;

await writeFile(join(stageDir, "AppxManifest.xml"), manifest);

// 5. Run makeappx
const outputFilename = `${appName}_${quadVersion}_x64.msix`;
const outputPath = join(distDir, outputFilename);

console.log(`[build-msix] Creating MSIX: ${outputPath}`);
execSync(`makeappx pack /d "${stageDir}" /p "${outputPath}" /o`, { stdio: "inherit" });
console.log(`[build-msix] MSIX created successfully`);

// 6. Generate update metadata
const baseUrl = "https://github.com/jxsuite/jx/releases/latest/download/";
await generateUpdateMetadata(outputPath, version, baseUrl, distDir);

// 7. Copy artifacts
const artifactsDir = join(projectRoot, "artifacts");
await mkdir(artifactsDir, { recursive: true });

const distFiles = new Bun.Glob("*.{msix,json}");
for await (const file of distFiles.scan(distDir)) {
  await cp(join(distDir, file), join(artifactsDir, file));
  console.log(`[build-msix] Copied ${file} → artifacts/`);
}
