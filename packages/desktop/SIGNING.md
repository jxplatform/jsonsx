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

The certificate's **Subject must exactly match** the `<Identity Publisher>` in the generated
`AppxManifest.xml` — MSIX compares them as raw strings, and any difference fails both
`signtool sign` and `Add-AppxPackage`. Both values therefore come from a single constant,
`MSIX_PUBLISHER` in [`scripts/msix-identity.ts`](scripts/msix-identity.ts), currently
`CN=118A192A-BE3D-4B35-A22B-EA889CD1D0B4` (the Partner Center publisher ID). The manifest cannot use
a friendlier name without breaking Store submission, so the certificate follows the manifest.

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

### Signing fails / MSIX ships unsigned despite a certificate

`build-msix.ts` catches signing failures and continues with an **unsigned** package (it records the
honest status in `artifacts/msix-signing.json`), so a subject mismatch shows up as a warning rather
than a hard failure. Confirm the certificate's Subject:

```powershell
certutil -dump -p dev-cert-password .\certs\jx-studio-dev.pfx
```

If it is not exactly `CN=118A192A-BE3D-4B35-A22B-EA889CD1D0B4`, the certificate predates the shared
`MSIX_PUBLISHER` constant — delete it and re-run `bun run sign:cert`, then `bun run sign:trust`.

### Installation fails with "This app couldn't be installed"

- Ensure certificate is in trusted root store (`bun run sign:trust`)
- Check event viewer for detailed error (Event Viewer → Windows Logs → System)

## Notes

- The certificate password is hardcoded to `dev-cert-password` (dev-only; change in `sign-cert.ts` and `build-msix.ts` if needed)
- Certificate is valid for 10 years from generation
- For distribution, use a real code-signing certificate from a trusted CA
