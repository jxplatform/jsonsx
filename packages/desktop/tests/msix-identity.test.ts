/**
 * MSIX package identity (scripts/msix-identity.ts) — the shared publisher subject and manifest
 * renderer.
 *
 * The regression these guard: `sign-cert.ts` derived the cert Subject from
 * `electrobun-builder-for-windows`'s `loadConfig()`, which returns this package's
 * `electrobun.config.ts` — a shape with no `windows.msix` key — so the read was always `undefined`
 * and the `CN=Jx Studio Dev` fallback always won, while the manifest hardcoded the Partner Center
 * publisher ID. MSIX signing requires those two strings to be byte-identical, so a fresh clone
 * could not have produced a signable cert. Both now read one constant; these tests hold that.
 */
import { describe, expect, test } from "bun:test";
import {
  DEV_CERT_FILENAME,
  DEV_CERT_PASSWORD,
  MSIX_IDENTITY_NAME,
  MSIX_PUBLISHER,
  MSIX_PUBLISHER_DISPLAY_NAME,
  renderAppxManifest,
  toQuadVersion,
} from "../scripts/msix-identity";

describe("toQuadVersion", () => {
  test("pads a three-part package.json version to MSIX's four parts", () => {
    expect(toQuadVersion("1.2.1")).toBe("1.2.1.0");
    expect(toQuadVersion("0.19.0")).toBe("0.19.0.0");
  });

  test("leaves an already-quad version alone", () => {
    expect(toQuadVersion("1.2.1.4")).toBe("1.2.1.4");
  });

  test("does not pad a prerelease or two-part version it cannot interpret", () => {
    // Split length is 3 for "1.2.1-rc.1"? No — "-rc.1" makes it 4 segments; either way the value is
    // Passed through rather than silently mangled into an invalid Version attribute.
    expect(toQuadVersion("1.2")).toBe("1.2");
  });
});

describe("renderAppxManifest", () => {
  test("Publisher is exactly MSIX_PUBLISHER — the cert Subject sign-cert.ts requests", () => {
    // This is THE invariant. signtool compares these as raw strings; a friendly name here would
    // Fail signing and Add-AppxPackage both.
    expect(renderAppxManifest("1.2.1")).toContain(`Publisher="${MSIX_PUBLISHER}"`);
  });

  test("carries the Partner Center identity name and display publisher", () => {
    const manifest = renderAppxManifest("1.2.1");
    expect(manifest).toContain(`Name="${MSIX_IDENTITY_NAME}"`);
    expect(manifest).toContain(
      `<PublisherDisplayName>${MSIX_PUBLISHER_DISPLAY_NAME}</PublisherDisplayName>`,
    );
  });

  test("stamps the quad version, not the raw package version", () => {
    expect(renderAppxManifest("1.2.1")).toContain('Version="1.2.1.0"');
  });

  test("emits SINGLE backslashes in asset paths", () => {
    // The template literal's `\\` is an escape: MSIX wants `Assets\StoreLogo.png`. A doubled
    // Separator reaching the XML makes makeappx fail to locate the logos.
    const manifest = renderAppxManifest("1.2.1");
    expect(manifest).toContain(String.raw`<Logo>Assets\StoreLogo.png</Logo>`);
    expect(manifest).toContain(String.raw`Executable="bin\launcher.exe"`);
    expect(manifest).not.toContain(String.raw`Assets\\StoreLogo.png`);
  });

  test("declares the full-trust capability the launcher needs", () => {
    const manifest = renderAppxManifest("1.2.1");
    expect(manifest).toContain('<rescap:Capability Name="runFullTrust" />');
    expect(manifest).toContain('<Capability Name="internetClient" />');
  });

  test("is well-formed XML with the declaration first", () => {
    const manifest = renderAppxManifest("1.2.1");
    expect(manifest.startsWith('<?xml version="1.0" encoding="utf-8"?>')).toBe(true);
    expect(manifest.trimEnd().endsWith("</Package>")).toBe(true);
  });
});

describe("dev certificate constants", () => {
  test("match the literals scripts/trust-cert.ps1 repeats in PowerShell", async () => {
    // The .ps1 cannot import this module, so the duplication is real and worth pinning.
    const ps1 = await Bun.file(new URL("../scripts/trust-cert.ps1", import.meta.url)).text();
    expect(ps1).toContain(DEV_CERT_FILENAME);
    expect(ps1).toContain(DEV_CERT_PASSWORD);
  });
});
