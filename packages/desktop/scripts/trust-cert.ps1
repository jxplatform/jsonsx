# Trust a self-signed certificate for local MSIX installation
# Run from packages/desktop: bun run sign:trust
# Requires elevation - will self-elevate via UAC if not already admin.

$certPath = Resolve-Path ".\certs\jx-studio-dev.pfx" -ErrorAction SilentlyContinue
$certPassword = "dev-cert-password"

if (!$certPath) {
  Write-Host "Error: Certificate not found at .\certs\jx-studio-dev.pfx" -ForegroundColor Red
  Write-Host "Run: bun run sign:cert" -ForegroundColor Yellow
  exit 1
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (!$isAdmin) {
  Write-Host "Not running as admin. Installing current-user trust only." -ForegroundColor Yellow
  Write-Host "If needed, re-run in elevated PowerShell to also trust at machine level." -ForegroundColor Yellow
}

$securePassword = ConvertTo-SecureString $certPassword -AsPlainText -Force

$pfxData = Get-PfxData -FilePath $certPath -Password $securePassword
$expectedThumbprint = $pfxData.EndEntityCertificates[0].Thumbprint
Write-Host "Target certificate thumbprint: $expectedThumbprint" -ForegroundColor DarkCyan

Write-Host "Installing certificate to CurrentUser\\TrustedPeople..." -ForegroundColor Cyan
Import-PfxCertificate -FilePath $certPath -CertStoreLocation "cert:\CurrentUser\TrustedPeople" -Password $securePassword -ErrorAction Stop | Out-Null

Write-Host "Installing certificate to CurrentUser\\Root..." -ForegroundColor Cyan
Import-PfxCertificate -FilePath $certPath -CertStoreLocation "cert:\CurrentUser\Root" -Password $securePassword -ErrorAction Stop | Out-Null

$currentUserTrustedPeopleMatch = Get-ChildItem "cert:\CurrentUser\TrustedPeople" | Where-Object { $_.Thumbprint -eq $expectedThumbprint }
$currentUserRootMatch = Get-ChildItem "cert:\CurrentUser\Root" | Where-Object { $_.Thumbprint -eq $expectedThumbprint }

if (!$currentUserTrustedPeopleMatch -or !$currentUserRootMatch) {
  Write-Host "Failed to trust certificate in current user stores." -ForegroundColor Red
  exit 1
}

if ($isAdmin) {
  Write-Host "Installing certificate to LocalMachine\\TrustedPeople..." -ForegroundColor Cyan
  Import-PfxCertificate -FilePath $certPath -CertStoreLocation "cert:\LocalMachine\TrustedPeople" -Password $securePassword -ErrorAction Stop | Out-Null

  Write-Host "Installing certificate to LocalMachine\\Root..." -ForegroundColor Cyan
  Import-PfxCertificate -FilePath $certPath -CertStoreLocation "cert:\LocalMachine\Root" -Password $securePassword -ErrorAction Stop | Out-Null

  $trustedPeopleMatch = Get-ChildItem "cert:\LocalMachine\TrustedPeople" | Where-Object { $_.Thumbprint -eq $expectedThumbprint }
  $rootMatch = Get-ChildItem "cert:\LocalMachine\Root" | Where-Object { $_.Thumbprint -eq $expectedThumbprint }

  if (!$trustedPeopleMatch -or !$rootMatch) {
    Write-Host "Machine-level trust install incomplete for expected thumbprint." -ForegroundColor Yellow
    Write-Host "Current-user trust is installed and should be enough for local Add-AppPackage." -ForegroundColor Yellow
  }
}

Write-Host "Done! MSIX packages signed with this certificate can now be installed." -ForegroundColor Green
