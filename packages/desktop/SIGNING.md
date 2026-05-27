# MSIX Signing for Local Testing

This guide explains how to sign and install Jx Studio MSIX packages locally for testing.

## Prerequisites

- Windows 10/11
- [Windows SDK](https://developer.microsoft.com/en-us/windows/downloads/windows-sdk/) installed (required for `signtool`)
- Run commands from `packages/desktop/` directory

## One-Time Setup

### 1. Generate a Self-Signed Certificate

```bash
bun run sign:cert
```

This creates a self-signed code-signing certificate at `packages/desktop/certs/jx-studio-dev.pfx` with password `dev-cert-password`.

### 2. Trust the Certificate Locally

```bash
bun run sign:trust
```

This installs the certificate to your Windows trusted root store, allowing MSIX packages signed with it to install without SmartScreen warnings.

## Building and Installing

### 3. Build the Signed MSIX

```bash
bun run build:msix
```

The build will:

1. Compile the app with electrobun
2. Detect the certificate and automatically sign the MSIX package
3. Copy artifacts to `packages/desktop/artifacts/`

Look for output like:

```
[build-msix] Signed: Jx Studio_0.19.0_x64.msix
[build-msix] Copied Jx Studio_0.19.0_x64.msix → artifacts/
```

### 4. Install the Signed MSIX

Option A: Double-click the MSIX file in `artifacts/`

Option B: Use PowerShell:

```powershell
Add-AppxPackage -Path ".\artifacts\Jx Studio_0.19.0_x64.msix"
```

## Troubleshooting

### "signtool not found"

- Ensure Windows SDK is installed and `signtool.exe` is in your PATH
- Typical location: `C:\Program Files (x86)\Windows Kits\10\bin\10.0.XXXXX.0\x64\`
- Add to PATH or set it in `sign-cert.ts`

### Certificate issues

- Delete `packages/desktop/certs/jx-studio-dev.pfx` and regenerate with `bun run sign:cert`
- Check trusted certs: `certmgr.msc` → Trusted Root Certification Authorities

### Installation fails with "This app couldn't be installed"

- Ensure certificate is in trusted root store (`bun run sign:trust`)
- Check event viewer for detailed error (Event Viewer → Windows Logs → System)

## Notes

- The certificate password is hardcoded to `dev-cert-password` (dev-only; change in `sign-cert.ts` and `build-msix.ts` if needed)
- Certificate is valid for 10 years from generation
- For distribution, use a real code-signing certificate from a trusted CA
