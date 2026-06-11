import { $ } from "bun";
import { join, resolve } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { loadConfig } from "electrobun-builder-for-windows/dist/config.js";

const desktopDir = resolve(import.meta.dir, "..");
const certDir = join(desktopDir, "certs");
const certPath = join(certDir, "jx-studio-dev.pfx");
const certPassword = "dev-cert-password"; // Change this if needed

// Publisher in AppxManifest.xml Identity must exactly match the cert Subject
const config = await loadConfig(desktopDir);
const publisher: string = config.windows?.msix?.publisher ?? "CN=Jx Studio Dev";

if (!existsSync(certDir)) {
  console.log(`[sign-cert] Creating certs directory…`);
  mkdirSync(certDir, { recursive: true });
}

if (existsSync(certPath)) {
  console.log(`[sign-cert] Certificate already exists at ${certPath}`);
  console.log(`[sign-cert] To regenerate, delete ${certPath} and run again.`);
} else {
  console.log(`[sign-cert] Generating self-signed certificate…`);
  console.log(`[sign-cert] Using publisher subject: ${publisher}`);
  const pwshCmd = `
$cert = New-SelfSignedCertificate -Subject '${publisher}' -Type CodeSigningCert -CertStoreLocation 'cert:\\CurrentUser\\My' -KeyExportPolicy Exportable -KeyLength 2048 -HashAlgorithm SHA256 -NotAfter (Get-Date).AddYears(10)
$pwd = ConvertTo-SecureString -String '${certPassword}' -Force -AsPlainText
Export-PfxCertificate -Cert "cert:\\CurrentUser\\My\\$($cert.Thumbprint)" -FilePath '${certPath}' -Password $pwd -Force | Out-Null
Write-Host "Certificate exported to ${certPath}"
Write-Host "Certificate password: ${certPassword}"
  `;

  await $`powershell.exe -NoProfile -Command ${pwshCmd}`;
  console.log(`[sign-cert] Certificate generated successfully!`);
  console.log(`[sign-cert] Path: ${certPath}`);
  console.log(`[sign-cert] Password: ${certPassword}`);
  console.log(`[sign-cert] To install locally, run: bun run sign:trust`);
}
