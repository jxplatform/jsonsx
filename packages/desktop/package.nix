{
  bun2nix,
  stdenv,
  bun,
  makeWrapper,
  copyDesktopItems,
  chromium,
  lib,
}:
stdenv.mkDerivation {
  pname = "jx-studio";
  version = (lib.importJSON ../../package.json).version;

  src = lib.cleanSource ../..;

  nativeBuildInputs = [
    bun
    makeWrapper
    copyDesktopItems
  ];

  desktopItems = [ ./jx-studio.desktop ];

  bunDeps = bun2nix.fetchBunDeps {
    bunNix = ../../bun.nix;
  };

  configurePhase = ''
    export HOME="$TMPDIR"
    export BUN_INSTALL_CACHE_DIR=$(mktemp -d)
    cp -r "$bunDeps"/share/bun-cache/. "$BUN_INSTALL_CACHE_DIR"
    bun install --frozen-lockfile
  '';

  buildPhase = ''
    runHook preBuild

    bun run build
    bun run --cwd packages/desktop scripts/pre-build-rpc.ts

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p $out/lib/jx-studio $out/bin

    cp -r packages/desktop/assets $out/lib/jx-studio/
    cp -r packages/desktop/src $out/lib/jx-studio/

    # Copy node_modules, dereferencing workspace symlinks
    cp -rL node_modules $out/lib/jx-studio/

    makeWrapper ${bun}/bin/bun $out/bin/jx-studio \
      --add-flags "run $out/lib/jx-studio/src/chromium/index.ts" \
      --set CHROMIUM_BIN "${chromium}/bin/chromium" \
      --set JX_STUDIO_ASSETS "$out/lib/jx-studio/assets/studio"

    install -Dm644 packages/desktop/icon.png $out/share/icons/hicolor/512x512/apps/jx-studio.png
    install -Dm644 branding/jx_flattened.svg $out/share/icons/hicolor/scalable/apps/jx-studio.svg

    runHook postInstall
  '';

  meta = {
    description = "Jx Studio — visual JSON component editor";
    homepage = "https://jxsuite.com";
    platforms = [
      "x86_64-linux"
      "aarch64-linux"
    ];
  };
}
